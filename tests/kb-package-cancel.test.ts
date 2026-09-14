/**
 * issue 30 — 取消响应测量（队列暂停/取消对可中止转换的响应时间）。
 *
 * 独立成文件的原因：需要 mock `@firecrawl/anydoc` 与 `electron`（与
 * kb-ingest-queue.test.ts 同一套接缝），而门禁主文件走真实引擎/真实模型，
 * vitest 的模块 mock 是文件级的，不能混在同一文件。
 *
 * 测量语义（spec §Testing Decisions「转换、布局和索引期间窗口仍可响应
 * 取消/切换，记录内存峰值」）：
 *  - 取消确认延迟：从调用 pause() 到队列确认停止（任务回 queued）
 *  - 取消期间主线程可响应：轮询 tick 的最大间隔
 *  - 迟到结果拒绝：attempt 失效后引擎结果不得写盘
 *
 * 结果写 `.scratch/llm-wiki/spikes/30-package/cancel-measurement.json`
 * 供主门禁汇总进 report（KB_PACKAGE_REPORT_DIR 可覆盖）。
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';

const globalDataDir = join(tmpdir(), `sv-pkg-gate-cancel-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`);

vi.mock('electron', () => ({
  app: { getPath: vi.fn(() => globalDataDir) },
}));

vi.mock('@firecrawl/anydoc', () => ({
  toDocument: vi.fn(),
  toMarkdownBytes: vi.fn(),
  formatFromPath: vi.fn(),
}));

import { toMarkdownBytes, formatFromPath } from '@firecrawl/anydoc';
import { WikiIngestQueueManager } from '../src/main/kb/ingest-queue';
import { importWikiSources } from '../src/main/kb/source-import';
import { initWikiLayout } from '../src/main/kb/wiki-layout';
import { sourceIdFor } from '../src/main/kb/source-identity';
import { createMemorySampler, formatBytes } from './package/kb-package-perf';
import { packageReportDir } from './package/kb-package-report';

vi.setConfig({ testTimeout: 60_000 });

const mockToMarkdownBytes = vi.mocked(toMarkdownBytes);
const mockFormatFromPath = vi.mocked(formatFromPath);
const DOCX_FORMAT = 'docx' as unknown as ReturnType<typeof formatFromPath>;

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');

let kbPath: string;

beforeEach(async () => {
  kbPath = join(tmpdir(), `sv-pkg-gate-cancel-kb-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`);
  mkdirSync(kbPath, { recursive: true });
  await initWikiLayout(kbPath, { kbId: 'kb-gate-cancel', name: '取消响应测量库' });
  mockFormatFromPath.mockReturnValue(DOCX_FORMAT);
});

afterEach(() => {
  rmSync(kbPath, { recursive: true, force: true });
  rmSync(globalDataDir, { recursive: true, force: true });
  mockToMarkdownBytes.mockReset();
});

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe('issue 30 — 取消响应测量（转换期间 pause/cancel）', () => {
  it('pause 确认延迟、取消期间主线程 tick、迟到结果拒绝提交', async () => {
    // 1) 首次转换直接失败 → 来源以 failed 落库（不挂起导入）
    mockToMarkdownBytes.mockRejectedValueOnce(Object.assign(new Error('locked'), { code: 'encrypted' }));
    const srcAbs = join(kbPath, '_incoming', 'big.docx');
    mkdirSync(join(kbPath, '_incoming'), { recursive: true });
    writeFileSync(srcAbs, 'fake-docx-bytes');
    const imported = await importWikiSources(kbPath, [{ absolutePath: srcAbs }]);
    expect(imported[0]?.ok).toBe(false);
    const sourceId = sourceIdFor('big.docx');

    // 2) 重试转换挂在 gate 上（可控长转换）
    let release!: (text: string) => void;
    const gate = new Promise<string>((resolveGate) => {
      release = resolveGate;
    });
    let conversionStarted = false;
    mockToMarkdownBytes.mockImplementation(async () => {
      conversionStarted = true;
      return await gate;
    });

    const mgr = new WikiIngestQueueManager({ notify: () => undefined });
    const attach = await mgr.attach(kbPath, 'kb-gate-cancel');
    expect(attach.ok).toBe(true);
    const task = await mgr.enqueueConvert('kb-gate-cancel', sourceId);

    const startedAt = Date.now();
    while (!conversionStarted && Date.now() - startedAt < 10_000) await sleep(20);
    expect(conversionStarted).toBe(true);

    // 3) 取消窗口：主线程 tick 探针 + 内存峰值采样
    const sampler = createMemorySampler(20);
    sampler.start();
    let tickMaxGap = 0;
    let lastTick = Date.now();
    let cancelledAcked = false;
    const ticker = (async () => {
      while (!cancelledAcked) {
        await sleep(5);
        const now = Date.now();
        tickMaxGap = Math.max(tickMaxGap, now - lastTick);
        lastTick = now;
      }
    })();

    const t0 = Date.now();
    await mgr.pause('kb-gate-cancel');
    const cancelAckMs = Date.now() - t0;
    cancelledAcked = true;
    await ticker;

    const snap = mgr.snapshot('kb-gate-cancel');
    const paused = snap?.paused === true;
    const taskBackToQueued = snap?.tasks.find((t) => t.taskId === task.taskId)?.phase === 'queued';

    // 4) 迟到结果：attempt 已失效，不得把结果写盘
    release('# late-after-cancel');
    await sleep(500);
    const snapAfter = mgr.snapshot('kb-gate-cancel');
    const lateRejected = snapAfter?.tasks.find((t) => t.taskId === task.taskId)?.phase === 'queued';

    const memoryPeak = sampler.stop();
    await mgr.detach('kb-gate-cancel');

    expect(paused).toBe(true);
    expect(taskBackToQueued).toBe(true);
    expect(lateRejected).toBe(true);
    expect(cancelAckMs).toBeLessThan(5000);
    expect(tickMaxGap).toBeLessThan(2000);

    console.log(
      `[kb-package-cancel] cancelAck=${cancelAckMs}ms tickMaxGap=${tickMaxGap}ms `
        + `rssPeak=${formatBytes(memoryPeak.rssPeakBytes)} heapPeak=${formatBytes(memoryPeak.heapUsedPeakBytes)}`,
    );

    // 5) 供主门禁汇总
    const reportDir = packageReportDir(repoRoot);
    mkdirSync(reportDir, { recursive: true });
    writeFileSync(
      join(reportDir, 'cancel-measurement.json'),
      JSON.stringify(
        {
          cancelAckMs,
          tickMaxGapMs: tickMaxGap,
          lateResultRejected: paused && taskBackToQueued && lateRejected,
          memoryPeak,
          source: 'queue.pause()（受控长转换：anydoc mock 挂起，迟到结果验证拒绝提交）',
        },
        null,
        2,
      ),
      'utf-8',
    );
  });
});
