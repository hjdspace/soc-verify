/**
 * 覆盖率视图（Mission Control）— 覆盖率分析的工作视图。
 *
 * 双 Tab（模块排序 / Bin 明细；Bin 首次进入显示骨架屏——真实实现为
 * loadUncovered 查询 loading 态）+ 7 日趋势图（SVG 双折线 + 90% 目标
 * 虚线；无按日历史查询，降级为最近 N 次 merge session，不造假数据）+
 * 汇总面板（四类覆盖率条 + 距目标差值 + 收敛预测）+ 模块排序表（列头
 * 排序 / 低覆盖着色 <75% 黄、<70% 红 / 行点击下钻现有覆盖率明细）。
 * 数据只读复用 coverage store，不重写数据层。
 */

import { useEffect, useMemo, useState } from 'react';
import { FileDown, PieChart, Upload } from 'lucide-react';
import { ViewHeader } from '@renderer/components/layout/ViewHeader';
import { CoverageImportDialog } from '@renderer/components/coverage/CoverageImportDialog';
import { useCoverageCoreStore, useCoverageGapsStore, useCoverageExportStore } from '@renderer/stores/coverage';
import { useProjectStore } from '@renderer/stores/project';
import { useWorkbenchStore } from '@renderer/stores/workbench';
import { cn } from '@renderer/lib/utils';
import type {
  CoverageData,
  CoverageMetric,
  CoverageNode,
  CoverageSummary,
  UncoveredItem,
} from '@shared/types';
import { DEFAULT_COVERAGE_TARGETS } from '@shared/types';

// ─── 常量 ────────────────────────────────────────────────────────

/** 汇总面板 / 模块排序表展示的四类 metric（对照原型四条覆盖率条） */
type SummaryMetric = 'functional' | 'line' | 'branch' | 'assertion';

type TrendPoint = { sessionId: string; createdAt: number; summary: CoverageSummary };

const SUMMARY_METRICS: ReadonlyArray<{ key: SummaryMetric; name: string; bar: string }> = [
  { key: 'functional', name: '功能', bar: 'bg-primary' },
  { key: 'line', name: '语句', bar: 'bg-status-running' },
  { key: 'branch', name: '分支', bar: 'bg-violet' },
  { key: 'assertion', name: '断言', bar: 'bg-warning' },
];

/** 趋势图取最近 7 个 merge session（7 日趋势的降级数据源） */
const TREND_LIMIT = 7;
/** 趋势图目标虚线固定 90%（原型「目标 90」） */
const TARGET_LINE = 90;
/** 低覆盖阈值：Issue #5 硬性规则 <75% 黄、<70% 红 */
const LOW_THRESHOLD = 75;
const VERY_LOW_THRESHOLD = 70;

// ─── 工具函数 ────────────────────────────────────────────────────

function lowTextClass(pct: number | null): string {
  if (pct === null) return 'text-muted-foreground';
  if (pct < VERY_LOW_THRESHOLD) return 'text-status-fail-foreground';
  if (pct < LOW_THRESHOLD) return 'text-warning-foreground';
  return 'text-foreground';
}

function lowBarClass(pct: number | null): string {
  if (pct === null) return 'bg-muted-foreground/40';
  if (pct < VERY_LOW_THRESHOLD) return 'bg-status-fail';
  if (pct < LOW_THRESHOLD) return 'bg-warning';
  return 'bg-primary';
}

function fmtDate(ts: number): string {
  const d = new Date(ts);
  const mm = String(d.getMonth() + 1).padStart(2, '0');
  const dd = String(d.getDate()).padStart(2, '0');
  return `${mm}-${dd}`;
}

function fmtDateTime(ts: number): string {
  const d = new Date(ts);
  const hh = String(d.getHours()).padStart(2, '0');
  const mi = String(d.getMinutes()).padStart(2, '0');
  return `${fmtDate(ts)} ${hh}:${mi}`;
}

/** 取 session ID 简写（取最后一段，最多 8 字符；与 CoverageDashboard 一致） */
function shortSessionId(sid: string): string {
  const parts = sid.split(/[_-]/);
  const last = parts[parts.length - 1] ?? sid;
  return last.length > 8 ? last.slice(0, 8) : last;
}

// ─── 收敛预测（基于最近 N 个 merge session 的功能覆盖率增速） ────

