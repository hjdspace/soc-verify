/**
 * 覆盖率视图（Mission Control）— 覆盖率分析的工作视图。
 *
 * SoC 代码覆盖率重构：只关注代码覆盖率（line），功能/断言覆盖率退役。
 * 模块排序表（列头排序 / 低覆盖着色 <75% 黄、<70% 红 / 行点击下钻现有
 * 覆盖率明细；代码覆盖率 = 百分比 + 覆盖点数比合并展示；branch 列来自
 * summary 数据，blocks/statements 列预留 detail.txt 按需解析后填充）
 * + 7 日趋势图（SVG 单折线 + 90% 目标虚线；无按日历史查询，降级为最近
 * N 次 merge session，不造假数据）+ 汇总面板（代码覆盖率条 + 覆盖点数比
 * + 距目标差值 + 收敛预测）。
 * 数据只读复用 coverage store，不重写数据层。
 */

import { Fragment, useEffect, useMemo, useState } from 'react';
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
} from '@shared/types';
import { DEFAULT_COVERAGE_TARGETS } from '@shared/types';

// ─── 常量 ────────────────────────────────────────────────────

type TrendPoint = { sessionId: string; createdAt: number; summary: CoverageSummary };

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

// ─── 收敛预测（基于最近 N 个 merge session 的代码覆盖率增速） ──

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
    (recent[recent.length - 1].summary.line - recent[0].summary.line) /
    (spanMs / 86_400_000);
  if (rate <= 0) return { kind: 'stalled', diff };
  return { kind: 'predict', diff, days: Math.ceil(diff / rate) };
}

function convergenceText(conv: Convergence | null, target: number | undefined): string {
  if (!target || !conv) return '暂无覆盖率数据';
  switch (conv.kind) {
    case 'reached':
      return `代码覆盖率已达 ${target}% 目标`;
    case 'predict':
      return `距 ${target}% 目标还差 ${conv.diff.toFixed(1)}pp；按近期收敛速度，预计 ${conv.days} 天内达成`;
    case 'no-trend':
      return `距 ${target}% 目标还差 ${conv.diff.toFixed(1)}pp；暂无收敛趋势数据，无法预测`;
    case 'stalled':
      return `距 ${target}% 目标还差 ${conv.diff.toFixed(1)}pp；近期未在收敛，建议优先处理低覆盖模块`;
  }
}

// ─── 7 日趋势图（SVG 单折线 + 90% 目标虚线） ─────────────────────

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
  const values = recent.map((t) => t.summary.line);
  const minVal = Math.min(TARGET_LINE, ...values);
  const yMin = Math.max(0, Math.floor((minVal - 5) / 5) * 5);
  const yMax = 100;
  const yOf = (v: number): number => padTop + plotH * (1 - (v - yMin) / (yMax - yMin));
  const xOf = (i: number): number =>
    recent.length === 1 ? padX + plotW / 2 : padX + (plotW * i) / (recent.length - 1);

  return (
    <div
      className="flex min-w-0 flex-col overflow-hidden rounded-xl border border-border bg-card"
      data-testid="cov-trend-panel"
    >
      <div className="flex items-center gap-3 border-b border-border px-3.5 py-2.5 text-xs font-semibold text-foreground">
        7 日趋势
        <span className="ml-auto flex gap-3 text-[10px] font-normal text-muted-foreground">
          <span className="flex items-center gap-1">
            <span className="inline-block h-0.5 w-3 rounded bg-status-running" />
            代码
          </span>
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
        {/* 单折线（代码覆盖率） + 末端数据点 */}
        <g>
          {(() => {
            const pts = recent.map((t, i) => ({ x: xOf(i), y: yOf(t.summary.line) }));
            const lastPt = pts[pts.length - 1];
            return (
              <>
                {pts.length > 1 && (
                  <polyline
                    points={pts.map((p) => `${p.x},${p.y}`).join(' ')}
                    fill="none"
                    strokeWidth={1.8}
                    strokeLinecap="round"
                    className="stroke-status-running"
                    data-testid="cov-trend-line-code"
                  />
                )}
                <circle cx={lastPt.x} cy={lastPt.y} r={3} className="fill-status-running" />
              </>
            );
          })()}
        </g>
      </svg>
      <div className="px-3.5 pb-2 text-[10px] text-muted-foreground/70">
        最近 {recent.length} 次 merge session（按日历史查询待接入，降级展示）
      </div>
    </div>
  );
}

// ─── 汇总面板（代码覆盖率条 + 点数比 + 距目标差值 + 收敛预测） ───

