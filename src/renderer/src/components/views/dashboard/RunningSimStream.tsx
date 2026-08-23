import { useEffect, useState } from 'react';
import { useSimulationStore, type SimulationRunRecord } from '@renderer/stores/simulation';
import { useUiStore } from '@renderer/stores/ui';
import { useWorkbenchStore } from '@renderer/stores/workbench';
import { cn } from '@renderer/lib/utils';

/** 状态点颜色（对照原型 `.status-dot`） */
function dotClass(status: SimulationRunRecord['status']): string {
  switch (status) {
    case 'running': return 'bg-status-running animate-pulse';
    case 'pass': return 'bg-status-pass';
    case 'fail':
    case 'error': return 'bg-status-fail';
    case 'pending': return 'bg-muted-foreground/40';
    default: return 'bg-status-aborted';
  }
}

function formatDuration(ms: number): string {
  if (ms < 0) ms = 0;
  const s = Math.floor(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m`;
  return `${Math.floor(m / 60)}h${m % 60}m`;
}

/**
 * 运行中仿真流行。
 * 真实数据无进度/ETA 字段：运行中显示 indeterminate 脉冲进度条 + 实时耗时，
 * 终态显示全宽状态条 + 总时长（不伪造百分比与 ETA）。
 */
function RunRow({ run, now }: { run: SimulationRunRecord; now: number }) {
  const isRunning = run.status === 'running' || run.status === 'pending';
  const duration = isRunning
    ? now - run.startTime
    : run.endTime
      ? run.endTime - run.startTime
      : 0;

  return (
    <div
      className="grid cursor-pointer grid-cols-[18px_1fr_110px_130px_90px] items-center gap-2.5 border-b border-border px-3.5 py-2 transition-colors last:border-b-0 hover:bg-accent"
      data-testid={`run-row-${run.runId}`}
    >
      <span className={cn('size-2 shrink-0 rounded-full', dotClass(run.status))} />
      <div className="min-w-0 overflow-hidden font-mono text-xs text-foreground">
        <span className="block truncate">{run.caseName ?? run.caseId}</span>
      </div>
      <span className="truncate text-[11px] text-muted-foreground">{run.subsys}</span>
      <div className="h-1 overflow-hidden rounded-sm bg-background">
        {run.status === 'running' && (
          <div className="h-full w-1/3 animate-pulse rounded-sm bg-status-running" />
        )}
        {run.status === 'pending' && null}
        {(run.status === 'pass') && <div className="h-full w-full rounded-sm bg-status-pass" />}
        {(run.status === 'fail' || run.status === 'error') && (
          <div className="h-full w-full rounded-sm bg-status-fail" />
        )}
        {run.status === 'aborted' && <div className="h-full w-full rounded-sm bg-status-aborted" />}
      </div>
      <span
        className={cn(
          'shrink-0 text-right font-mono text-[11px] text-muted-foreground',
          (run.status === 'fail' || run.status === 'error') && 'text-status-fail-foreground',
        )}
      >
        {run.status === 'fail' || run.status === 'error'
          ? `失败 · ${formatDuration(duration)}`
          : formatDuration(duration)}
      </span>
    </div>
  );
}

/**
 * 运行中仿真流面板：数据复用 simulation store 的 activeRuns
 * （排序逻辑与 RunningCasesPanel 一致：运行中优先、最新在前）。
 */
export function RunningSimStream() {
  const activeRuns = useSimulationStore((s) => s.activeRuns);
  const setActiveView = useUiStore((s) => s.setActiveView);
  const open = useWorkbenchStore((s) => s.open);
  const [now, setNow] = useState(() => Date.now());

  const hasLive = activeRuns.some((r) => r.status === 'running' || r.status === 'pending');
  useEffect(() => {
    if (!hasLive) return;
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, [hasLive]);

  const runningCount = activeRuns.filter((r) => r.status === 'running' || r.status === 'pending').length;
  const sorted = [...activeRuns].sort((a, b) => {
    const rank = (r: SimulationRunRecord) =>
      r.status === 'running' || r.status === 'pending' ? 0 : r.status === 'fail' || r.status === 'error' ? 1 : 2;
    if (rank(a) !== rank(b)) return rank(a) - rank(b);
    return b.startTime - a.startTime;
  });

  return (
    <div className="flex min-w-0 flex-col overflow-hidden rounded-xl border border-border bg-card">
      <div className="flex items-center gap-2 border-b border-border px-3.5 py-2.5 text-xs font-semibold text-foreground">
        运行中仿真
        <span className="rounded-full bg-primary/15 px-[7px] font-mono text-[10px] font-normal text-primary">
          {runningCount}
        </span>
        <button
          className="ml-auto cursor-pointer text-[11px] font-normal text-muted-foreground transition-colors hover:text-foreground"
          onClick={() => setActiveView('simulation')}
        >
          查看全部 →
        </button>
      </div>
      {sorted.length === 0 ? (
        <div className="px-3.5 py-6 text-center text-xs text-muted-foreground/70" data-testid="run-stream-empty">
          暂无仿真运行 — 从工作区启动仿真后此处实时展示
        </div>
      ) : (
        sorted.map((run) => (
          <div
            key={run.runId}
            role="button"
            tabIndex={0}
            onClick={() => open({ type: 'simulation-detail', runId: run.runId })}
            onKeyDown={(e) => {
              if (e.key === 'Enter') open({ type: 'simulation-detail', runId: run.runId });
            }}
          >
            <RunRow run={run} now={now} />
          </div>
        ))
      )}
    </div>
  );
}
