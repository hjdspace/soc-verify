// @vitest-environment jsdom
/**
 * KbWikiTasks 任务面板行为测试（issue 03 — 队列 UI 可操作 + 事件回归）。
 *
 * 覆盖：
 *  - 快照渲染：任务行（阶段标签/attempt/失败原因）、来源列表与加入队列
 *  - kb:task 事件回归：seq 更新时任务阶段实时刷新（旧 seq 忽略）
 *  - 队列控制：暂停/继续、清除已完成、restoredWaiting 继续横幅
 *  - 任务操作：queued 取消、failed 重试
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import React from 'react';

// ─── Hoisted mock data ──────────────────────────────────────

const { snapshot, sources } = vi.hoisted(() => {
  const snapshot = {
    kbId: 'kb-1',
    paused: false,
    seq: 10,
    restoredWaiting: false,
    lastPersistError: null,
    tasks: [
      {
        taskId: 'task-1',
        kbId: 'kb-1',
        kind: 'convertSource',
        sourceId: 'sid-1',
        sourcePath: 'docs/alpha.md',
        phase: 'queued',
        attemptId: 'att-1',
        attempt: 1,
        lastError: null,
        enqueuedAt: '2026-01-01T00:00:00.000Z',
        updatedAt: '2026-01-01T00:00:00.000Z',
      },
      {
        taskId: 'task-2',
        kbId: 'kb-1',
        kind: 'convertSource',
        sourceId: 'sid-2',
        sourcePath: 'docs/beta.docx',
        phase: 'failed',
        attemptId: 'att-2',
        attempt: 2,
        lastError: { code: 'encrypted', message: '文档已加密，无法读取', at: '2026-01-01T00:00:01.000Z' },
        usage: { inputTokens: 1_200, outputTokens: 340 },
        retryCount: 2,
        enqueuedAt: '2026-01-01T00:00:00.000Z',
        updatedAt: '2026-01-01T00:00:01.000Z',
      },
    ],
  };
  const sources = [
    {
      sourceId: 'sid-1',
      sourcePath: 'docs/alpha.md',
      ext: '.md',
      size: 100,
      revision: 'r1',
      revisionShort: 'r1',
      status: 'ready',
      parsedRevision: 'r1',
      parsedHash: 'h1',
      parsedStale: false,
      assetCount: 0,
      importedAt: '2026-01-01T00:00:00.000Z',
      updatedAt: '2026-01-01T00:00:00.000Z',
    },
    {
      sourceId: 'sid-9',
      sourcePath: 'docs/gamma.txt',
      ext: '.txt',
      size: 50,
      revision: 'r2',
      revisionShort: 'r2',
      status: 'ready',
      parsedRevision: 'r2',
      parsedHash: 'h2',
      parsedStale: false,
      assetCount: 0,
      importedAt: '2026-01-01T00:00:00.000Z',
      updatedAt: '2026-01-01T00:00:00.000Z',
    },
  ];
  return { snapshot, sources };
});

// ─── Mock tRPC ──────────────────────────────────────────────

const mocks = vi.hoisted(() => ({
  queueSnapshotQuery: vi.fn(),
  queueEnqueueMutate: vi.fn(),
  queuePauseMutate: vi.fn(),
  queueResumeMutate: vi.fn(),
  queueCancelMutate: vi.fn(),
  queueRetryMutate: vi.fn(),
  queueContinueTextOnlyMutate: vi.fn(),
  queueClearMutate: vi.fn(),
  wikiCompileEnqueueMutate: vi.fn(),
}));

vi.mock('@renderer/lib/trpc', () => ({
  trpc: {
    kb: {
      sources: {
        query: vi.fn().mockResolvedValue(sources),
        useQuery: vi.fn(() => ({ data: sources, isLoading: false })),
      },
      queueSnapshot: { query: mocks.queueSnapshotQuery },
      queueEnqueue: { mutate: mocks.queueEnqueueMutate.mockResolvedValue({ results: [{ ok: true }] }) },
      queuePause: { mutate: mocks.queuePauseMutate.mockResolvedValue({ ok: true }) },
      queueResume: { mutate: mocks.queueResumeMutate.mockResolvedValue({ ok: true }) },
      queueCancel: { mutate: mocks.queueCancelMutate.mockResolvedValue({ ok: true }) },
      queueRetry: { mutate: mocks.queueRetryMutate.mockResolvedValue({ ok: true }) },
      queueContinueTextOnly: { mutate: mocks.queueContinueTextOnlyMutate.mockResolvedValue({ ok: true }) },
      queueClear: { mutate: mocks.queueClearMutate.mockResolvedValue({ removed: 1 }) },
      wikiCompileEnqueue: { mutate: mocks.wikiCompileEnqueueMutate.mockResolvedValue({ results: [{ ok: true }] }) },
    },
  },
}));

// ─── Mock toast store ───────────────────────────────────────

vi.mock('@renderer/stores/toast', () => ({
  useToastStore: Object.assign(
    vi.fn((selector: (s: Record<string, unknown>) => unknown) =>
      selector({ success: vi.fn(), error: vi.fn(), warning: vi.fn(), info: vi.fn() }),
    ),
    { getState: vi.fn(() => ({ success: vi.fn(), error: vi.fn(), warning: vi.fn(), info: vi.fn() })) },
  ),
}));

// ─── Mock eventBridge ───────────────────────────────────────

const kbTaskCallbacks: Array<(e: unknown) => void> = [];

beforeEach(() => {
  kbTaskCallbacks.length = 0;
  (window as unknown as { eventBridge: unknown }).eventBridge = {
    onKbTask: (callback: (e: unknown) => void) => {
      kbTaskCallbacks.push(callback);
      return () => {
        const idx = kbTaskCallbacks.indexOf(callback);
        if (idx >= 0) kbTaskCallbacks.splice(idx, 1);
      };
    },
  };
});

afterEach(() => {
  delete (window as unknown as { eventBridge?: unknown }).eventBridge;
});

// ─── Import after mocks ─────────────────────────────────────

import { KbWikiTasks } from '@renderer/components/kb/KbWikiTasks';
import { useKbQueueStore } from '@renderer/stores/kb-queue';

function resetQueueStore() {
  useKbQueueStore.setState({
    snapshot: null,
    snapshotState: 'idle',
  });
}

describe('KbWikiTasks 导入任务面板（issue 03）', () => {
  beforeEach(() => {
    resetQueueStore();
    vi.clearAllMocks();
    // clearAllMocks 不恢复实现：重立 resolve 值
    mocks.queueSnapshotQuery.mockResolvedValue({ ok: true, snapshot });
    mocks.queueEnqueueMutate.mockResolvedValue({ results: [{ ok: true }] });
    mocks.queuePauseMutate.mockResolvedValue({ ok: true });
    mocks.queueResumeMutate.mockResolvedValue({ ok: true });
    mocks.queueCancelMutate.mockResolvedValue({ ok: true });
    mocks.queueRetryMutate.mockResolvedValue({ ok: true });
    mocks.queueContinueTextOnlyMutate.mockResolvedValue({ ok: true });
    mocks.queueClearMutate.mockResolvedValue({ removed: 1 });
    mocks.wikiCompileEnqueueMutate.mockResolvedValue({ results: [{ ok: true }] });
  });

  it('拉取快照并渲染任务阶段与失败原因；来源列表可加入队列', async () => {
    render(<KbWikiTasks />);

    await waitFor(() => expect(screen.getByText('docs/alpha.md')).toBeTruthy());
    expect(screen.getByText('docs/beta.docx')).toBeTruthy();
    // 阶段标签
    expect(screen.getByText('排队中')).toBeTruthy();
    expect(screen.getByText('失败')).toBeTruthy();
    // 失败原因可见
    expect(screen.getByText(/文档已加密，无法读取/)).toBeTruthy();
    // attempt 展示
    expect(screen.getByText(/第 2 次尝试/)).toBeTruthy();

    // 来源列表 + 加入队列
    expect(screen.getByText('docs/gamma.txt')).toBeTruthy();
    const enqueueButtons = screen.getAllByTitle('加入队列');
    expect(enqueueButtons.length).toBeGreaterThanOrEqual(1);
    fireEvent.click(enqueueButtons[enqueueButtons.length - 1]!);
    await waitFor(() =>
      expect(mocks.queueEnqueueMutate).toHaveBeenCalledWith({ sourceIds: ['sid-9'] }),
    );
  });

  it('来源列表可触发编译（issue 08）：wikiCompileEnqueue 入队', async () => {
    render(<KbWikiTasks />);

    await waitFor(() => expect(screen.getByText('docs/gamma.txt')).toBeTruthy());
    const compileButtons = screen.getAllByTitle(/编译为知识页/);
    expect(compileButtons.length).toBeGreaterThanOrEqual(1);
    fireEvent.click(compileButtons[compileButtons.length - 1]!);
    await waitFor(() =>
      expect(mocks.wikiCompileEnqueueMutate).toHaveBeenCalledWith({ sourceId: 'sid-9' }),
    );
  });

  it('kb:task 事件按 seq 应用：任务阶段实时刷新，旧 seq 忽略', async () => {
    render(<KbWikiTasks />);
    await waitFor(() => expect(screen.getByText('排队中')).toBeTruthy());
    expect(kbTaskCallbacks.length).toBe(1);

    // 新事件：task-1 转换完成（seq 前进）
    kbTaskCallbacks[0]!({
      type: 'task',
      kbId: 'kb-1',
      seq: 11,
      taskId: 'task-1',
      attemptId: 'att-1',
      phase: 'done',
      lastError: null,
    });
    await waitFor(() => expect(screen.getByText('完成')).toBeTruthy());

    // 旧 seq 事件：被忽略（task-2 的 seq 10 事件不应改变界面状态依据）
    kbTaskCallbacks[0]!({
      type: 'task',
      kbId: 'kb-1',
      seq: 5,
      taskId: 'task-1',
      attemptId: 'att-1',
      phase: 'queued',
      lastError: null,
    });
    await waitFor(() => expect(screen.getByText('完成')).toBeTruthy());
  });

  it('restoredWaiting 显示继续横幅；点击调用 resume', async () => {
    mocks.queueSnapshotQuery.mockResolvedValue({
      ok: true,
      snapshot: { ...snapshot, restoredWaiting: true },
    });
    render(<KbWikiTasks />);

    const banner = await screen.findByText(/检测到上次中断的任务/);
    expect(banner).toBeTruthy();
    const resumeBtn = screen.getByTitle('继续处理队列任务');
    fireEvent.click(resumeBtn);
    await waitFor(() => expect(mocks.queueResumeMutate).toHaveBeenCalled());
  });

  it('队列控制：暂停/清除已完成可操作', async () => {
    render(<KbWikiTasks />);
    await waitFor(() => expect(screen.getByText('docs/alpha.md')).toBeTruthy());

    fireEvent.click(screen.getByTitle('暂停队列'));
    await waitFor(() => expect(mocks.queuePauseMutate).toHaveBeenCalled());

    fireEvent.click(screen.getByTitle('清除已完成任务'));
    await waitFor(() => expect(mocks.queueClearMutate).toHaveBeenCalled());
  });

  it('任务操作：queued 任务可取消，failed 任务可重试', async () => {
    render(<KbWikiTasks />);
    await waitFor(() => expect(screen.getByText('docs/alpha.md')).toBeTruthy());

    fireEvent.click(screen.getByTitle('取消任务'));
    await waitFor(() =>
      expect(mocks.queueCancelMutate).toHaveBeenCalledWith({ taskId: 'task-1' }),
    );

    fireEvent.click(screen.getByTitle('重试任务'));
    await waitFor(() =>
      expect(mocks.queueRetryMutate).toHaveBeenCalledWith({ taskId: 'task-2' }),
    );
  });

  it('任务行展示重试次数与 usage（issue 09），失败原因同时可见', async () => {
    render(<KbWikiTasks />);
    await waitFor(() => expect(screen.getByText('docs/beta.docx')).toBeTruthy());

    expect(screen.getByText('已重试 2 次')).toBeTruthy();
    expect(screen.getByText('tokens 入 1200 / 出 340')).toBeTruthy();
    expect(screen.getByText(/文档已加密，无法读取/)).toBeTruthy();
  });

  it('kb:task 事件可刷新重试次数与 usage（issue 09）', async () => {
    render(<KbWikiTasks />);
    await waitFor(() => expect(screen.getByText('排队中')).toBeTruthy());

    kbTaskCallbacks[0]!({
      type: 'task',
      kbId: 'kb-1',
      seq: 11,
      taskId: 'task-1',
      attemptId: 'att-1',
      phase: 'done',
      lastError: null,
      usage: { inputTokens: 50, outputTokens: 20 },
      retryCount: 1,
    });
    await waitFor(() => expect(screen.getByText('已重试 1 次')).toBeTruthy());
    expect(screen.getByText('tokens 入 50 / 出 20')).toBeTruthy();
  });

  it('分段进度可见（issue 10）：事件里的 done/total 渲染为「分段 n/m」', async () => {
    render(<KbWikiTasks />);
    await waitFor(() => expect(screen.getByText('排队中')).toBeTruthy());

    kbTaskCallbacks[0]!({
      type: 'task',
      kbId: 'kb-1',
      seq: 11,
      taskId: 'task-1',
      attemptId: 'att-1',
      phase: 'analyzing',
      lastError: null,
      progress: { done: 3, total: 12 },
    });
    await waitFor(() => expect(screen.getByText('分段 3/12')).toBeTruthy());
    expect(screen.getByText('分析中')).toBeTruthy();
  });

  it('blocked 任务（issue 10）：显示「已阻塞」、原因与可用的重试入口', async () => {
    render(<KbWikiTasks />);
    await waitFor(() => expect(screen.getByText('排队中')).toBeTruthy());

    kbTaskCallbacks[0]!({
      type: 'task',
      kbId: 'kb-1',
      seq: 11,
      taskId: 'task-1',
      attemptId: 'att-1',
      phase: 'blocked',
      lastError: { code: 'contextBudgetExceeded', message: '可用输入预算不足', at: '2026-01-01T00:00:02.000Z' },
      progress: null,
    });

    await waitFor(() => expect(screen.getByText('已阻塞')).toBeTruthy());
    expect(screen.getByText(/可用输入预算不足/)).toBeTruthy();
    // blocked 可重试（补齐预算后继续）
    const retryButtons = screen.getAllByTitle(/重试任务/);
    expect(retryButtons.length).toBeGreaterThanOrEqual(1);
  });

  // ── 批量读图进度与缓存命中（issue 13）────────────────────────

  it('vision 阶段进度显示解读进度与缓存命中（issue 13）：视觉 n/m · 复用 r', async () => {
    render(<KbWikiTasks />);
    await waitFor(() => expect(screen.getByText('排队中')).toBeTruthy());

    kbTaskCallbacks[0]!({
      type: 'task',
      kbId: 'kb-1',
      seq: 11,
      taskId: 'task-1',
      attemptId: 'att-1',
      phase: 'vision',
      lastError: null,
      progress: { done: 30, total: 61, reused: 20 },
    });
    await waitFor(() => expect(screen.getByText('视觉 30/61')).toBeTruthy());
    expect(screen.getByText('复用 20')).toBeTruthy();
    expect(screen.getByText('视觉解析')).toBeTruthy();
  });

  it('非 vision 阶段的进度仍显示分段（issue 10 回归）', async () => {
    render(<KbWikiTasks />);
    await waitFor(() => expect(screen.getByText('排队中')).toBeTruthy());

    kbTaskCallbacks[0]!({
      type: 'task',
      kbId: 'kb-1',
      seq: 12,
      taskId: 'task-1',
      attemptId: 'att-1',
      phase: 'analyzing',
      lastError: null,
      progress: { done: 3, total: 12 },
    });
    await waitFor(() => expect(screen.getByText('分段 3/12')).toBeTruthy());
  });

  it('visionBatchLimit → blocked 显示继续批次/缩小范围两个入口（issue 13）', async () => {
    render(<KbWikiTasks />);
    await waitFor(() => expect(screen.getByText('排队中')).toBeTruthy());

    kbTaskCallbacks[0]!({
      type: 'task',
      kbId: 'kb-1',
      seq: 11,
      taskId: 'task-1',
      attemptId: 'att-1',
      phase: 'blocked',
      lastError: {
        code: 'visionBatchLimit',
        message: '图像解读达到单批页数上限，待处理页共 11 页。',
        at: '2026-01-01T00:00:02.000Z',
      },
      progress: null,
    });

    await waitFor(() => expect(screen.getByText('已阻塞')).toBeTruthy());
    expect(screen.getByText(/待处理页共 11 页/)).toBeTruthy();
    // 重试 = 继续下一批（已成功解读复用）；仅按文字继续 = 缩小范围
    expect(screen.getByTitle(/继续下一批/)).toBeTruthy();
    const textOnly = screen.getByTestId('continue-text-only');
    fireEvent.click(textOnly);
    await waitFor(() =>
      expect(mocks.queueContinueTextOnlyMutate).toHaveBeenCalledWith({ taskId: 'task-1' }),
    );
  });
});
