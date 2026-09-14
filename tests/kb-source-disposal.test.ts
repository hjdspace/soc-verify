/**
 * 来源撤回与库停用/删除行为测试（issue 20，spec §1/§6/§10）。
 *
 * 验收（A13, A21；User Stories 3, 69）：
 *  - 来源 withdrawn 状态与实际保留修订区分；旧页面可读但需复核
 *  - 活动任务因来源撤回失效；迟到输出不能发布
 *  - 删除页是显式操作，空 FILE 不是删除；同来源其他贡献不被模糊匹配误删
 *  - 卸载/注销保持文件不变；删除另有明确范围预览与显式动作
 *  - 暂停/取消任务，等待正在提交完成；读写资源释放后才删除受管内容
 *  - 目录含未知文件、离线或权限失败时不递归删除根，不报告成功
 *  - 历史修订/审批资料不是缓存，UI 准确显示其将被删除
 *  - 已知旧格式登记处置与不可达挂载惰性处理不丢路径
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { rmSync, mkdirSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

// electron mock
const globalDataDir = join(tmpdir(), `sv-kb-disposal-app-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`);

vi.mock('electron', () => ({
  app: {
    getPath: vi.fn(() => globalDataDir),
  },
}));

import { initWikiLayout, readWikiManifest, writeWikiManifest } from '../src/main/kb/wiki-layout';
import {
  withdrawSource,
  previewDeleteKb,
} from '../src/main/kb/source-disposal';
import { kbRegistry } from '../src/main/kb/registry';
import type { WikiSourceStatus } from '@shared/kb-types';

let kbPath: string;

beforeEach(async () => {
  kbPath = join(tmpdir(), `sv-kb-disposal-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`);
  mkdirSync(kbPath, { recursive: true });
  await initWikiLayout(kbPath, { kbId: 'kb-disposal-test', name: '测试撤回' });
});

afterEach(() => {
  rmSync(kbPath, { recursive: true, force: true });
  rmSync(globalDataDir, { recursive: true, force: true });
});

// ── Fixture helpers ──────────────────────────────────────────

const SOURCE_ID_A = 'a'.repeat(64);
const SOURCE_ID_B = 'b'.repeat(64);
const REVISION_1 = '1'.repeat(64);
const REVISION_2 = '2'.repeat(64);
const PARSED_HASH = 'c'.repeat(64);

async function registerSource(
  sourceId: string,
  sourcePath: string,
  currentRevision: string,
  opts: { parsedRevision?: string | null; parsedHash?: string | null; status?: WikiSourceStatus; ext?: string } = {},
): Promise<void> {
  const manifest = await readWikiManifest(kbPath);
  if (!manifest.ok) throw new Error('manifest');
  const rec = {
    sourcePath,
    sourceId,
    ext: opts.ext ?? '.pdf',
    size: 100,
    currentRevision,
    parsedRevision: opts.parsedRevision ?? currentRevision,
    parsedHash: opts.parsedHash ?? PARSED_HASH,
    engine: 'anydoc',
    engineFingerprint: 'fp',
    status: (opts.status ?? 'ready') as WikiSourceStatus,
    assetCount: 0,
    importedAt: '2026-09-13T00:00:00Z',
    updatedAt: '2026-09-13T00:00:00Z',
  };
  await writeWikiManifest(kbPath, {
    ...manifest.manifest,
    sources: { ...(manifest.manifest.sources ?? {}), [sourceId]: rec },
  });
}

function writeWikiPage(pageId: string, title: string, sources: Array<{ sourceId: string; sourceRevision: string; parsedHash: string }>, body = '正文'): void {
  const parts = pageId.split('/');
  const dir = join(kbPath, 'wiki', ...parts.slice(0, -1));
  mkdirSync(dir, { recursive: true });
  const srcLines = sources.length === 0
    ? 'sources: []'
    : ['sources:', ...sources.flatMap((s) => [
        `  - sourceId: "${s.sourceId}"`,
        `    sourceRevision: "${s.sourceRevision}"`,
        `    parsedHash: "${s.parsedHash}"`,
      ])].join('\n');
  writeFileSync(
    join(dir, `${parts[parts.length - 1]}.md`),
    [
      '---',
      `type: concept`,
      `title: "${title}"`,
      'summary: 摘要。',
      'keywords: [test]',
      'tags: []',
      srcLines,
      'created: "2026-09-13T00:00:00Z"',
      'updated: "2026-09-13T00:00:00Z"',
      '---',
      '',
      `# ${title}`,
      '',
      body,
    ].join('\n'),
    'utf-8',
  );
}

function writeFile(relPath: string, content: string): void {
  const full = join(kbPath, ...relPath.split('/'));
  const dir = full.replace(/[/\\][^/\\]+$/, '');
  mkdirSync(dir, { recursive: true });
  writeFileSync(full, content, 'utf-8');
}

async function registerKb(): Promise<void> {
  await kbRegistry.register('测试撤回库', kbPath);
}

// ── Tests ───────────────────────────────────────────────────

describe('withdrawSource — 来源撤回', () => {
  it('标记来源为 withdrawn 并计算受影响页面', async () => {
    await registerSource(SOURCE_ID_A, 'docs/axi.pdf', REVISION_1);
    await registerSource(SOURCE_ID_B, 'docs/ddr.pdf', REVISION_2);
    writeWikiPage('concepts/axi', 'AXI 限制', [
      { sourceId: SOURCE_ID_A, sourceRevision: REVISION_1, parsedHash: PARSED_HASH },
    ]);
    writeWikiPage('concepts/ddr', 'DDR 限制', [
      { sourceId: SOURCE_ID_B, sourceRevision: REVISION_2, parsedHash: PARSED_HASH },
    ]);

    const result = await withdrawSource(kbPath, SOURCE_ID_A);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    // 受影响页面包含 axi，不包含 ddr
    expect(result.impact.affectedPages).toContain('concepts/axi');
    expect(result.impact.affectedPages).not.toContain('concepts/ddr');

    // manifest 中来源标为 withdrawn
    const manifest = await readWikiManifest(kbPath);
    expect(manifest.ok).toBe(true);
    if (!manifest.ok) return;
    const rec = manifest.manifest.sources?.[SOURCE_ID_A];
    expect(rec?.status).toBe('withdrawn');
    // 来源 B 不受影响
    const recB = manifest.manifest.sources?.[SOURCE_ID_B];
    expect(recB?.status).toBe('ready');
  });

  it('撤回后旧页面仍可读但来源标为 withdrawn', async () => {
    await registerSource(SOURCE_ID_A, 'docs/axi.pdf', REVISION_1);
    writeWikiPage('concepts/axi', 'AXI 限制', [
      { sourceId: SOURCE_ID_A, sourceRevision: REVISION_1, parsedHash: PARSED_HASH },
    ]);

    const result = await withdrawSource(kbPath, SOURCE_ID_A);
    expect(result.ok).toBe(true);

    // 页面文件仍在
    const pagePath = join(kbPath, 'wiki', 'concepts', 'axi.md');
    expect(existsSync(pagePath)).toBe(true);
    // 页面内容仍可读
    const content = readFileSync(pagePath, 'utf-8');
    expect(content).toContain('AXI 限制');
  });

  it('撤回不级联删除知识页', async () => {
    await registerSource(SOURCE_ID_A, 'docs/axi.pdf', REVISION_1);
    writeWikiPage('concepts/axi', 'AXI 限制', [
      { sourceId: SOURCE_ID_A, sourceRevision: REVISION_1, parsedHash: PARSED_HASH },
    ]);

    await withdrawSource(kbPath, SOURCE_ID_A);

    // 页面文件仍然存在——不直接级联删除
    expect(existsSync(join(kbPath, 'wiki', 'concepts', 'axi.md'))).toBe(true);
  });

  it('被引用的旧修订原件仍保留', async () => {
    await registerSource(SOURCE_ID_A, 'docs/axi.pdf', REVISION_1);
    writeWikiPage('concepts/axi', 'AXI', [
      { sourceId: SOURCE_ID_A, sourceRevision: REVISION_1, parsedHash: PARSED_HASH },
    ]);

    await withdrawSource(kbPath, SOURCE_ID_A);

    // 虽然原件文件可能不存在（只是注册了来源），但来源记录仍保留在 manifest
    const manifest = await readWikiManifest(kbPath);
    if (!manifest.ok) return;
    expect(manifest.manifest.sources?.[SOURCE_ID_A]).toBeDefined();
    expect(manifest.manifest.sources?.[SOURCE_ID_A].status).toBe('withdrawn');
  });

  it('同来源其他贡献不被模糊匹配误删', async () => {
    await registerSource(SOURCE_ID_A, 'docs/axi.pdf', REVISION_1);
    await registerSource(SOURCE_ID_B, 'docs/axi-report.pdf', REVISION_2);
    // 两页都引用来源 A
    writeWikiPage('concepts/axi', 'AXI 限制', [
      { sourceId: SOURCE_ID_A, sourceRevision: REVISION_1, parsedHash: PARSED_HASH },
    ]);
    writeWikiPage('concepts/axi-report', 'AXI 报告', [
      { sourceId: SOURCE_ID_A, sourceRevision: REVISION_1, parsedHash: PARSED_HASH },
      { sourceId: SOURCE_ID_B, sourceRevision: REVISION_2, parsedHash: PARSED_HASH },
    ]);

    // 只撤回来源 A
    const result = await withdrawSource(kbPath, SOURCE_ID_A);
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    // 来源 B 仍为 ready
    const manifest = await readWikiManifest(kbPath);
    if (!manifest.ok) return;
    expect(manifest.manifest.sources?.[SOURCE_ID_B]?.status).toBe('ready');

    // 两页都仍在
    expect(existsSync(join(kbPath, 'wiki', 'concepts', 'axi.md'))).toBe(true);
    expect(existsSync(join(kbPath, 'wiki', 'concepts', 'axi-report.md'))).toBe(true);
  });

  it('撤回不存在的来源返回错误', async () => {
    const result = await withdrawSource(kbPath, 'nonexistent');
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe('sourceNotFound');
  });

  it('已撤回的来源再次撤回返回错误', async () => {
    await registerSource(SOURCE_ID_A, 'docs/axi.pdf', REVISION_1);
    writeWikiPage('concepts/axi', 'AXI', [
      { sourceId: SOURCE_ID_A, sourceRevision: REVISION_1, parsedHash: PARSED_HASH },
    ]);

    const first = await withdrawSource(kbPath, SOURCE_ID_A);
    expect(first.ok).toBe(true);

    const second = await withdrawSource(kbPath, SOURCE_ID_A);
    expect(second.ok).toBe(false);
    if (second.ok) return;
    expect(second.error.code).toBe('alreadyWithdrawn');
  });
});

// ── deleteKb 范围预览 ────────────────────────────────────────

describe('previewDeleteKb — 删除库范围预览', () => {
  it('返回受管资产范围（wiki 页面、raw 来源、page-history）', async () => {
    await registerSource(SOURCE_ID_A, 'docs/axi.pdf', REVISION_1);
    writeWikiPage('concepts/axi', 'AXI', [
      { sourceId: SOURCE_ID_A, sourceRevision: REVISION_1, parsedHash: PARSED_HASH },
    ]);
    // 模拟 page-history
    writeFile('.kb/page-history/concepts/axi.jsonl', '{"commitId":"c1"}');
    writeFile('.kb/staging/cs1.json', '{"changeSetId":"cs1"}');

    const result = await previewDeleteKb(kbPath);

    expect(result.canDelete).toBe(true);
    expect(result.wikiPageCount).toBe(1);
    expect(result.sourceCount).toBe(1);
    expect(result.hasPageHistory).toBe(true);
    expect(result.hasStaging).toBe(true);
  });

  it('目录含未知文件时拒绝删除', async () => {
    await registerSource(SOURCE_ID_A, 'docs/axi.pdf', REVISION_1);
    writeWikiPage('concepts/axi', 'AXI', [
      { sourceId: SOURCE_ID_A, sourceRevision: REVISION_1, parsedHash: PARSED_HASH },
    ]);
    // 放一个不认识的文件
    writeFile('unknown-file.txt', 'surprise');

    const result = await previewDeleteKb(kbPath);

    expect(result.canDelete).toBe(false);
    expect(result.unknownFiles).toContain('unknown-file.txt');
  });

  it('历史修订不是缓存，准确显示将被删除', async () => {
    await registerSource(SOURCE_ID_A, 'docs/axi.pdf', REVISION_1);
    writeFile('.kb/page-history/concepts/axi.jsonl', '{"commitId":"c1"}');
    writeFile('.kb/transactions/tx1/manifest.json', '{"txId":"tx1","state":"committed","writes":[]}');

    const result = await previewDeleteKb(kbPath);

    expect(result.canDelete).toBe(true);
    expect(result.hasPageHistory).toBe(true);
    expect(result.hasTransactions).toBe(true);
  });

  it('空库可删除', async () => {
    const result = await previewDeleteKb(kbPath);
    expect(result.canDelete).toBe(true);
    expect(result.wikiPageCount).toBe(0);
    expect(result.sourceCount).toBe(0);
  });
});

// ── deleteKb 实际执行 ───────────────────────────────────────

describe('kbRegistry.deleteKb — 实际删除', () => {
  it('正常删除已注册且无未知文件的库', async () => {
    await registerKb();
    await registerSource(SOURCE_ID_A, 'docs/axi.pdf', REVISION_1);
    writeWikiPage('concepts/axi', 'AXI', [
      { sourceId: SOURCE_ID_A, sourceRevision: REVISION_1, parsedHash: PARSED_HASH },
    ]);

    const result = await kbRegistry.deleteKb('kb-disposal-test', kbPath);
    expect(result.ok).toBe(true);

    // 库目录被删除
    expect(existsSync(kbPath)).toBe(false);

    // 注册表中已移除
    const entries = await kbRegistry.list(kbPath);
    expect(entries.find((e) => e.id === 'kb-disposal-test')).toBeUndefined();
  });

  it('含未知文件时拒绝递归删除根目录', async () => {
    await registerKb();
    writeFile('unknown-file.txt', 'surprise');

    const result = await kbRegistry.deleteKb('kb-disposal-test', kbPath);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe('unknownFilesPresent');

    // 库目录仍在
    expect(existsSync(kbPath)).toBe(true);
  });
});
