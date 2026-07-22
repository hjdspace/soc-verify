/**
 * CoverageDashboard — 覆盖率仪表盘视图（Slice 4）。
 *
 * 实现 PRD 用户故事 24-28：
 *   - US-24: 8 个概览卡片（含达标状态徽章 + 进度条）
 *   - US-25: 覆盖率趋势折线图（纯 SVG，最近 N 个 merge session）
 *   - US-26: 紧凑树表格（模块名 + line/branch/functional 三列）
 *   - US-27: 未覆盖项列表（按 metric 切换 tab）
 *   - US-28: AI 分析建议面板（本切片为占位，实际分析在 Slice 6b）
 *
 * US-29 视图切换已在 Slice 3 的 CoveragePanel 中实现。
 */
import { useMemo, useState } from 'react';
import {
  ChevronRight, ChevronDown, Check, AlertTriangle, X, Minus, Sparkles,
  Loader2, Square, RefreshCw,
} from 'lucide-react';
import { cn } from '@renderer/lib/utils';
import { useCoverageStore } from '@renderer/stores/coverage';
import { useProjectStore } from '@renderer/stores/project';
import type {
  CoverageData, CoverageMetric, CoverageNode, CoverageSummary,
  CoverageTriplet, UncoveredItem,
} from '@shared/types';
import { COVERAGE_METRICS, DEFAULT_COVERAGE_TARGETS } from '@shared/types';

// ─── 常量 ────────────────────────────────────────────────────────

const METRIC_LABELS: Record<CoverageMetric, string> = {
  line: 'Line',
  branch: 'Branch',
  toggle: 'Toggle',
  condition: 'Cond',
  fsm_state: 'FSM St',
  fsm_transition: 'FSM Tr',
  functional: 'Func',
  assertion: 'Assert',
};

type Status = 'pass' | 'warn' | 'fail' | 'na';

// ─── 颜色分类（与 CoverageTreeTable 保持一致） ──────────────────

/**
 * 根据 metric、百分比和目标值分类覆盖率状态。
 * - percentage === null → na（灰）
 * - 无目标（assertion）: >= 90 pass; >= 80 warn; 否则 fail
 * - 有目标: >= target pass; >= target-5 warn; 否则 fail
 */
function classify(
  metric: CoverageMetric,
  percentage: number | null,
  target: number | undefined,
): Status {
  if (percentage === null) return 'na';
  if (target === undefined) {
    if (percentage >= 90) return 'pass';
    if (percentage >= 80) return 'warn';
    return 'fail';
  }
  if (percentage >= target) return 'pass';
  if (percentage >= target - 5) return 'warn';
  return 'fail';
}

const STATUS_TEXT: Record<Status, string> = {
  pass: 'text-emerald-500',
  warn: 'text-yellow-500',
  fail: 'text-destructive',
  na: 'text-muted-foreground',
};

const STATUS_BADGE: Record<Status, string> = {
  pass: 'bg-emerald-500/15 text-emerald-500',
  warn: 'bg-yellow-500/15 text-yellow-500',
  fail: 'bg-destructive/15 text-destructive',
  na: 'bg-muted text-muted-foreground',
};

const STATUS_BAR: Record<Status, string> = {
  pass: 'bg-emerald-500',
  warn: 'bg-yellow-500',
  fail: 'bg-destructive',
  na: 'bg-muted-foreground',
};

const STATUS_LABEL: Record<Status, string> = {
  pass: '达标',
  warn: '接近',
  fail: '未达标',
  na: '无目标',
};

const STATUS_ICON: Record<Status, typeof Check> = {
  pass: Check,
  warn: AlertTriangle,
  fail: X,
  na: Minus,
};

// ─── 趋势图线条配置 ─────────────────────────────────────────────

type TrendLineKey = 'line' | 'branch' | 'functional';

const TREND_LINES: Array<{ key: TrendLineKey; label: string; color: string }> = [
  { key: 'line', label: 'Line', color: '#3b82f6' },       // 蓝
  { key: 'branch', label: 'Branch', color: '#f97316' },   // 橙
  { key: 'functional', label: 'Functional', color: '#22c55e' }, // 绿
];

// ─── 辅助函数 ────────────────────────────────────────────────────

function pctStr(n: number | null): string {
  return n === null ? 'N/A' : `${n.toFixed(1)}%`;
}

