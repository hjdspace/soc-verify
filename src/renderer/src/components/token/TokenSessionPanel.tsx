/**
 * TokenSessionPanel — Token Monitor 会话列表面板。
 *
 * Issue #4: 分页表格展示会话列表（会话 ID | 引擎 | 模型 | 开始时间 | 持续时间 |
 * 总 token | cost），支持按引擎筛选、按列排序（时间/token/cost）、分页（每页 50 条）。
 * 点击行展开 per-request 明细（每轮 LLM 调用的详细 token/cost 拆分）。
 *
 * 先例：src/renderer/src/components/token/TokenModelPanel.tsx
 */

import { useEffect, useMemo } from 'react';
import { ArrowDown, ArrowUp, ChevronLeft, ChevronRight } from 'lucide-react';
import {
  useTokenStore,
  type SessionEntry,
  type SessionDetailEntry,
  type SessionSortBy,
  type SessionEngineFilter,
} from '@renderer/stores/token';
import { useProjectStore } from '@renderer/stores/project';
import { cn } from '@renderer/lib/utils';

/** 表格列定义 */
type Column = {
  key: SessionSortBy;
  label: string;
  sortable: boolean;
};

const COLUMNS: Column[] = [
  { key: 'time', label: '开始时间', sortable: true },
  { key: 'tokens', label: '总 Token', sortable: true },
  { key: 'cost', label: 'Cost', sortable: true },
];

/** 持续时间列（不可排序） */
const DURATION_COLUMN = { label: '持续时间' };

const ENGINE_OPTIONS: Array<{ value: SessionEngineFilter; label: string }> = [
  { value: 'all', label: '全部' },
  { value: 'omp', label: 'omp' },
  { value: 'claude-code', label: 'claude-code' },
  { value: 'codex', label: 'codex' },
];

/** 格式化 token 数量 */
function formatTokens(n: number): string {
  return n.toLocaleString('en-US');
}

/** 格式化费用 */
function formatCost(usd: number): string {
  return `$${usd.toFixed(4)}`;
}

/** 格式化时间 */
function formatTime(ts: number): string {
  return new Date(ts).toLocaleString('zh-CN', {
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  });
}

