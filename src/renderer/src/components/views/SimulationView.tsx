/**
 * 仿真视图（Mission Control）— 仿真运行管理的工作视图。
 *
 * 分段筛选器（全部/运行中/失败/通过/队列/已停止，含计数）+ 用例名/seed
 * 关键字过滤 + 运行表格（状态点/用例+seed/子系统/进度/耗时/ETA）。
 * 数据只读复用 simulation store；真实数据无进度/ETA 字段：运行中显示
 * indeterminate 脉冲进度条 + 实时耗时，ETA 列降级为占位/终态文案，不伪造。
 * 顶栏动作：停止全部 / 新建仿真（前往工作区用例列表，Issue #4 / Plan Slice 3）。
 */

import { useEffect, useMemo, useState } from 'react';
import { Play, Search, Square } from 'lucide-react';
import { ViewHeader } from '@renderer/components/layout/ViewHeader';
import { useSimulationStore, type SimulationRunRecord } from '@renderer/stores/simulation';
import { useProjectStore } from '@renderer/stores/project';
import { useUiStore } from '@renderer/stores/ui';
import { useWorkbenchStore } from '@renderer/stores/workbench';
import { cn } from '@renderer/lib/utils';

/** 分段筛选器：key 对应原型 data-filter；fail 段聚合 fail 与 error */
type SegKey = 'all' | 'running' | 'fail' | 'pass' | 'queued' | 'stopped';

const SEGMENTS: ReadonlyArray<{ key: SegKey; label: string; match: (r: SimulationRunRecord) => boolean }> = [
  { key: 'all', label: '全部', match: () => true },
  { key: 'running', label: '运行中', match: (r) => r.status === 'running' },
  { key: 'fail', label: '失败', match: (r) => r.status === 'fail' || r.status === 'error' },
  { key: 'pass', label: '通过', match: (r) => r.status === 'pass' },
  { key: 'queued', label: '队列', match: (r) => r.status === 'pending' },
  { key: 'stopped', label: '已停止', match: (r) => r.status === 'aborted' },
];

/** 状态点颜色（与总览视图 RunningSimStream 一致） */
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

