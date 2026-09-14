/**
 * kb ingest queue 行为测试（issue 03 — 让导入任务可暂停、取消并在重启后恢复）。
 *
 * 用真实临时目录 + 真文件 fixture + 受控 anydoc mock 走通队列行为：
 *  - 持久 taskId/attemptId/kbId/阶段/lastError/paused；初始单 worker
 *  - 暂停/取消中止可中止的转换；迟到结果因 attempt 失效不可提交
 *  - committing 临界区不可半途丢弃（暂停/取消/卸载等待提交完成）
 *  - 只重排 queued；重试新 attempt 且保留失败原因
 *  - 重启恢复安全状态并等待继续（不意外执行）
 *  - 持久化失败不确认操作成功；坏队列文件不静默清空
 *  - 切库/卸载绑定原任务库；事件带身份与单调 seq，快照可重拉
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { rmSync, mkdirSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

// ─── Mocks ──────────────────────────────────────────────────

const globalDataDir = join(tmpdir(), `sv-kb-queue-app-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`);

vi.mock('electron', () => ({
  app: {
    getPath: vi.fn(() => globalDataDir),
  },
}));

vi.mock('@firecrawl/anydoc', () => ({
  toDocument: vi.fn(),
  toMarkdownBytes: vi.fn(),
  formatFromPath: vi.fn(),
}));

// writeWikiManifest 可阻断：构造 committing 临界区窗口（最终 manifest 写入）
vi.mock('../src/main/kb/wiki-layout', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/main/kb/wiki-layout')>();
  return {
    ...actual,
    writeWikiManifest: vi.fn((...args: Parameters<typeof actual.writeWikiManifest>) =>
      actual.writeWikiManifest(...args),
    ),
  };
});

// writeFileAtomic 可注入失败：持久化失败场景
vi.mock('../src/main/kb/atomic-commit', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/main/kb/atomic-commit')>();
  return {
    ...actual,
    writeFileAtomic: vi.fn((...args: Parameters<typeof actual.writeFileAtomic>) =>
      actual.writeFileAtomic(...args),
    ),
  };
});

import { toDocument, toMarkdownBytes, formatFromPath } from '@firecrawl/anydoc';
import { writeWikiManifest } from '../src/main/kb/wiki-layout';
import { writeFileAtomic } from '../src/main/kb/atomic-commit';
import {
  WikiIngestQueueManager,
  WikiQueueError,
} from '../src/main/kb/ingest-queue';
import {
  importWikiSources,
  WikiSourceAbortedError,
} from '../src/main/kb/source-import';
import { initWikiLayout, readWikiManifest } from '../src/main/kb/wiki-layout';
import { sourceIdFor } from '../src/main/kb/source-identity';
import type { WikiTaskEvent } from '@shared/kb-types';

// 真实临时目录 + 轮询等待的 E2E 风格测试：放宽单测超时，
// 全套并行跑时磁盘负载高，5s 默认值会抖动。
vi.setConfig({ testTimeout: 30000 });

const mockToDocument = vi.mocked(toDocument);
const mockToMarkdownBytes = vi.mocked(toMarkdownBytes);
const mockFormatFromPath = vi.mocked(formatFromPath);
const mockWriteManifest = vi.mocked(writeWikiManifest);
const mockWriteFileAtomic = vi.mocked(writeFileAtomic);

/** anydoc Format 是 ambient const enum（运行时不存在），mock 用等价字符串桥接类型 */
const DOCX_FORMAT = 'docx' as unknown as ReturnType<typeof formatFromPath>;

// ─── Fixture helpers ────────────────────────────────────────

let kbPath: string;
let incomingDir: string;

beforeEach(async () => {
  kbPath = join(tmpdir(), `sv-kb-queue-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`);
  incomingDir = join(kbPath, '_incoming');
  mkdirSync(kbPath, { recursive: true });
  mkdirSync(incomingDir, { recursive: true });
  await initWikiLayout(kbPath, { kbId: 'kb-test', name: '测试库' });
  vi.clearAllMocks();
  // clearAllMocks 不恢复实现：重建立直通，防止上一个用例的 mock 覆盖泄漏
  mockWriteManifest.mockImplementation((...args: Parameters<typeof writeWikiManifest>) =>
    passThroughWriteManifest(...args),
  );
  mockWriteFileAtomic.mockImplementation((...args: Parameters<typeof writeFileAtomic>) =>
    passThroughWriteFileAtomic(...args),
  );
  mockFormatFromPath.mockReturnValue(DOCX_FORMAT);
  // 默认：anydoc 转换失败（encrypted）——需要成功的场景在具体测试中显式覆盖
  mockToMarkdownBytes.mockRejectedValue(Object.assign(new Error('locked'), { code: 'encrypted' }));
  mockToDocument.mockRejectedValue(Object.assign(new Error('locked'), { code: 'encrypted' }));
});

afterEach(() => {
  rmSync(kbPath, { recursive: true, force: true });
  rmSync(globalDataDir, { recursive: true, force: true });
});

/** 等待条件成立（轮询内存快照/磁盘状态；支持异步谓词）。
 * 默认 10s：全套并行跑时磁盘负载高，3s 量级会抖动。
 */
