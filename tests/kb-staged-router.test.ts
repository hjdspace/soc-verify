/**
 * kb-router 知识审阅入口测试（issue 05）。
 *
 * 测试缝：tRPC server-side caller（复用 kb-wiki-router 的 harness 模式）。
 * 覆盖：
 *  - kb.stagedChangeSets：列出本库变更集（kbId 过滤）、未挂载/非 wiki 拒绝
 *  - kb.stagedChangeSet：读取 before/proposed 与审阅选择、非本库拒绝、未知拒绝
 *  - kb.decideStaged：记录选择持久、未知变更集/未知页结构化失败
 *  - 正式 wiki/ 在 staging 与选择阶段保持不变
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { rmSync, mkdirSync, existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

const { tmpDir, projectDir, globalDataDir } = vi.hoisted(() => {
  const os = require('node:os');
  const fs = require('node:fs');
  const path = require('node:path');
  const base = os.tmpdir() + `/sv-kb-staged-router-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
  const dirs = {
    tmpDir: base,
    projectDir: path.join(base, 'project'),
    globalDataDir: path.join(base, 'appdata'),
  };
  fs.mkdirSync(dirs.tmpDir, { recursive: true });
  fs.mkdirSync(dirs.projectDir, { recursive: true });
  fs.mkdirSync(dirs.globalDataDir, { recursive: true });
  return dirs;
});

vi.mock('electron', () => ({
  app: { getPath: vi.fn(() => globalDataDir) },
  BrowserWindow: { getAllWindows: vi.fn(() => []) },
  dialog: { showOpenDialog: vi.fn().mockResolvedValue({ canceled: true, filePaths: [] }) },
}));

vi.mock('../src/main/project/project-manager', () => ({
  projectManager: {
    listProjects: vi.fn(() => [{
      id: 'test-project-id', rootPath: projectDir, name: 'Test Project', lastOpenedAt: Date.now(),
    }]),
    getProjectByPath: vi.fn(() => ({
      id: 'test-project-id', rootPath: projectDir, name: 'Test Project', lastOpenedAt: Date.now(),
    })),
  },
}));

vi.mock('../src/main/credentials/credential-manager', () => ({
  credentialManager: {
    get: vi.fn().mockResolvedValue(null),
    getDefaultCredential: vi.fn().mockReturnValue(null),
  },
}));

vi.mock('../src/main/kb/deep-reindexer', () => ({ deepReindex: vi.fn() }));

vi.mock('@firecrawl/anydoc', () => ({
  toDocument: vi.fn(),
  toMarkdownBytes: vi.fn(),
  formatFromPath: vi.fn(),
  toMarkdown: vi.fn(),
  formatFromBytes: vi.fn(),
  formatFromExtension: vi.fn(),
}));

import { kbRouter } from '../src/main/ipc/routers/kb-router';
import { initWikiLayout, wikiLayout } from '../src/main/kb/wiki-layout';
import { stageProposal } from '../src/main/kb/staging';

const caller = kbRouter.createCaller({});

let kbPath: string;

const SRC_REF = { sourceId: 'a'.repeat(64), sourceRevision: 'b'.repeat(64), parsedHash: 'c'.repeat(64) };

beforeEach(() => {
  kbPath = join(tmpDir, `kb-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`);
  mkdirSync(kbPath, { recursive: true });
});

afterEach(() => {
  rmSync(kbPath, { recursive: true, force: true });
});

const pageBody = (type: string, title: string, refs = [SRC_REF]): string => [
  '---',
  `type: ${type}`,
  `title: "${title}"`,
  'summary: 摘要。',
  'keywords: []',
  'tags: []',
  'sources:',
  ...refs.flatMap((s) => [
    `  - sourceId: "${s.sourceId}"`,
    `    sourceRevision: "${s.sourceRevision}"`,
    `    parsedHash: "${s.parsedHash}"`,
  ]),
  'created: "2026-09-13T00:00:00Z"',
  'updated: "2026-09-13T00:00:00Z"',
  '---', '', `# ${title}`, '', '正文。',
].join('\n');

const fileBlock = (p: string, body: string): string => `---FILE: ${p}---\n${body}\n---END FILE---`;

async function mountWikiKb(): Promise<void> {
  const st = await caller.status({});
  if (st.mounted) await caller.unmount({ kbId: st.mounted.kbId });
  await caller.unregister({ kbId: 'wiki-kb-id' });
  await initWikiLayout(kbPath, { kbId: 'wiki-kb-id', name: 'Wiki KB' });
  const reg = await caller.register({ name: `Wiki KB ${Math.random().toString(36).slice(2, 8)}`, path: kbPath });
  if (!reg.ok) throw new Error(`register failed: ${reg.error?.message}`);
  const mounted = await caller.mount({ kbId: 'wiki-kb-id' });
  if (!mounted.ok) throw new Error(`mount failed: ${mounted.error?.message}`);
}

async function unmountIfAny(): Promise<void> {
  const st = await caller.status({});
  if (st.mounted) await caller.unmount({ kbId: st.mounted.kbId });
}

describe('kb.stagedChangeSets', () => {
  it('列出本库待审阅变更集摘要', async () => {
    await mountWikiKb();
    await stageProposal(kbPath, {
      kbId: 'wiki-kb-id', taskId: 'task-1', origin: 'compile', sourceRefs: [SRC_REF],
      proposalText: fileBlock('wiki/concepts/axi.md', pageBody('concept', 'AXI')),
    });

    const res = await caller.stagedChangeSets({});
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.value).toHaveLength(1);
    expect(res.value[0].pageCount).toBe(1);
    expect(res.value[0].taskId).toBe('task-1');
  });

  it('未挂载拒绝', async () => {
    await unmountIfAny();
    await expect(caller.stagedChangeSets({})).rejects.toThrow('未挂载');
  });
});

describe('kb.stagedChangeSet', () => {
  it('读取 before/proposed 与审阅选择', async () => {
    await mountWikiKb();
    const staged = await stageProposal(kbPath, {
      kbId: 'wiki-kb-id', taskId: 'task-1', origin: 'compile', sourceRefs: [SRC_REF],
      proposalText: fileBlock('wiki/concepts/axi.md', pageBody('concept', 'AXI')),
    });
    if (!staged.ok) throw new Error('stage');
    const csId = staged.value.changeSet.changeSetId;

    const res = await caller.stagedChangeSet({ changeSetId: csId });
    expect(res.changeSet.changeSetId).toBe(csId);
    expect(res.changeSet.pages[0].proposed).toContain('# AXI');
    expect(res.changeSet.pages[0].before).toBeNull();
    expect(res.review).not.toBeNull();
  });

  it('未知变更集 NOT_FOUND', async () => {
    await mountWikiKb();
    await expect(caller.stagedChangeSet({ changeSetId: 'nope' })).rejects.toThrow();
  });

  it('变更集不属于当前挂载库时拒绝（不跨库泄漏）', async () => {
    await mountWikiKb();
    const staged = await stageProposal(kbPath, {
      kbId: 'another-kb', taskId: 't', origin: 'compile', sourceRefs: [SRC_REF],
      proposalText: fileBlock('wiki/concepts/axi.md', pageBody('concept', 'AXI')),
    });
    if (!staged.ok) throw new Error('stage');
    await expect(caller.stagedChangeSet({ changeSetId: staged.value.changeSet.changeSetId }))
      .rejects.toThrow('不属于当前挂载库');
  });
});

describe('kb.decideStaged', () => {
  it('记录逐 hunk 选择并持久可读回', async () => {
    await mountWikiKb();
    const staged = await stageProposal(kbPath, {
      kbId: 'wiki-kb-id', taskId: 't', origin: 'compile', sourceRefs: [SRC_REF],
      proposalText: fileBlock('wiki/concepts/axi.md', pageBody('concept', 'AXI 新版', [SRC_REF])),
    });
    if (!staged.ok) throw new Error('stage');
    const csId = staged.value.changeSet.changeSetId;
    const relPath = 'wiki/concepts/axi.md';

    const dec = await caller.decideStaged({ changeSetId: csId, pageRelPath: relPath, hunkIds: [0, 1], decision: 'accepted' });
    expect(dec.ok).toBe(true);

    const reread = await caller.stagedChangeSet({ changeSetId: csId });
    const page = reread.review?.pages.find((p) => p.relPath === relPath);
    expect(page?.hunkStates[0]).toBe('accepted');
    expect(page?.hunkStates[1]).toBe('accepted');
  });

  it('未知变更集结构化失败（不抛错）', async () => {
    await mountWikiKb();
    const res = await caller.decideStaged({ changeSetId: 'nope', pageRelPath: 'wiki/concepts/x.md', hunkIds: [0], decision: 'rejected' });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.code).toBe('changeSetNotFound');
  });

  it('未知页结构化失败', async () => {
    await mountWikiKb();
    const staged = await stageProposal(kbPath, {
      kbId: 'wiki-kb-id', taskId: 't', origin: 'compile', sourceRefs: [SRC_REF],
      proposalText: fileBlock('wiki/concepts/axi.md', pageBody('concept', 'AXI')),
    });
    if (!staged.ok) throw new Error('stage');
    const res = await caller.decideStaged({ changeSetId: staged.value.changeSet.changeSetId, pageRelPath: 'wiki/concepts/nope.md', hunkIds: [0], decision: 'accepted' });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.code).toBe('unknownPage');
  });
});

describe('正式 wiki/ 在 staging 阶段保持不变', () => {
  it('staging + 选择后 wiki/ 无新页、无索引改写', async () => {
    await mountWikiKb();
    const staged = await stageProposal(kbPath, {
      kbId: 'wiki-kb-id', taskId: 't', origin: 'compile', sourceRefs: [SRC_REF],
      proposalText: fileBlock('wiki/concepts/axi.md', pageBody('concept', 'AXI')),
    });
    if (!staged.ok) throw new Error('stage');
    await caller.decideStaged({ changeSetId: staged.value.changeSet.changeSetId, pageRelPath: 'wiki/concepts/axi.md', hunkIds: [0], decision: 'accepted' });

    expect(existsSync(join(kbPath, 'wiki', 'concepts', 'axi.md'))).toBe(false);
    expect(existsSync(join(kbPath, 'wiki', 'index.md'))).toBe(false);
    // staging/reviews 有记录
    expect(readdirSync(wikiLayout(kbPath).stagingDir).filter((f) => f.endsWith('.json')).length).toBe(1);
    expect(readdirSync(wikiLayout(kbPath).reviewsDir).filter((f) => f.endsWith('.json')).length).toBe(1);
  });
});
