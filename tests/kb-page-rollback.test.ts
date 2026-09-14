/**
 * KB 页面历史与回滚测试（issue 19，spec §6）。
 *
 * 验收（A13；User Stories 38, 39, 40）：
 *  - 历史按 commit 列旧/新内容、操作与来源引用；创建前不存在可表达；
 *  - 回滚生成新的 staged 变更并走基线/链接/来源校验，不直接覆写；
 *  - 回滚再次可追溯，页面/原件/视觉解读引用不因历史显示而丢失；
 *  - 发布回滚后检索按 revision 失效，不展示旧索引拼新正文；
 *  - 回滚前外部修改与已撤回来源有明确结果，测试不改无关页面。
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import {
  readPageHistory,
  createRollbackProposal,
  type RollbackInput,
} from '../src/main/kb/page-rollback';
import { stageProposal, recordDecision } from '../src/main/kb/staging';
import { publishChangeSet, historyFilePath, appendHistoryEntryIdempotent } from '../src/main/kb/publish';
import { wikiRealHunkIds } from '../src/shared/wiki-hunks';
import { initWikiLayout, readWikiManifest, writeWikiManifest, type WikiKbManifest } from '../src/main/kb/wiki-layout';
import { searchWiki } from '../src/main/kb/wiki-search';
import type { WikiPageHistoryEntry, WikiSourceRef } from '@shared/kb-types';

let kbPath: string;

const KB_ID = 'kb-rollback-test';
const SOURCE_ID = 'a'.repeat(64);
const SOURCE_REVISION_1 = 'b'.repeat(64);
const PARSED_HASH = 'c'.repeat(64);

const SRC_REF_1: WikiSourceRef = {
  sourceId: SOURCE_ID,
  sourceRevision: SOURCE_REVISION_1,
  parsedHash: PARSED_HASH,
};

const sha = (text: string): string => createHash('sha256').update(text, 'utf-8').digest('hex');

const SRC_PATH = 'axi-spec';

async function registerSource(ref: WikiSourceRef, currentRevision = ref.sourceRevision): Promise<void> {
  const manifest = await readWikiManifest(kbPath);
  if (!manifest.ok) throw new Error('manifest');
  await writeWikiManifest(kbPath, {
    ...manifest.manifest,
    sources: {
      ...(manifest.manifest.sources ?? {}),
      [ref.sourceId]: {
        sourcePath: SRC_PATH,
        sourceId: ref.sourceId,
        ext: '.pdf',
        size: 1,
        currentRevision,
        parsedRevision: currentRevision,
        parsedHash: ref.parsedHash,
        engine: 'anydoc',
        engineFingerprint: 'fp',
        status: 'ready',
        assetCount: 0,
        importedAt: '2026-09-13T00:00:00Z',
        updatedAt: '2026-09-13T00:00:00Z',
      },
    },
  });
}

function pageBody(title: string, body: string, sources: WikiSourceRef[] = [], type = 'concept'): string {
  const srcLines = sources.length === 0
    ? 'sources: []'
    : ['sources:', ...sources.flatMap((s) => [
        `  - sourceId: "${s.sourceId}"`,
        `    sourceRevision: "${s.sourceRevision}"`,
        `    parsedHash: "${s.parsedHash}"`,
      ])].join('\n');
  return [
    '---',
    `type: ${type}`,
    `title: "${title}"`,
    'summary: 摘要。',
    'keywords: [AXI]',
    'tags: []',
    srcLines,
    'created: "2026-09-13T00:00:00Z"',
    'updated: "2026-09-13T00:00:00Z"',
    '---',
    '',
    `# ${title}`,
    '',
    body,
  ].join('\n');
}

const fileBlock = (p: string, body: string): string => `---FILE: ${p}---\n${body}\n---END FILE---`;

async function stageAndAccept(
  relPath: string,
  content: string,
  sourceRefs: WikiSourceRef[] = [SRC_REF_1],
  extra: { kbId?: string; readBaseline?: Array<{ pageId: string; hash: string | null }> } = {},
): Promise<string> {
  const staged = await stageProposal(kbPath, {
    kbId: extra.kbId ?? KB_ID,
    taskId: 'task-1',
    origin: 'compile',
    sourceRefs,
    proposalText: fileBlock(relPath, content),
    ...extra,
  });
  if (!staged.ok) throw new Error(`stage: ${staged.error.code} ${staged.error.message}`);
  const changeSetId = staged.value.changeSet.changeSetId;
  const page = staged.value.changeSet.pages.find((p) => p.relPath === relPath);
  if (!page) throw new Error('staged page missing');
  const rec = await recordDecision(kbPath, {
    changeSetId,
    pageRelPath: relPath,
    hunkIds: wikiRealHunkIds(page),
    decision: 'accepted',
  });
  if (!rec.ok) throw new Error(`decide: ${rec.error.code}`);
  return changeSetId;
}

beforeEach(async () => {
  kbPath = mkdtempSync(join(tmpdir(), 'sv-kb-rollback-'));
  await initWikiLayout(kbPath, { kbId: KB_ID, name: 'Rollback 测试库' });
  await registerSource(SRC_REF_1);
});

afterEach(() => {
  rmSync(kbPath, { recursive: true, force: true });
});

// ── readPageHistory ──────────────────────────────────────────────

describe('readPageHistory — 页面历史读取', () => {
  it('无历史时返回空列表', async () => {
    const history = await readPageHistory(kbPath, 'concepts/axi');
    expect(history.ok).toBe(true);
    if (!history.ok) return;
    expect(history.entries).toHaveLength(0);
  });

  it('发布后历史包含 create 操作，创建前不存在可表达', async () => {
    const body = pageBody('AXI 限制', '正文 A。', [SRC_REF_1]);
    const csId = await stageAndAccept('wiki/concepts/axi.md', body);
    const res = await publishChangeSet(kbPath, {
      kbId: KB_ID,
      changeSetId: csId,
      now: '2026-09-13T10:00:00Z',
    });
    expect(res.ok).toBe(true);

    const history = await readPageHistory(kbPath, 'concepts/axi');
    expect(history.ok).toBe(true);
    if (!history.ok) return;
    expect(history.entries).toHaveLength(1);
    const entry = history.entries[0]!;
    expect(entry.operation).toBe('create');
    expect(entry.beforeHash).toBeNull(); // 创建前不存在
    expect(entry.afterHash).toBe(sha(body));
    expect(entry.sources).toEqual([SRC_REF_1]);
    expect(entry.commitId).toBe(res.ok ? res.commitId : '');
  });

  it('多次发布后历史按时间倒序排列，列出每次改动', async () => {
    // 第一次发布：创建页
    const body1 = pageBody('AXI 限制 v1', '正文 A。', [SRC_REF_1]);
    const csId1 = await stageAndAccept('wiki/concepts/axi.md', body1);
    await publishChangeSet(kbPath, { kbId: KB_ID, changeSetId: csId1, now: '2026-09-13T10:00:00Z' });

    // 第二次发布：更新页
    const body2 = pageBody('AXI 限制 v2', '正文 B。', [SRC_REF_1]);
    const csId2 = await stageAndAccept('wiki/concepts/axi.md', body2);
    await publishChangeSet(kbPath, { kbId: KB_ID, changeSetId: csId2, now: '2026-09-13T11:00:00Z' });

    const history = await readPageHistory(kbPath, 'concepts/axi');
    expect(history.ok).toBe(true);
    if (!history.ok) return;
    expect(history.entries).toHaveLength(2);
    // 倒序：最新在前
    expect(history.entries[0]!.operation).toBe('update');
    expect(history.entries[0]!.afterHash).toBe(sha(body2));
    expect(history.entries[0]!.beforeHash).toBe(sha(body1));
    expect(history.entries[1]!.operation).toBe('create');
    expect(history.entries[1]!.afterHash).toBe(sha(body1));
    expect(history.entries[1]!.beforeHash).toBeNull();
  });

  it('历史条目包含来源引用与 commitId', async () => {
    const body = pageBody('AXI 限制', '正文 A。', [SRC_REF_1]);
    const csId = await stageAndAccept('wiki/concepts/axi.md', body);
    const res = await publishChangeSet(kbPath, {
      kbId: KB_ID,
      changeSetId: csId,
      now: '2026-09-13T10:00:00Z',
    });
    expect(res.ok).toBe(true);

    const history = await readPageHistory(kbPath, 'concepts/axi');
    expect(history.ok).toBe(true);
    if (!history.ok) return;
    const entry = history.entries[0]!;
    expect(entry.sources).toHaveLength(1);
    expect(entry.sources[0]!.sourceId).toBe(SOURCE_ID);
    expect(entry.sources[0]!.sourceRevision).toBe(SOURCE_REVISION_1);
    expect(entry.commitId).toBeTruthy();
    expect(entry.changeSetId).toBe(csId);
  });
});

// ── createRollbackProposal ───────────────────────────────────────

describe('createRollbackProposal — 回滚提案生成', () => {
  it('回滚到历史版本生成新 staged 变更，不直接覆写', async () => {
    // 创建页 v1
    const body1 = pageBody('AXI 限制 v1', '正文 A。', [SRC_REF_1]);
    const csId1 = await stageAndAccept('wiki/concepts/axi.md', body1);
    await publishChangeSet(kbPath, { kbId: KB_ID, changeSetId: csId1, now: '2026-09-13T10:00:00Z' });

    // 更新页 v2
    const body2 = pageBody('AXI 限制 v2', '正文 B。', [SRC_REF_1]);
    const csId2 = await stageAndAccept('wiki/concepts/axi.md', body2);
    await publishChangeSet(kbPath, { kbId: KB_ID, changeSetId: csId2, now: '2026-09-13T11:00:00Z' });

    // 确认 v2 是当前
    const current = readFileSync(join(kbPath, 'wiki/concepts/axi.md'), 'utf-8');
    expect(current).toBe(body2);

    // 回滚到 v1
    const history = await readPageHistory(kbPath, 'concepts/axi');
    if (!history.ok) throw new Error('history');
    const createEntry = history.entries.find((e) => e.operation === 'create')!;

    const rollback: RollbackInput = {
      kbId: KB_ID,
      pageId: 'concepts/axi',
      targetCommitId: createEntry.commitId,
    };
    const result = await createRollbackProposal(kbPath, rollback);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.changeSet.origin).toBe('fix');
    expect(result.changeSet.pages).toHaveLength(1);
    const page = result.changeSet.pages[0]!;
    expect(page.relPath).toBe('wiki/concepts/axi.md');
    expect(page.proposed).toBe(body1); // 回滚到 v1 内容
    expect(page.before).toBe(body2); // 当前是 v2
    expect(page.baselineHash).toBe(sha(body2));
    expect(page.sources).toEqual([SRC_REF_1]); // 保留原来源引用

    // 正式页仍是 v2（未发布前不覆写）
    const stillCurrent = readFileSync(join(kbPath, 'wiki/concepts/axi.md'), 'utf-8');
    expect(stillCurrent).toBe(body2);
  });

  it('回滚提案经审阅接受并发布后页面恢复到历史版本', async () => {
    // 创建页 v1
    const body1 = pageBody('AXI 限制 v1', '正文 A。', [SRC_REF_1]);
    const csId1 = await stageAndAccept('wiki/concepts/axi.md', body1);
    await publishChangeSet(kbPath, { kbId: KB_ID, changeSetId: csId1, now: '2026-09-13T10:00:00Z' });

    // 更新页 v2
    const body2 = pageBody('AXI 限制 v2', '正文 B。', [SRC_REF_1]);
    const csId2 = await stageAndAccept('wiki/concepts/axi.md', body2);
    await publishChangeSet(kbPath, { kbId: KB_ID, changeSetId: csId2, now: '2026-09-13T11:00:00Z' });

    // 回滚到 v1
    const history = await readPageHistory(kbPath, 'concepts/axi');
    if (!history.ok) throw new Error('history');
    const createEntry = history.entries.find((e) => e.operation === 'create')!;

    const rollbackRes = await createRollbackProposal(kbPath, {
      kbId: KB_ID,
      pageId: 'concepts/axi',
      targetCommitId: createEntry.commitId,
    });
    expect(rollbackRes.ok).toBe(true);
    if (!rollbackRes.ok) return;

    // 审阅接受
    const rollbackCsId = rollbackRes.changeSet.changeSetId;
    const rollbackPage = rollbackRes.changeSet.pages[0]!;
    const dec = await recordDecision(kbPath, {
      changeSetId: rollbackCsId,
      pageRelPath: rollbackPage.relPath,
      hunkIds: wikiRealHunkIds(rollbackPage),
      decision: 'accepted',
    });
    expect(dec.ok).toBe(true);

    // 发布回滚
    const pubRes = await publishChangeSet(kbPath, {
      kbId: KB_ID,
      changeSetId: rollbackCsId,
      now: '2026-09-13T12:00:00Z',
    });
    expect(pubRes.ok).toBe(true);
    if (!pubRes.ok) return;

    // 页面已恢复到 v1
    const restored = readFileSync(join(kbPath, 'wiki/concepts/axi.md'), 'utf-8');
    expect(restored).toBe(body1);
  });

  it('回滚后历史新增 update 条目，回滚本身可追溯', async () => {
    const body1 = pageBody('AXI 限制 v1', '正文 A。', [SRC_REF_1]);
    const csId1 = await stageAndAccept('wiki/concepts/axi.md', body1);
    await publishChangeSet(kbPath, { kbId: KB_ID, changeSetId: csId1, now: '2026-09-13T10:00:00Z' });

    const body2 = pageBody('AXI 限制 v2', '正文 B。', [SRC_REF_1]);
    const csId2 = await stageAndAccept('wiki/concepts/axi.md', body2);
    await publishChangeSet(kbPath, { kbId: KB_ID, changeSetId: csId2, now: '2026-09-13T11:00:00Z' });

    const history1 = await readPageHistory(kbPath, 'concepts/axi');
    if (!history1.ok) throw new Error('history');
    const createEntry = history1.entries.find((e) => e.operation === 'create')!;

    const rollbackRes = await createRollbackProposal(kbPath, {
      kbId: KB_ID,
      pageId: 'concepts/axi',
      targetCommitId: createEntry.commitId,
    });
    expect(rollbackRes.ok).toBe(true);
    if (!rollbackRes.ok) return;

    const rollbackCsId = rollbackRes.changeSet.changeSetId;
    const rollbackPage = rollbackRes.changeSet.pages[0]!;
    await recordDecision(kbPath, {
      changeSetId: rollbackCsId,
      pageRelPath: rollbackPage.relPath,
      hunkIds: wikiRealHunkIds(rollbackPage),
      decision: 'accepted',
    });

    await publishChangeSet(kbPath, { kbId: KB_ID, changeSetId: rollbackCsId, now: '2026-09-13T12:00:00Z' });

    // 历史应有 3 条
    const history2 = await readPageHistory(kbPath, 'concepts/axi');
    expect(history2.ok).toBe(true);
    if (!history2.ok) return;
    expect(history2.entries).toHaveLength(3);
    // 最新一条是 update（回滚操作）
    const latest = history2.entries[0]!;
    expect(latest.operation).toBe('update');
    expect(latest.afterHash).toBe(sha(body1)); // 恢复到 v1
    expect(latest.beforeHash).toBe(sha(body2)); // 从 v2 回滚
  });

  it('回滚发布后检索按 revision 失效，不展示旧索引拼新正文', async () => {
    const body1 = pageBody('AXI 限制 v1', 'AXLEN 限制 128', [SRC_REF_1]);
    const csId1 = await stageAndAccept('wiki/concepts/axi.md', body1);
    await publishChangeSet(kbPath, { kbId: KB_ID, changeSetId: csId1, now: '2026-09-13T10:00:00Z' });

    const body2 = pageBody('AXI 限制 v2', 'AXLEN 限制 256', [SRC_REF_1]);
    const csId2 = await stageAndAccept('wiki/concepts/axi.md', body2);
    await publishChangeSet(kbPath, { kbId: KB_ID, changeSetId: csId2, now: '2026-09-13T11:00:00Z' });

    // 回滚到 v1
    const history = await readPageHistory(kbPath, 'concepts/axi');
    if (!history.ok) throw new Error('history');
    const createEntry = history.entries.find((e) => e.operation === 'create')!;

    const rollbackRes = await createRollbackProposal(kbPath, {
      kbId: KB_ID,
      pageId: 'concepts/axi',
      targetCommitId: createEntry.commitId,
    });
    expect(rollbackRes.ok).toBe(true);
    if (!rollbackRes.ok) return;

    const rollbackCsId = rollbackRes.changeSet.changeSetId;
    const rollbackPage = rollbackRes.changeSet.pages[0]!;
    await recordDecision(kbPath, {
      changeSetId: rollbackCsId,
      pageRelPath: rollbackPage.relPath,
      hunkIds: wikiRealHunkIds(rollbackPage),
      decision: 'accepted',
    });
    await publishChangeSet(kbPath, { kbId: KB_ID, changeSetId: rollbackCsId, now: '2026-09-13T12:00:00Z' });

    // 检索：应找到恢复后的 v1 内容
    const searchRes = await searchWiki(kbPath, { query: 'AXLEN' });
    expect(searchRes.ok).toBe(true);
    if (!searchRes.ok) return;
    const hits = searchRes.result.hits.filter((h) => h.kind === 'wiki');
    expect(hits.length).toBeGreaterThanOrEqual(1);
    // 命中 v1 内容（128），不是 v2 内容（256）
    const axiHit = hits.find((h) => h.id === 'concepts/axi');
    expect(axiHit).toBeDefined();
    expect(axiHit!.snippet).toContain('128');
    expect(axiHit!.snippet).not.toContain('256');
  });

  it('回滚不改变其他页面', async () => {
    // 创建两个页面
    const bodyA1 = pageBody('AXI 限制 v1', '正文 A1。', [SRC_REF_1]);
    const csA1 = await stageAndAccept('wiki/concepts/axi.md', bodyA1);
    await publishChangeSet(kbPath, { kbId: KB_ID, changeSetId: csA1, now: '2026-09-13T10:00:00Z' });

    const bodyB = pageBody('DDR 配置', '正文 DDR。', [SRC_REF_1]);
    const csB = await stageAndAccept('wiki/concepts/ddr.md', bodyB);
    await publishChangeSet(kbPath, { kbId: KB_ID, changeSetId: csB, now: '2026-09-13T10:30:00Z' });

    // 更新 A
    const bodyA2 = pageBody('AXI 限制 v2', '正文 A2。', [SRC_REF_1]);
    const csA2 = await stageAndAccept('wiki/concepts/axi.md', bodyA2);
    await publishChangeSet(kbPath, { kbId: KB_ID, changeSetId: csA2, now: '2026-09-13T11:00:00Z' });

    // 回滚 A 到 v1
    const history = await readPageHistory(kbPath, 'concepts/axi');
    if (!history.ok) throw new Error('history');
    const createEntry = history.entries.find((e) => e.operation === 'create')!;

    const rollbackRes = await createRollbackProposal(kbPath, {
      kbId: KB_ID,
      pageId: 'concepts/axi',
      targetCommitId: createEntry.commitId,
    });
    expect(rollbackRes.ok).toBe(true);
    if (!rollbackRes.ok) return;

    const rollbackCsId = rollbackRes.changeSet.changeSetId;
    const rollbackPage = rollbackRes.changeSet.pages[0]!;
    await recordDecision(kbPath, {
      changeSetId: rollbackCsId,
      pageRelPath: rollbackPage.relPath,
      hunkIds: wikiRealHunkIds(rollbackPage),
      decision: 'accepted',
    });
    await publishChangeSet(kbPath, { kbId: KB_ID, changeSetId: rollbackCsId, now: '2026-09-13T12:00:00Z' });

    // B 页不变
    const stillB = readFileSync(join(kbPath, 'wiki/concepts/ddr.md'), 'utf-8');
    expect(stillB).toBe(bodyB);
  });
});

// ── 错误情形 ─────────────────────────────────────────────────────

describe('createRollbackProposal — 错误情形', () => {
  it('pageId 不存在时返回 pageNotFound', async () => {
    const result = await createRollbackProposal(kbPath, {
      kbId: KB_ID,
      pageId: 'concepts/nonexistent',
      targetCommitId: 'fake-commit-id',
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe('pageNotFound');
  });

  it('targetCommitId 在历史中不存在时返回 commitNotFound', async () => {
    const body = pageBody('AXI 限制', '正文 A。', [SRC_REF_1]);
    const csId = await stageAndAccept('wiki/concepts/axi.md', body);
    await publishChangeSet(kbPath, { kbId: KB_ID, changeSetId: csId, now: '2026-09-13T10:00:00Z' });

    const result = await createRollbackProposal(kbPath, {
      kbId: KB_ID,
      pageId: 'concepts/axi',
      targetCommitId: 'nonexistent-commit-id',
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe('commitNotFound');
  });

  it('kbId 不匹配时返回 kbIdMismatch', async () => {
    const body = pageBody('AXI 限制', '正文 A。', [SRC_REF_1]);
    const csId = await stageAndAccept('wiki/concepts/axi.md', body);
    await publishChangeSet(kbPath, { kbId: KB_ID, changeSetId: csId, now: '2026-09-13T10:00:00Z' });

    const history = await readPageHistory(kbPath, 'concepts/axi');
    if (!history.ok) throw new Error('history');
    const entry = history.entries[0]!;

    const result = await createRollbackProposal(kbPath, {
      kbId: 'wrong-kb-id',
      pageId: 'concepts/axi',
      targetCommitId: entry.commitId,
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe('kbIdMismatch');
  });

  it('来源已撤回时返回 staleSource', async () => {
    const body = pageBody('AXI 限制', '正文 A。', [SRC_REF_1]);
    const csId = await stageAndAccept('wiki/concepts/axi.md', body);
    await publishChangeSet(kbPath, { kbId: KB_ID, changeSetId: csId, now: '2026-09-13T10:00:00Z' });

    // 撤回来源：从 manifest 中删除来源记录
    const manifest = await readWikiManifest(kbPath);
    if (!manifest.ok) throw new Error('manifest');
    const updatedManifest: WikiKbManifest = {
      ...manifest.manifest,
      sources: {},
    };
    await writeWikiManifest(kbPath, updatedManifest);

    const history = await readPageHistory(kbPath, 'concepts/axi');
    if (!history.ok) throw new Error('history');
    const entry = history.entries[0]!;

    const result = await createRollbackProposal(kbPath, {
      kbId: KB_ID,
      pageId: 'concepts/axi',
      targetCommitId: entry.commitId,
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe('staleSource');
  });
});

// ── 手动写历史条目测试 ─────────────────────────────────────────

describe('readPageHistory — 手动写入历史条目', () => {
  it('能读取手动写入的页面历史条目', async () => {
    const entry: WikiPageHistoryEntry = {
      commitId: 'test-commit-1',
      changeSetId: 'test-cs-1',
      pageId: 'concepts/axi',
      relPath: 'wiki/concepts/axi.md',
      operation: 'create',
      beforeHash: null,
      afterHash: sha('test content'),
      sources: [SRC_REF_1],
      at: '2026-09-13T10:00:00Z',
    };

    const historyFile = historyFilePath(kbPath, 'concepts/axi');
    const content = appendHistoryEntryIdempotent(null, entry);
    writeFileSync(historyFile, content, 'utf-8');

    const history = await readPageHistory(kbPath, 'concepts/axi');
    expect(history.ok).toBe(true);
    if (!history.ok) return;
    expect(history.entries).toHaveLength(1);
    expect(history.entries[0]!.commitId).toBe('test-commit-1');
    expect(history.entries[0]!.operation).toBe('create');
  });

  it('损坏的历史行被跳过，不静默清空', async () => {
    const entry: WikiPageHistoryEntry = {
      commitId: 'test-commit-2',
      changeSetId: 'test-cs-2',
      pageId: 'concepts/axi',
      relPath: 'wiki/concepts/axi.md',
      operation: 'update',
      beforeHash: sha('before'),
      afterHash: sha('after'),
      sources: [SRC_REF_1],
      at: '2026-09-13T11:00:00Z',
    };

    const historyFile = historyFilePath(kbPath, 'concepts/axi');
    // 写入一行坏 JSON + 一行正常 JSON
    const badLine = 'not valid json\n';
    const goodLine = JSON.stringify(entry) + '\n';
    writeFileSync(historyFile, badLine + goodLine, 'utf-8');

    const history = await readPageHistory(kbPath, 'concepts/axi');
    expect(history.ok).toBe(true);
    if (!history.ok) return;
    expect(history.entries).toHaveLength(1); // 坏行被跳过
    expect(history.entries[0]!.commitId).toBe('test-commit-2');
  });
});