async function waitFor(fn: () => boolean | Promise<boolean>, timeoutMs = 10000, message = 'waitFor timeout'): Promise<void> {
  const start = Date.now();
  while (!(await fn())) {
    if (Date.now() - start > timeoutMs) throw new Error(message);
    await new Promise((r) => setTimeout(r, 10));
  }
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** 轮询磁盘队列文件直到条件成立。
 * settleRun 先更新内存并推送事件、flush 异步落盘——观察到内存终态后立即读盘
 * 会拿到上一次落盘的旧状态，因此磁盘断言必须轮询等待。
 */
async function waitForQueueDisk(
  pred: (q: {
    kbId: string;
    paused: boolean;
    seq: number;
    tasks: Array<{ taskId: string; phase: string; attemptId: string; attempt: number; lastError: { code: string; message: string } | null }>;
  }) => boolean,
  timeoutMs = 10000,
): Promise<void> {
  const start = Date.now();
  for (;;) {
    let ok = false;
    try {
      const raw = JSON.parse(readFileSync(queueFilePath(), 'utf-8')) as Parameters<typeof pred>[0];
      ok = pred(raw);
    } catch {
      ok = false; // 尚未写出/正在换名：继续等待
    }
    if (ok) return;
    if (Date.now() - start > timeoutMs) throw new Error('waitForQueueDisk timeout');
    await sleep(10);
  }
}

/** writeFileAtomic 直通（mock 覆盖后恢复真实实现用；importActual 必须 await） */
async function passThroughWriteFileAtomic(filePath: string, content: string | Buffer): Promise<void> {
  const actual = await vi.importActual<typeof import('../src/main/kb/atomic-commit')>('../src/main/kb/atomic-commit');
  return actual.writeFileAtomic(filePath, content);
}

/** writeWikiManifest 直通 */
async function passThroughWriteManifest(
  ...args: Parameters<typeof writeWikiManifest>
): Promise<void> {
  const actual = await vi.importActual<typeof import('../src/main/kb/wiki-layout')>('../src/main/kb/wiki-layout');
  return actual.writeWikiManifest(...args);
}

function deferred<T>() {
  let resolve!: (v: T) => void;
  let reject!: (err: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

/** 导入一个文本来源（.md 直通，立即 ready） */
async function importReadyText(relPath: string, content: string): Promise<string> {
  writeFileSync(join(incomingDir, relPath), content, 'utf-8');
  const results = await importWikiSources(kbPath, [{ absolutePath: join(incomingDir, relPath), relPath }]);
  expect(results[0]?.ok).toBe(true);
  return sourceIdFor(relPath);
}

/** 导入一个转换失败的 docx 来源（来源已保存，status=failed） */
async function importFailedDocx(relPath: string): Promise<string> {
  mockToMarkdownBytes.mockRejectedValueOnce(Object.assign(new Error('locked'), { code: 'encrypted' }));
  mockToDocument.mockRejectedValueOnce(Object.assign(new Error('locked'), { code: 'encrypted' }));
  writeFileSync(join(incomingDir, relPath), 'fake-docx-bytes');
  const results = await importWikiSources(kbPath, [{ absolutePath: join(incomingDir, relPath), relPath }]);
  expect(results[0]?.ok).toBe(false);
  return sourceIdFor(relPath);
}

function queueFilePath(): string {
  return join(kbPath, '.kb', 'queue.json');
}

type Notify = (e: WikiTaskEvent) => void;

function makeManager(notify?: Notify): WikiIngestQueueManager {
  return new WikiIngestQueueManager(notify ? { notify } : {});
}

async function attachFresh(notify?: Notify): Promise<WikiIngestQueueManager> {
  const mgr = makeManager(notify);
  const res = await mgr.attach(kbPath, 'kb-test');
  expect(res.ok).toBe(true);
  return mgr;
}

// ─── 持久化与入队 ───────────────────────────────────────────

describe('持久化与入队', () => {
  it('并发附着等待恢复落盘；首次落盘失败后下一次附着可恢复有效队列', async () => {
    const mgr = await attachFresh();
    await mgr.pause('kb-test');
    await mgr.detach('kb-test');
    const writing = deferred<void>();
    const release = deferred<void>();
    mockWriteFileAtomic.mockImplementationOnce(async () => {
      writing.resolve();
      await release.promise;
      throw new Error('disk unavailable');
    });

    const first = mgr.attach(kbPath, 'kb-test');
    await writing.promise;
    const second = mgr.attach(kbPath, 'kb-test');
    release.resolve();
    expect(await first).toEqual({ ok: false, reason: 'queueIoError' });
    expect((await second).ok).toBe(true);
    expect(mgr.snapshot('kb-test')).toMatchObject({ kbId: 'kb-test', paused: true });
    await mgr.detach('kb-test');
  });

  it('入队创建持久任务（taskId/attemptId/kbId/phase/attempt）并落盘，事件带单调 seq', async () => {
    const sid = await importReadyText('a.md', '# A');
    const events: WikiTaskEvent[] = [];
    const mgr = await attachFresh((e) => events.push(e));

    const task = await mgr.enqueueConvert('kb-test', sid);
    expect(task.taskId).toBeTruthy();
    expect(task.attemptId).toBeTruthy();
    expect(task.kbId).toBe('kb-test');
    expect(task.kind).toBe('convertSource');
    expect(task.phase).toBe('queued');
    expect(task.attempt).toBe(1);

    // 队列文件落盘
    const raw = JSON.parse(readFileSync(queueFilePath(), 'utf-8')) as {
      queueVersion: number;
      kbId: string;
      paused: boolean;
      seq: number;
      tasks: Array<{ taskId: string; phase: string; attemptId: string }>;
    };
    expect(raw.queueVersion).toBe(1);
    expect(raw.kbId).toBe('kb-test');
    expect(raw.tasks).toHaveLength(1);
    expect(raw.tasks[0]?.taskId).toBe(task.taskId);

    // 文本来源自动执行（单 worker）→ done
    const snap = mgr.snapshot('kb-test');
    expect(snap).not.toBeNull();
    await waitFor(() => mgr.snapshot('kb-test')?.tasks[0]?.phase === 'done');
    // 事件在 flush 成功后投递（先落盘后通知）：内存先可见 done，等最后一条
    // 事件送达后再断言事件流与快照 seq 的一致性
    await waitFor(() => events.length > 0 && events[events.length - 1]!.seq === mgr.snapshot('kb-test')?.seq);
    const doneSnap = mgr.snapshot('kb-test')!;
    expect(doneSnap.tasks[0]?.attemptId).toBe(task.attemptId);

    // 事件带身份与 seq，单调递增，与快照 seq 一致
    expect(events.length).toBeGreaterThan(0);
    const seqs = events.map((e) => e.seq);
    for (let i = 1; i < seqs.length; i++) {
      expect(seqs[i]).toBeGreaterThan(seqs[i - 1]!);
    }
    expect(events.every((e) => e.kbId === 'kb-test')).toBe(true);
    const taskEvents = events.filter((e) => e.type === 'task');
    expect(taskEvents.every((e) => e.taskId === task.taskId && e.attemptId === task.attemptId)).toBe(true);
    expect(doneSnap.seq).toBe(seqs[seqs.length - 1]);
  });

  it('同来源活动任务去重：重复入队返回同一任务', async () => {
    const sid = await importFailedDocx('dup.docx');
    mockToMarkdownBytes.mockImplementation(() => new Promise<string>(() => {}));
    const mgr = await attachFresh();

    const t1 = await mgr.enqueueConvert('kb-test', sid);
    const t2 = await mgr.enqueueConvert('kb-test', sid);
    expect(t2.taskId).toBe(t1.taskId);
    expect(mgr.snapshot('kb-test')?.tasks).toHaveLength(1);
  });

  it('未知来源入队拒绝（sourceNotFound），不产生任务', async () => {
    const mgr = await attachFresh();
    await expect(mgr.enqueueConvert('kb-test', 'no-such-source')).rejects.toBeInstanceOf(WikiQueueError);
    expect(mgr.snapshot('kb-test')?.tasks).toHaveLength(0);
    expect(existsSync(queueFilePath())).toBe(false);
  });

  it('kbId 不符的请求被拒绝（任务绑定原任务库）', async () => {
    const sid = await importReadyText('b.md', '# B');
    const mgr = await attachFresh();
    await expect(mgr.enqueueConvert('kb-other', sid)).rejects.toBeInstanceOf(WikiQueueError);
  });

  it('默认单 worker：第二个任务在前一个完成后才开始', async () => {
    const s1 = await importFailedDocx('one.docx');
    const s2 = await importFailedDocx('two.docx');
    const gate1 = deferred<string>();
    const gate2 = deferred<string>();
    const mdCalls: number[] = [];
    mockToMarkdownBytes.mockImplementation(() => {
      mdCalls.push(Date.now());
      return mdCalls.length === 1 ? gate1.promise : gate2.promise;
    });

    const mgr = await attachFresh();
    await mgr.enqueueConvert('kb-test', s1);
    await mgr.enqueueConvert('kb-test', s2);

    await waitFor(() => mgr.snapshot('kb-test')?.tasks.filter((t) => t.phase === 'converting').length === 1);
    expect(mgr.snapshot('kb-test')?.tasks.find((t) => t.sourceId === s2)?.phase).toBe('queued');

    gate1.resolve('# one');
    await waitFor(() => mgr.snapshot('kb-test')?.tasks.find((t) => t.sourceId === s1)?.phase === 'done');
    await waitFor(() => mgr.snapshot('kb-test')?.tasks.find((t) => t.sourceId === s2)?.phase === 'converting');
    gate2.resolve('# two');
    await waitFor(() => mgr.snapshot('kb-test')?.tasks.every((t) => t.phase === 'done') === true);
  });

  it('setWorkerLimit 支持有界并发（clamp 到 [1,5]）', async () => {
    const s1 = await importFailedDocx('p1.docx');
    const s2 = await importFailedDocx('p2.docx');
    const gate1 = deferred<string>();
    const gate2 = deferred<string>();
    let call = 0;
    mockToMarkdownBytes.mockImplementation(() => {
      call += 1;
      return call === 1 ? gate1.promise : gate2.promise;
    });

    const mgr = await attachFresh();
    mgr.setWorkerLimit(2);
    await mgr.enqueueConvert('kb-test', s1);
    await mgr.enqueueConvert('kb-test', s2);

    // 两个同时 converting
    await waitFor(() => mgr.snapshot('kb-test')?.tasks.filter((t) => t.phase === 'converting').length === 2);
    gate1.resolve('# 1');
    gate2.resolve('# 2');
    await waitFor(() => mgr.snapshot('kb-test')?.tasks.every((t) => t.phase === 'done') === true);

    // clamp：越界值收敛
    mgr.setWorkerLimit(0);
    mgr.setWorkerLimit(99);
    expect(mgr.snapshot('kb-test')).not.toBeNull();
  });
});

// ─── 暂停与恢复 ─────────────────────────────────────────────

describe('暂停与恢复', () => {
  it('暂停中止转换中的工作：任务回 queued、paused 持久；迟到结果不可提交', async () => {
    const sid = await importFailedDocx('slow.docx');
    const gate = deferred<string>();
    mockToMarkdownBytes.mockImplementation(() => gate.promise);
    const mgr = await attachFresh();

    await mgr.enqueueConvert('kb-test', sid);
    await waitFor(() => mgr.snapshot('kb-test')?.tasks[0]?.phase === 'converting');

    await mgr.pause('kb-test');

    // paused 持久 + 任务回 queued
    const snap = mgr.snapshot('kb-test')!;
    expect(snap.paused).toBe(true);
    expect(snap.tasks[0]?.phase).toBe('queued');
    const onDisk = JSON.parse(readFileSync(queueFilePath(), 'utf-8')) as { paused: boolean; tasks: Array<{ phase: string }> };
    expect(onDisk.paused).toBe(true);
    expect(onDisk.tasks[0]?.phase).toBe('queued');

    // 模拟不可中止的底层转换迟到的结果：attempt 已失效，不得写盘
    gate.resolve('# late');
    await sleep(80);
    const manifest = await readWikiManifest(kbPath);
    expect(manifest.ok).toBe(true);
    expect(manifest.ok && manifest.manifest.sources?.[sid]?.status).toBe('failed');
    expect(mgr.snapshot('kb-test')?.tasks[0]?.phase).toBe('queued');
  });

  it('恢复后以新 attempt 重跑并完成', async () => {
    const sid = await importFailedDocx('resume.docx');
    const gate = deferred<string>();
    mockToMarkdownBytes.mockImplementation(() => gate.promise);
    const mgr = await attachFresh();

    const task = await mgr.enqueueConvert('kb-test', sid);
    await waitFor(() => mgr.snapshot('kb-test')?.tasks[0]?.phase === 'converting');
    await mgr.pause('kb-test');
    const afterPause = mgr.snapshot('kb-test')!;
    expect(afterPause.tasks[0]?.attempt).toBe(2); // 中止的执行消耗 attempt

    mockToMarkdownBytes.mockResolvedValue('# resumed');
    await mgr.resume('kb-test');
    await waitFor(() => mgr.snapshot('kb-test')?.tasks[0]?.phase === 'done');
    const snap = mgr.snapshot('kb-test')!;
    expect(snap.paused).toBe(false);
    expect(snap.tasks[0]?.attempt).toBe(2);
    expect(snap.tasks[0]?.attemptId).not.toBe(task.attemptId);

    const manifest = await readWikiManifest(kbPath);
    expect(manifest.ok && manifest.manifest.sources?.[sid]?.status).toBe('ready');
  });

  it('暂停等待 committing 完成，不半途丢弃提交', async () => {
    const sid = await importFailedDocx('committing.docx');
    const gate = deferred<string>();
    mockToMarkdownBytes.mockImplementation(() => gate.promise);
    const mgr = await attachFresh();
    await mgr.enqueueConvert('kb-test', sid);
    await waitFor(() => mgr.snapshot('kb-test')?.tasks[0]?.phase === 'converting');

    // 转换完成 → 最终 manifest 写入（committing 临界区）被阻断
    const releaseCommit = deferred<void>();
    mockWriteManifest.mockImplementation(async (path, manifest) => {
      const rec = manifest.sources?.[sid];
      if (rec?.status === 'ready') {
        await releaseCommit.promise;
      }
      const actual = await vi.importActual<typeof import('../src/main/kb/wiki-layout')>('../src/main/kb/wiki-layout');
      return actual.writeWikiManifest(path, manifest);
    });
    gate.resolve('# committing');

    // 进入 committing 阶段（事件可见）
    await waitFor(() => mgr.snapshot('kb-test')?.tasks[0]?.phase === 'committing');

    // 暂停必须等待提交完成
    let pauseDone = false;
    const pausePromise = mgr.pause('kb-test').then(() => {
      pauseDone = true;
    });
    await sleep(80);
    expect(pauseDone).toBe(false);
    expect(mgr.snapshot('kb-test')?.tasks[0]?.phase).toBe('committing');

    releaseCommit.resolve();
    await pausePromise;
    expect(mgr.snapshot('kb-test')?.tasks[0]?.phase).toBe('done');
    expect(mgr.snapshot('kb-test')?.paused).toBe(true);
  });
});

// ─── 取消与重试 ─────────────────────────────────────────────

describe('取消与重试', () => {
  it('取消转换中的任务：attempt 失效，迟到的转换结果不写盘；重试以新 attempt 完成', async () => {
    const sid = await importFailedDocx('cancel.docx');
    const gate = deferred<string>();
    mockToMarkdownBytes.mockImplementation(() => gate.promise);
    const mgr = await attachFresh();

    const task = await mgr.enqueueConvert('kb-test', sid);
    await waitFor(() => mgr.snapshot('kb-test')?.tasks[0]?.phase === 'converting');

    await mgr.cancelTask('kb-test', task.taskId);
    const snap = mgr.snapshot('kb-test')!;
    expect(snap.tasks[0]?.phase).toBe('cancelled');
    const onDisk = JSON.parse(readFileSync(queueFilePath(), 'utf-8')) as { tasks: Array<{ phase: string }> };
    expect(onDisk.tasks[0]?.phase).toBe('cancelled');

    // 迟到的结果：attempt 失效 → 不可写盘
    gate.resolve('# late-after-cancel');
    await sleep(80);
    const manifest = await readWikiManifest(kbPath);
    expect(manifest.ok && manifest.manifest.sources?.[sid]?.status).toBe('failed');

    // 重试：新 attempt，执行成功
    mockToMarkdownBytes.mockResolvedValue('# retried');
    await mgr.retryTask('kb-test', task.taskId);
    const afterRetry = mgr.snapshot('kb-test')!;
    expect(afterRetry.tasks[0]?.phase).toBe('queued');
    expect(afterRetry.tasks[0]?.attempt).toBe(2);
    expect(afterRetry.tasks[0]?.attemptId).not.toBe(task.attemptId);
    await waitFor(() => mgr.snapshot('kb-test')?.tasks[0]?.phase === 'done');
    const manifest2 = await readWikiManifest(kbPath);
    expect(manifest2.ok && manifest2.manifest.sources?.[sid]?.status).toBe('ready');
  });

  it('committing 阶段取消被拒绝（正在提交），提交完成后任务 done', async () => {
    const sid = await importFailedDocx('cancel-committing.docx');
    const gate = deferred<string>();
    mockToMarkdownBytes.mockImplementation(() => gate.promise);
    const mgr = await attachFresh();
    const task = await mgr.enqueueConvert('kb-test', sid);
    await waitFor(() => mgr.snapshot('kb-test')?.tasks[0]?.phase === 'converting');

    const releaseCommit = deferred<void>();
    mockWriteManifest.mockImplementation(async (path, manifest) => {
      const rec = manifest.sources?.[sid];
      if (rec?.status === 'ready') await releaseCommit.promise;
      const actual = await vi.importActual<typeof import('../src/main/kb/wiki-layout')>('../src/main/kb/wiki-layout');
      return actual.writeWikiManifest(path, manifest);
    });
    gate.resolve('# x');
    await waitFor(() => mgr.snapshot('kb-test')?.tasks[0]?.phase === 'committing');

    await expect(mgr.cancelTask('kb-test', task.taskId)).rejects.toMatchObject({ code: 'committing' });

    releaseCommit.resolve();
    await waitFor(() => mgr.snapshot('kb-test')?.tasks[0]?.phase === 'done');
  });

  it('转换失败 → failed + lastError 持久；重试新 attempt 且保留失败原因直到新结果', async () => {
    const sid = await importFailedDocx('retry.docx');
    // 队列重试转换再次失败（encrypted）
    const mgr = await attachFresh();
    const task = await mgr.enqueueConvert('kb-test', sid);
    await waitFor(() => mgr.snapshot('kb-test')?.tasks[0]?.phase === 'failed');
    const failed = mgr.snapshot('kb-test')!;
    expect(failed.tasks[0]?.lastError?.code).toBe('ioError');
    expect(failed.tasks[0]?.lastError?.message).toContain('encrypted');

    // 失败状态持久（事件先于落盘，轮询磁盘等待）
    await waitForQueueDisk((q) => q.tasks[0]?.phase === 'failed');
    const onDisk = JSON.parse(readFileSync(queueFilePath(), 'utf-8')) as {
      tasks: Array<{ phase: string; lastError: { code: string; message: string } | null }>;
    };
    expect(onDisk.tasks[0]?.phase).toBe('failed');
    expect(onDisk.tasks[0]?.lastError?.message).toContain('encrypted');

    // 重试：新 attempt；lastError 保留（失败原因不清除）
    mockToMarkdownBytes.mockRejectedValueOnce(Object.assign(new Error('still locked'), { code: 'encrypted' }));
    await mgr.retryTask('kb-test', task.taskId);
    const retried = mgr.snapshot('kb-test')!;
    expect(retried.tasks[0]?.attempt).toBe(2);
    expect(retried.tasks[0]?.lastError?.message).toContain('encrypted');

    // 再次失败后修复重试 → 成功 → lastError 清除
    await waitFor(() => mgr.snapshot('kb-test')?.tasks[0]?.phase === 'failed');
    mockToMarkdownBytes.mockResolvedValue('# fixed');
    await mgr.retryTask('kb-test', task.taskId);
    await waitFor(() => mgr.snapshot('kb-test')?.tasks[0]?.phase === 'done');
    expect(mgr.snapshot('kb-test')?.tasks[0]?.lastError).toBeNull();
  });

  it('只有 queued 可重排：move 生效于 queued 子序列，converting 不可移动', async () => {
    const s1 = await importReadyText('m1.md', '# 1');
    const s2 = await importReadyText('m2.md', '# 2');
    const s3 = await importReadyText('m3.md', '# 3');
    const mgr = await attachFresh();
    mgr.setWorkerLimit(99);
    // 全部立即执行完 → 清理后用 paused 重新排队
    await waitFor(() => mgr.snapshot('kb-test')?.tasks.every((t) => t.phase === 'done') === true);
    await mgr.clearFinished('kb-test');

    await mgr.pause('kb-test');
    const t1 = await mgr.enqueueConvert('kb-test', s1);
    const t2 = await mgr.enqueueConvert('kb-test', s2);
    const t3 = await mgr.enqueueConvert('kb-test', s3);
    expect(mgr.snapshot('kb-test')?.tasks.map((t) => t.taskId)).toEqual([t1.taskId, t2.taskId, t3.taskId]);

    // 下移 t1 → [t2, t1, t3]
    expect(await mgr.moveTask('kb-test', t1.taskId, 'down')).toBe(true);
    expect(mgr.snapshot('kb-test')?.tasks.map((t) => t.taskId)).toEqual([t2.taskId, t1.taskId, t3.taskId]);
    // 上移 t3（跨过 t1）→ [t2, t3, t1]
    expect(await mgr.moveTask('kb-test', t3.taskId, 'up')).toBe(true);
    expect(mgr.snapshot('kb-test')?.tasks.map((t) => t.taskId)).toEqual([t2.taskId, t3.taskId, t1.taskId]);
    // t1 已在 queued 子序列末尾 → 再下移无效
    expect(await mgr.moveTask('kb-test', t1.taskId, 'down')).toBe(false);

    // 恢复执行后，done 任务不可重排
    await mgr.resume('kb-test');
    await waitFor(() => mgr.snapshot('kb-test')?.tasks.every((t) => t.phase === 'done') === true);
    expect(await mgr.moveTask('kb-test', t1.taskId, 'up')).toBe(false);
  });

  it('clearFinished 只移除 done，保留 failed/cancelled 供查看与重试', async () => {
    const s1 = await importReadyText('c1.md', '# c1');
    const mgr = await attachFresh();
    const t1 = await mgr.enqueueConvert('kb-test', s1);
    await waitFor(() => mgr.snapshot('kb-test')?.tasks[0]?.phase === 'done');

    // 手工构造 cancelled 任务（paused 下入队再取消）
    await mgr.pause('kb-test');
    const s2 = await importReadyText('c2.md', '# c2');
    const t2 = await mgr.enqueueConvert('kb-test', s2);
    await mgr.cancelTask('kb-test', t2.taskId);

    const removed = await mgr.clearFinished('kb-test');
    expect(removed).toBe(1);
    const snap = mgr.snapshot('kb-test')!;
    expect(snap.tasks.map((t) => t.taskId)).toEqual([t2.taskId]);
    expect(snap.tasks[0]?.phase).toBe('cancelled');
    void t1;
  });
});

// ─── 重启恢复 ───────────────────────────────────────────────

describe('重启恢复', () => {
  it('attach 恢复安全状态：converting → queued（新 attempt）并等待继续，不自动执行', async () => {
    const sid = await importFailedDocx('restore.docx');
    // 模拟崩溃遗留：队列文件中有 converting 任务
    const crafted = {
      queueVersion: 1,
      kbId: 'kb-test',
      paused: false,
      seq: 7,
      tasks: [
        {
          taskId: 'task-crashed',
          kbId: 'kb-test',
          kind: 'convertSource',
          sourceId: sid,
          sourcePath: 'restore.docx',
          phase: 'converting',
          attemptId: 'att-dead',
          attempt: 2,
          lastError: null,
          enqueuedAt: '2026-01-01T00:00:00.000Z',
          updatedAt: '2026-01-01T00:00:00.000Z',
        },
      ],
    };
    writeFileSync(queueFilePath(), JSON.stringify(crafted, null, 2));

    const events: WikiTaskEvent[] = [];
    const mgr = makeManager((e) => events.push(e));
    const res = await mgr.attach(kbPath, 'kb-test');
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.restored).toBe(1);
    expect(res.snapshot.tasks[0]?.phase).toBe('queued');
    expect(res.snapshot.tasks[0]?.attempt).toBe(3);
    expect(res.snapshot.tasks[0]?.attemptId).not.toBe('att-dead');
    expect(res.snapshot.restoredWaiting).toBe(true);
    expect(res.snapshot.seq).toBeGreaterThanOrEqual(7);

    // 不自动执行：等待一段时间仍是 queued
    mockToMarkdownBytes.mockImplementation(() => new Promise<string>(() => {}));
    await sleep(100);
    expect(mgr.snapshot('kb-test')?.tasks[0]?.phase).toBe('queued');

    // 继续后才执行
    mockToMarkdownBytes.mockResolvedValue('# restored');
    await mgr.resume('kb-test');
    await waitFor(() => mgr.snapshot('kb-test')?.tasks[0]?.phase === 'done');
    expect(mgr.snapshot('kb-test')?.restoredWaiting).toBe(false);
  });

  it('attach 恢复 paused 标志与 seq 续号；queued 恢复任务同样等待继续', async () => {
    const sid = await importReadyText('hold.md', '# hold');
    const crafted = {
      queueVersion: 1,
      kbId: 'kb-test',
      paused: true,
      seq: 42,
      tasks: [
        {
          taskId: 'task-held',
          kbId: 'kb-test',
          kind: 'convertSource',
          sourceId: sid,
          sourcePath: 'hold.md',
          phase: 'queued',
          attemptId: 'att-held',
          attempt: 1,
          lastError: null,
          enqueuedAt: '2026-01-01T00:00:00.000Z',
          updatedAt: '2026-01-01T00:00:00.000Z',
        },
      ],
    };
    writeFileSync(queueFilePath(), JSON.stringify(crafted, null, 2));

    const mgr = await attachFresh();
    const snap = mgr.snapshot('kb-test')!;
    expect(snap.paused).toBe(true);
    expect(snap.seq).toBeGreaterThanOrEqual(42);
    expect(snap.tasks[0]?.attemptId).toBe('att-held'); // 未执行过的 queued 保留 attempt
    await sleep(80);
    expect(snap.tasks[0]?.phase).toBe('queued'); // 不自动执行

    // resume 后执行且 seq 续号
    await mgr.resume('kb-test');
    await waitFor(() => mgr.snapshot('kb-test')?.tasks[0]?.phase === 'done');
    expect(mgr.snapshot('kb-test')!.seq).toBeGreaterThan(42);
  });

  it('坏队列文件：attach 报 corrupted、文件原样保留（不静默清空）、操作不可用', async () => {
    writeFileSync(queueFilePath(), '{oops broken json');
    const mgr = makeManager();
    const res = await mgr.attach(kbPath, 'kb-test');
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.reason).toBe('corrupted');

    // 文件未被清空/改写
    expect(readFileSync(queueFilePath(), 'utf-8')).toBe('{oops broken json');

    // 队列操作不可用（不静默降级）
    await expect(mgr.enqueueConvert('kb-test', 'whatever')).rejects.toBeInstanceOf(WikiQueueError);
    await expect(mgr.pause('kb-test')).rejects.toBeInstanceOf(WikiQueueError);
    expect(mgr.snapshot('kb-test')).toBeNull();
  });

  it('队列文件 kbId 与库身份不符：拒绝 attach 且不改写文件', async () => {
    const crafted = {
      queueVersion: 1,
      kbId: 'kb-someone-else',
      paused: false,
      seq: 1,
      tasks: [],
    };
    writeFileSync(queueFilePath(), JSON.stringify(crafted));
    const mgr = makeManager();
    const res = await mgr.attach(kbPath, 'kb-test');
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.reason).toBe('kbIdMismatch');
    expect(JSON.parse(readFileSync(queueFilePath(), 'utf-8'))).toMatchObject({ kbId: 'kb-someone-else' });
  });

  it('结构非法的任务记录视为损坏（保留现场）', async () => {
    const crafted = {
      queueVersion: 1,
      kbId: 'kb-test',
      paused: false,
      seq: 1,
      tasks: [{ nonsense: true }],
    };
    writeFileSync(queueFilePath(), JSON.stringify(crafted));
    const mgr = makeManager();
    const res = await mgr.attach(kbPath, 'kb-test');
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.reason).toBe('corrupted');
    expect(readFileSync(queueFilePath(), 'utf-8')).toContain('nonsense');
  });
});

