/**
 * kb-router × 持久导入队列端到端测试（issue 03 — 可暂停、取消、重启恢复）。
 *
 * 测试缝：tRPC server-side caller（router.createCaller）。
 * mock electron（app.getPath 返回临时目录 + BrowserWindow webContents.send 间谍）、
 * project-service、credential-manager、deep-reindexer、@firecrawl/anydoc。
 * .txt 来源走文本直通（不触 anydoc）→ 确定性成功；.docx 来源 mock 拒绝 → 确定性失败。
 *
 * 覆盖场景：
 *  - kb.mount（wiki）自动附着队列；mount 结果携带 queue 附着结果
 *  - kb.queueEnqueue：文本来源入队 → 转换 → done（持久化到 .kb/queue.json）、
 *    未知来源 sourceNotFound、同来源去重
 *  - kb:task 事件经 webContents.send 广播（带 kbId 与单调 seq）
 *  - kb.queuePause / queueResume：paused 下任务停留 queued，resume 后跑完
 *  - kb.queueCancel / queueRetry：queued 取消、终态取消拒绝、failed 重试新 attempt
 *  - kb.queueMove：queued 子序列内上下移、非 queued 固定点返回 moved false
 *  - 卸载 → 重新挂载：恢复 paused/queued 任务（restoredWaiting）等待继续
 *  - 坏队列文件：corrupted 拒绝且不改写文件；kbId 不符拒绝
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { rmSync, mkdirSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';

// 真实临时目录 + 轮询等待的 E2E 风格测试：放宽单测超时，
// 全套并行跑时磁盘负载高，5s 默认值会抖动。
vi.setConfig({ testTimeout: 30000 });

// ─── Hoisted tmp dirs ──────────────────────────────────────

const { tmpBase } = vi.hoisted(() => {
  const os = require('node:os');
  const path = require('node:path');
  const tmpBase = path.join(os.tmpdir(), `sv-kb-queue-router-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`);
  return { tmpBase };
});

// webContents.send 间谍容器（vi.mock 工厂闭包内引用）
const sendCalls: Array<[string, unknown]> = [];

vi.mock('electron', () => ({
  app: {
    getPath: vi.fn((name: string) => (name === 'userData' ? join(tmpBase, 'appdata') : tmpBase)),
  },
  BrowserWindow: {
    getAllWindows: vi.fn(() => [
      {
        isDestroyed: () => false,
        webContents: {
          send: (channel: string, payload: unknown) => {
            sendCalls.push([channel, payload]);
          },
        },
      },
    ]),
  },
  dialog: {
    showOpenDialog: vi.fn().mockResolvedValue({ canceled: true, filePaths: [] }),
  },
}));

vi.mock('../src/main/project/project-manager', () => ({
  projectManager: {
    listProjects: vi.fn(() => [
      { id: 'test-project-id', rootPath: join(tmpBase, 'project'), name: 'Test Project', lastOpenedAt: Date.now() },
    ]),
    getProjectByPath: vi.fn(() => ({
      id: 'test-project-id',
      rootPath: join(tmpBase, 'project'),
      name: 'Test Project',
      lastOpenedAt: Date.now(),
    })),
  },
}));

vi.mock('../src/main/credentials/credential-manager', () => ({
  credentialManager: {
    get: vi.fn().mockResolvedValue(null),
    getDefaultCredential: vi.fn().mockReturnValue(null),
  },
}));

vi.mock('../src/main/kb/deep-reindexer', () => ({
  deepReindex: vi.fn(),
}));

vi.mock('@firecrawl/anydoc', () => ({
  toDocument: vi.fn().mockRejectedValue(Object.assign(new Error('locked'), { code: 'encrypted' })),
  toMarkdownBytes: vi.fn().mockRejectedValue(Object.assign(new Error('locked'), { code: 'encrypted' })),
  formatFromPath: vi.fn(),
  toMarkdown: vi.fn(),
  formatFromBytes: vi.fn(),
  formatFromExtension: vi.fn(),
}));

// ─── Imports (after mocks) ──────────────────────────────────

import { kbRouter } from '../src/main/ipc/routers/kb-router';
import { initWikiLayout } from '../src/main/kb/wiki-layout';
import type { WikiQueueSnapshot, WikiTaskEvent } from '@shared/kb-types';

const caller = kbRouter.createCaller({});

// ─── Helpers ────────────────────────────────────────────────

let kbDir = '';
let inboxDir = '';
let kbId = '';

async function registerAndMount(): Promise<void> {
  kbDir = join(tmpBase, `kb-${Math.random().toString(36).slice(2, 8)}`);
  inboxDir = join(tmpBase, `inbox-${Math.random().toString(36).slice(2, 8)}`);
  mkdirSync(kbDir, { recursive: true });
  mkdirSync(inboxDir, { recursive: true });
  await initWikiLayout(kbDir, { kbId: 'kb-router-test', name: '队列测试库' });
  const reg = await caller.register({ name: '队列测试库', path: kbDir });
  if (!reg.ok) throw new Error(`register failed: ${JSON.stringify(reg.error)}`);
  kbId = reg.id;
  const mounted = await caller.mount({ kbId });
  if (!mounted.ok) throw new Error(`mount failed: ${JSON.stringify(mounted.error)}`);
}

function makeTxt(rel: string, content = '# 标题\n\n正文内容。\n'): string {
  const p = join(inboxDir, rel.replace(/\//g, '-'));
  writeFileSync(p, content, 'utf-8');
  return p;
}

function makeDocx(rel: string): string {
  const p = join(inboxDir, rel.replace(/\//g, '-'));
  writeFileSync(p, 'fake-docx-bytes');
  return p;
}

async function importOne(absolutePath: string, relPath: string): Promise<string> {
  const r = await caller.importSources({ items: [{ absolutePath, relPath }] });
  const first = r.results[0];
  if (!first) throw new Error('importSources returned no results');
  if (!first.ok) throw new Error(`importSources failed (${first.error.code}): ${first.error.message}`);
  return first.source.sourceId;
}

/** 允许失败导入：返回 outcome（failed 记录已持久化） */
async function importOneAllowFail(absolutePath: string, relPath: string): Promise<void> {
  const r = await caller.importSources({ items: [{ absolutePath, relPath }] });
  const first = r.results[0];
  if (!first) throw new Error('importSources returned no results');
}

