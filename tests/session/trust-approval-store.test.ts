// @vitest-environment jsdom
/**
 * session-approval store —— trust 请求队列与决议（issue 04）。
 *
 * 覆盖：onTrustRequest 入队、resolveTrust 移除并调 trpc、自动展开右面板。
 * 先例：tests/ui/dashboard-panel.test.tsx（eventBridge mock）、
 *       tests/session/session-store.test.ts（trpc mock）。
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';

const { resolveTrustMutateMock, toggleRightPanelMock } = vi.hoisted(() => ({
  resolveTrustMutateMock: vi.fn(async () => ({ ok: true })),
  toggleRightPanelMock: vi.fn(),
}));

vi.mock('@renderer/lib/trpc', () => ({
  trpc: {
    session: {
      resolveTrust: { mutate: resolveTrustMutateMock },
      resolveApproval: { mutate: vi.fn(async () => ({ ok: true })) },
      resolveAsk: { mutate: vi.fn(async () => ({ ok: true })) },
      setApprovalMode: { mutate: vi.fn(async () => ({}) ) },
    },
  },
}));

vi.mock('@renderer/stores/toast', () => ({
  useToastStore: {
    getState: () => ({ success: vi.fn(), error: vi.fn(), info: vi.fn() }),
  },
}));

vi.mock('@renderer/stores/ui', () => ({
  useUiStore: {
    getState: () => ({
      rightPanelCollapsed: true,
      toggleRightPanel: toggleRightPanelMock,
    }),
  },
}));

vi.mock('@renderer/stores/session-core', () => ({
  useSessionCoreStore: {
    getState: () => ({ currentSessionId: 'session_1', sessions: [] }),
    setState: vi.fn(),
  },
}));

import { useSessionApprovalStore } from '@renderer/stores/session-approval';

type TrustListener = (data: { sessionId: string; requestId: string; kind: string; name: string; path?: string }) => void;

// store 内部注册标志是模块级的（生产语义：renderer 生命周期内注册一次），
// 因此整个文件只注册一次，各用例复用同一监听器引用。
let trustListener: TrustListener | null = null;

beforeEach(() => {
  vi.clearAllMocks();
  (window as unknown as { eventBridge: unknown }).eventBridge = {
    onTrustRequest: (callback: TrustListener) => {
      trustListener = callback;
      return () => {
        trustListener = null;
      };
    },
  };
  useSessionApprovalStore.getState().registerApprovalEventListeners();
  useSessionApprovalStore.setState({ trustRequests: [], approvalRequests: [], askRequests: [] });
});

describe('session-approval store — trust 请求（issue 04）', () => {
  it('onTrustRequest 事件入队 trustRequests', () => {
    expect(trustListener).not.toBeNull();
    trustListener!({
      sessionId: 'session_1',
      requestId: 'trust_1',
      kind: 'mcp-server',
      name: 'traceweave',
      path: '/proj/.mcp.json',
    });

    const { trustRequests } = useSessionApprovalStore.getState();
    expect(trustRequests).toHaveLength(1);
    expect(trustRequests[0]).toMatchObject({
      requestId: 'trust_1',
      sessionId: 'session_1',
      kind: 'mcp-server',
      name: 'traceweave',
    });
  });

  it('右面板折叠时入队自动展开', () => {
    trustListener!({ sessionId: 's', requestId: 'trust_2', kind: 'project-extension', name: 'ext' });
    expect(toggleRightPanelMock).toHaveBeenCalled();
  });

  it('resolveTrust 移除队列项并调用 trpc.session.resolveTrust（kind 随请求透传）', async () => {
    trustListener!({ sessionId: 's', requestId: 'trust_3', kind: 'mcp-server', name: 'alpha' });
    expect(useSessionApprovalStore.getState().trustRequests).toHaveLength(1);

    await useSessionApprovalStore.getState().resolveTrust('trust_3', true);

    expect(resolveTrustMutateMock).toHaveBeenCalledWith({ requestId: 'trust_3', approved: true, kind: 'mcp-server' });
    expect(useSessionApprovalStore.getState().trustRequests).toHaveLength(0);
  });

  it('队列中不存在的 requestId 不调用 mutate（幂等忽略）', async () => {
    await useSessionApprovalStore.getState().resolveTrust('missing', true);
    expect(resolveTrustMutateMock).not.toHaveBeenCalled();
  });

  it('重复注册监听器幂等（不重复入队）', () => {
    const first = trustListener;
    useSessionApprovalStore.getState().registerApprovalEventListeners();
    expect(trustListener).toBe(first);
  });
});
