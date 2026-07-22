/**
 * CoverageTreeTable — 覆盖率树表格视图（Slice 3）。
 *
 * 实现 PRD 用户故事 18-23：
 *   - 展开/折叠模块树的节点
 *   - 每列指标用颜色标记达标（绿）/接近（黄）/未达标（红）/N/A（灰）
 *   - 过滤模块名
 *   - 一键展开/全部折叠
 *   - "仅看未达标"过滤
 *   - 顶部 8 个概览卡片（总体覆盖率 + 达标状态徽章 + 进度条）
 */
import { useMemo, useState } from 'react';
import {
  ChevronRight, ChevronDown, Check, AlertTriangle, X, Minus,
} from 'lucide-react';
import { cn } from '@renderer/lib/utils';
import type {
  CoverageData, CoverageMetric, CoverageNode, CoverageTriplet,
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

const METRIC_TARGET_HINTS: Record<CoverageMetric, string> = {
  line: '≥95%',
  branch: '≥90%',
  toggle: '≥85%',
  condition: '≥85%',
  fsm_state: '=100%',
  fsm_transition: '≥90%',
  functional: '=100%',
  assertion: '≥90%',
};

type Status = 'pass' | 'warn' | 'fail' | 'na';

// ─── 颜色分类 ────────────────────────────────────────────────────

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

/** 判断子树中是否有名字匹配过滤的节点 */
function subtreeMatchesFilter(node: CoverageNode, filter: string): boolean {
  if (node.name.toLowerCase().includes(filter)) return true;
  return node.children.some((c) => subtreeMatchesFilter(c, filter));
}

/** 判断节点自身是否有 fail 状态的 metric */
function nodeHasFail(
  node: CoverageNode,
  targets: Partial<Record<CoverageMetric, number>>,
): boolean {
  return COVERAGE_METRICS.some(
    (m) => classify(m, node.metrics[m].percentage, targets[m]) === 'fail',
  );
}

type VisibleRow = {
  node: CoverageNode;
  dimmed: boolean;
};

/**
 * 递归收集可见行。
 * - 展开状态：祖先全部展开时行才可见
 * - 过滤：节点或其后代匹配过滤时才可见（过滤时自动展开匹配子树）
 */
function collectVisible(
  node: CoverageNode,
  expanded: Set<string>,
  filter: string,
  unmetOnly: boolean,
  effectiveTargets: Partial<Record<CoverageMetric, number>>,
  isAncestorExpanded: boolean,
  out: VisibleRow[],
): void {
  const filterActive = filter.length > 0;
  const selfMatch = !filterActive || node.name.toLowerCase().includes(filter);
  const subtreeMatch = !filterActive || selfMatch || subtreeMatchesFilter(node, filter);

  if (!subtreeMatch) return;
  if (!isAncestorExpanded) return;

  out.push({
    node,
    dimmed: unmetOnly && !nodeHasFail(node, effectiveTargets),
  });

  // 过滤激活时自动展开包含匹配项的子树
  const isExpanded = expanded.has(node.path) || (filterActive && subtreeMatch);
  for (const child of node.children) {
    collectVisible(
      child, expanded, filter, unmetOnly, effectiveTargets,
      isAncestorExpanded && isExpanded, out,
    );
  }
}

// ─── 主组件 ──────────────────────────────────────────────────────

export type CoverageTreeTableProps = {
  data: CoverageData;
  targets: Partial<Record<CoverageMetric, number>>;
};

export function CoverageTreeTable({ data, targets }: CoverageTreeTableProps) {
  const { root } = data;

  // 合并默认目标与项目级覆盖
  const effectiveTargets = useMemo<Partial<Record<CoverageMetric, number>>>(
    () => ({ ...DEFAULT_COVERAGE_TARGETS, ...targets }),
    [targets],
  );

  const allExpandablePaths = useMemo(() => collectExpandablePaths(root), [root]);

  // 默认展开根节点
  const [expanded, setExpanded] = useState<Set<string>>(() => new Set([root.path]));
  const [filter, setFilter] = useState('');
  const [unmetOnly, setUnmetOnly] = useState(false);

  const visibleRows = useMemo(() => {
    const rows: VisibleRow[] = [];
    collectVisible(
      root, expanded, filter.trim().toLowerCase(), unmetOnly,
      effectiveTargets, true, rows,
    );
    return rows;
  }, [root, expanded, filter, unmetOnly, effectiveTargets]);

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
    <div className="space-y-3">
      {/* 概览卡片 */}
      <OverviewCards root={root} targets={effectiveTargets} />

      {/* 工具栏 */}
      <div className="flex flex-wrap items-center gap-2">
        <input
          type="text"
          value={filter}
          onChange={(e) => setFilter(e.target.value)}
          placeholder="过滤模块..."
          className="w-40 rounded border border-border bg-card px-2 py-1 text-xs outline-none focus:border-primary"
        />
        <button
          onClick={expandAll}
          className="rounded border border-border bg-card px-2 py-1 text-xs hover:bg-secondary"
        >
          全部展开
        </button>
        <button
          onClick={collapseAll}
          className="rounded border border-border bg-card px-2 py-1 text-xs hover:bg-secondary"
        >
          全部折叠
        </button>
        <button
          onClick={() => setUnmetOnly((v) => !v)}
          className={cn(
            'rounded border px-2 py-1 text-xs',
            unmetOnly
              ? 'border-primary/50 bg-primary/10 text-primary'
              : 'border-border bg-card hover:bg-secondary',
          )}
        >
          仅看未达标
        </button>
      </div>

      {/* 主树表格 */}
      <div className="overflow-hidden rounded border border-border">
        <div className="max-h-[60vh] overflow-auto">
          <table className="w-full text-xs">
            <thead className="sticky top-0 z-10 bg-secondary">
              <tr>
                <th className="px-2 py-1.5 text-left text-[10px] uppercase text-muted-foreground">
                  模块
                </th>
                {COVERAGE_METRICS.map((m) => (
                  <th
                    key={m}
                    className="px-2 py-1.5 text-right text-[10px] uppercase text-muted-foreground"
                  >
                    {METRIC_LABELS[m]}
                    <span className="block font-normal normal-case text-muted-foreground/70">
                      {METRIC_TARGET_HINTS[m]}
                    </span>
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {visibleRows.length === 0 ? (
                <tr>
                  <td colSpan={9} className="px-2 py-4 text-center text-muted-foreground">
                    无匹配模块
                  </td>
                </tr>
              ) : (
                visibleRows.map(({ node, dimmed }) => (
                  <TreeRow
                    key={node.path}
                    node={node}
                    expanded={expanded.has(node.path)}
                    dimmed={dimmed}
                    targets={effectiveTargets}
                    onToggle={toggleNode}
                  />
                ))
              )}
            </tbody>
          </table>
        </div>
      </div>

      {/* 图例 */}
      <div className="flex gap-4 text-[10px] text-muted-foreground">
        <LegendItem dotClass="bg-emerald-500" label="达标" />
        <LegendItem dotClass="bg-yellow-500" label="接近目标 (<5%)" />
        <LegendItem dotClass="bg-destructive" label="未达标" />
        <LegendItem dotClass="bg-muted-foreground" label="N/A" />
      </div>
    </div>
  );
}

// ─── 概览卡片 ────────────────────────────────────────────────────

function OverviewCards({
  root,
  targets,
}: {
  root: CoverageNode;
  targets: Partial<Record<CoverageMetric, number>>;
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
    </div>
  );
}

// ─── 树行 ────────────────────────────────────────────────────────

function TreeRow({
  node,
  expanded,
  dimmed,
  targets,
  onToggle,
}: {
  node: CoverageNode;
  expanded: boolean;
  dimmed: boolean;
  targets: Partial<Record<CoverageMetric, number>>;
  onToggle: (path: string) => void;
}) {
  const hasChildren = node.children.length > 0;
  const isRoot = node.depth === 0;

  return (
    <tr
      className={cn(
        'border-t border-border',
        isRoot && 'bg-card font-medium',
        dimmed && 'opacity-30',
      )}
    >
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
      {COVERAGE_METRICS.map((m) => {
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

// ─── 图例 ────────────────────────────────────────────────────────

function LegendItem({ dotClass, label }: { dotClass: string; label: string }) {
  return (
    <div className="flex items-center gap-1.5">
      <span className={cn('h-2 w-2 rounded-full', dotClass)} />
      {label}
    </div>
  );
}