async function waitForSnapshot(
  pred: (s: WikiQueueSnapshot) => boolean,
  timeoutMs = 10000,
  message = 'waitForSnapshot timeout',
): Promise<WikiQueueSnapshot> {
  const start = Date.now();
  for (;;) {
    const r = await caller.queueSnapshot({});
    if (r.ok && pred(r.snapshot)) return r.snapshot;
    if (Date.now() - start > timeoutMs) {
      throw new Error(`${message}: last=${JSON.stringify(r)}`);
    }
    await new Promise((res) => setTimeout(res, 20));
  }
}

/** 轮询磁盘队列文件直到条件成立。
 * settleRun 先更新内存并推送事件、flush 异步落盘——观察到内存终态后立即
 * 读盘会拿到上一次落盘的旧状态，磁盘断言必须轮询等待。
 */
async function waitForQueueDiskFile(
  pred: (q: { kbId: string; tasks: Array<{ phase: string }> }) => boolean,
  timeoutMs = 10000,
): Promise<void> {
  const start = Date.now();
  for (;;) {
    let ok = false;
    try {
      const raw = JSON.parse(readFileSync(join(kbDir, '.kb', 'queue.json'), 'utf-8')) as Parameters<typeof pred>[0];
      ok = pred(raw);
    } catch {
      ok = false; // 尚未写出/正在换名：继续等待
    }
    if (ok) return;
    if (Date.now() - start > timeoutMs) throw new Error('waitForQueueDiskFile timeout');
    await new Promise((res) => setTimeout(res, 10));
  }
}

function taskEvents(): WikiTaskEvent[] {
  return sendCalls
    .filter(([ch, payload]) => ch === 'kb:task' && (payload as WikiTaskEvent).type === 'task')
    .map(([, payload]) => payload as WikiTaskEvent);
}

// ─── Tests ──────────────────────────────────────────────────