type Convergence =
  | { kind: 'reached'; diff: number }
  | { kind: 'predict'; diff: number; days: number }
  | { kind: 'no-trend'; diff: number }
  | { kind: 'stalled'; diff: number };

function predictConvergence(
  trend: TrendPoint[],
  target: number | undefined,
  current: number | null,
): Convergence | null {
  if (target === undefined || current === null) return null;
  const diff = target - current;
  if (diff <= 0) return { kind: 'reached', diff };
  if (trend.length < 2) return { kind: 'no-trend', diff };
  const recent = trend.slice(-3);
  const spanMs = recent[recent.length - 1].createdAt - recent[0].createdAt;
  if (spanMs <= 0) return { kind: 'no-trend', diff };
  const rate =
    (recent[recent.length - 1].summary.functional - recent[0].summary.functional) /
    (spanMs / 86_400_000);
  if (rate <= 0) return { kind: 'stalled', diff };
  return { kind: 'predict', diff, days: Math.ceil(diff / rate) };
}

function convergenceText(conv: Convergence | null, target: number | undefined): string {
  if (!target || !conv) return '暂无覆盖率数据';
  switch (conv.kind) {
    case 'reached':
      return `功能覆盖率已达 ${target}% 目标`;
    case 'predict':
      return `距 ${target}% 目标还差 ${conv.diff.toFixed(1)}pp；按近期收敛速度，预计 ${conv.days} 天内达成`;
    case 'no-trend':
      return `距 ${target}% 目标还差 ${conv.diff.toFixed(1)}pp；暂无收敛趋势数据，无法预测`;
    case 'stalled':
      return `距 ${target}% 目标还差 ${conv.diff.toFixed(1)}pp；近期未在收敛，建议优先处理低覆盖模块`;
  }
}

// ─── 7 日趋势图（SVG 双折线 + 90% 目标虚线） ─────────────────────

