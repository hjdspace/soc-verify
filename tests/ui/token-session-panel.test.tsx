// @vitest-environment jsdom
import { render, screen, fireEvent, waitFor, act } from '@testing-library/react';
import { describe, it, expect, beforeEach, vi } from 'vitest';
import React from 'react';

/* ── trpc mock ── */
const mockSessionsQuery = vi.fn();
const mockSessionDetailQuery = vi.fn();

vi.mock('@renderer/lib/trpc', () => ({
  trpc: {
    token: {
      summary: { query: vi.fn() },
      trends: { query: vi.fn() },
      engineBreakdown: { query: vi.fn() },
      modelBreakdown: { query: vi.fn() },
      sessions: { query: (...args: unknown[]) => mockSessionsQuery(...args) },
      sessionDetail: { query: (...args: unknown[]) => mockSessionDetailQuery(...args) },
    },
  },
}));

/* ── toast store mock ── */
vi.mock('@renderer/stores/toast', () => ({
  useToastStore: {
    getState: () => ({ error: vi.fn() }),
  },
}));

/* ── project store mock ── */
const projectState = vi.hoisted(() => ({ currentProjectId: 'proj-1' as string | null }));
vi.mock('@renderer/stores/project', () => ({
  useProjectStore: (selector: (s: { currentProjectId: string | null }) => unknown) =>
    selector(projectState),
}));

import { TokenSessionPanel } from '@renderer/components/token/TokenSessionPanel';
import { useTokenStore } from '@renderer/stores/token';

const MOCK_SESSIONS = {
  sessions: [
    {
      sessionId: 'sess-1',
      engine: 'omp',
      model: 'claude-sonnet-4-20250514',
      startTime: Date.now() - 10 * 60 * 1000,
      endTime: Date.now() - 5 * 60 * 1000,
      durationMs: 5 * 60 * 1000,
      totalTokens: 1500,
      totalCost: 0.07,
      messageCount: 2,
    },
    {
      sessionId: 'sess-2',
      engine: 'claude-code',
      model: 'gpt-4o',
      startTime: Date.now() - 20 * 60 * 1000,
      endTime: Date.now() - 15 * 60 * 1000,
      durationMs: 5 * 60 * 1000,
      totalTokens: 2000,
      totalCost: 0.10,
      messageCount: 1,
    },
  ],
  total: 2,
};

const MOCK_SESSION_DETAIL = [
  {
    messageId: 'msg-1',
    model: 'claude-sonnet-4-20250514',
    inputTokens: 800,
    outputTokens: 200,
    cacheReadTokens: 100,
    cacheWriteTokens: 50,
    totalTokens: 1000,
    costUsd: 0.05,
    timestamp: Date.now() - 10 * 60 * 1000,
  },
  {
    messageId: 'msg-2',
    model: 'claude-sonnet-4-20250514',
    inputTokens: 400,
    outputTokens: 100,
    cacheReadTokens: 50,
    cacheWriteTokens: 0,
    totalTokens: 500,
    costUsd: 0.02,
    timestamp: Date.now() - 8 * 60 * 1000,
  },
];

beforeEach(() => {
  vi.clearAllMocks();
  projectState.currentProjectId = 'proj-1';
  useTokenStore.setState({
    summary: null,
    trends: [],
    engineBreakdown: [],
    modelBreakdown: [],
    sessions: [],
    sessionsTotal: 0,
    sessionDetail: [],
    sessionDetailSessionId: null,
    loading: false,
    error: null,
    timeRange: 'all',
    trendGroupBy: 'engine',
    sessionEngineFilter: 'all',
    sessionSortBy: 'time',
    sessionSortDir: 'desc',
    sessionPage: 1,
    sessionPageSize: 50,
    loadedForProject: null,
  });
});