function SummaryPanel({ overview, tree, targets, trend, loading }: {
  overview: CoverageSummary | null;
  tree: CoverageData | null;
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
  const deltaOf = last && prev ? last.summary.line - prev.summary.line : null;
  const conv = predictConvergence(trend, effective.line, overview?.line ?? null);

  // 覆盖点数比（root line triplet 的 covered/total）
  const lineTriplet = tree?.root.metrics.line ?? null;
  const pointsText =
    lineTriplet && lineTriplet.total !== null
      ? `${lineTriplet.covered ?? 0} / ${lineTriplet.total} 覆盖点`
      : null;

  const value = overview?.line ?? null;
  const target = effective.line;
  const diff = target !== undefined && value !== null ? target - value : null;
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
          {Array.from({ length: 2 }, (_, i) => (
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
          <div className="flex items-center gap-2.5" data-testid="cov-sum-row-line">
            <span className="w-8 shrink-0 text-xs text-muted-foreground">代码</span>
            <div className="h-1.5 min-w-0 flex-1 overflow-hidden rounded-sm bg-background">
              <div
                className={cn('h-full rounded-sm', lowBarClass(overview.line))}
                style={{ width: `${overview.line}%` }}
              />
            </div>
            <span className="w-12 shrink-0 text-right font-mono text-xs text-foreground">
              {overview.line.toFixed(1)}%
            </span>
            <span
              className="w-16 shrink-0 text-right text-[10px] text-muted-foreground"
              data-testid="cov-sum-diff-line"
            >
              {diff === null ? '无目标' : diff > 0 ? `差 ${diff.toFixed(1)}pp` : '已达标'}
            </span>
            <span
              className={cn(
                'w-11 shrink-0 text-right font-mono text-[10px]',
                deltaOf === null
                  ? 'text-muted-foreground/40'
                  : deltaOf > 0
                    ? 'text-primary'
                    : deltaOf < 0
                      ? 'text-status-fail-foreground'
                      : 'text-muted-foreground',
              )}
              data-testid="cov-sum-delta-line"
            >
              {deltaOf === null ? '—' : `${deltaOf > 0 ? '+' : ''}${deltaOf.toFixed(1)}`}
            </span>
          </div>
          {pointsText && (
            <div
              className="text-[11px] font-mono text-muted-foreground"
              data-testid="cov-sum-points"
            >
              覆盖点数比 {pointsText}
            </div>
          )}
          <div
            className="pt-1 text-[11px] leading-relaxed text-muted-foreground"
            data-testid="cov-convergence"
          >
            {convergenceText(conv, effective.line)}
          </div>
        </div>
      )}
    </div>
  );
}

// ─── 模块排序表（列头排序 / 低覆盖着色 / 行点击下钻） ────────────

type SortKey = 'module' | 'path' | 'line' | 'branch' | 'statement' | 'block';

type ModuleRow = {
  node: CoverageNode;
  /** 代码覆盖率（line） */
  line: number | null;
  /** branch 覆盖率（detail.txt 解析后填充，暂 N/A） */
  branch: number | null;
  /** statement 覆盖率（detail.txt 解析后填充，暂 N/A；映射 line metric） */
  statement: number | null;
  /** block 覆盖率（detail.txt 解析后填充，暂 N/A；映射 line metric） */
  block: number | null;
};

const MODULE_GRID = 'grid grid-cols-[minmax(0,0.9fr)_minmax(0,1.4fr)_90px_130px_64px_64px_64px]';

/** 表头列定义。'module' 与 'path' 为文本列（左对齐），其余为数值列（右对齐）。 */
const SORTABLE_COLS: ReadonlyArray<{ key: SortKey; label: string }> = [
  { key: 'module', label: '模块' },
  { key: 'path', label: '层级' },
  { key: 'line', label: '代码覆盖率' },
  { key: 'branch', label: 'Branch' },
  { key: 'statement', label: 'Stmts' },
  { key: 'block', label: 'Blocks' },
];

function toModuleRow(node: CoverageNode): ModuleRow {
  return {
    node,
    line: node.metrics.line.percentage,
    branch: node.metrics.branch.percentage,
    // statement/block 待 detail.txt 按需解析后填充（暂 N/A）
    statement: null,
    block: null,
  };
}

function collectRows(node: CoverageNode, out: ModuleRow[]): void {
  for (const child of node.children) {
    out.push(toModuleRow(child));
    collectRows(child, out);
  }
}

function compareRows(a: ModuleRow, b: ModuleRow, key: SortKey, dir: 'asc' | 'desc'): number {
  // 文本列：模块名 / 完整层级 path（点号字典序天然保持树形分组）
  if (key === 'module') {
    const byName = a.node.name.localeCompare(b.node.name);
    return dir === 'asc' ? byName : -byName;
  }
  if (key === 'path') {
    const byPath = a.node.path.localeCompare(b.node.path);
    return dir === 'asc' ? byPath : -byPath;
  }
  const av = a[key];
  const bv = b[key];
  // N/A 恒沉底（无数据不参与高低位次）
  if (av === null && bv === null) return 0;
  if (av === null) return 1;
  if (bv === null) return -1;
  return dir === 'asc' ? av - bv : bv - av;
}

/** 代码覆盖率单元：百分比 + 覆盖点数比合并展示（如 94.13% (353/375)） */
function CoverageCell({ path, node, pct }: { path: string; node: CoverageNode; pct: number | null }) {
  const t = node.metrics.line;
  const counts = pct !== null && t.covered !== null && t.total !== null ? ` (${t.covered}/${t.total})` : '';
  return (
    <span
      data-testid={`cov-cell-${path}-line`}
      className={cn('text-right font-mono text-[11px] tabular-nums', lowTextClass(pct))}
    >
      {pct === null ? 'N/A' : `${pct.toFixed(1)}%${counts}`}
    </span>
  );
}

/** 预留列（blocks/branches/statements）：detail.txt 按需解析后填充，暂 N/A */
function PlaceholderCell({ path, metric, pct }: { path: string; metric: string; pct: number | null }) {
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
        <span className="block truncate font-mono text-xs text-foreground" title={row.node.name}>
          {row.node.name}
        </span>
      </div>
      {/* 完整层级 path（点号拼接，与树一致）：同名模块（如各级 U_SYNC_UPDT）靠它区分 */}
      <div className="min-w-0 overflow-hidden" title={row.node.path}>
        <span
          className="block truncate font-mono text-[10px] text-muted-foreground/80"
          data-testid={`cov-path-${row.node.path}`}
        >
          {row.node.path}
        </span>
      </div>
      <div
        className="h-1 overflow-hidden rounded-sm bg-background"
        title={row.line === null ? 'N/A' : `${row.line.toFixed(1)}%`}
      >
        <div
          className={cn('h-full rounded-sm', lowBarClass(row.line))}
          style={{ width: `${row.line ?? 0}%` }}
          data-testid={`cov-bar-${row.node.path}`}
        />
      </div>
      <CoverageCell path={row.node.path} node={row.node} pct={row.line} />
      <PlaceholderCell path={row.node.path} metric="branch" pct={row.branch} />
      <PlaceholderCell path={row.node.path} metric="statement" pct={row.statement} />
      <PlaceholderCell path={row.node.path} metric="block" pct={row.block} />
    </div>
  );
}