function TrendChart({ trend }: { trend: TrendPoint[] }) {
  const recent = useMemo(() => trend.slice(-TREND_LIMIT), [trend]);

  if (recent.length === 0) {
    return (
      <div
        className="flex min-w-0 flex-col overflow-hidden rounded-xl border border-border bg-card"
        data-testid="cov-trend-panel"
      >
        <div className="border-b border-border px-3.5 py-2.5 text-xs font-semibold text-foreground">
          7 日趋势
        </div>
        <div
          className="grid flex-1 place-items-center px-3.5 py-12 text-xs text-muted-foreground/70"
          data-testid="cov-trend-empty"
        >
          暂无趋势数据（需要多个 merge session）
        </div>
      </div>
    );
  }

  const width = 560;
  const height = 210;
  const padX = 40;
  const padTop = 14;
  const padBottom = 26;
  const plotW = width - padX - 14;
  const plotH = height - padTop - padBottom;

  // y 轴范围自适应：覆盖所有值与目标线，下探到 5 的倍数
  const values = recent.flatMap((t) => [t.summary.functional, t.summary.line]);
  const minVal = Math.min(TARGET_LINE, ...values);
  const yMin = Math.max(0, Math.floor((minVal - 5) / 5) * 5);
  const yMax = 100;
  const yOf = (v: number): number => padTop + plotH * (1 - (v - yMin) / (yMax - yMin));
  const xOf = (i: number): number =>
    recent.length === 1 ? padX + plotW / 2 : padX + (plotW * i) / (recent.length - 1);

  const lines = [
    { key: 'functional' as const, label: '功能', stroke: 'stroke-primary', bar: 'bg-primary', dot: 'fill-primary', testId: 'cov-trend-line-functional' },
    { key: 'line' as const, label: '代码', stroke: 'stroke-status-running', bar: 'bg-status-running', dot: 'fill-status-running', testId: 'cov-trend-line-code' },
  ];

  return (
    <div
      className="flex min-w-0 flex-col overflow-hidden rounded-xl border border-border bg-card"
      data-testid="cov-trend-panel"
    >
      <div className="flex items-center gap-3 border-b border-border px-3.5 py-2.5 text-xs font-semibold text-foreground">
        7 日趋势
        <span className="ml-auto flex gap-3 text-[10px] font-normal text-muted-foreground">
          {lines.map((l) => (
            <span key={l.key} className="flex items-center gap-1">
              <span className={cn('inline-block h-0.5 w-3 rounded', l.bar)} />
              {l.label}
            </span>
          ))}
        </span>
      </div>
      <svg
        viewBox={`0 0 ${width} ${height}`}
        className="w-full"
        role="img"
        aria-label="覆盖率 7 日趋势图"
        data-testid="cov-trend-chart"
      >
        {/* y 轴范围网格线 */}
        {[yMin, yMax].map((v) => (
          <g key={v}>
            <line
              x1={padX}
              y1={yOf(v)}
              x2={width - 14}
              y2={yOf(v)}
              stroke="currentColor"
              strokeWidth={0.5}
              strokeDasharray="3 4"
              className="text-border"
            />
            <text
              x={padX - 4}
              y={yOf(v) + 3}
              fontSize={9}
              textAnchor="end"
              className="fill-muted-foreground font-mono"
            >
              {v}
            </text>
          </g>
        ))}
        {/* 90% 目标虚线 */}
        {yMin < TARGET_LINE && (
          <g data-testid="cov-trend-target-line">
            <line
              x1={padX}
              y1={yOf(TARGET_LINE)}
              x2={width - 14}
              y2={yOf(TARGET_LINE)}
              stroke="currentColor"
              strokeWidth={1}
              strokeDasharray="5 4"
              className="text-warning"
            />
            <text
              x={padX - 4}
              y={yOf(TARGET_LINE) + 3}
              fontSize={9}
              textAnchor="end"
              className="fill-warning-foreground font-mono"
            >
              {TARGET_LINE}
            </text>
          </g>
        )}
        {/* x 轴日期标签 */}
        {recent.map((t, i) => (
          <text
            key={t.sessionId}
            x={xOf(i)}
            y={height - 8}
            fontSize={9}
            textAnchor="middle"
            className="fill-muted-foreground font-mono"
          >
            {fmtDate(t.createdAt)}
          </text>
        ))}
        {/* 双折线 + 末端数据点 */}
        {lines.map((l) => {
          const pts = recent.map((t, i) => ({ x: xOf(i), y: yOf(t.summary[l.key]) }));
          const lastPt = pts[pts.length - 1];
          return (
            <g key={l.key}>
              {pts.length > 1 && (
                <polyline
                  points={pts.map((p) => `${p.x},${p.y}`).join(' ')}
                  fill="none"
                  strokeWidth={1.8}
                  strokeLinecap="round"
                  className={l.stroke}
                  data-testid={l.testId}
                />
              )}
              <circle cx={lastPt.x} cy={lastPt.y} r={3} className={l.dot} />
            </g>
          );
        })}
      </svg>
      <div className="px-3.5 pb-2 text-[10px] text-muted-foreground/70">
        最近 {recent.length} 次 merge session（按日历史查询待接入，降级展示）
      </div>
    </div>
  );
}

// ─── 汇总面板（四类覆盖率条 + 距目标差值 + 收敛预测） ────────────