function tripletStr(t: CoverageTriplet): string {
  if (t.percentage === null) return '';
  return `${t.covered ?? '?'}/${t.total ?? '?'}`;
}

/** 收集树中所有有子节点的路径（用于全部展开） */
function collectExpandablePaths(node: CoverageNode, out: Set<string> = new Set()): Set<string> {
  if (node.children.length > 0) {
    out.add(node.path);
    for (const child of node.children) collectExpandablePaths(child, out);
  }
  return out;
}

type VisibleRow = { node: CoverageNode };

/** 递归收集可见行（简化版，无过滤） */
function collectVisible(
  node: CoverageNode,
  expanded: Set<string>,
  isAncestorExpanded: boolean,
  out: VisibleRow[],
): void {
  if (!isAncestorExpanded) return;
  out.push({ node });
  const isExpanded = expanded.has(node.path);
  for (const child of node.children) {
    collectVisible(child, expanded, isAncestorExpanded && isExpanded, out);
  }
}

/** 取 session ID 简写（取最后一段，最多 8 字符） */
function shortSessionId(sid: string): string {
  const parts = sid.split(/[_\-]/);
  const last = parts[parts.length - 1] ?? sid;
  return last.length > 8 ? last.slice(0, 8) : last;
}

// ─── 主组件 ──────────────────────────────────────────────────────

export type CoverageDashboardProps = {
  data: CoverageData;
  overview: CoverageSummary | null;
  targets: Partial<Record<CoverageMetric, number>>;
  sessions: Array<{ sessionId: string; createdAt: number }>;
  trend: Array<{ sessionId: string; createdAt: number; summary: CoverageSummary }>;
};

export function CoverageDashboard({
  data, overview, targets, sessions, trend,
}: CoverageDashboardProps) {
  const { root } = data;

  // 合并默认目标与项目级覆盖
  const effectiveTargets = useMemo<Partial<Record<CoverageMetric, number>>>(
    () => ({ ...DEFAULT_COVERAGE_TARGETS, ...targets }),
    [targets],
  );

  return (
    <div className="space-y-4">
      {/* 1. 概览卡片 */}
      <OverviewCards root={root} targets={effectiveTargets} overview={overview} />

      {/* 2. 趋势折线图 */}
      <TrendChart trend={trend} sessions={sessions} />

      {/* 3. 紧凑树表格 */}
      <CompactTreeTable root={root} targets={effectiveTargets} />

      {/* 4. 未覆盖项列表 */}
      <UncoveredList data={data} />

      {/* 5. AI 覆盖收敛面板（Slice 6b） */}
      <AiClosurePanel overview={overview} />
    </div>
  );
}

// ─── 概览卡片 ────────────────────────────────────────────────────

function OverviewCards({
  root,
  targets,
  overview,
}: {
  root: CoverageNode;
  targets: Partial<Record<CoverageMetric, number>>;
  overview: CoverageSummary | null;
}) {
  return (
    <div className="grid grid-cols-4 gap-2">
      {COVERAGE_METRICS.map((m) => {
        const triplet = root.metrics[m];
        const status = classify(m, triplet.percentage, targets[m]);
        const target = targets[m];
        const Icon = STATUS_ICON[status];
        return (
          <div key={m} className="rounded border border-border bg-card p-2">
            <div className="mb-1 flex items-center justify-between">
              <span className="text-[10px] font-medium text-muted-foreground">
                {METRIC_LABELS[m]}
              </span>
              <span
                className={cn(
                  'flex h-4 w-4 items-center justify-center rounded-full',
                  STATUS_BADGE[status],
                )}
              >
                <Icon className="h-2.5 w-2.5" />
              </span>
            </div>
            <div className={cn('font-mono text-lg font-bold', STATUS_TEXT[status])}>
              {pctStr(triplet.percentage)}
            </div>
            <div className="font-mono text-[10px] text-muted-foreground">
              {tripletStr(triplet) || '—'}
            </div>
            {/* 进度条 */}
            <div className="mt-1.5 h-1 overflow-hidden rounded-full bg-secondary">
              <div
                className={cn('h-full rounded-full transition-all', STATUS_BAR[status])}
                style={{ width: `${triplet.percentage ?? 0}%` }}
              />
            </div>
            <div className="mt-1 text-[9px] text-muted-foreground">
              {target !== undefined
                ? `目标 ${target}% · ${STATUS_LABEL[status]}`
                : STATUS_LABEL[status]}
            </div>
          </div>
        );
      })}
      {/* 总体覆盖率卡片（使用 overview） */}
      {overview && (
        <div className="col-span-4 rounded border border-border bg-secondary/40 p-2">
          <div className="flex items-center justify-between">
            <span className="text-[10px] font-medium text-muted-foreground">总体覆盖率（8 项均值）</span>
            <span className="font-mono text-lg font-bold text-foreground">
              {overview.overall.toFixed(1)}%
            </span>
          </div>
        </div>
      )}
    </div>
  );
}

