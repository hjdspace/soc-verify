/**
 * 仿真视图下方运行列表面板（Issue #4）。
 *
 * 从 SimulationView 中抽取运行列表表格逻辑为独立组件。
 * 包含分段筛选器（全部/运行中/失败/通过/队列/已停止，含计数）、
 * 关键字过滤（用例名/seed）、运行表格行（状态点/用例名+seed/子系统/
 * 进度条/耗时/ETA）、骨架屏、空状态、无匹配状态、停止全部按钮。
 * 行点击跳转到运行详情 Tab（workbench.open）。
 * 运行中仿真秒级刷新实时耗时。
 *
 * 性能优化：
 *   - 虚拟滚动：仅渲染可见区域内的行，支持万级用例流畅滚动
 *   - React.memo：RunRow 缓存，避免 now 秒级刷新导致全部行重渲染
 *
 * 布局对齐原型 sim-page-01-left-tree-right-options.html：
 *   .rla（flex-1 flex-col overflow-hidden）
 *     .lh → 筛选栏（标题 + 分段 + 搜索 + 停止全部）
 *     .rh → 表头行（sticky 不可滚动）
 *     .table → 行体（flex-1 overflow-y-auto，虚拟滚动）
 */

import { useEffect, useMemo, useRef, useState, useCallback, memo } from 'react';
import { Search, Square } from 'lucide-react';
import { useSimulationStore, type SimulationRunRecord } from '@renderer/stores/simulation';
import { useWorkbenchStore } from '@renderer/stores/workbench';
import { cn } from '@renderer/lib/utils';

/** 分段筛选器：fail 段聚合 fail 与 error */
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
  if (m < 60) return `${m}m ${s % 60}s`;
  return `${Math.floor(m / 60)}h ${m % 60}m ${s % 60}s`;
}

const ROW_GRID = 'grid grid-cols-[18px_1.4fr_100px_1fr_80px_70px]';

// ─── 虚拟滚动常量 ────────────────────────────────────────────────

const ROW_HEIGHT = 40; // px — RunRow 的预估高度（px-3 py-1.5 + 内容）
const OVERSCAN = 8;   // 额外渲染的行数（上下各 overscan）