function SummaryPanel({ overview, targets, trend, loading }: {
  overview: CoverageSummary | null;
  targets: Partial<Record<CoverageMetric, number>>;
  trend: TrendPoint[];
  loading: boolean;
}) {
  const effective = useMemo(
    () => ({ ...DEFAULT_COVERAGE_TARGETS, ...targets }),
    [targets],
  );
  // 与上一 session 的差值（trend 已按 createdAt 升序）
  const last = trend[trend.length - 1];
  const prev = trend[trend.length - 2];
  const deltaOf = (key: SummaryMetric): number | null =>
    last && prev ? last.summary[key] - prev.summary[key] : null;
  const conv = predictConvergence(trend, effective.functional, overview?.functional ?? null);

  return (
    <div
      className="flex min-w-0 flex-col overflow-hidden rounded-xl border border-border bg-card"
      data-testid="cov-summary-panel"
    >
      <div className="border-b border-border px-3.5 py-2.5 text-xs font-semibold text-foreground">
        汇总
      </div>
      {loading && !overview ? (
        <div className="flex flex-col gap-3 p-4" data-testid="cov-sum-skeleton">
          {Array.from({ length: 4 }, (_, i) => (
            <div key={i} className="h-5 w-full animate-pulse rounded bg-muted" />
          ))}
        </div>
      ) : !overview ? (
        <div
          className="grid flex-1 place-items-center px-3.5 py-12 text-xs text-muted-foreground/70"
          data-testid="cov-sum-empty"
        >
          尚无覆盖率数据 — 导入 EDA 覆盖率报告后此处展示汇总
        </div>
      ) : (
        <div className="flex flex-1 flex-col gap-3 p-4">
          {SUMMARY_METRICS.map(({ key, name, bar }) => {
            const value = overview[key];
            const target = effective[key];
            const diff = target !== undefined ? target - value : null;
            const delta = deltaOf(key);
            return (
              <div key={key} className="flex items-center gap-2.5" data-testid={`cov-sum-row-${key}`}>
                <span className="w-8 shrink-0 text-xs text-muted-foreground">{name}</span>
                <div className="h-1.5 min-w-0 flex-1 overflow-hidden rounded-sm bg-background">
                  <div className={cn('h-full rounded-sm', bar)} style={{ width: `${value}%` }} />
                </div>
                <span className="w-12 shrink-0 text-right font-mono text-xs text-foreground">
                  {value.toFixed(1)}%
                </span>
                <span
                  className="w-16 shrink-0 text-right text-[10px] text-muted-foreground"
                  data-testid={`cov-sum-diff-${key}`}
                >
                  {diff === null ? '无目标' : diff > 0 ? `差 ${diff.toFixed(1)}pp` : '已达标'}
                </span>
                <span
                  className={cn(
                    'w-11 shrink-0 text-right font-mono text-[10px]',
                    delta === null
                      ? 'text-muted-foreground/40'
                      : delta > 0
                        ? 'text-primary'
                        : delta < 0
                          ? 'text-status-fail-foreground'
                          : 'text-muted-foreground',
                  )}
                  data-testid={`cov-sum-delta-${key}`}
                >
                  {delta === null ? '—' : `${delta > 0 ? '+' : ''}${delta.toFixed(1)}`}
                </span>
              </div>
            );
          })}
          <div
            className="pt-1 text-[11px] leading-relaxed text-muted-foreground"
            data-testid="cov-convergence"
          >
            {convergenceText(conv, effective.functional)}
          </div>
        </div>
      )}
    </div>
  );
}

// ─── 模块排序表（列头排序 / 低覆盖着色 / 行点击下钻） ────────────

type SortKey = 'module' | 'overall' | 'functional' | 'line' | 'branch' | 'assertion';

type ModuleRow = {
  node: CoverageNode;
  parent: string;
  /** 主覆盖率 = 四类 metric（功能/语句/分支/断言）非 N/A 值的均值 */
  overall: number | null;
  functional: number | null;
  line: number | null;
  branch: number | null;
  assertion: number | null;
};

const MODULE_GRID = 'grid-cols-[minmax(0,1.3fr)_110px_64px_64px_64px_64px_64px]';

const SORTABLE_COLS: ReadonlyArray<{ key: SortKey; label: string }> = [
  { key: 'module', label: '模块' },
  { key: 'overall', label: '覆盖率' },
  { key: 'functional', label: '功能' },
  { key: 'line', label: '语句' },
  { key: 'branch', label: '分支' },
  { key: 'assertion', label: '断言' },
];

function toModuleRow(node: CoverageNode, parent: string): ModuleRow {
  const four: Array<number | null> = [
    node.metrics.functional.percentage,
    node.metrics.line.percentage,
    node.metrics.branch.percentage,
    node.metrics.assertion.percentage,
  ];
  const valid = four.filter((v): v is number => v !== null);
  const overall = valid.length === 0 ? null : valid.reduce((s, v) => s + v, 0) / valid.length;
  return {
    node,
    parent,
    overall,
    functional: node.metrics.functional.percentage,
    line: node.metrics.line.percentage,
    branch: node.metrics.branch.percentage,
    assertion: node.metrics.assertion.percentage,
  };
}

function collectRows(node: CoverageNode, parentName: string, out: ModuleRow[]): void {
  for (const child of node.children) {
    out.push(toModuleRow(child, parentName));
    collectRows(child, child.name, out);
  }
}

function compareRows(a: ModuleRow, b: ModuleRow, key: SortKey, dir: 'asc' | 'desc'): number {
  if (key === 'module') {
    const byName = a.node.name.localeCompare(b.node.name);
    return dir === 'asc' ? byName : -byName;
  }
  const av = a[key];
  const bv = b[key];
  // N/A 恒沉底（无数据不参与高低位次）
  if (av === null && bv === null) return 0;
  if (av === null) return 1;
  if (bv === null) return -1;
  return dir === 'asc' ? av - bv : bv - av;
}