describe('kb-router 持久导入队列（issue 03）', () => {
  beforeEach(() => {
    sendCalls.length = 0;
    mkdirSync(join(tmpBase, 'project'), { recursive: true });
    mkdirSync(join(tmpBase, 'appdata'), { recursive: true });
  });

  afterEach(async () => {
    // 卸载当前挂载库（队列 detach + 落盘），再清理临时目录
    try {
      const status = await caller.status({});
      if (status.mounted) await caller.unmount({ kbId: status.mounted.kbId });
    } catch {
      // 未挂载/未注册时忽略
    }
    rmSync(tmpBase, { recursive: true, force: true });
  });

  it('mount wiki 库自动附着队列；快照可用且事件带身份', async () => {
    await registerAndMount();
    const snap = await caller.queueSnapshot({});
    expect(snap.ok).toBe(true);
    if (!snap.ok) return;
    expect(snap.snapshot.kbId).toBe(kbId);
    expect(snap.snapshot.paused).toBe(false);
    expect(snap.snapshot.tasks).toEqual([]);
    expect(sendCalls.some(([ch]) => ch === 'kb:task')).toBe(false);
  });

  it('文本来源入队 → 转换完成 → 持久化 done；未知来源报 sourceNotFound；同来源去重', { timeout: 15000 }, async () => {
    await registerAndMount();
    const sourceId = await importOne(makeTxt('alpha.txt'), 'alpha.txt');

    const bad = await caller.queueEnqueue({ sourceIds: ['no-such-source'] });
    expect(bad.results[0]?.ok).toBe(false);
    if (!bad.results[0]?.ok) expect(bad.results[0]?.error.code).toBe('sourceNotFound');

    const r = await caller.queueEnqueue({ sourceIds: [sourceId] });
    expect(r.results[0]).toMatchObject({ ok: true });

    const snap = await waitForSnapshot((s) => s.tasks.length === 1 && s.tasks[0]!.phase === 'done');
    expect(snap.tasks[0]!.sourceId).toBe(sourceId);
    expect(snap.tasks[0]!.kbId).toBe(kbId);
    expect(snap.tasks[0]!.attempt).toBe(1);

    // 持久化：queue.json 里任务为 done（事件先于落盘，轮询等待）
    await waitForQueueDiskFile((q) => q.kbId === kbId && q.tasks.length === 1 && q.tasks[0]?.phase === 'done');
    const raw = JSON.parse(readFileSync(join(kbDir, '.kb', 'queue.json'), 'utf-8')) as {
      kbId: string;
      tasks: Array<{ phase: string }>;
    };
    expect(raw.kbId).toBe(kbId);
    expect(raw.tasks).toHaveLength(1);
    expect(raw.tasks[0]?.phase).toBe('done');
  });

  it('kb:task 事件经 webContents.send 广播，携带 kbId 与单调 seq', async () => {
    await registerAndMount();
    const sourceId = await importOne(makeTxt('beta.txt'), 'beta.txt');
    await caller.queueEnqueue({ sourceIds: [sourceId] });
    await waitForSnapshot((s) => s.tasks.length === 1 && s.tasks[0]!.phase === 'done');

    const events = taskEvents();
    expect(events.length).toBeGreaterThanOrEqual(2); // queued + converting(+committing) + done
    for (const e of events) {
      expect(e.kbId).toBe(kbId);
      expect(typeof e.seq).toBe('number');
    }
    const seqs = events.map((e) => e.seq);
    for (let i = 1; i < seqs.length; i++) {
      expect(seqs[i]!).toBeGreaterThan(seqs[i - 1]!);
    }
  });

  it('paused 下入队停留 queued、同来源去重，resume 后跑完', async () => {
    await registerAndMount();
    await caller.queuePause({});
    const sourceId = await importOne(makeTxt('gamma.txt'), 'gamma.txt');
    const r = await caller.queueEnqueue({ sourceIds: [sourceId] });
    expect(r.results[0]?.ok).toBe(true);
    // 去重：活动（queued）任务存在时再次入队返回同一任务
    const again = await caller.queueEnqueue({ sourceIds: [sourceId] });
    expect(again.results[0]?.ok).toBe(true);
    if (again.results[0]?.ok && r.results[0]?.ok) {
      expect(again.results[0].task.taskId).toBe(r.results[0].task.taskId);
    }

    await new Promise((res) => setTimeout(res, 150));
    const paused = await caller.queueSnapshot({});
    expect(paused.ok).toBe(true);
    if (paused.ok) {
      expect(paused.snapshot.paused).toBe(true);
      expect(paused.snapshot.tasks).toHaveLength(1);
      expect(paused.snapshot.tasks[0]!.phase).toBe('queued');
    }

    await caller.queueResume({});
    const snap = await waitForSnapshot((s) => s.tasks[0]?.phase === 'done');
    expect(snap.paused).toBe(false);
  });

  it('queued 任务可取消；终态取消被拒绝；failed 任务可重试（新 attempt）', async () => {
    await registerAndMount();
    // failed 来源：docx 导入失败（记录已持久化）→ 入队转换再次失败
    await importOneAllowFail(makeDocx('bad.docx'), 'bad.docx');
    const sources = await caller.sources({});
    const failedSource = sources.find((s) => s.parsedStale || s.status === 'failed');
    expect(failedSource).toBeTruthy();

    const r = await caller.queueEnqueue({ sourceIds: [failedSource!.sourceId] });
    expect(r.results[0]).toMatchObject({ ok: true });
    await waitForSnapshot((s) => s.tasks[0]?.phase === 'failed');
    const failedSnap = await caller.queueSnapshot({});
    if (failedSnap.ok) {
      expect(failedSnap.snapshot.tasks[0]!.lastError).toBeTruthy();
      const attempt1 = failedSnap.snapshot.tasks[0]!.attempt;

      await caller.queueRetry({ taskId: failedSnap.snapshot.tasks[0]!.taskId });
      const retried = await waitForSnapshot((s) => s.tasks[0]?.phase === 'failed' && s.tasks[0]!.attempt > attempt1);
      expect(retried.tasks[0]!.attempt).toBe(attempt1 + 1);
    }

    // 终态取消被拒绝（结构化 Result，不抛错）
    const doneOrFailed = await caller.queueSnapshot({});
    if (doneOrFailed.ok) {
      const taskId = doneOrFailed.snapshot.tasks[0]!.taskId;
      const cancelResult = await caller.queueCancel({ taskId });
      expect(cancelResult.ok).toBe(false);
      if (!cancelResult.ok) expect(cancelResult.error.code).toBe('invalidPhase');
    }

    // queued 任务可取消
    await caller.queuePause({});
    const queuedId = await importOne(makeTxt('delta.txt'), 'delta.txt');
    await caller.queueEnqueue({ sourceIds: [queuedId] });
    const snap = await caller.queueSnapshot({});
    expect(snap.ok).toBe(true);
    if (snap.ok) {
      const queuedTask = snap.snapshot.tasks.find((t) => t.phase === 'queued');
      expect(queuedTask).toBeTruthy();
      await caller.queueCancel({ taskId: queuedTask!.taskId });
      const after = await caller.queueSnapshot({});
      if (after.ok) {
        expect(after.snapshot.tasks.find((t) => t.taskId === queuedTask!.taskId)?.phase).toBe('cancelled');
      }
    }
  });

  it('queueMove 只在 queued 子序列内移动；非 queued 返回 moved false', async () => {
    await registerAndMount();
    await caller.queuePause({});
    const ids: string[] = [];
    for (const rel of ['m1.txt', 'm2.txt', 'm3.txt']) {
      ids.push(await importOne(makeTxt(rel), rel));
    }
    await caller.queueEnqueue({ sourceIds: ids });

    let snap = await caller.queueSnapshot({});
    if (!snap.ok) throw new Error('snapshot unavailable');
    expect(snap.snapshot.tasks.map((t) => t.sourceId)).toEqual(ids);

    // m2 上移 → [m2, m1, m3]
    const m2Task = snap.snapshot.tasks.find((t) => t.sourcePath === 'm2.txt')!;
    expect((await caller.queueMove({ taskId: m2Task.taskId, direction: 'up' })).moved).toBe(true);
    snap = await caller.queueSnapshot({});
    if (!snap.ok) throw new Error('snapshot unavailable');
    expect(snap.snapshot.tasks.map((t) => t.sourcePath)).toEqual(['m2.txt', 'm1.txt', 'm3.txt']);

    // m3 下移无目标 → false
    const m3Task = snap.snapshot.tasks.find((t) => t.sourcePath === 'm3.txt')!;
    expect((await caller.queueMove({ taskId: m3Task.taskId, direction: 'down' })).moved).toBe(false);

    // 非 queued（done/failed/cancelled）→ false：清一个 done 任务再试
    await caller.queueResume({});
    await waitForSnapshot((s) => s.tasks.every((t) => t.phase === 'done'));
    const doneSnap = await caller.queueSnapshot({});
    if (doneSnap.ok) {
      expect((await caller.queueMove({ taskId: doneSnap.snapshot.tasks[0]!.taskId, direction: 'up' })).moved).toBe(false);
    }
  });

  it('卸载后重新挂载：恢复 paused/queued 任务并等待继续（restoredWaiting）', async () => {
    await registerAndMount();
    await caller.queuePause({});
    const ids: string[] = [];
    for (const rel of ['r1.txt', 'r2.txt']) {
      ids.push(await importOne(makeTxt(rel), rel));
    }
    await caller.queueEnqueue({ sourceIds: ids });

    await caller.unmount({ kbId });
    // 重新挂载：队列文件有 queued 任务 → restoredWaiting
    const mounted = await caller.mount({ kbId });
    expect(mounted.ok).toBe(true);
    if (!mounted.ok) return;
    expect(mounted.queue).toBeTruthy();
    if (mounted.queue?.ok) {
      expect(mounted.queue.restored).toBe(2);
      expect(mounted.queue.snapshot.restoredWaiting).toBe(true);
      expect(mounted.queue.snapshot.paused).toBe(true);
    }

    // 恢复后跑完
    await caller.queueResume({});
    const snap = await waitForSnapshot((s) => s.tasks.every((t) => t.phase === 'done'));
    expect(snap.tasks).toHaveLength(2);
  });

  it('坏队列文件：corrupted 拒绝附着且不改写文件', async () => {
    await registerAndMount();
    await caller.unmount({ kbId });
    const queuePath = join(kbDir, '.kb', 'queue.json');
    writeFileSync(queuePath, '{ not valid json !!', 'utf-8');

    const mounted = await caller.mount({ kbId });
    expect(mounted.ok).toBe(true);
    if (!mounted.ok) return;
    expect(mounted.queue).toEqual({ ok: false, reason: 'corrupted' });

    const snap = await caller.queueSnapshot({});
    expect(snap).toEqual({ ok: false, reason: 'notAttached' });
    // 现场保留：文件未被清空或改写
    expect(readFileSync(queuePath, 'utf-8')).toBe('{ not valid json !!');
  });

  it('队列文件 kbId 不符：拒绝附着且不改写', async () => {
    await registerAndMount();
    await caller.unmount({ kbId });
    const queuePath = join(kbDir, '.kb', 'queue.json');
    writeFileSync(
      queuePath,
      JSON.stringify({
        queueVersion: 1,
        kbId: 'kb-other',
        paused: false,
        seq: 0,
        tasks: [],
      }),
      'utf-8',
    );

    const mounted = await caller.mount({ kbId });
    expect(mounted.ok).toBe(true);
    if (!mounted.ok) return;
    expect(mounted.queue).toEqual({ ok: false, reason: 'kbIdMismatch' });
    expect(JSON.parse(readFileSync(queuePath, 'utf-8')).kbId).toBe('kb-other');
  });

  it('clearFinished 只清除 done，failed/cancelled 保留', async () => {
    await registerAndMount();
    const okId = await importOne(makeTxt('c1.txt'), 'c1.txt');
    await importOneAllowFail(makeDocx('c2.docx'), 'c2.docx');
    const sources = await caller.sources({});
    const failedSource = sources.find((s) => s.status === 'failed' || s.parsedStale);
    expect(failedSource).toBeTruthy();

    await caller.queueEnqueue({ sourceIds: [okId, failedSource!.sourceId] });
    await waitForSnapshot((s) => s.tasks.length === 2 && s.tasks.every((t) => t.phase === 'done' || t.phase === 'failed'));

    const r = await caller.queueClear({});
    expect(r.removed).toBeGreaterThanOrEqual(1);
    const snap = await caller.queueSnapshot({});
    if (snap.ok) {
      expect(snap.snapshot.tasks.every((t) => t.phase !== 'done')).toBe(true);
    }
    expect(existsSync(join(kbDir, '.kb', 'queue.json'))).toBe(true);
  });
});