// ─── 趋势折线图（纯 SVG） ────────────────────────────────────────

function TrendChart({
  trend,
  sessions,
}: {
  trend: Array<{ sessionId: string; createdAt: number; summary: CoverageSummary }>;
  sessions: Array<{ sessionId: string; createdAt: number }>;
}) {
  // 趋势数据按 createdAt 升序排列（时间从左到右）
  const sortedTrend = useMemo(
    () => [...trend].sort((a, b) => a.createdAt - b.createdAt),
    [trend],
  );

  // 图表尺寸
  const width = 600;
  const height = 120;
  const padX = 32;
  const padY = 16;
  const plotW = width - padX * 2;
  const plotH = height - padY * 2;

  // 计算折线坐标
  const lineData = useMemo(() => {
    if (sortedTrend.length === 0) return [];
    return TREND_LINES.map(({ key, label, color }) => {
      const points = sortedTrend.map((t, i) => {
        const x = sortedTrend.length === 1
          ? padX + plotW / 2
          : padX + (plotW * i) / (sortedTrend.length - 1);
        const value = t.summary[key];
        const y = padY + plotH * (1 - value / 100);
        return { x, y, value };
      });
      return { key, label, color, points };
    });
  }, [sortedTrend, plotW, plotH]);

  // 空状态
  if (sortedTrend.length === 0) {
    return (
      <div className="rounded border border-border bg-card p-3">
        <div className="mb-2 text-xs font-medium">覆盖率趋势</div>
        <div className="flex items-center justify-center py-6 text-xs text-muted-foreground">
          暂无趋势数据（需要多个 merge session）
        </div>
      </div>
    );
  }

  return (
    <div className="rounded border border-border bg-card p-3">
      <div className="mb-2 flex items-center justify-between">
        <span className="text-xs font-medium">覆盖率趋势</span>
        {/* 图例 */}
        <div className="flex gap-3 text-[10px] text-muted-foreground">
          {TREND_LINES.map((l) => (
            <span key={l.key} className="flex items-center gap-1">
              <span
                className="inline-block h-0.5 w-3 rounded"
                style={{ backgroundColor: l.color }}
              />
              {l.label}
            </span>
          ))}
        </div>
      </div>
      <svg
        className="w-full"
        viewBox={`0 0 ${width} ${height}`}
        preserveAspectRatio="none"
        role="img"
        aria-label="覆盖率趋势图"
      >
        {/* Y 轴网格线 + 标签（0/25/50/75/100） */}
        {[0, 25, 50, 75, 100].map((v) => {
          const y = padY + plotH * (1 - v / 100);
          return (
            <g key={v}>
              <line
                x1={padX}
                y1={y}
                x2={width - padX}
                y2={y}
                stroke="currentColor"
                strokeWidth={0.5}
                className="text-border"
              />
              <text
                x={padX - 4}
                y={y + 3}
                fontSize={8}
                textAnchor="end"
                className="fill-muted-foreground font-mono"
              >
                {v}%
              </text>
            </g>
          );
        })}

        {/* X 轴标签（session ID 简写） */}
        {sortedTrend.map((t, i) => {
          const x = sortedTrend.length === 1
            ? padX + plotW / 2
            : padX + (plotW * i) / (sortedTrend.length - 1);
          return (
            <text
              key={t.sessionId}
              x={x}
              y={height - 3}
              fontSize={8}
              textAnchor="middle"
              className="fill-muted-foreground font-mono"
            >
              {shortSessionId(t.sessionId)}
            </text>
          );
        })}

        {/* 三条折线 */}
        {lineData.map((line) => {
          const polylinePoints = line.points.map((p) => `${p.x},${p.y}`).join(' ');
          return (
            <g key={line.key}>
              <polyline
                points={polylinePoints}
                fill="none"
                stroke={line.color}
                strokeWidth={1.8}
                opacity={0.85}
              />
              {/* 数据点 */}
              {line.points.map((p, i) => (
                <circle
                  key={`${line.key}-${i}`}
                  cx={p.x}
                  cy={p.y}
                  r={2.5}
                  fill={line.color}
                />
              ))}
            </g>
          );
        })}
      </svg>
      <div className="mt-1 text-[10px] text-muted-foreground">
        共 {sortedTrend.length} 个 session{sessions.length > sortedTrend.length ? `（已加载 ${sessions.length} 个，仅显示有数据的）` : ''}
      </div>
    </div>
  );
}

