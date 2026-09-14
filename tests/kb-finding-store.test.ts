/**
 * finding-store 知识待办持久化与状态管理测试（issue 25，spec §9）。
 *
 * 覆盖验收映射 A17 A18：
 *  - finding 有稳定身份、证据位置/hash、状态与时间
 *  - 重复扫描保留 ignored/resolved
 *  - 证据变化可重开
 *  - 不同库不混用状态
 *  - 更新动作：ignore/unignore/resolve/reopen
 *  - 列表查询过滤
 *  - 坏 JSON 保留损坏副本
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  mergeFindings,
  readFindings,
  listFindings,
  updateFindingStatus,
} from '../src/main/kb/finding-store';
import { computeFindingId } from '../src/main/kb/structural-lint';
import { initWikiLayout } from '../src/main/kb/wiki-layout';
import type { WikiStructuralFinding } from '@shared/kb-types';

let kbPath: string;

beforeEach(async () => {
  kbPath = mkdtempSync(join(tmpdir(), 'sv-kb-findings-'));
  await initWikiLayout(kbPath, { kbId: 'kb-findings', name: '待办测试库' });
});

afterEach(() => {
  rmSync(kbPath, { recursive: true, force: true });
});

// ── 辅助 ────────────────────────────────────────────────────────

function makeFinding(
  overrides: Partial<WikiStructuralFinding> = {},
): WikiStructuralFinding {
  const kind = overrides.kind ?? 'orphan';
  const pageIds = overrides.pageIds ?? ['concepts/a'];
  const evidenceRefs = overrides.evidenceRefs ?? ['wiki/concepts/a.md'];
  return {
    findingId: overrides.findingId ?? computeFindingId(kind, pageIds, evidenceRefs),
    kbId: overrides.kbId ?? 'kb-findings',
    kind,
    pageIds,
    evidenceRefs,
    evidenceHashes: overrides.evidenceHashes ?? ['abcdef0123456789'],
    status: overrides.status ?? 'open',
    createdAt: overrides.createdAt ?? '2026-09-14T00:00:00Z',
    updatedAt: overrides.updatedAt ?? '2026-09-14T00:00:00Z',
  };
}

function findingsFile(): string {
  return join(kbPath, '.kb', 'findings', 'findings.json');
}

// ── readFindings ────────────────────────────────────────────────

describe('readFindings — 读取', () => {
  it('文件不存在时返回空数组', async () => {
    const result = await readFindings(kbPath);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.findings).toEqual([]);
  });

  it('读取已持久化的 findings', async () => {
    const finding = makeFinding();
    await mergeFindings(kbPath, [finding], '2026-09-14T00:00:00Z');

    const result = await readFindings(kbPath);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.findings).toHaveLength(1);
    expect(result.findings[0].findingId).toBe(finding.findingId);
  });

  it('坏 JSON 保留损坏副本', async () => {
    // 先写一个合法的 findings 文件
    const finding = makeFinding();
    await mergeFindings(kbPath, [finding], '2026-09-14T00:00:00Z');

    // 覆写为坏 JSON
    writeFileSync(findingsFile(), '{ broken json', 'utf-8');

    const result = await readFindings(kbPath);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.code).toBe('ioError');

    // 损坏副本存在
    const backupPath = join(kbPath, '.kb', 'findings', 'findings.corrupt.json');
    expect(existsSync(backupPath)).toBe(true);
  });
});

// ── mergeFindings ───────────────────────────────────────────────

describe('mergeFindings — 合并扫描结果', () => {
  it('首次扫描 → 全部 status=open', async () => {
    const f1 = makeFinding({ pageIds: ['concepts/a'], kind: 'orphan' });
    const f2 = makeFinding({ pageIds: ['concepts/b'], kind: 'no-outlinks' });

    const merged = await mergeFindings(kbPath, [f1, f2], '2026-09-14T00:00:00Z');
    expect(merged).toHaveLength(2);
    expect(merged.every((f) => f.status === 'open')).toBe(true);
  });

  it('重复扫描保留 ignored 状态', async () => {
    const f1 = makeFinding({ pageIds: ['concepts/a'], kind: 'orphan' });

    // 首次扫描
    await mergeFindings(kbPath, [f1], '2026-09-14T00:00:00Z');

    // 忽略
    await updateFindingStatus(kbPath, f1.findingId, 'ignore', '2026-09-14T01:00:00Z');

    // 重新扫描（同样的 evidenceHashes）
    const merged = await mergeFindings(kbPath, [f1], '2026-09-14T02:00:00Z');
    const found = merged.find((f) => f.findingId === f1.findingId);
    expect(found).toBeDefined();
    expect(found!.status).toBe('ignored');
    // createdAt 保留首次时间
    expect(found!.createdAt).toBe('2026-09-14T00:00:00Z');
  });

  it('重复扫描保留 resolved 状态', async () => {
    const f1 = makeFinding({ pageIds: ['concepts/a'], kind: 'orphan' });

    await mergeFindings(kbPath, [f1], '2026-09-14T00:00:00Z');
    await updateFindingStatus(kbPath, f1.findingId, 'resolve', '2026-09-14T01:00:00Z');

    const merged = await mergeFindings(kbPath, [f1], '2026-09-14T02:00:00Z');
    const found = merged.find((f) => f.findingId === f1.findingId);
    expect(found!.status).toBe('resolved');
  });

  it('证据变化 → 重开为 open', async () => {
    const f1 = makeFinding({
      pageIds: ['concepts/a'],
      kind: 'orphan',
      evidenceHashes: ['hash-v1'],
    });

    // 首次扫描 + 忽略
    await mergeFindings(kbPath, [f1], '2026-09-14T00:00:00Z');
    await updateFindingStatus(kbPath, f1.findingId, 'ignore', '2026-09-14T01:00:00Z');

    // 重新扫描，证据 hash 变了
    const f1Updated = makeFinding({
      pageIds: ['concepts/a'],
      kind: 'orphan',
      evidenceHashes: ['hash-v2'],
    });
    const merged = await mergeFindings(kbPath, [f1Updated], '2026-09-14T02:00:00Z');
    const found = merged.find((f) => f.findingId === f1.findingId);
    expect(found).toBeDefined();
    // 证据改变 → 重开
    expect(found!.status).toBe('open');
    // createdAt 保留首次时间
    expect(found!.createdAt).toBe('2026-09-14T00:00:00Z');
    // updatedAt 更新
    expect(found!.updatedAt).toBe('2026-09-14T02:00:00Z');
  });

  it('已有但未扫描到的 finding 保留', async () => {
    const f1 = makeFinding({ pageIds: ['concepts/a'], kind: 'orphan' });
    const f2 = makeFinding({ pageIds: ['concepts/b'], kind: 'orphan' });

    // 首次扫描两个
    await mergeFindings(kbPath, [f1, f2], '2026-09-14T00:00:00Z');

    // 第二次只扫描到 f1
    const merged = await mergeFindings(kbPath, [f1], '2026-09-14T01:00:00Z');
    // f2 仍保留
    expect(merged).toHaveLength(2);
    expect(merged.some((f) => f.findingId === f2.findingId)).toBe(true);
  });

  it('新 finding 在重复扫描中追加', async () => {
    const f1 = makeFinding({ pageIds: ['concepts/a'], kind: 'orphan' });
    await mergeFindings(kbPath, [f1], '2026-09-14T00:00:00Z');

    const f2 = makeFinding({ pageIds: ['concepts/b'], kind: 'orphan' });
    const merged = await mergeFindings(kbPath, [f1, f2], '2026-09-14T01:00:00Z');
    expect(merged).toHaveLength(2);
  });
});

// ── updateFindingStatus ─────────────────────────────────────────

describe('updateFindingStatus — 更新状态', () => {
  it('ignore → status=ignored', async () => {
    const f = makeFinding();
    await mergeFindings(kbPath, [f], '2026-09-14T00:00:00Z');

    const result = await updateFindingStatus(kbPath, f.findingId, 'ignore', '2026-09-14T01:00:00Z');
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.finding.status).toBe('ignored');
    expect(result.finding.updatedAt).toBe('2026-09-14T01:00:00Z');
  });

  it('resolve → status=resolved', async () => {
    const f = makeFinding();
    await mergeFindings(kbPath, [f], '2026-09-14T00:00:00Z');

    const result = await updateFindingStatus(kbPath, f.findingId, 'resolve', '2026-09-14T01:00:00Z');
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.finding.status).toBe('resolved');
  });

  it('unignore → status=open', async () => {
    const f = makeFinding();
    await mergeFindings(kbPath, [f], '2026-09-14T00:00:00Z');
    await updateFindingStatus(kbPath, f.findingId, 'ignore', '2026-09-14T01:00:00Z');

    const result = await updateFindingStatus(kbPath, f.findingId, 'unignore', '2026-09-14T02:00:00Z');
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.finding.status).toBe('open');
  });

  it('reopen → status=open', async () => {
    const f = makeFinding();
    await mergeFindings(kbPath, [f], '2026-09-14T00:00:00Z');
    await updateFindingStatus(kbPath, f.findingId, 'resolve', '2026-09-14T01:00:00Z');

    const result = await updateFindingStatus(kbPath, f.findingId, 'reopen', '2026-09-14T02:00:00Z');
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.finding.status).toBe('open');
  });

  it('不存在的 finding → findingNotFound', async () => {
    const result = await updateFindingStatus(kbPath, 'nonexistent-id', 'ignore');
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.code).toBe('findingNotFound');
  });

  it('更新持久化到磁盘', async () => {
    const f = makeFinding();
    await mergeFindings(kbPath, [f], '2026-09-14T00:00:00Z');
    await updateFindingStatus(kbPath, f.findingId, 'ignore', '2026-09-14T01:00:00Z');

    // 重新读取
    const result = await readFindings(kbPath);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const stored = result.findings.find((x) => x.findingId === f.findingId);
    expect(stored).toBeDefined();
    expect(stored!.status).toBe('ignored');
  });
});

// ── listFindings ────────────────────────────────────────────────

describe('listFindings — 列表查询过滤', () => {
  beforeEach(async () => {
    const f1 = makeFinding({ pageIds: ['concepts/a'], kind: 'orphan' });
    const f2 = makeFinding({ pageIds: ['concepts/b'], kind: 'no-outlinks' });
    const f3 = makeFinding({
      pageIds: ['concepts/c'],
      kind: 'broken-link',
      evidenceRefs: ['wiki/concepts/c.md', 'target:concepts/x'],
    });
    await mergeFindings(kbPath, [f1, f2, f3], '2026-09-14T00:00:00Z');

    // f1 → ignored, f2 → resolved, f3 stays open
    await updateFindingStatus(kbPath, f1.findingId, 'ignore', '2026-09-14T01:00:00Z');
    await updateFindingStatus(kbPath, f2.findingId, 'resolve', '2026-09-14T01:00:00Z');
  });

  it('无过滤 → 返回全部', async () => {
    const result = await listFindings(kbPath);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.findings).toHaveLength(3);
  });

  it('按状态过滤', async () => {
    const result = await listFindings(kbPath, { status: 'open' });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.findings).toHaveLength(1);
    expect(result.findings[0].kind).toBe('broken-link');
  });

  it('按 ignored 过滤', async () => {
    const result = await listFindings(kbPath, { status: 'ignored' });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.findings).toHaveLength(1);
    expect(result.findings[0].kind).toBe('orphan');
  });

  it('按 resolved 过滤', async () => {
    const result = await listFindings(kbPath, { status: 'resolved' });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.findings).toHaveLength(1);
    expect(result.findings[0].kind).toBe('no-outlinks');
  });

  it('按 kind 过滤', async () => {
    const result = await listFindings(kbPath, { kind: 'orphan' });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.findings).toHaveLength(1);
  });

  it('组合过滤', async () => {
    const result = await listFindings(kbPath, { status: 'open', kind: 'broken-link' });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.findings).toHaveLength(1);
  });
});

// ── 跨库隔离 ────────────────────────────────────────────────────

describe('跨库隔离', () => {
  it('不同库的 findings 不混用', async () => {
    const kbPath2 = mkdtempSync(join(tmpdir(), 'sv-kb-findings2-'));
    try {
      await initWikiLayout(kbPath2, { kbId: 'kb-other', name: '另一个库' });

      const f1 = makeFinding({
        pageIds: ['concepts/a'],
        kind: 'orphan',
        kbId: 'kb-findings',
      });
      const f2 = makeFinding({
        pageIds: ['concepts/a'],
        kind: 'orphan',
        kbId: 'kb-other',
      });

      await mergeFindings(kbPath, [f1], '2026-09-14T00:00:00Z');
      await mergeFindings(kbPath2, [f2], '2026-09-14T00:00:00Z');

      // 在 kb1 中忽略 f1
      await updateFindingStatus(kbPath, f1.findingId, 'ignore', '2026-09-14T01:00:00Z');

      // kb2 中 f2 仍为 open
      const result2 = await readFindings(kbPath2);
      expect(result2.ok).toBe(true);
      if (!result2.ok) return;
      const stored2 = result2.findings.find((x) => x.findingId === f2.findingId);
      expect(stored2).toBeDefined();
      expect(stored2!.status).toBe('open');

      // kb1 中 f1 为 ignored
      const result1 = await readFindings(kbPath);
      expect(result1.ok).toBe(true);
      if (!result1.ok) return;
      const stored1 = result1.findings.find((x) => x.findingId === f1.findingId);
      expect(stored1).toBeDefined();
      expect(stored1!.status).toBe('ignored');
    } finally {
      rmSync(kbPath2, { recursive: true, force: true });
    }
  });
});

// ── 重复扫描回归 ─────────────────────────────────────────────────

describe('重复扫描回归', () => {
  it('多次扫描+忽略+重扫 → 状态一致', async () => {
    const f = makeFinding({ pageIds: ['concepts/a'], kind: 'orphan' });

    // 扫描 1
    await mergeFindings(kbPath, [f], '2026-09-14T00:00:00Z');
    expect(f.status).toBe('open');

    // 忽略
    await updateFindingStatus(kbPath, f.findingId, 'ignore', '2026-09-14T01:00:00Z');

    // 扫描 2 — 同证据 → 保留 ignored
    let merged = await mergeFindings(kbPath, [f], '2026-09-14T02:00:00Z');
    let found = merged.find((x) => x.findingId === f.findingId);
    expect(found!.status).toBe('ignored');

    // 扫描 3 — 同证据 → 仍保留 ignored
    merged = await mergeFindings(kbPath, [f], '2026-09-14T03:00:00Z');
    found = merged.find((x) => x.findingId === f.findingId);
    expect(found!.status).toBe('ignored');
  });
});

// ── 图洞察 finding 持久化（issue 26）─────────────────────────────

describe('graph insight findings — 图洞察持久化', () => {
  it('bridge-node finding 可持久化与读取', async () => {
    const f = makeFinding({
      kind: 'bridge-node' as never,
      pageIds: ['concepts/bridge'],
      evidenceRefs: ['wiki/concepts/bridge.md', 'revision:1', 'communities:0,1'],
      evidenceHashes: ['bridgehash00123456'],
    });

    await mergeFindings(kbPath, [f], '2026-09-14T00:00:00Z');

    const result = await listFindings(kbPath);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.findings).toHaveLength(1);
    expect(result.findings[0].kind).toBe('bridge-node');
  });

  it('sparse-community finding 可持久化与读取', async () => {
    const f = makeFinding({
      kind: 'sparse-community' as never,
      pageIds: ['concepts/a', 'concepts/b'],
      evidenceRefs: ['community:0', 'revision:1', 'members:concepts/a,concepts/b'],
      evidenceHashes: ['sparsehash0001234567'],
    });

    await mergeFindings(kbPath, [f], '2026-09-14T00:00:00Z');

    const result = await listFindings(kbPath);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.findings).toHaveLength(1);
    expect(result.findings[0].kind).toBe('sparse-community');
  });

  it('图洞察 finding 与结构 finding 共存', async () => {
    const orphan = makeFinding({ kind: 'orphan', pageIds: ['concepts/a'] });
    const bridge = makeFinding({
      kind: 'bridge-node' as never,
      pageIds: ['concepts/b'],
      evidenceRefs: ['wiki/concepts/b.md', 'revision:1', 'communities:0,1'],
      evidenceHashes: ['bridgehash00123456'],
    });
    const sparse = makeFinding({
      kind: 'sparse-community' as never,
      pageIds: ['concepts/c'],
      evidenceRefs: ['community:1', 'revision:1', 'members:concepts/c'],
      evidenceHashes: ['sparsehash0001234567'],
    });

    await mergeFindings(kbPath, [orphan, bridge, sparse], '2026-09-14T00:00:00Z');

    const result = await listFindings(kbPath);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.findings).toHaveLength(3);
    const kinds = result.findings.map((f) => f.kind).sort();
    expect(kinds).toEqual(['bridge-node', 'orphan', 'sparse-community']);
  });

  it('图洞察 finding 重复刷新保留 ignored 状态', async () => {
    const f = makeFinding({
      kind: 'bridge-node' as never,
      pageIds: ['concepts/bridge'],
      evidenceRefs: ['wiki/concepts/bridge.md', 'revision:1', 'communities:0,1'],
      evidenceHashes: ['bridgehash00123456'],
    });

    await mergeFindings(kbPath, [f], '2026-09-14T00:00:00Z');
    await updateFindingStatus(kbPath, f.findingId, 'ignore', '2026-09-14T01:00:00Z');

    const merged = await mergeFindings(kbPath, [f], '2026-09-14T02:00:00Z');
    const found = merged.find((x) => x.findingId === f.findingId);
    expect(found!.status).toBe('ignored');
  });

  it('图洞察 finding 证据变化可重开', async () => {
    const f = makeFinding({
      kind: 'bridge-node' as never,
      pageIds: ['concepts/bridge'],
      evidenceRefs: ['wiki/concepts/bridge.md', 'revision:1', 'communities:0,1'],
      evidenceHashes: ['hash-v1'],
    });

    await mergeFindings(kbPath, [f], '2026-09-14T00:00:00Z');
    await updateFindingStatus(kbPath, f.findingId, 'resolve', '2026-09-14T01:00:00Z');

    // 证据变化
    const f2 = { ...f, evidenceHashes: ['hash-v2'] };
    const merged = await mergeFindings(kbPath, [f2], '2026-09-14T02:00:00Z');
    const found = merged.find((x) => x.findingId === f2.findingId);
    expect(found!.status).toBe('open');
  });

  it('按 kind 过滤图洞察 finding', async () => {
    const orphan = makeFinding({ kind: 'orphan', pageIds: ['concepts/a'] });
    const bridge = makeFinding({
      kind: 'bridge-node' as never,
      pageIds: ['concepts/b'],
      evidenceRefs: ['wiki/concepts/b.md', 'revision:1', 'communities:0,1'],
      evidenceHashes: ['bridgehash00123456'],
    });

    await mergeFindings(kbPath, [orphan, bridge], '2026-09-14T00:00:00Z');

    // 过滤 bridge-node
    const bridgeResult = await listFindings(kbPath, { kind: 'bridge-node' as never });
    expect(bridgeResult.ok).toBe(true);
    if (!bridgeResult.ok) return;
    expect(bridgeResult.findings).toHaveLength(1);
    expect(bridgeResult.findings[0].kind).toBe('bridge-node');

    // 过滤 orphan
    const orphanResult = await listFindings(kbPath, { kind: 'orphan' });
    expect(orphanResult.ok).toBe(true);
    if (!orphanResult.ok) return;
    expect(orphanResult.findings).toHaveLength(1);
    expect(orphanResult.findings[0].kind).toBe('orphan');
  });
});