// ─── 持久化失败 ─────────────────────────────────────────────

describe('持久化失败', () => {
  it('入队持久化失败：操作不被确认成功，内存与磁盘均无任务', async () => {
    const sid = await importReadyText('pf.md', '# pf');
    const mgr = await attachFresh();

    // 仅对 queue.json 注入写失败
    mockWriteFileAtomic.mockImplementation(async (filePath, content) => {
      if (String(filePath).endsWith('queue.json')) {
        throw new Error('EACCES: simulated write failure');
      }
      const actual = await vi.importActual<typeof import('../src/main/kb/atomic-commit')>('../src/main/kb/atomic-commit');
      return actual.writeFileAtomic(filePath, content);
    });

    await expect(mgr.enqueueConvert('kb-test', sid)).rejects.toBeInstanceOf(WikiQueueError);
    expect(mgr.snapshot('kb-test')?.tasks).toHaveLength(0);
    expect(existsSync(queueFilePath())).toBe(false);

    // 磁盘恢复后可正常入队
    mockWriteFileAtomic.mockImplementation((...args: Parameters<typeof writeFileAtomic>) =>
      passThroughWriteFileAtomic(...args),
    );
    const task = await mgr.enqueueConvert('kb-test', sid);
    expect(task.phase).toBe('queued');
  });

  it('暂停持久化失败：paused 不生效且操作报错', async () => {
    const mgr = await attachFresh();
    mockWriteFileAtomic.mockImplementation(async (filePath, content) => {
      if (String(filePath).endsWith('queue.json')) {
        throw new Error('disk full');
      }
      const actual = await vi.importActual<typeof import('../src/main/kb/atomic-commit')>('../src/main/kb/atomic-commit');
      return actual.writeFileAtomic(filePath, content);
    });
    await expect(mgr.pause('kb-test')).rejects.toBeInstanceOf(WikiQueueError);
    expect(mgr.snapshot('kb-test')?.paused).toBe(false);
  });
});

