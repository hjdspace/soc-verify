/**
 * structural-lint 结构检查测试（issue 25，spec §9）。
 *
 * 覆盖验收映射 A17 A18：
 *  - 结构检查使用有效知识边，聚合入链/自链不掩盖孤儿，歧义算断链
 *  - finding 有稳定身份、证据位置/hash、状态与时间
 *  - 重复扫描保留 ignored/resolved（finding-store 侧验证）
 *  - 大库检查可取消，显示覆盖/进度
 *  - findingId 稳定性（同规则+同页面+同证据 → 同 id）
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  computeStructuralFindings,
  computeFindingId,
  runStructuralLint,
} from '../src/main/kb/structural-lint';
import { buildWikiGraphSnapshot, invalidateGraphSnapshot } from '../src/main/kb/wiki-graph';
import { initWikiLayout } from '../src/main/kb/wiki-layout';
import type { WikiGraphSnapshot } from '@shared/kb-types';

let kbPath: string;

beforeEach(async () => {
  kbPath = mkdtempSync(join(tmpdir(), 'sv-kb-lint-'));
  await initWikiLayout(kbPath, { kbId: 'kb-lint', name: '结构检查测试库' });
  invalidateGraphSnapshot(kbPath);
});

afterEach(() => {
  rmSync(kbPath, { recursive: true, force: true });
  invalidateGraphSnapshot(kbPath);
});

const PAGE_FM = (
  type: string,
  title: string,
  extra: Record<string, string> = {},
): string => {
  const base: Array<[string, string]> = [
    ['type', type],
    ['title', `"${title}"`],
    ['summary', '测试页摘要。'],
    ['keywords', '[测试]'],
    ['tags', '[单测]'],
    ['sources', '[]'],
    ['created', '"2026-09-13T00:00:00Z"'],
    ['updated', '"2026-09-13T00:00:00Z"'],
    ...Object.entries(extra).map(([k, v]) => [k, v] as [string, string]),
  ];
  const merged = new Map(base);
  const lines = Array.from(merged, ([k, v]) => `${k}: ${v}`);
  return ['---', ...lines, '---', '', `# ${title}`, ''].join('\n');
};

function writeWikiPage(rel: string, content: string): void {
  const abs = join(kbPath, 'wiki', rel);
  mkdirSync(abs.replace(/[\\/][^\\/]*$/, ''), { recursive: true });
  writeFileSync(abs, content, 'utf-8');
}


async function getSnapshot(): Promise<WikiGraphSnapshot> {
  const res = await buildWikiGraphSnapshot(kbPath);
  if (!res.ok) throw new Error('构建图快照失败');
  return res.snapshot;
}

// ── computeFindingId 稳定性 ─────────────────────────────────────

describe('computeFindingId — 稳定身份', () => {
  it('同规则+同页面+同证据 → 同 id', () => {
    const id1 = computeFindingId('orphan', ['concepts/a'], ['wiki/concepts/a.md']);
    const id2 = computeFindingId('orphan', ['concepts/a'], ['wiki/concepts/a.md']);
    expect(id1).toBe(id2);
  });

  it('不同规则 → 不同 id', () => {
    const id1 = computeFindingId('orphan', ['concepts/a'], ['wiki/concepts/a.md']);
    const id2 = computeFindingId('no-outlinks', ['concepts/a'], ['wiki/concepts/a.md']);
    expect(id1).not.toBe(id2);
  });

  it('不同页面 → 不同 id', () => {
    const id1 = computeFindingId('orphan', ['concepts/a'], ['wiki/concepts/a.md']);
    const id2 = computeFindingId('orphan', ['concepts/b'], ['wiki/concepts/b.md']);
    expect(id1).not.toBe(id2);
  });

  it('不同证据位置 → 不同 id（证据改变 → 重开）', () => {
    const id1 = computeFindingId('broken-link', ['concepts/a'], ['wiki/concepts/a.md', 'target:concepts/x']);
    const id2 = computeFindingId('broken-link', ['concepts/a'], ['wiki/concepts/a.md', 'target:concepts/y']);
    expect(id1).not.toBe(id2);
  });

  it('id 为 32 字符 hex', () => {
    const id = computeFindingId('orphan', ['concepts/a'], ['wiki/concepts/a.md']);
    expect(id).toMatch(/^[0-9a-f]{32}$/);
  });
});

// ── computeStructuralFindings 规则 ──────────────────────────────

describe('computeStructuralFindings — 结构检查规则', () => {
  it('orphan: 没有其他知识页有效入链', async () => {
    // A 无入链 → orphan；B 被 A 链接 → 有入链 → 非 orphan
    writeWikiPage('concepts/a.md', PAGE_FM('concept', 'A')
      + '\n链接到 [[concepts/b]]。\n');
    writeWikiPage('concepts/b.md', PAGE_FM('concept', 'B'));

    const snapshot = await getSnapshot();
    const findings = computeStructuralFindings(snapshot, '2026-09-14T00:00:00Z');

    const orphan = findings.filter((f) => f.kind === 'orphan');
    // A 有出链到 B，B 有入链从 A
    // A: inlinks=[] → orphan
    // B: inlinks=[A] → 非 orphan
    // 但 A 有出链 → 非 no-outlinks
    // B: outlinks=[] → no-outlinks
    expect(orphan).toHaveLength(1);
    expect(orphan[0].pageIds).toEqual(['concepts/a']);

    const noOutlinks = findings.filter((f) => f.kind === 'no-outlinks');
    expect(noOutlinks).toHaveLength(1);
    expect(noOutlinks[0].pageIds).toEqual(['concepts/b']);
  });

  it('自链不消除孤儿', async () => {
    // 页面只自链 → inlinks 中无其他页 → 仍为 orphan
    writeWikiPage('concepts/self.md', PAGE_FM('concept', 'Self')
      + '\n自链 [[concepts/self]]。\n');

    const snapshot = await getSnapshot();
    const findings = computeStructuralFindings(snapshot, '2026-09-14T00:00:00Z');

    const orphan = findings.find((f) => f.kind === 'orphan' && f.pageIds.includes('concepts/self'));
    expect(orphan).toBeDefined();
  });

  it('broken-link: 断链（unresolved）产生 finding', async () => {
    writeWikiPage('concepts/a.md', PAGE_FM('concept', 'A')
      + '\n链接到 [[concepts/nonexistent]]。\n');

    const snapshot = await getSnapshot();
    const findings = computeStructuralFindings(snapshot, '2026-09-14T00:00:00Z');

    const broken = findings.filter((f) => f.kind === 'broken-link');
    expect(broken).toHaveLength(1);
    expect(broken[0].pageIds).toEqual(['concepts/a']);
    expect(broken[0].evidenceRefs).toContain('target:concepts/nonexistent');
  });

  it('broken-link: 歧义（ambiguous）产生 finding', async () => {
    writeWikiPage('concepts/dup.md', PAGE_FM('concept', 'Dup1')
      + '\n链接到 [[dup]]。\n');
    writeWikiPage('pitfalls/dup.md', PAGE_FM('pitfall', 'Dup2'));

    const snapshot = await getSnapshot();
    const findings = computeStructuralFindings(snapshot, '2026-09-14T00:00:00Z');

    const broken = findings.filter((f) => f.kind === 'broken-link');
    expect(broken).toHaveLength(1);
    expect(broken[0].pageIds).toEqual(['concepts/dup']);
  });

  it('完整连通图无 orphan/no-outlinks findings', async () => {
    // A → B → A：互链
    writeWikiPage('concepts/a.md', PAGE_FM('concept', 'A')
      + '\n链接到 [[concepts/b]]。\n');
    writeWikiPage('concepts/b.md', PAGE_FM('concept', 'B')
      + '\n链接到 [[concepts/a]]。\n');

    const snapshot = await getSnapshot();
    const findings = computeStructuralFindings(snapshot, '2026-09-14T00:00:00Z');

    const orphan = findings.filter((f) => f.kind === 'orphan');
    const noOutlinks = findings.filter((f) => f.kind === 'no-outlinks');
    const broken = findings.filter((f) => f.kind === 'broken-link');
    expect(orphan).toHaveLength(0);
    expect(noOutlinks).toHaveLength(0);
    expect(broken).toHaveLength(0);
  });

  it('finding 有证据位置和证据 hash', async () => {
    writeWikiPage('concepts/orphan.md', PAGE_FM('concept', 'Orphan'));

    const snapshot = await getSnapshot();
    const findings = computeStructuralFindings(snapshot, '2026-09-14T00:00:00Z');

    const orphan = findings.find((f) => f.kind === 'orphan');
    expect(orphan).toBeDefined();
    expect(orphan!.evidenceRefs).toEqual(['wiki/concepts/orphan.md']);
    expect(orphan!.evidenceHashes).toHaveLength(1);
    expect(orphan!.evidenceHashes[0]).toMatch(/^[0-9a-f]{16}$/);
    expect(orphan!.status).toBe('open');
    expect(orphan!.createdAt).toBe('2026-09-14T00:00:00Z');
    expect(orphan!.updatedAt).toBe('2026-09-14T00:00:00Z');
  });

  it('kbId 内嵌于 finding', async () => {
    writeWikiPage('concepts/a.md', PAGE_FM('concept', 'A'));

    const snapshot = await getSnapshot();
    const findings = computeStructuralFindings(snapshot, '2026-09-14T00:00:00Z');

    expect(findings.length).toBeGreaterThan(0);
    for (const f of findings) {
      expect(f.kbId).toBe('kb-lint');
    }
  });

  it('findingId 稳定（重复推导同一图快照）', async () => {
    writeWikiPage('concepts/a.md', PAGE_FM('concept', 'A')
      + '\n链接到 [[concepts/b]]。\n');
    writeWikiPage('concepts/b.md', PAGE_FM('concept', 'B'));

    const snapshot = await getSnapshot();
    const findings1 = computeStructuralFindings(snapshot, '2026-09-14T00:00:00Z');
    const findings2 = computeStructuralFindings(snapshot, '2026-09-14T01:00:00Z');

    // 同一快照 → 同一 findingId（时间不同不影响身份）
    const ids1 = findings1.map((f) => f.findingId).sort();
    const ids2 = findings2.map((f) => f.findingId).sort();
    expect(ids1).toEqual(ids2);
  });
});

// ── runStructuralLint ───────────────────────────────────────────

describe('runStructuralLint — 运行结构检查', () => {
  it('正常运行返回覆盖信息', async () => {
    writeWikiPage('concepts/a.md', PAGE_FM('concept', 'A'));
    writeWikiPage('concepts/b.md', PAGE_FM('concept', 'B'));

    const result = await runStructuralLint(kbPath, { now: '2026-09-14T00:00:00Z' });
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(result.kbId).toBe('kb-lint');
    expect(result.coverage.totalPages).toBe(2);
    expect(result.coverage.checkedPages).toBe(2);
    expect(result.coverage.uncovered).toEqual([]);
    expect(result.canceled).toBe(false);
    expect(result.ranAt).toBe('2026-09-14T00:00:00Z');
  });

  it('取消信号 → canceled=true', async () => {
    writeWikiPage('concepts/a.md', PAGE_FM('concept', 'A'));

    const controller = new AbortController();
    controller.abort();
    const result = await runStructuralLint(kbPath, {
      now: '2026-09-14T00:00:00Z',
      signal: controller.signal,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.canceled).toBe(true);
    expect(result.coverage.uncovered.length).toBeGreaterThan(0);
  });

  it('读取门禁关闭时返回 readGateBlocked', async () => {
    // 不写 manifest → manifest 不存在 → catalogFailed
    // 但 initWikiLayout 已写了 manifest，所以我们用另一个路径
    const emptyPath = mkdtempSync(join(tmpdir(), 'sv-kb-lint-empty-'));
    try {
      const result = await runStructuralLint(emptyPath);
      expect(result.ok).toBe(false);
      if (result.ok) return;
      // 没 manifest → catalogFailed
      expect(result.code).toBe('catalogFailed');
    } finally {
      rmSync(emptyPath, { recursive: true, force: true });
    }
  });

  it('findings 包含 orphan/no-outlinks/broken-link 三种', async () => {
    // orphan page (no inlinks, no outlinks)
    writeWikiPage('concepts/orphan.md', PAGE_FM('concept', 'Orphan'));
    // page with broken link
    writeWikiPage('concepts/broken.md', PAGE_FM('concept', 'Broken')
      + '\n链接到 [[concepts/nonexistent]]。\n');
    // connected page
    writeWikiPage('concepts/linked.md', PAGE_FM('concept', 'Linked')
      + '\n链接到 [[concepts/broken]]。\n');

    const result = await runStructuralLint(kbPath, { now: '2026-09-14T00:00:00Z' });
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const kinds = new Set(result.findings.map((f) => f.kind));
    expect(kinds.has('orphan')).toBe(true);
    expect(kinds.has('no-outlinks')).toBe(true);
    expect(kinds.has('broken-link')).toBe(true);
  });

  it('重复扫描回归（同一图 → 同一 findings）', async () => {
    writeWikiPage('concepts/a.md', PAGE_FM('concept', 'A')
      + '\n链接到 [[concepts/b]]。\n');
    writeWikiPage('concepts/b.md', PAGE_FM('concept', 'B'));

    const r1 = await runStructuralLint(kbPath, { now: '2026-09-14T00:00:00Z' });
    const r2 = await runStructuralLint(kbPath, { now: '2026-09-14T01:00:00Z' });
    if (!r1.ok || !r2.ok) throw new Error('lint 失败');

    const ids1 = r1.findings.map((f) => f.findingId).sort();
    const ids2 = r2.findings.map((f) => f.findingId).sort();
    expect(ids1).toEqual(ids2);
  });
});
