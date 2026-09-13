/**
 * kb-long-source-checkpoint.test.ts — 长来源分段 checkpoint（issue 10，spec §4）。
 *
 * 验收：
 *  - checkpoint 含来源、parsed/视觉、模型/规则/提示与分块指纹；
 *  - 任一指纹不匹配 → 不恢复（重算），不把旧结论拼到新来源上；
 *  - 坏文件/损坏 JSON 不抛异常，按「无 checkpoint」处理（重算而非静默沿用）。
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, readFileSync, existsSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import {
  chunkShapeHash,
  longSourceCheckpointKey,
  longSourceCheckpointPath,
  parseLongSourceCheckpoint,
  loadLongSourceCheckpoint,
  saveLongSourceCheckpoint,
  clearLongSourceCheckpoint,
  type LongSourceCheckpointKey,
  type LongSourceCheckpointInput,
} from '../src/main/kb/long-source-checkpoint';

let kbPath: string;

const BASE_INPUT: LongSourceCheckpointInput = {
  sourceId: 'a'.repeat(64),
  sourceRevision: 'b'.repeat(64),
  parsedHash: 'c'.repeat(64),
  visionHash: null,
  schemaHash: 'd'.repeat(64),
  purposeHash: 'e'.repeat(64),
  modelFingerprint: 'deepseek-chat/v1',
  promptVersion: 1,
  chunkTargetTokens: 8_000,
  chunkOverlapTokens: 400,
  chunks: [
    { startLine: 1, endLine: 100 },
    { startLine: 101, endLine: 210 },
  ],
};

function expected(input: LongSourceCheckpointInput = BASE_INPUT): {
  key: LongSourceCheckpointKey;
  fingerprint: string;
  chunkTotal: number;
} {
  const { key, fingerprint } = longSourceCheckpointKey(input);
  return { key, fingerprint, chunkTotal: input.chunks.length };
}

function sample(overrides: Partial<{ completedThrough: number; analyses: string[] }> = {}) {
  const { key, fingerprint } = longSourceCheckpointKey(BASE_INPUT);
  return {
    version: 1 as const,
    fingerprint,
    key,
    completedThrough: overrides.completedThrough ?? 2,
    digest: '累计摘要：AXI outstanding 上限。',
    analyses: overrides.analyses ?? ['第 1 段分析', '第 2 段分析'],
    updatedAt: '2026-09-14T00:00:00Z',
  };
}

beforeEach(() => {
  kbPath = mkdtempSync(join(tmpdir(), 'sv-kb-checkpoint-'));
  mkdirSync(join(kbPath, '.kb'), { recursive: true });
});

afterEach(() => {
  rmSync(kbPath, { recursive: true, force: true });
});

describe('checkpoint 键与指纹', () => {
  it('同一输入得到稳定指纹，分块形状写入键中', () => {
    const a = longSourceCheckpointKey(BASE_INPUT);
    const b = longSourceCheckpointKey(BASE_INPUT);
    expect(a.fingerprint).toBe(b.fingerprint);
    expect(a.key.chunkShapeHash).toBe(chunkShapeHash(BASE_INPUT.chunks));
    expect(a.key.chunkTargetTokens).toBe(8_000);
    expect(a.key.visionHash).toBeNull();
    expect(a.key.promptVersion).toBe(1);
  });

  it.each([
    ['来源修订', { sourceRevision: 'f'.repeat(64) }],
    ['parsed 指纹', { parsedHash: 'f'.repeat(64) }],
    ['视觉指纹', { visionHash: 'f'.repeat(64) }],
    ['schema 指纹', { schemaHash: 'f'.repeat(64) }],
    ['purpose 指纹', { purposeHash: 'f'.repeat(64) }],
    ['模型指纹', { modelFingerprint: 'other-model' }],
    ['提示版本', { promptVersion: 2 }],
    ['分块目标', { chunkTargetTokens: 9_000 }],
    ['分块重叠', { chunkOverlapTokens: 500 }],
    ['分块形状', { chunks: [{ startLine: 1, endLine: 101 }, { startLine: 102, endLine: 210 }] }],
  ])('%s 变化 → 指纹不同（不匹配即重算）', (_label, patch) => {
    const changed = longSourceCheckpointKey({ ...BASE_INPUT, ...patch } as LongSourceCheckpointInput);
    expect(changed.fingerprint).not.toBe(longSourceCheckpointKey(BASE_INPUT).fingerprint);
  });
});

describe('读写与恢复判定', () => {
  it('保存后可读回，路径在 .kb/compile-checkpoints 下', async () => {
    const cp = sample();
    await saveLongSourceCheckpoint(kbPath, BASE_INPUT.sourceId, cp);
    const path = longSourceCheckpointPath(kbPath, BASE_INPUT.sourceId);
    expect(path).toContain(join('.kb', 'compile-checkpoints'));
    expect(existsSync(path)).toBe(true);

    const loaded = await loadLongSourceCheckpoint(kbPath, BASE_INPUT.sourceId, expected());
    expect(loaded?.completedThrough).toBe(2);
    expect(loaded?.analyses).toEqual(['第 1 段分析', '第 2 段分析']);
    expect(loaded?.digest).toContain('AXI');
  });

  it('指纹不匹配 → 不恢复（返回 null，由调用方重算）', async () => {
    await saveLongSourceCheckpoint(kbPath, BASE_INPUT.sourceId, sample());
    const changed = longSourceCheckpointKey({ ...BASE_INPUT, parsedHash: '9'.repeat(64) });
    const loaded = await loadLongSourceCheckpoint(kbPath, BASE_INPUT.sourceId, {
      key: changed.key,
      fingerprint: changed.fingerprint,
      chunkTotal: 2,
    });
    expect(loaded).toBeNull();
  });

  it('completedThrough 与分块数/分析条数不符 → 不恢复', async () => {
    const bad = sample({ completedThrough: 3, analyses: ['a', 'b'] });
    await saveLongSourceCheckpoint(kbPath, BASE_INPUT.sourceId, bad);
    expect(await loadLongSourceCheckpoint(kbPath, BASE_INPUT.sourceId, expected())).toBeNull();

    const mismatch = sample({ completedThrough: 2, analyses: ['a'] });
    await saveLongSourceCheckpoint(kbPath, BASE_INPUT.sourceId, mismatch);
    expect(await loadLongSourceCheckpoint(kbPath, BASE_INPUT.sourceId, expected())).toBeNull();
  });

  it('无 checkpoint / 坏 JSON / 结构非法 → null，不抛异常', async () => {
    expect(await loadLongSourceCheckpoint(kbPath, BASE_INPUT.sourceId, expected())).toBeNull();

    const path = longSourceCheckpointPath(kbPath, BASE_INPUT.sourceId);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, '{ not json', 'utf-8');
    expect(await loadLongSourceCheckpoint(kbPath, BASE_INPUT.sourceId, expected())).toBeNull();

    writeFileSync(path, JSON.stringify({ version: 2 }), 'utf-8');
    expect(await loadLongSourceCheckpoint(kbPath, BASE_INPUT.sourceId, expected())).toBeNull();
    expect(parseLongSourceCheckpoint({ version: 1 })).toBeNull();
  });

  it('clear 后可恢复为「无 checkpoint」', async () => {
    await saveLongSourceCheckpoint(kbPath, BASE_INPUT.sourceId, sample());
    expect(existsSync(longSourceCheckpointPath(kbPath, BASE_INPUT.sourceId))).toBe(true);
    await clearLongSourceCheckpoint(kbPath, BASE_INPUT.sourceId);
    expect(existsSync(longSourceCheckpointPath(kbPath, BASE_INPUT.sourceId))).toBe(false);
    await clearLongSourceCheckpoint(kbPath, BASE_INPUT.sourceId); // 幂等
  });

  it('checkpoint 不保存凭证（只存指纹与分析文本）', async () => {
    await saveLongSourceCheckpoint(kbPath, BASE_INPUT.sourceId, sample());
    const raw = readFileSync(longSourceCheckpointPath(kbPath, BASE_INPUT.sourceId), 'utf-8');
    expect(raw).not.toMatch(/apiKey|sk-|Bearer /);
    const parsed = JSON.parse(raw) as { key?: Record<string, unknown> };
    expect(Object.keys(parsed.key ?? {})).not.toContain('apiKey');
    expect(Object.keys(parsed)).not.toContain('apiKey');
  });
});