function NumCell({ path, metric, pct }: { path: string; metric: SummaryMetric; pct: number | null }) {
  return (
    <span
      data-testid={`cov-cell-${path}-${metric}`}
      className={cn('text-right font-mono text-[11px] tabular-nums', lowTextClass(pct))}
    >
      {pct === null ? 'N/A' : pct.toFixed(1)}
    </span>
  );
}

function ModuleRowView({ row, onOpen }: { row: ModuleRow; onOpen: () => void }) {
  return (
    <div
      role="button"
      tabIndex={0}
      data-testid={`cov-mod-row-${row.node.path}`}
      className={cn(
        MODULE_GRID,
        'cursor-pointer items-center gap-2 border-b border-border px-3.5 py-2 transition-colors last:border-b-0 hover:bg-accent',
      )}
      onClick={onOpen}
      onKeyDown={(e) => {
        if (e.key === 'Enter') onOpen();
      }}
    >
      <div className="min-w-0 overflow-hidden">
        <span className="block truncate font-mono text-xs text-foreground">{row.node.name}</span>
        <span className="block truncate text-[10px] text-muted-foreground/70">{row.parent}</span>
      </div>
      <div
        className="h-1 overflow-hidden rounded-sm bg-background"
        title={row.overall === null ? 'N/A' : `${row.overall.toFixed(1)}%`}
      >
        <div
          className={cn('h-full rounded-sm', lowBarClass(row.overall))}
          style={{ width: `${row.overall ?? 0}%` }}
          data-testid={`cov-bar-${row.node.path}`}
        />
      </div>
      <NumCell path={row.node.path} metric="functional" pct={row.functional} />
      <NumCell path={row.node.path} metric="line" pct={row.line} />
      <NumCell path={row.node.path} metric="branch" pct={row.branch} />
      <NumCell path={row.node.path} metric="assertion" pct={row.assertion} />
      {/* 24hΔ 无每模块历史数据源，降级占位不造假 */}
      <span
        className="text-right font-mono text-[11px] text-muted-foreground/50"
        data-testid={`cov-delta-${row.node.path}`}
      >
        —
      </span>
    </div>
  );
}

function ModuleSortTable({ tree, loading, onOpen }: {
  tree: CoverageData | null;
  loading: boolean;
  onOpen: () => void;
}) {
  const [sortKey, setSortKey] = useState<SortKey>('overall');
  // 默认主覆盖率升序：低覆盖模块置顶，便于聚焦收敛
  const [sortDir, setSortDir] = useState<'asc' | 'desc'>('asc');

  const rows = useMemo<ModuleRow[]>(() => {
    if (!tree) return [];
    const out: ModuleRow[] = [];
    collectRows(tree.root, tree.root.name, out);
    return out;
  }, [tree]);

  const sorted = useMemo(
    () => [...rows].sort((a, b) => compareRows(a, b, sortKey, sortDir)),
    [rows, sortKey, sortDir],
  );

  const handleSort = (key: SortKey): void => {
    if (key === sortKey) {
      setSortDir((d) => (d === 'asc' ? 'desc' : 'asc'));
    } else {
      setSortKey(key);
      setSortDir(key === 'module' ? 'asc' : 'desc');
    }
  };

  return (
    <div
      className="overflow-hidden rounded-xl border border-border bg-card"
      data-testid="cov-mod-table"
    >
      <div className="flex items-center gap-2 border-b border-border px-3.5 py-2.5 text-xs font-semibold text-foreground">
        模块覆盖率排序
        <span className="text-[10px] font-normal text-muted-foreground">{rows.length} 模块</span>
      </div>
      <div
        className={cn(
          MODULE_GRID,
          'gap-2 border-b border-border px-3.5 py-2 text-[10.5px] uppercase tracking-[0.08em] text-muted-foreground/70',
        )}
      >
        {SORTABLE_COLS.map(({ key, label }) => (
          <button
            key={key}
            data-testid={`cov-sort-${key}`}
            onClick={() => handleSort(key)}
            className={cn(
              'flex cursor-pointer items-center gap-1 transition-colors hover:text-foreground',
              key !== 'module' && key !== 'overall' && 'justify-end',
              sortKey === key && 'text-primary',
            )}
          >
            {label}
            {sortKey === key && (
              <span className="text-[9px]">{sortDir === 'asc' ? '↑' : '↓'}</span>
            )}
          </button>
        ))}
        <span className="text-right">24h Δ</span>
      </div>
      {loading && !tree ? (
        <div className="flex flex-col gap-2 p-4" data-testid="cov-mod-skeleton">
          {Array.from({ length: 6 }, (_, i) => (
            <div key={i} className="h-8 w-full animate-pulse rounded bg-muted" />
          ))}
        </div>
      ) : !tree ? (
        <div
          className="flex flex-col items-center gap-2 px-3.5 py-12 text-muted-foreground"
          data-testid="cov-mod-empty"
        >
          <PieChart className="size-6 opacity-30" />
          <span className="text-xs">暂无覆盖率数据</span>
          <span className="text-[11px] opacity-60">
            导入 EDA 覆盖率报告（cov_merge 目录）后此处展示模块排序
          </span>
        </div>
      ) : rows.length === 0 ? (
        <div
          className="px-3.5 py-10 text-center text-xs text-muted-foreground/70"
          data-testid="cov-mod-empty"
        >
          覆盖率树无子模块
        </div>
      ) : (
        sorted.map((row) => (
          <ModuleRowView key={row.node.path} row={row} onOpen={onOpen} />
        ))
      )}
    </div>
  );
}