// ─── 紧凑树表格（仅 line/branch/functional 三列） ────────────────

const COMPACT_METRICS: CoverageMetric[] = ['line', 'branch', 'functional'];

function CompactTreeTable({
  root,
  targets,
}: {
  root: CoverageNode;
  targets: Partial<Record<CoverageMetric, number>>;
}) {
  const allExpandablePaths = useMemo(() => collectExpandablePaths(root), [root]);
  // 默认展开根节点
  const [expanded, setExpanded] = useState<Set<string>>(() => new Set([root.path]));

  const visibleRows = useMemo(() => {
    const rows: VisibleRow[] = [];
    collectVisible(root, expanded, true, rows);
    return rows;
  }, [root, expanded]);

  const toggleNode = (path: string) => {
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(path)) next.delete(path);
      else next.add(path);
      return next;
    });
  };

  const expandAll = () => setExpanded(new Set(allExpandablePaths));
  const collapseAll = () => setExpanded(new Set());

  return (
    <div className="rounded border border-border bg-card">
      {/* 工具栏 */}
      <div className="flex items-center justify-between border-b border-border px-3 py-2">
        <span className="text-xs font-medium">模块层级覆盖率</span>
        <div className="flex gap-1">
          <button
            onClick={expandAll}
            className="rounded border border-border bg-background px-2 py-0.5 text-[10px] hover:bg-secondary"
          >
            全部展开
          </button>
          <button
            onClick={collapseAll}
            className="rounded border border-border bg-background px-2 py-0.5 text-[10px] hover:bg-secondary"
          >
            全部折叠
          </button>
        </div>
      </div>
      {/* 表格 */}
      <div className="max-h-[40vh] overflow-auto">
        <table className="w-full text-xs">
          <thead className="sticky top-0 z-10 bg-secondary">
            <tr>
              <th className="px-2 py-1.5 text-left text-[10px] uppercase text-muted-foreground">
                模块
              </th>
              {COMPACT_METRICS.map((m) => (
                <th
                  key={m}
                  className="px-2 py-1.5 text-right text-[10px] uppercase text-muted-foreground"
                >
                  {METRIC_LABELS[m]}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {visibleRows.map(({ node }) => (
              <CompactTreeRow
                key={node.path}
                node={node}
                expanded={expanded.has(node.path)}
                targets={targets}
                onToggle={toggleNode}
              />
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function CompactTreeRow({
  node,
  expanded,
  targets,
  onToggle,
}: {
  node: CoverageNode;
  expanded: boolean;
  targets: Partial<Record<CoverageMetric, number>>;
  onToggle: (path: string) => void;
}) {
  const hasChildren = node.children.length > 0;
  const isRoot = node.depth === 0;

  return (
    <tr className={cn('border-t border-border', isRoot && 'bg-secondary/30 font-medium')}>
      <td className="px-2 py-1">
        <div className="flex items-center" style={{ paddingLeft: `${node.depth * 14}px` }}>
          {hasChildren ? (
            <button
              onClick={() => onToggle(node.path)}
              className="flex items-center gap-1"
            >
              {expanded
                ? <ChevronDown className="h-3 w-3 flex-shrink-0" />
                : <ChevronRight className="h-3 w-3 flex-shrink-0" />}
              <span className="font-semibold">{node.name}</span>
            </button>
          ) : (
            <span className="pl-4">{node.name}</span>
          )}
        </div>
      </td>
      {COMPACT_METRICS.map((m) => {
        const triplet = node.metrics[m];
        const status = classify(m, triplet.percentage, targets[m]);
        return (
          <td key={m} className="px-2 py-1 text-right">
            <div className="flex flex-col items-end">
              <span className={cn('font-mono text-[11px] font-semibold', STATUS_TEXT[status])}>
                {pctStr(triplet.percentage)}
              </span>
              {triplet.percentage !== null && (
                <span className="font-mono text-[9px] text-muted-foreground">
                  {tripletStr(triplet)}
                </span>
              )}
            </div>
          </td>
        );
      })}
    </tr>
  );
}

// ─── 未覆盖项列表（按 metric 切换 tab） ──────────────────────────

function UncoveredList({ data }: { data: CoverageData }) {
  const [activeMetric, setActiveMetric] = useState<CoverageMetric>('line');
  const uncovered = data.uncovered;
  const items: UncoveredItem[] = useMemo(() => {
    if (!uncovered) return [];
    return uncovered[activeMetric] ?? [];
  }, [uncovered, activeMetric]);

  return (
    <div className="rounded border border-border bg-card p-3">
      <div className="mb-2 flex items-center justify-between">
        <span className="text-xs font-medium">未覆盖项</span>
        {/* Tab 切换 */}
        <div className="flex flex-wrap gap-1">
          {COVERAGE_METRICS.map((m) => (
            <button
              key={m}
              onClick={() => setActiveMetric(m)}
              className={cn(
                'rounded px-2 py-0.5 text-[10px] transition-colors',
                activeMetric === m
                  ? 'bg-primary/10 text-primary'
                  : 'bg-secondary text-muted-foreground hover:text-foreground',
              )}
            >
              {METRIC_LABELS[m]}
            </button>
          ))}
        </div>
      </div>

      {/* 列表内容 */}
      {!uncovered ? (
        <div className="py-4 text-center text-xs text-muted-foreground">
          暂无未覆盖项数据
        </div>
      ) : items.length === 0 ? (
        <div className="py-4 text-center text-xs text-muted-foreground">
          全部覆盖
        </div>
      ) : (
        <div className="flex max-h-[220px] flex-col gap-1 overflow-y-auto">
          {items.map((item, idx) => (
            <UncoveredItemRow key={`${item.module}-${idx}`} item={item} />
          ))}
        </div>
      )}
    </div>
  );
}

function UncoveredItemRow({ item }: { item: UncoveredItem }) {
  return (
    <div className="flex items-center gap-2 rounded bg-secondary/50 px-2 py-1.5 text-[11px] hover:bg-secondary">
      <span className="min-w-[140px] font-mono font-medium text-primary">
        {item.module}
      </span>
      {item.file && (
        <span className="font-mono text-muted-foreground">
          {item.file}{item.line !== undefined ? `:${item.line}` : ''}
        </span>
      )}
      {item.signal && (
        <span className="font-mono text-muted-foreground">
          {item.signal}
        </span>
      )}
      <span className="ml-auto text-muted-foreground">{item.description}</span>
      <span className="rounded bg-destructive/15 px-1.5 py-0.5 text-[9px] font-bold uppercase tracking-wide text-destructive">
        GAP
      </span>
    </div>
  );
}

// ─── AI 覆盖收敛面板（Slice 6b） ─────────────────────────────────

/** Gap 状态对应的显示文本与颜色 */
const GAP_STATUS_LABEL: Record<string, string> = {
  pending: '待处理',
  in_progress: '进行中',
  closed: '已关闭',
  escalated: '已升级',
  failed: '失败',
};

const GAP_STATUS_COLOR: Record<string, string> = {
  pending: 'text-muted-foreground',
  in_progress: 'text-primary',
  closed: 'text-emerald-500',
  escalated: 'text-destructive',
  failed: 'text-destructive',
};

const GAP_STATUS_DOT: Record<string, string> = {
  pending: 'bg-muted-foreground',
  in_progress: 'bg-primary',
  closed: 'bg-emerald-500',
  escalated: 'bg-destructive',
  failed: 'bg-destructive',
};

/** Closure 状态文本 */
const CLOSURE_STATUS_LABEL: Record<string, string> = {
  pending: '待处理',
  running: '运行中',
  completed: '已完成',
  failed: '失败',
  aborted: '已中止',
};

function AiClosurePanel({ overview }: { overview: CoverageSummary | null }) {
  const currentClosure = useCoverageStore((s) => s.currentClosure);
  const closureLive = useCoverageStore((s) => s.closureLive);
  const startClosure = useCoverageStore((s) => s.startClosure);
  const abortClosure = useCoverageStore((s) => s.abortClosure);
  const currentProjectId = useProjectStore((s) => s.currentProjectId);
  const currentSessionId = useCoverageStore((s) => s.currentSessionId);

  const canStart = !!currentProjectId && !!currentSessionId;
  const isActive = closureLive.running;
  const isTerminal = currentClosure
    ? ['completed', 'aborted', 'failed'].includes(currentClosure.status)
    : false;

  const handleStart = (): void => {
    if (!canStart || !currentProjectId || !currentSessionId) return;
    void startClosure(currentProjectId, currentSessionId);
  };

  const handleAbort = (): void => {
    if (!currentProjectId || !currentClosure) return;
    void abortClosure(currentProjectId, currentClosure.id);
  };

  // 无 closure 记录 → 显示启动按钮
  if (!currentClosure) {
    return (
      <div className="rounded border border-primary/30 bg-primary/5 p-3">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-2">
            <Sparkles className="h-4 w-4 text-primary" />
            <div>
              <div className="text-xs font-semibold">AI 覆盖收敛分析</div>
              <div className="text-[10px] text-muted-foreground">
                {overview
                  ? `当前总体覆盖率 ${overview.overall.toFixed(1)}%`
                  : '导入覆盖率数据后可启动 AI Closure'}
              </div>
            </div>
          </div>
          <button
            onClick={handleStart}
            disabled={!canStart}
            className="flex items-center gap-1 rounded bg-primary px-3 py-1 text-xs text-primary-foreground hover:bg-primary/90 disabled:opacity-50"
            title={canStart ? '启动 AI Coverage Closure 闭环' : '需要先选择项目与覆盖率 Session'}
            data-testid="closure-start-btn"
          >
            <Sparkles className="h-3 w-3" />
            启动 AI Closure
          </button>
        </div>
        <div className="mt-2 text-[11px] text-muted-foreground">
          AI 将自动识别覆盖率缺口，生成定向测试并迭代验证，直至达标或触发升级转人工审查。
        </div>
      </div>
    );
  }

  // 有 closure 记录（运行中或已完成）
  const gaps = currentClosure.gaps;
  const completedGaps = gaps.filter((g) => g.status === 'closed').length;
  const escalatedGaps = gaps.filter((g) => g.status === 'escalated').length;
  const failedGaps = gaps.filter((g) => g.status === 'failed').length;

  // 计算总 delta（最后一个迭代的 deltaBefore → deltaAfter）
  let totalDeltaOverall = 0;
  for (const gap of gaps) {
    const lastIter = gap.iterations[gap.iterations.length - 1];
    if (lastIter?.deltaBefore && lastIter?.deltaAfter) {
      totalDeltaOverall += lastIter.deltaAfter.overall - lastIter.deltaBefore.overall;
    }
  }

  return (
    <div className="rounded border border-border bg-card p-3">
      {/* 头部：标题 + 状态 + 操作按钮 */}
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          {isActive ? (
            <span className="relative flex h-3 w-3">
              <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-primary opacity-75" />
              <span className="relative inline-flex h-3 w-3 rounded-full bg-primary" />
            </span>
          ) : (
            <Sparkles className="h-4 w-4 text-primary" />
          )}
          <div>
            <div className="text-xs font-semibold">
              AI 覆盖收敛分析
              <span className="ml-2 rounded bg-secondary px-1.5 py-0.5 text-[9px] font-normal text-muted-foreground">
                {CLOSURE_STATUS_LABEL[currentClosure.status] ?? currentClosure.status}
              </span>
            </div>
            <div className="text-[10px] text-muted-foreground">
              {overview
                ? `当前总体覆盖率 ${overview.overall.toFixed(1)}%`
                : `${gaps.length} 个 Gap`}
            </div>
          </div>
        </div>
        {isActive ? (
          <button
            onClick={handleAbort}
            className="flex items-center gap-1 rounded border border-destructive/50 bg-destructive/10 px-3 py-1 text-xs text-destructive hover:bg-destructive/20"
            data-testid="closure-abort-btn"
          >
            <Square className="h-3 w-3" />
            中止
          </button>
        ) : isTerminal ? (
          <button
            onClick={handleStart}
            disabled={!canStart}
            className="flex items-center gap-1 rounded bg-primary px-3 py-1 text-xs text-primary-foreground hover:bg-primary/90 disabled:opacity-50"
            data-testid="closure-restart-btn"
          >
            <RefreshCw className="h-3 w-3" />
            重新启动
          </button>
        ) : null}
      </div>

      {/* 运行中实时进度 */}
      {isActive && closureLive.activeGapId && (
        <div className="mt-2 rounded bg-secondary/40 p-2">
          <div className="flex items-center gap-2 text-[11px]">
            <Loader2 className="h-3 w-3 animate-spin text-primary" />
            <span className="text-foreground">
              Gap 迭代中 · Round {closureLive.activeRound ?? '?'}
              {closureLive.agentPhase === 'prompting' && ' · AI 生成测试中'}
              {closureLive.agentPhase === 'ended' && ' · AI 完成，计算 Delta'}
            </span>
          </div>
          {typeof closureLive.lastDeltaOverall === 'number' && (
            <div className="mt-1 font-mono text-[10px] text-muted-foreground">
              最近 Delta: <span className="text-primary">+{closureLive.lastDeltaOverall.toFixed(2)}%</span>
            </div>
          )}
          {closureLive.lastError && (
            <div className="mt-1 text-[10px] text-destructive">{closureLive.lastError}</div>
          )}
        </div>
      )}

      {/* Gap 队列 */}
      <div className="mt-2">
        <div className="mb-1 text-[10px] font-medium text-muted-foreground">
          Gap 队列（{gaps.length}）· 已关闭 {completedGaps} · 升级 {escalatedGaps} · 失败 {failedGaps}
        </div>
        <div className="flex max-h-[180px] flex-col gap-1 overflow-y-auto">
          {gaps.map((gap) => {
            const lastIter = gap.iterations[gap.iterations.length - 1];
            const iterDelta = lastIter?.deltaBefore && lastIter?.deltaAfter
              ? lastIter.deltaAfter.overall - lastIter.deltaBefore.overall
              : undefined;
            const isLiveGap = isActive && closureLive.activeGapId === gap.id;
            return (
              <div
                key={gap.id}
                className={cn(
                  'flex items-center gap-2 rounded px-2 py-1.5 text-[11px]',
                  isLiveGap ? 'bg-primary/10' : 'bg-secondary/50',
                )}
              >
                <span className={cn('h-2 w-2 flex-shrink-0 rounded-full', GAP_STATUS_DOT[gap.status] ?? 'bg-muted-foreground')} />
                <span className="min-w-[100px] font-mono font-medium text-foreground">
                  {gap.gap.nodeName}
                </span>
                <span className="text-muted-foreground">{METRIC_LABELS[gap.gap.metric] ?? gap.gap.metric}</span>
                <span className="font-mono text-destructive">−{gap.gap.deficit.toFixed(1)}</span>
                <span className={cn('ml-auto', GAP_STATUS_COLOR[gap.status] ?? 'text-muted-foreground')}>
                  {GAP_STATUS_LABEL[gap.status] ?? gap.status}
                </span>
                {gap.iterations.length > 0 && (
                  <span className="font-mono text-[10px] text-muted-foreground">
                    R{gap.iterations.length}
                    {typeof iterDelta === 'number' && (
                      <span className={iterDelta >= 1 ? 'text-primary' : 'text-yellow-500'}>
                        {' '}({iterDelta >= 0 ? '+' : ''}{iterDelta.toFixed(1)}%)
                      </span>
                    )}
                  </span>
                )}
                {isLiveGap && (
                  <Loader2 className="h-3 w-3 animate-spin text-primary" />
                )}
              </div>
            );
          })}
        </div>
      </div>

      {/* 完成后摘要 */}
      {isTerminal && (
        <div className="mt-2 rounded border border-border bg-secondary/30 p-2 text-[11px]">
          <div className="flex items-center justify-between">
            <span className="text-muted-foreground">Closure 结果摘要</span>
            <span className="font-mono text-primary">
              总 Delta: +{totalDeltaOverall.toFixed(1)}%
            </span>
          </div>
          {currentClosure.status === 'aborted' && (
            <div className="mt-1 text-destructive">闭环已被用户中止</div>
          )}
          {escalatedGaps > 0 && (
            <div className="mt-1 text-destructive">
              {escalatedGaps} 个 Gap 已升级至人工审查（Dead code 确认 / Exclusion 审批需人工介入）
            </div>
          )}
        </div>
      )}
    </div>
  );
}