// ─── 切库 / 卸载 ────────────────────────────────────────────

describe('切库与卸载', () => {
  it('卸载中止 converting 并持久化 queued；重新 attach 恢复同一队列', async () => {
    const sid = await importFailedDocx('detach.docx');
    const gate = deferred<string>();
    mockToMarkdownBytes.mockImplementation(() => gate.promise);
    const mgr = await attachFresh();
    await mgr.enqueueConvert('kb-test', sid);
    await waitFor(() => mgr.snapshot('kb-test')?.tasks[0]?.phase === 'converting');

    await mgr.detach('kb-test');

    // 内存清空；磁盘上是安全状态
    expect(mgr.snapshot('kb-test')).toBeNull();
    const onDisk = JSON.parse(readFileSync(queueFilePath(), 'utf-8')) as { tasks: Array<{ phase: string }> };
    expect(onDisk.tasks[0]?.phase).toBe('queued');

    // 迟到的转换结果在卸载后不可提交
    gate.resolve('# after-detach');
    await sleep(80);
    const manifest = await readWikiManifest(kbPath);
    expect(manifest.ok && manifest.manifest.sources?.[sid]?.status).toBe('failed');

    // 重新挂载（切库回来）恢复队列并等待继续
    const mgr2 = makeManager();
    const res = await mgr2.attach(kbPath, 'kb-test');
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.snapshot.tasks[0]?.phase).toBe('queued');
    expect(res.snapshot.restoredWaiting).toBe(true);
  });

  it('卸载等待正在提交的工作完成后才返回', async () => {
    const sid = await importFailedDocx('detach-committing.docx');
    const gate = deferred<string>();
    mockToMarkdownBytes.mockImplementation(() => gate.promise);
    const mgr = await attachFresh();
    await mgr.enqueueConvert('kb-test', sid);
    await waitFor(() => mgr.snapshot('kb-test')?.tasks[0]?.phase === 'converting');

    const releaseCommit = deferred<void>();
    mockWriteManifest.mockImplementation(async (path, manifest) => {
      const rec = manifest.sources?.[sid];
      if (rec?.status === 'ready') await releaseCommit.promise;
      const actual = await vi.importActual<typeof import('../src/main/kb/wiki-layout')>('../src/main/kb/wiki-layout');
      return actual.writeWikiManifest(path, manifest);
    });
    gate.resolve('# detach-commit');
    await waitFor(() => mgr.snapshot('kb-test')?.tasks[0]?.phase === 'committing');

    let detachDone = false;
    const detachPromise = mgr.detach('kb-test').then(() => {
      detachDone = true;
    });
    await sleep(80);
    expect(detachDone).toBe(false);

    releaseCommit.resolve();
    await detachPromise;
    expect(detachDone).toBe(true);
    const onDisk = JSON.parse(readFileSync(queueFilePath(), 'utf-8')) as { tasks: Array<{ phase: string }> };
    expect(onDisk.tasks[0]?.phase).toBe('done');
  });

  it('卸载非附着库是 no-op；attach 不同库自动完成旧库握手', async () => {
    const mgr = await attachFresh();
    await expect(mgr.detach('kb-not-attached')).resolves.toBeUndefined();

    // 入队一个任务后切换到另一个库（新库目录）
    const sid = await importReadyText('switch.md', '# switch');
    await mgr.pause('kb-test');
    await mgr.enqueueConvert('kb-test', sid);

    const otherKb = join(tmpdir(), `sv-kb-queue-other-${Date.now()}`);
    mkdirSync(join(otherKb, '.kb'), { recursive: true });
    try {
      await initWikiLayout(otherKb, { kbId: 'kb-other', name: '其他库' });
      const res = await mgr.attach(otherKb, 'kb-other');
      expect(res.ok).toBe(true);
      expect(mgr.snapshot('kb-other')?.kbId).toBe('kb-other');
      // 旧库任务仍在旧库文件中（绑定原任务库）
      const oldOnDisk = JSON.parse(readFileSync(queueFilePath(), 'utf-8')) as { kbId: string; tasks: unknown[] };
      expect(oldOnDisk.kbId).toBe('kb-test');
      expect(oldOnDisk.tasks).toHaveLength(1);
    } finally {
      rmSync(otherKb, { recursive: true, force: true });
    }
  });

  it('旧库目录被外部删除后切库：flush 失败不阻塞新库附着（forceDetach 兜底）', async () => {
    const mgr = await attachFresh();
    // 旧库目录整体被删（外部删除/离线场景）
    rmSync(kbPath, { recursive: true, force: true });

    const otherKb = `${kbPath}-two`;
    mkdirSync(join(otherKb, '.kb'), { recursive: true });
    try {
      await initWikiLayout(otherKb, { kbId: 'kb-other', name: '其他库' });
      const res = await mgr.attach(otherKb, 'kb-other');
      expect(res.ok).toBe(true);
      if (!res.ok) return;
      expect(mgr.snapshot('kb-other')?.kbId).toBe('kb-other');
      expect(mgr.snapshot('kb-test')).toBeNull();
    } finally {
      rmSync(otherKb, { recursive: true, force: true });
    }
  });
});

