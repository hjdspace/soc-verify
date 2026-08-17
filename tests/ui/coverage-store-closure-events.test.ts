// @vitest-environment jsdom
/**
 * Coverage store Closure 事件缝测试（Issue 06/07）。
 *
 * 验证 handleClosureEvent 对 closure 事件流的 live 状态归约：
 * - agent_prompting / recovery_started / agent_ended → agentPhase 流转
 * - gap_escalated → lastEscalation 记录 + 活跃 target 清空（详情页升级原因展示的数据源）
 * - exclusion_suggested → live 状态无变化（审批面板自行拉取），loadClosure 兜底刷新
 * - completed / aborted → running=false
 * - 非当前 closure 的事件被忽略
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { useCoverageStore } from '@renderer/stores/coverage';

// ─── 依赖 mock ───────────────────────────────────────────────────

const getClosureQuery = vi.fn();

vi.mock('@renderer/lib/trpc', () => ({
  trpc: {
    coverage: {
      getClosure: { query: (...args: unknown[]) => getClosureQuery(...args) },
      listClosures: { query: vi.fn().mockResolvedValue([]) },
    },
  },
}));

vi.mock('@renderer/stores/project', () => ({
  useProjectStore: {
    getState: () => ({ currentProjectId: 'proj-1' }),
  },
}));

vi.mock('@renderer/stores/toast', () => ({
  useToastStore: {
    getState: () => ({ error: vi.fn(), success: vi.fn() }),
  },
}));

// ─── 测试 ────────────────────────────────────────────────────────

/** 等待 fire-and-forget 的 loadClosure 微任务完成 */
function flushAsync(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 10));
}

describe('coverage store handleClosureEvent（closure 事件缝）', () => {
  beforeEach(() => {
    getClosureQuery.mockReset();
    getClosureQuery.mockResolvedValue({
      id: 'c1',
      sessionId: 'merge-1',
      createdAt: 0,
      status: 'running',
      targets: [],
      maxRounds: 5,
      escalationThreshold: 2,
      workspaceDir: '/tmp/c1',
    });
    useCoverageStore.setState({
      currentClosureId: 'c1',
      currentClosure: null,
      closureLive: { running: false },
    });
  });

  it('agent_prompting → agentPhase=prompting 且 running=true', () => {
    useCoverageStore.getState().handleClosureEvent({
      type: 'closure:agent_prompting',
      closureId: 'c1',
      targetId: 't1',
      round: 1,
      sessionId: 'agent-1',
    });

    const live = useCoverageStore.getState().closureLive;
    expect(live.running).toBe(true);
    expect(live.agentPhase).toBe('prompting');
  });

  it('recovery_started → agentPhase=recovering；recovery_done → 记录 lastDeltaOverall 并清空 phase', () => {
    const store = useCoverageStore.getState();
    store.handleClosureEvent({ type: 'closure:recovery_started', closureId: 'c1', targetId: 't1', round: 1 });
    expect(useCoverageStore.getState().closureLive.agentPhase).toBe('recovering');

    store.handleClosureEvent({ type: 'closure:recovery_done', closureId: 'c1', targetId: 't1', round: 1, deltaOverall: 2.5 });
    const live = useCoverageStore.getState().closureLive;
    expect(live.agentPhase).toBeUndefined();
    expect(live.lastDeltaOverall).toBe(2.5);
  });

  it('gap_escalated → 记录 lastEscalation 并清空活跃 target（详情页升级原因数据源）', () => {
    useCoverageStore.setState({
      closureLive: { running: true, activeTargetId: 't1', activeRound: 2, agentPhase: 'prompting' },
    });

    useCoverageStore.getState().handleClosureEvent({
      type: 'closure:gap_escalated',
      closureId: 'c1',
      targetId: 't1',
      reason: '连续 2 轮 overall delta < 1%',
    });

    const live = useCoverageStore.getState().closureLive;
    expect(live.lastEscalation).toEqual({ targetId: 't1', reason: '连续 2 轮 overall delta < 1%' });
    expect(live.activeTargetId).toBeUndefined();
    expect(live.activeRound).toBeUndefined();
    expect(live.agentPhase).toBeUndefined();
  });

  it('exclusion_suggested → live 状态无变化，loadClosure 兜底刷新（工单 07 缝）', async () => {
    const before = { running: true, activeTargetId: 't1', activeRound: 1, agentPhase: 'ended' as const };
    useCoverageStore.setState({ closureLive: { ...before } });

    useCoverageStore.getState().handleClosureEvent({
      type: 'closure:exclusion_suggested',
      closureId: 'c1',
      targetId: 't1',
      round: 1,
      count: 2,
    });

    // live 状态不变（审批面板自行拉取建议数据）
    expect(useCoverageStore.getState().closureLive).toEqual(before);

    // 兜底 loadClosure 被触发
    await flushAsync();
    expect(getClosureQuery).toHaveBeenCalledWith({ projectId: 'proj-1', closureId: 'c1' });
  });

  it('completed → running=false 且活跃 target 清空', () => {
    useCoverageStore.setState({
      closureLive: { running: true, activeTargetId: 't1', activeRound: 3, agentPhase: 'ended' },
    });

    useCoverageStore.getState().handleClosureEvent({
      type: 'closure:completed',
      closureId: 'c1',
    });

    const live = useCoverageStore.getState().closureLive;
    expect(live.running).toBe(false);
    expect(live.activeTargetId).toBeUndefined();
    expect(live.activeRound).toBeUndefined();
  });

  it('非当前 closure 的事件被忽略（不更新 live、不触发刷新）', async () => {
    useCoverageStore.setState({ closureLive: { running: false } });

    useCoverageStore.getState().handleClosureEvent({
      type: 'closure:agent_prompting',
      closureId: 'other-closure',
      targetId: 't9',
      round: 1,
      sessionId: 'agent-9',
    });

    expect(useCoverageStore.getState().closureLive.running).toBe(false);

    await flushAsync();
    expect(getClosureQuery).not.toHaveBeenCalled();
  });

  it('缺 closureId 的事件直接忽略', () => {
    useCoverageStore.setState({ closureLive: { running: false } });

    useCoverageStore.getState().handleClosureEvent({
      type: 'closure:agent_prompting',
      targetId: 't1',
    });

    expect(useCoverageStore.getState().closureLive.running).toBe(false);
  });
});