// ─── Bin 明细（未命中 functional covergroup bins） ───────────────

function BinPanel({ state, items }: { state: 'idle' | 'loading' | 'loaded'; items: UncoveredItem[] }) {
  return (
    <div
      className="overflow-hidden rounded-xl border border-border bg-card"
      data-testid="cov-bin-panel"
    >
      <div className="flex items-center gap-2 border-b border-border px-3.5 py-2.5 text-xs font-semibold text-foreground">
        未命中 Bin · functional
        <span className="rounded bg-status-fail/15 px-1.5 py-0.5 text-[10px] font-normal text-status-fail-foreground">
          {items.length}
        </span>
      </div>
      {state !== 'loaded' ? (
        <div className="flex flex-col gap-2 p-4" data-testid="cov-bin-skeleton">
          <div className="h-5 w-1/3 animate-pulse rounded bg-muted" />
          {Array.from({ length: 4 }, (_, i) => (
            <div key={i} className="h-8 w-full animate-pulse rounded bg-muted" />
          ))}
        </div>
      ) : items.length === 0 ? (
        <div
          className="px-3.5 py-10 text-center text-xs text-muted-foreground/70"
          data-testid="cov-bin-empty"
        >
          暂无未命中 Bin 数据 — 需解析 detail 报告（functional covergroup bins）
        </div>
      ) : (
        <div className="flex max-h-[420px] flex-col overflow-y-auto">
          {items.map((item, i) => (
            <div
              key={`${item.module}-${i}`}
              data-testid={`cov-bin-row-${i}`}
              className="flex flex-wrap items-center gap-2 border-b border-border px-3.5 py-2 text-[11px] last:border-b-0"
            >
              <span className="font-mono text-xs text-foreground">{item.module}</span>
              <span className="min-w-0 flex-1 truncate text-muted-foreground">
                {item.description}
              </span>
              {item.signal && (
                <span className="font-mono text-[10px] text-muted-foreground/80">
                  {item.signal}
                </span>
              )}
              {item.file && (
                <span className="font-mono text-[10px] text-muted-foreground/80">
                  {item.file}
                  {item.line !== undefined ? `:${item.line}` : ''}
                </span>
              )}
              <span className="rounded bg-status-fail/15 px-1.5 py-0.5 text-[9px] font-semibold text-status-fail-foreground">
                未命中
              </span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

// ─── 主组件 ──────────────────────────────────────────────────────

export function CoverageView() {
  const currentProjectId = useProjectStore((s) => s.currentProjectId);
const sessions = useCoverageCoreStore((s) => s.sessions);
const currentSessionId = useCoverageCoreStore((s) => s.currentSessionId);
const tree = useCoverageCoreStore((s) => s.tree);
const overview = useCoverageCoreStore((s) => s.overview);
const loading = useCoverageCoreStore((s) => s.loading);
const loadSessions = useCoverageCoreStore((s) => s.loadSessions);
const loadTree = useCoverageCoreStore((s) => s.loadTree);
const loadUncovered = useCoverageCoreStore((s) => s.loadUncovered);
const openExportDialog = useCoverageExportStore((s) => s.openExportDialog);

  // gaps store
const targets = useCoverageGapsStore((s) => s.targets);
const trend = useCoverageGapsStore((s) => s.trend);
const loadTrend = useCoverageGapsStore((s) => s.loadTrend);
const uncoveredItems = useCoverageCoreStore((s) => s.uncoveredItems);
  const open = useWorkbenchStore((s) => s.open);

  const [tab, setTab] = useState<'module' | 'bin'>('module');
  const [binState, setBinState] = useState<'idle' | 'loading' | 'loaded'>('idle');
  const [importDialogOpen, setImportDialogOpen] = useState(false);

  // 数据加载：无树数据时 session → tree 链式拉取；趋势独立加载（DashboardView 模式）
  useEffect(() => {
    if (!currentProjectId) return;
    if (!tree) {
      void loadSessions(currentProjectId).then(() => loadTree(currentProjectId));
    }
    if (trend.length === 0) {
      void loadTrend(currentProjectId, TREND_LIMIT);
    }
  }, [currentProjectId, tree, trend.length, loadSessions, loadTree, loadTrend]);

  // Bin 明细首次进入：骨架屏 = loadUncovered 查询 loading 态（Issue #5）
  useEffect(() => {
    if (tab !== 'bin' || binState !== 'idle' || !currentProjectId) return;
    setBinState('loading');
    void loadUncovered(currentProjectId, currentSessionId ?? undefined, 'functional')
      .finally(() => setBinState('loaded'));
  }, [tab, binState, currentProjectId, currentSessionId, loadUncovered]);

  const sortedTrend = useMemo(
    () => [...trend].sort((a, b) => a.createdAt - b.createdAt),
    [trend],
  );

  const currentSession = sessions.find((s) => s.sessionId === currentSessionId) ?? null;
  const subtitle = currentSession
    ? `merge 自 ${shortSessionId(currentSession.sessionId)} · ${fmtDateTime(currentSession.createdAt)}`
    : '暂无覆盖率数据';

  return (
    <div className="flex-1 overflow-y-auto p-5" data-testid="coverage-view">
      <ViewHeader title="覆盖率" subtitle={subtitle}>
        <div
          className="flex rounded-lg border border-border bg-background p-0.5"
          data-testid="cov-tabs"
        >
          {([['module', '模块排序'], ['bin', 'Bin 明细']] as const).map(([key, label]) => (
            <button
              key={key}
              data-testid={`cov-tab-${key}`}
              aria-pressed={tab === key}
              className={cn(
                'cursor-pointer rounded-md px-3 py-1 text-xs transition-colors',
                tab === key
                  ? 'bg-accent font-medium text-foreground'
                  : 'text-muted-foreground hover:text-foreground',
              )}
              onClick={() => setTab(key)}
            >
              {label}
            </button>
          ))}
        </div>
        <button
          className="inline-flex cursor-pointer items-center gap-1.5 rounded-lg bg-primary px-3.5 py-1.5 text-xs font-semibold text-primary-foreground transition-colors hover:opacity-90"
          onClick={() => setImportDialogOpen(true)}
          data-testid="cov-import-btn"
        >
          <Upload className="size-3" />
          导入覆盖率
        </button>
        <button
          className="inline-flex cursor-pointer items-center gap-1.5 rounded-lg border border-border px-3.5 py-1.5 text-xs font-medium text-muted-foreground transition-colors hover:border-border/80 hover:bg-card hover:text-foreground"
          onClick={() => openExportDialog()}
          data-testid="cov-export-btn"
        >
          <FileDown className="size-3" />
          导出报告
        </button>
      </ViewHeader>

      <div className="mb-3 grid grid-cols-[1.6fr_1fr] items-stretch gap-3">
        <TrendChart trend={sortedTrend} />
        <SummaryPanel overview={overview} targets={targets} trend={sortedTrend} loading={loading} />
      </div>

      {tab === 'module' ? (
        <ModuleSortTable
          tree={tree}
          loading={loading}
          onOpen={() => open({ type: 'coverage-detail' })}
        />
      ) : (
        <BinPanel state={binState} items={uncoveredItems.functional ?? []} />
      )}

      <CoverageImportDialog
        open={importDialogOpen}
        onClose={() => setImportDialogOpen(false)}
      />
    </div>
  );
}