// ─── abort 契约（source-import 侧） ─────────────────────────

describe('转换中止契约', () => {
  it('convertWikiSource 在 signal 中止后不落任何转换产物', async () => {
    const sid = await importFailedDocx('abort-direct.docx');
    const gate = deferred<string>();
    const started = deferred<void>();
    mockToMarkdownBytes.mockImplementation(() => {
      started.resolve();
      return gate.promise;
    });
    const controller = new AbortController();

    // 直接验证契约：convertWikiSource(signal) 在 engine.convert 返回后发现中止
    const { convertWikiSource } = await import('../src/main/kb/source-import');
    const runPromise = convertWikiSource(kbPath, sid, { signal: controller.signal });
    // 引擎开始时 converting 已落盘；避免轮询读文件与 Windows rename 争用。
    await started.promise;
    const converting = await readWikiManifest(kbPath);
    expect(converting.ok && converting.manifest.sources?.[sid]?.status).toBe('converting');
    controller.abort();
    gate.resolve('# too late');

    await expect(runPromise).rejects.toBeInstanceOf(WikiSourceAbortedError);
    const manifest = await readWikiManifest(kbPath);
    // 被中止的运行不留任何痕迹：converting 标记还原为运行前状态（failed）
    expect(manifest.ok && manifest.manifest.sources?.[sid]?.status).toBe('failed');
  });
});
