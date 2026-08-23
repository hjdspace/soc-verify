import type { SessionEntry } from '@renderer/stores/session';
import { useSessionStore } from '@renderer/stores/session';
import { useDashboardStore } from '@renderer/stores/dashboard';
import { useUiStore } from '@renderer/stores/ui';
import { cn } from '@renderer/lib/utils';

type RcaPill = { label: string; tone: 'running' | 'done' } | null;

/** RCA 状态：查 session store 中该用例的错误分析会话（[仿真分析]/[编译修复] 前缀） */
function rcaStatusFor(sessions: SessionEntry[], caseName: string): RcaPill {
  const prefixes = [`[仿真分析] ${caseName}`, `[编译修复] ${caseName}`];
  const session = sessions.find((s) => prefixes.includes(s.name));
  if (!session) return null;
  if (session.status === 'streaming' || session.status === 'tool_executing' || session.status === 'creating') {
    return { label: 'AI 分析中', tone: 'running' };
  }
  return { label: '已分析', tone: 'done' };
}

/**
 * 失败聚焦：最近失败记录按用例聚合（失败次数 pill），RCA 状态映射自
 * 该用例的错误分析 AI 会话。数据只读复用 dashboard / session store。
 */
export function FailureFocusPanel() {
  const recentFailures = useDashboardStore((s) => s.recentFailures);
  const loadingTab = useDashboardStore((s) => s.loadingTab);
  const tabLoaded = useDashboardStore((s) => s.tabLoaded);
  const sessions = useSessionStore((s) => s.sessions);
  const setActiveView = useUiStore((s) => s.setActiveView);

  const loading = loadingTab === 'failures' && !tabLoaded.failures;

  const groups = new Map<string, { subsys: string; count: number; lastStart: number }>();
  if (recentFailures) {
    for (const f of recentFailures) {
      const prev = groups.get(f.caseName);
      groups.set(f.caseName, {
        subsys: f.subsys,
        count: (prev?.count ?? 0) + 1,
        lastStart: Math.max(prev?.lastStart ?? 0, new Date(f.startTime).getTime()),
      });
    }
  }
  const rows = [...groups.entries()]
    .map(([caseName, g]) => ({ caseName, ...g, rca: rcaStatusFor(sessions, caseName) }))
    .sort((a, b) => b.count - a.count || b.lastStart - a.lastStart);

  return (
    <div className="flex min-w-0 flex-col overflow-hidden rounded-xl border border-border bg-card">
      <div className="flex items-center gap-2 border-b border-border px-3.5 py-2.5 text-xs font-semibold text-foreground">
        失败聚焦
        {rows.length > 0 && (
          <span className="rounded-full bg-status-fail/15 px-[7px] font-mono text-[10px] font-normal text-status-fail-foreground">
            {recentFailures?.length ?? 0}
          </span>
        )}
        <button
          className="ml-auto cursor-pointer text-[11px] font-normal text-muted-foreground transition-colors hover:text-foreground"
          onClick={() => setActiveView('simulation')}
        >
          全部失败 →
        </button>
      </div>

      {loading ? (
        <div className="flex flex-col gap-2 p-4" data-testid="failure-panel-skeleton">
          <div className="h-3 w-5/6 animate-pulse rounded bg-muted" />
          <div className="h-3 w-4/6 animate-pulse rounded bg-muted" />
          <div className="h-3 w-3/6 animate-pulse rounded bg-muted" />
        </div>
      ) : rows.length === 0 ? (
        <div className="px-3.5 py-6 text-center text-xs text-muted-foreground/70" data-testid="failure-panel-empty">
          暂无失败用例
        </div>
      ) : (
        rows.map((row) => (
          <div
            key={row.caseName}
            className="grid grid-cols-[1fr_130px_80px_80px] items-center gap-2.5 border-b border-border px-3.5 py-2 text-xs last:border-b-0"
            data-testid={`fail-row-${row.caseName}`}
          >
            <span className="truncate font-mono text-[11.5px] text-foreground">{row.caseName}</span>
            <span className="truncate text-[11px] text-muted-foreground">{row.subsys}</span>
            <span className="inline-block w-fit rounded bg-status-fail/15 px-2 py-0.5 text-[10px] font-medium text-status-fail-foreground">
              ×{row.count}
            </span>
            {row.rca && (
              <span
                className={cn(
                  'inline-block w-fit rounded px-2 py-0.5 text-[10px] font-medium',
                  row.rca.tone === 'running'
                    ? 'bg-warning/15 text-warning-foreground'
                    : 'bg-primary/15 text-primary',
                )}
                data-testid={`rca-pill-${row.caseName}`}
              >
                {row.rca.label}
              </span>
            )}
          </div>
        ))
      )}
    </div>
  );
}
