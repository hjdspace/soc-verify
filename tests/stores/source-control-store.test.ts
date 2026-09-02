/**
 * source-control store 的 refreshStatus 测试：
 *
 * 文件树 watcher 事件（filetree:update）触发的轻量 git 状态刷新：
 * - 防抖合并：防抖窗口内的多次调用只发一次 git status 请求
 * - inflight 去重：请求进行中再次触发不会重复请求
 * - 只更新 status：不清空 SCM 面板正在查看的展开 diff 状态
 * - 失败静默：后台刷新失败不弹 toast、不抛错
 */
import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import type { SourceControlStatus } from '@shared/types';

const { statusQuery } = vi.hoisted(() => ({ statusQuery: vi.fn() }));

vi.mock('@renderer/lib/trpc', () => ({
  trpc: {
    scm: {
      status: { query: statusQuery },
    },
  },
}));

const { toastError } = vi.hoisted(() => ({ toastError: vi.fn() }));

vi.mock('@renderer/stores/toast', () => ({
  useToastStore: {
    getState: () => ({ error: toastError, success: vi.fn(), warning: vi.fn(), info: vi.fn() }),
  },
}));

import { useSourceControlStore } from '@renderer/stores/source-control';

function makeStatus(overrides: Partial<SourceControlStatus> = {}): SourceControlStatus {
  return {
    isRepository: true,
    branch: 'main',
    ahead: 0,
    behind: 0,
    files: [],
    ...overrides,
  };
}

describe('source-control store refreshStatus', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    statusQuery.mockReset();
    statusQuery.mockResolvedValue(makeStatus());
    useSourceControlStore.setState({
      status: null,
      expandedDiffKeys: {},
      fileDiffs: {},
      loadingDiffKeys: {},
    });
  });

  afterEach(async () => {
    // 冲刷模块级防抖 timer / inflight，避免跨测试泄漏
    await vi.runAllTimersAsync();
    vi.useRealTimers();
  });

  it('合并防抖窗口内的多次调用为一次请求，并更新 status', async () => {
    const finalStatus = makeStatus({ files: [], branch: 'feature' });
    statusQuery.mockResolvedValue(finalStatus);

    const store = useSourceControlStore.getState();
    void store.refreshStatus('p1');
    void store.refreshStatus('p1');
    void store.refreshStatus('p1');

    // 防抖窗口内不发请求
    await vi.advanceTimersByTimeAsync(499);
    expect(statusQuery).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(1);
    expect(statusQuery).toHaveBeenCalledTimes(1);
    expect(statusQuery).toHaveBeenCalledWith({ projectId: 'p1' });
    expect(useSourceControlStore.getState().status?.branch).toBe('feature');
  });

  it('请求进行中再次触发不会重复请求（inflight 去重）', async () => {
    let resolveQuery!: (s: SourceControlStatus) => void;
    statusQuery.mockImplementationOnce(
      () => new Promise<SourceControlStatus>((res) => { resolveQuery = res; }),
    );

    const first = useSourceControlStore.getState().refreshStatus('p1');
    await vi.advanceTimersByTimeAsync(500); // 第一轮防抖到期，请求发出（pending）

    const second = useSourceControlStore.getState().refreshStatus('p1');
    await vi.advanceTimersByTimeAsync(500); // 第二轮防抖到期，复用 inflight

    resolveQuery(makeStatus());
    await Promise.all([first, second]);

    expect(statusQuery).toHaveBeenCalledTimes(1);
  });

  it('只更新 status，不清空 SCM 面板的展开 diff 状态', async () => {
    useSourceControlStore.setState({
      expandedDiffKeys: { 'w:src/a.ts': true },
      fileDiffs: { 'w:src/a.ts': { path: 'src/a.ts', patch: '...' } as never },
      loadingDiffKeys: { 'w:src/a.ts': false },
    });

    const p = useSourceControlStore.getState().refreshStatus('p1');
    await vi.advanceTimersByTimeAsync(500); // 推进防抖定时器
    await p;

    const state = useSourceControlStore.getState();
    expect(state.status).not.toBeNull();
    expect(state.expandedDiffKeys).toEqual({ 'w:src/a.ts': true });
    expect(state.fileDiffs['w:src/a.ts']).toBeDefined();
  });

  it('失败静默：不弹 toast、不抛错、status 保持原值', async () => {
    const prevStatus = makeStatus({ branch: 'main' });
    useSourceControlStore.setState({ status: prevStatus });
    statusQuery.mockRejectedValue(new Error('git died'));

    const p = useSourceControlStore.getState().refreshStatus('p1');
    await vi.advanceTimersByTimeAsync(500); // 推进防抖定时器
    await expect(p).resolves.toBeUndefined();

    expect(toastError).not.toHaveBeenCalled();
    expect(useSourceControlStore.getState().status).toBe(prevStatus);
  });
});