/** 格式化持续时间 */
function formatDuration(ms: number): string {
  if (ms < 1000) return '< 1s';
  const seconds = Math.floor(ms / 1000);
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ${seconds % 60}s`;
  const hours = Math.floor(minutes / 60);
  return `${hours}h ${minutes % 60}m`;
}

export function TokenSessionPanel() {
  const currentProjectId = useProjectStore((s) => s.currentProjectId);
  const sessions = useTokenStore((s) => s.sessions);
  const sessionsTotal = useTokenStore((s) => s.sessionsTotal);
  const sessionDetail = useTokenStore((s) => s.sessionDetail);
  const sessionDetailSessionId = useTokenStore((s) => s.sessionDetailSessionId);
  const sessionEngineFilter = useTokenStore((s) => s.sessionEngineFilter);
  const sessionSortBy = useTokenStore((s) => s.sessionSortBy);
  const sessionSortDir = useTokenStore((s) => s.sessionSortDir);
  const sessionPage = useTokenStore((s) => s.sessionPage);
  const sessionPageSize = useTokenStore((s) => s.sessionPageSize);
  const loadSessions = useTokenStore((s) => s.loadSessions);
  const loadSessionDetail = useTokenStore((s) => s.loadSessionDetail);
  const setSessionEngineFilter = useTokenStore((s) => s.setSessionEngineFilter);
  const setSessionSort = useTokenStore((s) => s.setSessionSort);
  const setSessionPage = useTokenStore((s) => s.setSessionPage);
  const clearSessionDetail = useTokenStore((s) => s.clearSessionDetail);

  useEffect(() => {
    if (!currentProjectId) return;
    void loadSessions(currentProjectId);
  }, [currentProjectId, loadSessions]);

  /** 计算总页数 */
  const totalPages = useMemo(
    () => Math.max(1, Math.ceil(sessionsTotal / sessionPageSize)),
    [sessionsTotal, sessionPageSize],
  );

  /** 处理列头点击排序 */
  function handleSort(key: SessionSortBy) {
    if (sessionSortBy === key) {
      setSessionSort(key, sessionSortDir === 'asc' ? 'desc' : 'asc');
    } else {
      setSessionSort(key, key === 'time' ? 'desc' : 'desc');
    }
  }

  /** 处理引擎筛选变化 */
  function handleEngineFilterChange(e: React.ChangeEvent<HTMLSelectElement>) {
    setSessionEngineFilter(e.target.value as SessionEngineFilter);
  }

  /** 处理行点击（展开/收起明细） */
  function handleRowClick(sessionId: string) {
    if (!currentProjectId) return;
    if (sessionDetailSessionId === sessionId) {
      // Already expanded → collapse
      clearSessionDetail();
    } else {
      void loadSessionDetail(currentProjectId, sessionId);
    }
  }

  /** 处理分页 */
  function handlePageChange(page: number) {
    if (page < 1 || page > totalPages) return;
    setSessionPage(page);
  }

  if (!sessions || sessions.length === 0) {
    return (
      <div className="flex flex-1 items-center justify-center">
        <span className="text-sm text-muted-foreground">暂无会话数据</span>
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-4 p-4">
      {/* ─── 引擎筛选 ────────────────────────────────── */}
      <div className="flex items-center gap-2">
        <label htmlFor="engine-filter" className="text-xs text-muted-foreground">
          引擎筛选
        </label>
        <select
          id="engine-filter"
          data-testid="token-session-engine-filter"
          value={sessionEngineFilter}
          onChange={handleEngineFilterChange}
          className="rounded border border-border bg-card px-2 py-1 text-xs text-foreground"
        >
          {ENGINE_OPTIONS.map((opt) => (
            <option key={opt.value} value={opt.value}>
              {opt.label}
            </option>
          ))}
        </select>
        <span className="text-xs text-muted-foreground">
          共 {sessionsTotal} 个会话
        </span>
      </div>

      {/* ─── 表格 ────────────────────────────────────── */}
      <div
        data-testid="token-session-table"
        className="overflow-hidden rounded-md border border-border bg-card"
      >
        <table className="w-full text-xs">
          <thead className="border-b border-border bg-muted/30">
            <tr>
              <th className="px-3 py-2 text-left font-medium text-muted-foreground">
                会话 ID
              </th>
              <th className="px-3 py-2 text-left font-medium text-muted-foreground">
                引擎
              </th>
              <th className="px-3 py-2 text-left font-medium text-muted-foreground">
                模型
              </th>
              {COLUMNS.map((col) => (
                <th
                  key={col.key}
                  data-testid={`token-session-sort-${col.key}`}
                  onClick={() => col.sortable && handleSort(col.key)}
                  className={cn(
                    'select-none px-3 py-2 text-left font-medium text-muted-foreground',
                    col.sortable && 'cursor-pointer hover:text-foreground',
                  )}
                >
                  <span className="inline-flex items-center gap-1">
                    {col.label}
                    {sessionSortBy === col.key && (
                      sessionSortDir === 'desc'
                        ? <ArrowDown className="size-3" strokeWidth={2} />
                        : <ArrowUp className="size-3" strokeWidth={2} />
                    )}
                  </span>
                </th>
              ))}
              <th className="px-3 py-2 text-left font-medium text-muted-foreground">
                {DURATION_COLUMN.label}
              </th>
              <th className="px-3 py-2 text-left font-medium text-muted-foreground">
                消息数
              </th>
            </tr>
          </thead>
          <tbody>
            {sessions.map((session) => (
              <SessionRow
                key={session.sessionId}
                session={session}
                isExpanded={sessionDetailSessionId === session.sessionId}
                detail={sessionDetailSessionId === session.sessionId ? sessionDetail : []}
                onRowClick={handleRowClick}
              />
            ))}
          </tbody>
        </table>
      </div>

      {/* ─── 分页控件 ────────────────────────────────── */}
      <div
        data-testid="token-session-pagination"
        className="flex items-center justify-center gap-2"
      >
        <button
          type="button"
          data-testid="token-session-page-prev"
          disabled={sessionPage <= 1}
          onClick={() => handlePageChange(sessionPage - 1)}
          className="rounded border border-border p-1 text-muted-foreground hover:text-foreground disabled:opacity-50"
        >
          <ChevronLeft className="size-4" />
        </button>
        <span className="text-xs text-muted-foreground">
          第 {sessionPage} / {totalPages} 页
        </span>
        <button
          type="button"
          data-testid="token-session-page-next"
          disabled={sessionPage >= totalPages}
          onClick={() => handlePageChange(sessionPage + 1)}
          className="rounded border border-border p-1 text-muted-foreground hover:text-foreground disabled:opacity-50"
        >
          <ChevronRight className="size-4" />
        </button>
      </div>
    </div>
  );
}

/** 单行会话 + 展开明细 */
function SessionRow({
  session,
  isExpanded,
  detail,
  onRowClick,
}: {
  session: SessionEntry;
  isExpanded: boolean;
  detail: SessionDetailEntry[];
  onRowClick: (sessionId: string) => void;
}) {
  return (
    <>
      <tr
        data-testid={`token-session-row-${session.sessionId}`}
        onClick={() => onRowClick(session.sessionId)}
        className="cursor-pointer border-b border-border/50 last:border-0 hover:bg-accent/30"
      >
        <td className="px-3 py-2 font-medium text-foreground">
          {session.sessionId}
        </td>
        <td className="px-3 py-2 text-muted-foreground">{session.engine}</td>
        <td className="px-3 py-2 text-muted-foreground">{session.model}</td>
        <td className="px-3 py-2 text-muted-foreground">
          {formatTime(session.startTime)}
        </td>
        <td className="px-3 py-2 text-muted-foreground">
          {formatDuration(session.durationMs)}
        </td>
        <td className="px-3 py-2 text-foreground">
          {formatTokens(session.totalTokens)}
        </td>
        <td className="px-3 py-2 text-foreground">
          {formatCost(session.totalCost)}
        </td>
        <td className="px-3 py-2 text-muted-foreground">
          {session.messageCount}
        </td>
      </tr>
      {isExpanded && detail.length > 0 && (
        <tr className="border-b border-border/50 bg-muted/20">
          <td colSpan={8} className="px-4 py-2">
            <div className="text-xs font-semibold text-muted-foreground mb-1">
              Per-Request 明细
            </div>
            <table className="w-full text-xs">
              <thead>
                <tr className="border-b border-border/30">
                  <th className="px-2 py-1 text-left font-medium text-muted-foreground">时间</th>
                  <th className="px-2 py-1 text-left font-medium text-muted-foreground">模型</th>
                  <th className="px-2 py-1 text-left font-medium text-muted-foreground">Input</th>
                  <th className="px-2 py-1 text-left font-medium text-muted-foreground">Output</th>
                  <th className="px-2 py-1 text-left font-medium text-muted-foreground">Cache Read</th>
                  <th className="px-2 py-1 text-left font-medium text-muted-foreground">Cache Write</th>
                  <th className="px-2 py-1 text-left font-medium text-muted-foreground">Total</th>
                  <th className="px-2 py-1 text-left font-medium text-muted-foreground">Cost</th>
                </tr>
              </thead>
              <tbody>
                {detail.map((entry) => (
                  <tr
                    key={entry.messageId}
                    data-testid={`token-session-detail-${entry.messageId}`}
                    className="border-b border-border/20 last:border-0"
                  >
                    <td className="px-2 py-1 text-muted-foreground">
                      {formatTime(entry.timestamp)}
                    </td>
                    <td className="px-2 py-1 text-muted-foreground">{entry.model}</td>
                    <td className="px-2 py-1 text-muted-foreground">{formatTokens(entry.inputTokens)}</td>
                    <td className="px-2 py-1 text-muted-foreground">{formatTokens(entry.outputTokens)}</td>
                    <td className="px-2 py-1 text-muted-foreground">{formatTokens(entry.cacheReadTokens)}</td>
                    <td className="px-2 py-1 text-muted-foreground">{formatTokens(entry.cacheWriteTokens)}</td>
                    <td className="px-2 py-1 text-foreground">{formatTokens(entry.totalTokens)}</td>
                    <td className="px-2 py-1 text-foreground">{formatCost(entry.costUsd)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </td>
        </tr>
      )}
    </>
  );
}
