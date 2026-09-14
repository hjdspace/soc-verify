/**
 * kb-compile-queue-vision.test.ts — 编译队列视觉阶段行为测试（issue 12，spec §3/§5）。
 *
 * 验收：
 *  - 来源含位图资产且未配置视觉模型 → 任务 blocked（visionNotConfigured），
 *    不是普通 failed（等待用户配置，spec §5「配置不足为 blocked」）；
 *  - 用户明确选择「仅按文字继续」→ textOnly 持久化进队列文件，重跑成功且
 *    changeSet.partial=true、visionGaps 随提案落 staging；
 *  - 视觉解读失败 → failed（visionFailed）；重试复用已成功解读（不重复
 *    调用模型），只重做失败项；
 *  - vision 阶段对任务面板可见（phase='vision'），取消可观察；
 *  - textOnly 仅对视觉受阻任务可设置。
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, readFileSync, readdirSync, mkdirSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { WikiIngestQueueManager } from '../src/main/kb/ingest-queue';
import type { CompileLlm } from '../src/main/kb/compile';
import type { VisionLlm } from '../src/main/kb/vision';
import { initWikiLayout, writeWikiManifest, wikiLayout, SCHEMA_MD_SKELETON, type WikiKbManifest } from '../src/main/kb/wiki-layout';
import type { WikiSourceRecord } from '@shared/kb-types';

const KB_ID = 'kb-queue-vision';
const SOURCE_ID = 'a'.repeat(64);
const REVISION = 'b'.repeat(64);
const PARSED_CONTENT = '来源正文。';
const PARSED_HASH = createHash('sha256').update(PARSED_CONTENT, 'utf-8').digest('hex');
const SOURCE_PATH = 'note.md';

// 1x1 PNG（真实 PNG 字节）
const PNG_BYTES = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==',
  'base64',
);
const ASSET_ID = createHash('sha256').update(PNG_BYTES).digest('hex');

const VISION_OUTPUT = [
  '## 图类型',
  '时序图',
  '## 可见元素与信号',
  'CLK、VALID',
  '## 关系或时序',
  'VALID 在 CLK 后拉高',
  '## 可辨认数值',
  '无',
  '## 不确定项',
  '无',
].join('\n');

let kbPath: string;

beforeEach(async () => {
  kbPath = mkdtempSync(join(tmpdir(), 'sv-kb-queue-vision-'));
  await initWikiLayout(kbPath, { kbId: KB_ID, name: '队列视觉测试库' });
  writeFileSync(join(wikiLayout(kbPath).rawParsedDir, `${SOURCE_PATH}.md`), PARSED_CONTENT, 'utf-8');
  const manifest: WikiKbManifest = {
    manifestVersion: 1,
    format: 'wiki',
    kbId: KB_ID,
    name: '队列视觉测试库',
    createdAt: '2026-09-14T00:00:00Z',
    updatedAt: '2026-09-14T00:00:00Z',
    sources: {
      [SOURCE_ID]: {
        sourcePath: SOURCE_PATH,
        sourceId: SOURCE_ID,
        ext: '.md',
        size: PARSED_CONTENT.length,
        currentRevision: REVISION,
        parsedRevision: REVISION,
        parsedHash: PARSED_HASH,
        engine: 'text',
        engineFingerprint: 'text:v1',
        status: 'ready',
        assetCount: 0,
        importedAt: '2026-09-14T00:00:00Z',
        updatedAt: '2026-09-14T00:00:00Z',
      } satisfies WikiSourceRecord,
    },
  };
  await writeWikiManifest(kbPath, manifest);
  writeFileSync(wikiLayout(kbPath).schemaMdPath, SCHEMA_MD_SKELETON, 'utf-8');
});

afterEach(() => {
  rmSync(kbPath, { recursive: true, force: true });
});

// ── fixture ─────────────────────────────────────────────────────

function writeAssetManifest(assets: Array<Record<string, unknown>>): void {
  const dir = join(wikiLayout(kbPath).rawAssetsDir, SOURCE_ID, REVISION);
  mkdirSync(dir, { recursive: true });
  const seen = new Set<string>();
  for (const a of assets) {
    const id = String(a.assetId);
    if (!seen.has(id)) {
      writeFileSync(join(dir, `${id}.${a.ext ?? 'png'}`), (a._bytes as Buffer | undefined) ?? PNG_BYTES);
      seen.add(id);
    }
  }
  const records = assets.map(({ _bytes, ...rest }) => rest);
  writeFileSync(
    join(dir, 'pdf-assets.json'),
    JSON.stringify({
      manifestVersion: 1,
      sourceId: SOURCE_ID,
      revision: REVISION,
      parsedHash: PARSED_HASH,
      extractor: { runtime: 'test', version: '0' },
      assets: records,
      pages: [],
      stats: {
        totalPages: 1, processedPages: 1, failedPages: 0, skippedPages: 0,
        failures: [], skipped: [], bitmapAssets: assets.length, renderAssets: 0,
        renderCandidates: [], renderRendered: [], renderRemaining: [],
        batchLimitReached: false, textPages: 1, cancelled: false,
      },
      extractions: [],
      textLayer: true,
      createdAt: '2026-09-14T00:00:00Z',
      updatedAt: '2026-09-14T00:00:00Z',
    }),
    'utf-8',
  );
}

const OBJECT_ASSET = {
  assetId: ASSET_ID,
  file: `${ASSET_ID}.png`,
  ext: 'png',
  method: 'object' as const,
  page: 3,
  width: 1,
  height: 1,
};

type ScriptStep = { text: string };

function fakeCompileLlm(script: ScriptStep[]): CompileLlm {
  const impl = {
    model: 'fake-queue-model',
    i: 0,
    invoke: (_req: { system: string; user: string; maxTokens: number }) => {
      const step = script[impl.i++];
      return Promise.resolve({
        text: step?.text ?? 'unexpected',
        finishReason: 'stop',
        usage: { outputTokens: 1 },
      });
    },
  };
  return impl as unknown as CompileLlm;
}

function fakeVisionLlm(opts: { failOnCall?: number; hang?: boolean } = {}): VisionLlm & { calls: number } {
  const state = { calls: 0 };
  return {
    model: 'vision-queue-model',
    get calls() {
      return state.calls;
    },
    invoke: async () => {
      state.calls += 1;
      if (opts.hang) return new Promise(() => undefined);
      if (opts.failOnCall === state.calls) throw new Error('transient 500');
      return { text: VISION_OUTPUT, finishReason: 'stop', usage: { inputTokens: 5, outputTokens: 2 } };
    },
  } as unknown as VisionLlm & { calls: number };
}

const SUMMARY_BLOCK = `---FILE: wiki/sources/${SOURCE_ID}.md---\n---\ntype: source\ntitle: "N"\nsummary: s\nkeywords: []\ntags: []\nsources:\n  - sourceId: "${SOURCE_ID}"\n    sourceRevision: "${REVISION}"\n    parsedHash: "${PARSED_HASH}"\ncreated: "2026-09-14T00:00:00Z"\nupdated: "2026-09-14T00:00:00Z"\n---\n\n# N\n\n正文。\n---END FILE---`;

const CONCEPT_BLOCK = `---FILE: wiki/concepts/foo.md---\n---\ntype: concept\ntitle: "Foo"\nsummary: s\nkeywords: []\ntags: []\nsources:\n  - sourceId: "${SOURCE_ID}"\n    sourceRevision: "${REVISION}"\n    parsedHash: "${PARSED_HASH}"\ncreated: "2026-09-14T00:00:00Z"\nupdated: "2026-09-14T00:00:00Z"\n---\n\n# Foo\n\n握手。\n---END FILE---`;

function okScript(): ScriptStep[] {
  return [{ text: '分析' }, { text: `${SUMMARY_BLOCK}\n\n${CONCEPT_BLOCK}` }];
}

function waitForPhase(
  q: WikiIngestQueueManager,
  taskId: string,
  phase: string,
  timeoutMs = 3_000,
): Promise<void> {
  return vi.waitFor(
    () => {
      const snap = q.snapshot(KB_ID);
      const t = snap?.tasks.find((x) => x.taskId === taskId);
      if (t?.phase !== phase) throw new Error(`phase=${t?.phase} 期望 ${phase}`);
    },
    { timeout: timeoutMs, interval: 20 },
  );
}

function readStagedChangeSets(): Array<Record<string, unknown>> {
  const dir = wikiLayout(kbPath).stagingDir;
  return readdirSync(dir)
    .filter((f) => f.endsWith('.json'))
    .map((f) => JSON.parse(readFileSync(join(dir, f), 'utf-8')) as Record<string, unknown>);
}

// ── 行为测试 ────────────────────────────────────────────────────

describe('队列视觉门禁 — 未配置视觉模型', () => {
  it('有位图资产且 vision 工厂返回 null → blocked（visionNotConfigured），compile LLM 不被调用', async () => {
    let compileCalls = 0;
    const q = new WikiIngestQueueManager({
      notify: () => undefined,
      compileLlmFactory: async () => {
        compileCalls += 1;
        return fakeCompileLlm(okScript());
      },
      visionLlmFactory: async () => null,
    });
    await q.attach(kbPath, KB_ID);
    writeAssetManifest([OBJECT_ASSET]);
    const task = await q.enqueueCompile(KB_ID, SOURCE_ID);
    await waitForPhase(q, task.taskId, 'blocked');
    const snap = q.snapshot(KB_ID);
    expect(snap?.tasks.find((t) => t.taskId === task.taskId)?.lastError?.code).toBe('visionNotConfigured');
    // 不基于缺失证据生成
    expect(compileCalls).toBe(1); // factory 每次 attempt 调用一次，但 compile LLM 未 invoke
    expect(readStagedChangeSets()).toHaveLength(0);
  });

  it('无资产来源不受门禁影响：正常完成且不产生视觉解读记录', async () => {
    const q = new WikiIngestQueueManager({
      notify: () => undefined,
      compileLlmFactory: async () => fakeCompileLlm(okScript()),
      visionLlmFactory: async () => null, // 未配置视觉模型也不阻碍无资产来源
    });
    await q.attach(kbPath, KB_ID);
    const task = await q.enqueueCompile(KB_ID, SOURCE_ID);
    await waitForPhase(q, task.taskId, 'done');
    // 无视觉解读记录（无资产 → 视觉阶段 no-op）
    expect(existsSync(join(wikiLayout(kbPath).visionDir, SOURCE_ID))).toBe(false);
  });
});

describe('仅按文字继续（textOnly）', () => {
  it('continueTextOnly → textOnly 持久化，重跑 done 且 changeSet.partial=true + visionGaps', async () => {
    const q = new WikiIngestQueueManager({
      notify: () => undefined,
      compileLlmFactory: async () => fakeCompileLlm(okScript()),
      visionLlmFactory: async () => null,
    });
    await q.attach(kbPath, KB_ID);
    writeAssetManifest([OBJECT_ASSET]);
    const task = await q.enqueueCompile(KB_ID, SOURCE_ID);
    await waitForPhase(q, task.taskId, 'blocked');

    await q.continueTextOnly(KB_ID, task.taskId);
    await waitForPhase(q, task.taskId, 'done');

    const snap = q.snapshot(KB_ID);
    const t = snap?.tasks.find((x) => x.taskId === task.taskId);
    expect(t?.textOnly).toBe(true);
    // 队列文件持久化 textOnly（重启恢复后重试仍跳过视觉）
    const raw = readFileSync(join(kbPath, '.kb', 'queue.json'), 'utf-8');
    expect(raw).toContain('"textOnly": true');

    // 提案 partial + 视觉缺口
    const staged = readStagedChangeSets();
    expect(staged).toHaveLength(1);
    expect(staged[0]!.partial).toBe(true);
    expect(staged[0]!.visionGaps).toHaveLength(1);
  });

  it('textOnly 只对视觉受阻任务可设置（非 blocked/failed 或非视觉错误 → 拒绝）', async () => {
    const q = new WikiIngestQueueManager({
      notify: () => undefined,
      compileLlmFactory: async () => fakeCompileLlm(okScript()),
      visionLlmFactory: async () => null,
    });
    await q.attach(kbPath, KB_ID);
    const task = await q.enqueueCompile(KB_ID, SOURCE_ID);
    // queued 阶段不可设置
    await expect(q.continueTextOnly(KB_ID, task.taskId)).rejects.toMatchObject({ code: 'invalidPhase' });
    await waitForPhase(q, task.taskId, 'done');
    // 无视觉错误（无资产正常完成）不可设置
    await expect(q.continueTextOnly(KB_ID, task.taskId)).rejects.toMatchObject({ code: 'invalidPhase' });
  });
});

describe('视觉解读失败与重试复用', () => {
  it('visionFailed → failed；重试复用已成功解读，只重做失败项', async () => {
    const vision = fakeVisionLlm({ failOnCall: 2 }); // 第 2 次调用（第二张图）瞬时失败
    const q = new WikiIngestQueueManager({
      notify: () => undefined,
      compileLlmFactory: async () => fakeCompileLlm(okScript()),
      visionLlmFactory: async () => vision,
    });
    await q.attach(kbPath, KB_ID);
    const bytes2 = Buffer.from('second-image-bytes');
    const asset2Id = createHash('sha256').update(bytes2).digest('hex');
    writeAssetManifest([
      OBJECT_ASSET,
      { assetId: asset2Id, file: `${asset2Id}.png`, ext: 'png', method: 'object', page: 4, width: 1, height: 1, _bytes: bytes2 },
    ]);
    const task = await q.enqueueCompile(KB_ID, SOURCE_ID);
    await waitForPhase(q, task.taskId, 'failed');
    const snap = q.snapshot(KB_ID);
    expect(snap?.tasks.find((t) => t.taskId === task.taskId)?.lastError?.code).toBe('visionFailed');
    expect(vision.calls).toBe(2);

    // 重试：第一张复用（不重新调用模型），第二张重做成功
    await q.retryTask(KB_ID, task.taskId);
    await waitForPhase(q, task.taskId, 'done');
    expect(vision.calls).toBe(3);
    const staged = readStagedChangeSets();
    expect(staged).toHaveLength(1);
    expect(staged[0]!.partial).toBeFalsy();
  });
});

describe('vision 阶段可见性', () => {
  it('解读挂起时任务 phase=vision，取消可观察', async () => {
    const vision = fakeVisionLlm({ hang: true });
    const q = new WikiIngestQueueManager({
      notify: () => undefined,
      compileLlmFactory: async () => fakeCompileLlm(okScript()),
      visionLlmFactory: async () => vision,
    });
    await q.attach(kbPath, KB_ID);
    writeAssetManifest([OBJECT_ASSET]);
    const task = await q.enqueueCompile(KB_ID, SOURCE_ID);
    await waitForPhase(q, task.taskId, 'vision');
    await q.cancelTask(KB_ID, task.taskId);
    await waitForPhase(q, task.taskId, 'cancelled');
  });
});