describe('TokenSessionPanel — 渲染', () => {
  it('无数据显示空状态', () => {
    render(<TokenSessionPanel />);
    expect(screen.getByText('暂无会话数据')).toBeInTheDocument();
  });

  it('有数据时渲染表格', () => {
    useTokenStore.setState({
      sessions: MOCK_SESSIONS.sessions,
      sessionsTotal: MOCK_SESSIONS.total,
    });
    render(<TokenSessionPanel />);
    expect(screen.getByTestId('token-session-table')).toBeInTheDocument();
  });

  it('渲染所有会话行', () => {
    useTokenStore.setState({
      sessions: MOCK_SESSIONS.sessions,
      sessionsTotal: MOCK_SESSIONS.total,
    });
    render(<TokenSessionPanel />);
    expect(screen.getByText('sess-1')).toBeInTheDocument();
    expect(screen.getByText('sess-2')).toBeInTheDocument();
  });

  it('渲染表头列', () => {
    useTokenStore.setState({
      sessions: MOCK_SESSIONS.sessions,
      sessionsTotal: MOCK_SESSIONS.total,
    });
    render(<TokenSessionPanel />);
    expect(screen.getByText('会话 ID')).toBeInTheDocument();
    expect(screen.getByText('引擎')).toBeInTheDocument();
    expect(screen.getByText('模型')).toBeInTheDocument();
    expect(screen.getByText('开始时间')).toBeInTheDocument();
    expect(screen.getByText('持续时间')).toBeInTheDocument();
    expect(screen.getByText('总 Token')).toBeInTheDocument();
    expect(screen.getByText('Cost')).toBeInTheDocument();
  });

  it('渲染引擎筛选下拉框', () => {
    useTokenStore.setState({
      sessions: MOCK_SESSIONS.sessions,
      sessionsTotal: MOCK_SESSIONS.total,
    });
    render(<TokenSessionPanel />);
    expect(screen.getByTestId('token-session-engine-filter')).toBeInTheDocument();
  });
});

describe('TokenSessionPanel — 数据加载', () => {
  it('挂载时加载会话列表', async () => {
    mockSessionsQuery.mockResolvedValue(MOCK_SESSIONS);

    render(<TokenSessionPanel />);

    await waitFor(() => {
      expect(mockSessionsQuery).toHaveBeenCalledWith({
        projectId: 'proj-1',
        engine: undefined,
        sortBy: 'time',
        sortDir: 'desc',
        page: 1,
        pageSize: 50,
      });
    });
  });

  it('无项目 ID 时不加载', () => {
    projectState.currentProjectId = null;
    render(<TokenSessionPanel />);
    expect(mockSessionsQuery).not.toHaveBeenCalled();
  });
});

describe('TokenSessionPanel — 引擎筛选', () => {
  it('选择引擎筛选后重新加载', async () => {
    mockSessionsQuery.mockResolvedValue(MOCK_SESSIONS);
    render(<TokenSessionPanel />);

    // Wait for initial load
    await waitFor(() => {
      expect(mockSessionsQuery).toHaveBeenCalled();
    });

    // Select engine filter
    const filterSelect = screen.getByTestId('token-session-engine-filter');
    fireEvent.change(filterSelect, { target: { value: 'omp' } });

    await waitFor(() => {
      expect(mockSessionsQuery).toHaveBeenLastCalledWith(
        expect.objectContaining({ engine: 'omp' }),
      );
    });
  });
});

