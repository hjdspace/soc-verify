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
  queueClearMutate: vi.fn(),
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
      queueClear: { mutate: mocks.queueClearMutate.mockResolvedValue({ removed: 1 }) },
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
    mocks.queueClearMutate.mockResolvedValue({ removed: 1 });
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
});