function ModuleSortTable({ tree, loading, onOpen }: {
  tree: CoverageData | null;
  loading: boolean;
  onOpen: () => void;
}) {
  const [sortKey, setSortKey] = useState<SortKey>('line');
  // 默认代码覆盖率升序：低覆盖模块置顶，便于聚焦收敛
  const [sortDir, setSortDir] = useState<'asc' | 'desc'>('asc');

  const rows = useMemo<ModuleRow[]>(() => {
    if (!tree) return [];
    const out: ModuleRow[] = [];
    collectRows(tree.root, out);
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
      // 文本列（模块/层级）默认升序，数值列默认降序
      setSortDir(key === 'module' || key === 'path' ? 'asc' : 'desc');
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
        {SORTABLE_COLS.map(({ key, label }, i) => (
          <Fragment key={key}>
            {/* 文本列（模块/层级）之后插入覆盖率条的空表头占位，使数值列与数据行严格对齐 */}
            {i === 1 && <span aria-hidden />}
            <button
              data-testid={`cov-sort-${key}`}
              onClick={() => handleSort(key)}
              className={cn(
                'flex cursor-pointer items-center gap-1 transition-colors hover:text-foreground',
                key !== 'module' && key !== 'path' && 'justify-end',
                sortKey === key && 'text-primary',
              )}
            >
              {label}
              {sortKey === key && (
                <span className="text-[9px]">{sortDir === 'asc' ? '↑' : '↓'}</span>
              )}
            </button>
          </Fragment>
        ))}
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
  const openExportDialog = useCoverageExportStore((s) => s.openExportDialog);

  // gaps store
  const targets = useCoverageGapsStore((s) => s.targets);
  const trend = useCoverageGapsStore((s) => s.trend);
  const loadTrend = useCoverageGapsStore((s) => s.loadTrend);
  const open = useWorkbenchStore((s) => s.open);

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
        <SummaryPanel
          overview={overview}
          tree={tree}
          targets={targets}
          trend={sortedTrend}
          loading={loading}
        />
      </div>

      <ModuleSortTable
        tree={tree}
        loading={loading}
        onOpen={() => open({ type: 'coverage-detail' })}
      />

      <CoverageImportDialog
        open={importDialogOpen}
        onClose={() => setImportDialogOpen(false)}
      />
    </div>
  );
}