/** 终态 ETA 列文案：显示状态而非伪造 ETA；运行中/队列无数据源显示占位 */
function etaCell(status: SimulationRunRecord['status']): { label: string; className: string } {
  switch (status) {
    case 'pass': return { label: '通过', className: 'text-status-pass-foreground' };
    case 'fail':
    case 'error': return { label: '失败', className: 'text-status-fail-foreground' };
    case 'aborted': return { label: '已停止', className: 'text-status-aborted-foreground' };
    default: return { label: '—', className: 'text-muted-foreground/50' };
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

const ROW_GRID = 'grid-cols-[18px_1.4fr_110px_1fr_100px_90px]';

function RunRow({ run, now, onOpen }: {
  run: SimulationRunRecord;
  now: number;
  onOpen: () => void;
}) {
  const isRunning = run.status === 'running' || run.status === 'pending';
  const duration = isRunning
    ? now - run.startTime
    : run.endTime
      ? run.endTime - run.startTime
      : 0;
  const eta = etaCell(run.status);

  return (
    <div
      role="button"
      tabIndex={0}
      className={cn(ROW_GRID, 'cursor-pointer items-center gap-2.5 border-b border-border px-3.5 py-2 transition-colors last:border-b-0 hover:bg-accent')}
      data-testid={`sim-row-${run.runId}`}
      onClick={onOpen}
      onKeyDown={(e) => {
        if (e.key === 'Enter') onOpen();
      }}
    >
      <span className={cn('size-2 shrink-0 rounded-full', dotClass(run.status))} />
      <div className="min-w-0 overflow-hidden">
        <span className="block truncate font-mono text-xs text-foreground">
          {run.caseName ?? run.caseId}
        </span>
        {run.seed && (
          <span className="block truncate font-mono text-[10px] text-muted-foreground/80">
            seed {run.seed}
          </span>
        )}
      </div>
      <span className="truncate text-[11px] text-muted-foreground">{run.subsys}</span>
      <div className="h-1 overflow-hidden rounded-sm bg-background" data-testid="sim-progress-track">
        {run.status === 'running' && (
          <div className="h-full w-1/3 animate-pulse rounded-sm bg-status-running" />
        )}
        {run.status === 'pending' && null}
        {run.status === 'pass' && <div className="h-full w-full rounded-sm bg-status-pass" />}
        {(run.status === 'fail' || run.status === 'error') && (
          <div className="h-full w-full rounded-sm bg-status-fail" />
        )}
        {run.status === 'aborted' && <div className="h-full w-full rounded-sm bg-status-aborted" />}
      </div>
      <span className="text-right font-mono text-[11px] text-muted-foreground">
        {formatDuration(duration)}
      </span>
      <span className={cn('text-right font-mono text-[11px]', eta.className)}>{eta.label}</span>
    </div>
  );
}

export function SimulationView() {
  const currentProjectId = useProjectStore((s) => s.currentProjectId);
  const activeRuns = useSimulationStore((s) => s.activeRuns);
  const loading = useSimulationStore((s) => s.loadingActiveRuns);
  const loadActiveRuns = useSimulationStore((s) => s.loadActiveRuns);
  const stopAllRuns = useSimulationStore((s) => s.stopAllRuns);
  const setActiveView = useUiStore((s) => s.setActiveView);
  const open = useWorkbenchStore((s) => s.open);

  const [seg, setSeg] = useState<SegKey>('all');
  const [keyword, setKeyword] = useState('');
  const [now, setNow] = useState(() => Date.now());

  // 拉取插件运行（agent/回归启动）合并进 activeRuns；终端运行由 IPC 事件驱动
  useEffect(() => {
    if (!currentProjectId) return;
    void loadActiveRuns(currentProjectId);
  }, [currentProjectId, loadActiveRuns]);

  // 有运行中的仿真时秒级刷新实时耗时
  const hasLive = activeRuns.some((r) => r.status === 'running' || r.status === 'pending');
  useEffect(() => {
    if (!hasLive) return;
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, [hasLive]);

  const counts = useMemo(() => {
    const c: Record<SegKey, number> = { all: activeRuns.length, running: 0, fail: 0, pass: 0, queued: 0, stopped: 0 };
    for (const r of activeRuns) {
      for (const s of SEGMENTS) {
        if (s.key !== 'all' && s.match(r)) c[s.key] += 1;
      }
    }
    return c;
  }, [activeRuns]);

  const filtered = useMemo(() => {
    const segMatch = SEGMENTS.find((s) => s.key === seg)?.match ?? (() => true);
    const kw = keyword.trim().toLowerCase();
    return activeRuns
      .filter((r) => segMatch(r))
      .filter((r) => {
        if (!kw) return true;
        const name = (r.caseName ?? r.caseId).toLowerCase();
        return name.includes(kw) || (r.seed ?? '').toLowerCase().includes(kw);
      })
      .sort((a, b) => {
        const rank = (r: SimulationRunRecord) =>
          r.status === 'running' || r.status === 'pending'
            ? 0
            : r.status === 'fail' || r.status === 'error'
              ? 1
              : 2;
        return rank(a) - rank(b) || b.startTime - a.startTime;
      });
  }, [activeRuns, seg, keyword]);

  const liveCount = counts.running + counts.queued;

  const handleStopAll = () => {
    void stopAllRuns();
  };

  const clearFilters = () => {
    setSeg('all');
    setKeyword('');
  };

  return (
    <div className="flex-1 overflow-y-auto p-5" data-testid="simulation-view">
      <ViewHeader title="仿真" subtitle={`${liveCount} 运行中 · ${activeRuns.length - liveCount} 已完成`}>
        <button
          className="inline-flex cursor-pointer items-center gap-1.5 rounded-lg border border-border px-3.5 py-1.5 text-xs font-medium text-muted-foreground transition-colors hover:border-border/80 hover:bg-card hover:text-foreground disabled:cursor-not-allowed disabled:opacity-40"
          onClick={handleStopAll}
          disabled={!hasLive}
          data-testid="sim-stop-all"
        >
          <Square className="size-2.5" fill="currentColor" />
          停止全部
        </button>
        <button
          className="inline-flex cursor-pointer items-center gap-1.5 rounded-lg bg-primary px-3.5 py-1.5 text-xs font-semibold text-primary-foreground transition-colors hover:opacity-90"
          title="前往工作区用例列表启动仿真"
          onClick={() => setActiveView('workspace')}
          data-testid="sim-new-btn"
        >
          <Play className="size-2.5" fill="currentColor" />
          新建仿真
        </button>
      </ViewHeader>

      <div className="mb-3 flex flex-wrap items-center gap-2">
        <div className="flex rounded-lg border border-border bg-background p-0.5" data-testid="sim-seg">
          {SEGMENTS.map((s) => (
            <button
              key={s.key}
              data-testid={`sim-seg-${s.key}`}
              aria-pressed={seg === s.key}
              className={cn(
                'cursor-pointer rounded-md px-3 py-1 text-xs transition-colors',
                seg === s.key
                  ? 'bg-accent font-medium text-foreground'
                  : 'text-muted-foreground hover:text-foreground',
              )}
              onClick={() => setSeg(s.key)}
            >
              {s.label}
              <span
                className={cn(
                  'ml-1 font-mono text-[10px]',
                  seg === s.key ? 'text-primary' : 'text-muted-foreground/60',
                )}
              >
                {counts[s.key]}
              </span>
            </button>
          ))}
        </div>
        <div className="ml-auto flex items-center gap-2 rounded-lg border border-border bg-card px-3 py-1.5 text-muted-foreground">
          <Search className="size-3 shrink-0" />
          <input
            data-testid="sim-filter-input"
            value={keyword}
            onChange={(e) => setKeyword(e.target.value)}
            placeholder="过滤用例名 / seed…"
            autoComplete="off"
            className="w-44 border-none bg-transparent font-sans text-xs text-foreground outline-none placeholder:text-muted-foreground/50"
          />
        </div>
      </div>

      <div className="overflow-hidden rounded-xl border border-border bg-card">
        <div
          className={cn(ROW_GRID, 'gap-2.5 border-b border-border px-3.5 py-2 text-[10.5px] uppercase tracking-wider text-muted-foreground/70')}
        >
          <span />
          <span>用例</span>
          <span>子系统</span>
          <span>进度</span>
          <span>耗时</span>
          <span className="text-right">ETA</span>
        </div>

        {loading && activeRuns.length === 0 ? (
          <div className="flex flex-col gap-2 p-4" data-testid="sim-view-skeleton">
            {Array.from({ length: 5 }, (_, i) => (
              <div key={i} className="h-8 w-full animate-pulse rounded bg-muted" />
            ))}
          </div>
        ) : activeRuns.length === 0 ? (
          <div
            className="flex flex-col items-center gap-2 px-3.5 py-12 text-muted-foreground"
            data-testid="sim-view-empty"
          >
            <Play className="size-6 opacity-30" />
            <span className="text-xs">暂无仿真运行</span>
            <span className="text-[11px] opacity-60">从工作区用例列表或 OptionDock 启动仿真后此处实时展示</span>
          </div>
        ) : filtered.length === 0 ? (
          <div
            className="flex flex-col items-center gap-2 px-3.5 py-12 text-muted-foreground"
            data-testid="sim-view-no-match"
          >
            <Search className="size-6 opacity-30" />
            <span className="text-xs">无匹配的仿真运行</span>
            <button
              className="cursor-pointer rounded-lg border border-border px-3 py-1 text-[11px] text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
              onClick={clearFilters}
              data-testid="sim-clear-filters"
            >
              清空筛选
            </button>
          </div>
        ) : (
          filtered.map((run) => (
            <RunRow
              key={run.runId}
              run={run}
              now={now}
              onOpen={() => open({ type: 'simulation-detail', runId: run.runId })}
            />
          ))
        )}
      </div>
    </div>
  );
}