const RunRow = memo(function RunRow({ run, now, onOpen }: {
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

  const handleKeyDown = useCallback((e: React.KeyboardEvent) => {
    if (e.key === 'Enter') onOpen();
  }, [onOpen]);

  return (
    <div
      role="button"
      tabIndex={0}
      className={cn(ROW_GRID, 'cursor-pointer items-center gap-2 border-b border-border px-3 py-1.5 transition-colors last:border-b-0 hover:bg-accent')}
      data-testid={`sim-row-${run.runId}`}
      onClick={onOpen}
      onKeyDown={handleKeyDown}
    >
      <span className={cn('size-2 shrink-0 rounded-full', dotClass(run.status))} />
      <div className="min-w-0 overflow-hidden">
        <span className="block truncate font-mono text-[11px] text-foreground">
          {run.caseName ?? run.caseId}
        </span>
        {run.seed && (
          <span className="block truncate font-mono text-[10px] text-muted-foreground/80">
            seed {run.seed}
          </span>
        )}
      </div>
      <span className="truncate text-[10px] text-muted-foreground">{run.subsys}</span>
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
      <span className="text-right font-mono text-[10px] text-muted-foreground">
        {formatDuration(duration)}
      </span>
      <span className={cn('text-right font-mono text-[10px]', eta.className)}>{eta.label}</span>
    </div>
  );
});

export function RunListPanel({ projectId }: { projectId?: string } = {}) {
  const activeRuns = useSimulationStore((s) => s.activeRuns);
  const loading = useSimulationStore((s) => s.loadingActiveRuns);
  const loadActiveRuns = useSimulationStore((s) => s.loadActiveRuns);
  const stopAllRuns = useSimulationStore((s) => s.stopAllRuns);
  const open = useWorkbenchStore((s) => s.open);

  // The workspace running-simulations destination can be opened directly,
  // without mounting SimulationView first, so it must load persisted runs too.
  useEffect(() => {
    if (projectId && typeof loadActiveRuns === 'function') {
      void loadActiveRuns(projectId);
    }
  }, [projectId, loadActiveRuns]);

  const [seg, setSeg] = useState<SegKey>('all');
  const [keyword, setKeyword] = useState('');
  const [now, setNow] = useState(() => Date.now());

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

  const clearFilters = () => {
    setSeg('all');
    setKeyword('');
  };

  // ─── 虚拟滚动 ──────────────────────────────────────────────
  const scrollRef = useRef<HTMLDivElement>(null);
  const [scrollTop, setScrollTop] = useState(0);
  const [viewportHeight, setViewportHeight] = useState(600);

  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    // 初始读取视口高度
    setViewportHeight(el.clientHeight || 600);
    const onScroll = () => setScrollTop(el.scrollTop);
    el.addEventListener('scroll', onScroll, { passive: true });
    return () => el.removeEventListener('scroll', onScroll);
  }, []);

  // 监听容器大小变化（窗口 resize 等）
  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    if (typeof ResizeObserver === 'undefined') return;
    const ro = new ResizeObserver(() => {
      setViewportHeight(el.clientHeight || 600);
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  const totalRows = filtered.length;
  const startIndex = Math.max(0, Math.floor(scrollTop / ROW_HEIGHT) - OVERSCAN);
  const endIndex = Math.min(
    totalRows,
    Math.ceil((scrollTop + viewportHeight) / ROW_HEIGHT) + OVERSCAN,
  );
  const visibleSlice = filtered.slice(startIndex, endIndex);
  const topSpacer = startIndex * ROW_HEIGHT;
  const bottomSpacer = (totalRows - endIndex) * ROW_HEIGHT;

  return (
    <div className="flex flex-1 flex-col overflow-hidden" data-testid="run-list-panel">
      {/* ── Filter bar: segments + keyword + stop-all ─────────── */}
      <div className="flex flex-wrap items-center gap-2 px-3 py-2">
        <div className="flex items-center gap-2">
          <h3 className="text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">运行列表</h3>
        </div>
        <div className="flex items-center gap-0.5" data-testid="sim-seg">
          {SEGMENTS.map((s) => (
            <button
              key={s.key}
              data-testid={`sim-seg-${s.key}`}
              aria-pressed={seg === s.key}
              className={cn(
                'cursor-pointer rounded px-2 py-1 text-[11px] transition-colors',
                seg === s.key
                  ? 'bg-accent font-medium text-foreground'
                  : 'text-muted-foreground hover:bg-accent hover:text-foreground',
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
        <div className="ml-auto flex items-center gap-2">
          <div className="flex items-center gap-1.5 rounded-md border border-border bg-background px-2.5 py-1 text-muted-foreground">
            <Search className="size-3 shrink-0" />
            <input
              data-testid="sim-filter-input"
              value={keyword}
              onChange={(e) => setKeyword(e.target.value)}
              placeholder="过滤用例名 / seed…"
              autoComplete="off"
              className="w-32 border-none bg-transparent font-sans text-xs text-foreground outline-none placeholder:text-muted-foreground/50"
            />
          </div>
          <button
            className="inline-flex cursor-pointer items-center gap-1 rounded px-2 py-1 text-[11px] text-status-fail-foreground transition-colors hover:bg-status-fail/15 disabled:cursor-not-allowed disabled:opacity-40"
            onClick={() => void stopAllRuns()}
            disabled={!hasLive}
            data-testid="run-list-stop-all"
            title="停止全部运行中/队列中的仿真"
          >
            <Square className="size-2.5" fill="currentColor" />
            停止全部
          </button>
        </div>
      </div>

      {/* ── Table header (sticky, not scrollable) ────────────── */}
      <div
        className={cn(ROW_GRID, 'gap-2 border-b border-border px-3 py-1.5 text-[10px] uppercase tracking-wide text-muted-foreground/60')}
      >
        <span />
        <span>用例</span>
        <span>子系统</span>
        <span>进度</span>
        <span>耗时</span>
        <span className="text-right">ETA</span>
      </div>

      {/* ── Table body (virtual scrollable) ────────────────────── */}
      <div
        ref={scrollRef}
        className="flex-1 overflow-y-auto"
        data-testid="run-list-virtual-scroll"
      >
        {loading && activeRuns.length === 0 ? (
          <div className="flex flex-col gap-2 p-3" data-testid="sim-view-skeleton">
            {Array.from({ length: 5 }, (_, i) => (
              <div key={i} className="h-7 w-full animate-pulse rounded bg-muted" />
            ))}
          </div>
        ) : activeRuns.length === 0 ? (
          <div
            className="flex flex-col items-center gap-2 px-3 py-12 text-muted-foreground"
            data-testid="sim-view-empty"
          >
            <span className="text-xs">暂无仿真运行</span>
            <span className="text-[11px] opacity-60">从左侧用例树或 Option 面板启动仿真后此处实时展示</span>
          </div>
        ) : filtered.length === 0 ? (
          <div
            className="flex flex-col items-center gap-2 px-3 py-12 text-muted-foreground"
            data-testid="sim-view-no-match"
          >
            <Search className="size-6 opacity-30" />
            <span className="text-xs">无匹配的仿真运行</span>
            <button
              className="cursor-pointer rounded border border-border px-3 py-1 text-[11px] text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
              onClick={clearFilters}
              data-testid="sim-clear-filters"
            >
              清空筛选
            </button>
          </div>
        ) : (
          <>
            {/* 顶部空间 — 撑起虚拟滚动上方区域 */}
            {topSpacer > 0 && (
              <div style={{ height: topSpacer }} aria-hidden="true" />
            )}
            {visibleSlice.map((run) => (
              <RunRow
                key={run.runId}
                run={run}
                now={now}
                onOpen={() => open({ type: 'simulation-detail', runId: run.runId })}
              />
            ))}
            {/* 底部空间 — 撑起虚拟滚动下方区域 */}
            {bottomSpacer > 0 && (
              <div style={{ height: bottomSpacer }} aria-hidden="true" />
            )}
          </>
        )}
      </div>
    </div>
  );
}