describe('TokenSessionPanel — 排序交互', () => {
  it('点击列头切换排序方向', async () => {
    mockSessionsQuery.mockResolvedValue(MOCK_SESSIONS);
    useTokenStore.setState({
      sessions: MOCK_SESSIONS.sessions,
      sessionsTotal: MOCK_SESSIONS.total,
    });
    const { rerender } = render(<TokenSessionPanel />);

    // Wait for initial load to complete
    await waitFor(() => {
      expect(mockSessionsQuery).toHaveBeenCalled();
    });

    // Click "总 Token" header → sort by tokens descending
    await act(async () => {
      fireEvent.click(screen.getByTestId('token-session-sort-tokens'));
    });
    rerender(<TokenSessionPanel />);

    await waitFor(() => {
      expect(mockSessionsQuery).toHaveBeenLastCalledWith(
        expect.objectContaining({ sortBy: 'tokens', sortDir: 'desc' }),
      );
    });

    // Click again → ascending
    await act(async () => {
      fireEvent.click(screen.getByTestId('token-session-sort-tokens'));
    });
    rerender(<TokenSessionPanel />);

    await waitFor(() => {
      expect(mockSessionsQuery).toHaveBeenLastCalledWith(
        expect.objectContaining({ sortBy: 'tokens', sortDir: 'asc' }),
      );
    });
  });

  it('点击 Cost 列头按 cost 排序', async () => {
    mockSessionsQuery.mockResolvedValue(MOCK_SESSIONS);
    useTokenStore.setState({
      sessions: MOCK_SESSIONS.sessions,
      sessionsTotal: MOCK_SESSIONS.total,
    });
    const { rerender } = render(<TokenSessionPanel />);

    // Wait for initial load to complete
    await waitFor(() => {
      expect(mockSessionsQuery).toHaveBeenCalled();
    });

    await act(async () => {
      fireEvent.click(screen.getByTestId('token-session-sort-cost'));
    });
    rerender(<TokenSessionPanel />);

    await waitFor(() => {
      expect(mockSessionsQuery).toHaveBeenLastCalledWith(
        expect.objectContaining({ sortBy: 'cost', sortDir: 'desc' }),
      );
    });
  });
});

describe('TokenSessionPanel — 分页', () => {
  it('显示分页控件', () => {
    useTokenStore.setState({
      sessions: MOCK_SESSIONS.sessions,
      sessionsTotal: 100,
    });
    render(<TokenSessionPanel />);
    expect(screen.getByTestId('token-session-pagination')).toBeInTheDocument();
  });

  it('点击下一页触发加载', async () => {
    mockSessionsQuery.mockResolvedValue({ ...MOCK_SESSIONS, total: 100 });
    useTokenStore.setState({
      sessions: MOCK_SESSIONS.sessions,
      sessionsTotal: 100,
    });
    const { rerender } = render(<TokenSessionPanel />);

    // Wait for initial load to complete
    await waitFor(() => {
      expect(mockSessionsQuery).toHaveBeenCalled();
    });

    await act(async () => {
      const nextBtn = screen.getByTestId('token-session-page-next');
      fireEvent.click(nextBtn);
    });
    rerender(<TokenSessionPanel />);

    await waitFor(() => {
      expect(mockSessionsQuery).toHaveBeenLastCalledWith(
        expect.objectContaining({ page: 2 }),
      );
    });
  });
});

describe('TokenSessionPanel — 展开明细', () => {
  it('点击行展开 per-request 明细', async () => {
    mockSessionsQuery.mockResolvedValue(MOCK_SESSIONS);
    mockSessionDetailQuery.mockResolvedValue(MOCK_SESSION_DETAIL);
    useTokenStore.setState({
      sessions: MOCK_SESSIONS.sessions,
      sessionsTotal: MOCK_SESSIONS.total,
    });
    render(<TokenSessionPanel />);

    // Click on session row
    fireEvent.click(screen.getByTestId('token-session-row-sess-1'));

    await waitFor(() => {
      expect(mockSessionDetailQuery).toHaveBeenCalledWith({
        projectId: 'proj-1',
        sessionId: 'sess-1',
      });
    });
  });

  it('展开后显示明细数据', () => {
    useTokenStore.setState({
      sessions: MOCK_SESSIONS.sessions,
      sessionsTotal: MOCK_SESSIONS.total,
      sessionDetail: MOCK_SESSION_DETAIL,
      sessionDetailSessionId: 'sess-1',
    });
    render(<TokenSessionPanel />);

    // Detail rows should be visible
    expect(screen.getByTestId('token-session-detail-msg-1')).toBeInTheDocument();
    expect(screen.getByTestId('token-session-detail-msg-2')).toBeInTheDocument();
  });
});
