/**
 * TokenModelPanel — Token Monitor 模型分解面板。
 *
 * Issue #3: 按模型聚合的 token 用量表格（模型名 | 总 token | input | output |
 * cacheRead | cacheWrite | cost | 占比%），支持按列排序（点击列头切换升降序）。
 * 表格下方展示柱状图（按 token 量降序排列）。
 *
 * 先例：src/renderer/src/components/token/TokenEnginePanel.tsx
 */

import { useEffect, useMemo, useState } from 'react';
import ReactECharts from 'echarts-for-react';
import type { EChartsOption } from 'echarts';
import { ArrowDown, ArrowUp } from 'lucide-react';
import { useTokenStore, type ModelBreakdownEntry } from '@renderer/stores/token';
import { useProjectStore } from '@renderer/stores/project';
import { getEChartsTheme, onThemeChange } from '@renderer/lib/echarts-theme';

/** 排序方向 */
type SortDir = 'asc' | 'desc';

/** 可排序的列 key */
type SortKey = keyof ModelBreakdownEntry;

/** 表格列定义 */
type Column = {
  key: SortKey;
  label: string;
  sortable: boolean;
};

const COLUMNS: Column[] = [
  { key: 'model', label: '模型', sortable: true },
  { key: 'totalTokens', label: '总 Token', sortable: true },
  { key: 'inputTokens', label: 'Input', sortable: true },
  { key: 'outputTokens', label: 'Output', sortable: true },
  { key: 'cacheReadTokens', label: 'Cache Read', sortable: true },
  { key: 'cacheWriteTokens', label: 'Cache Write', sortable: true },
  { key: 'costUsd', label: 'Cost', sortable: true },
];

/** 格式化 token 数量 */
function formatTokens(n: number): string {
  return n.toLocaleString('en-US');
}

/** 格式化费用 */
function formatCost(usd: number): string {
  return `$${usd.toFixed(4)}`;
}

/** 比较函数 — 按列 key 和方向排序 */
function sortEntries(
  entries: ModelBreakdownEntry[],
  key: SortKey,
  dir: SortDir,
): ModelBreakdownEntry[] {
  const dirMul = dir === 'asc' ? 1 : -1;
  return [...entries].sort((a, b) => {
    const av = a[key];
    const bv = b[key];
    if (typeof av === 'string' && typeof bv === 'string') {
      return av.localeCompare(bv) * dirMul;
    }
    return ((av as number) - (bv as number)) * dirMul;
  });
}

export function TokenModelPanel() {
  const currentProjectId = useProjectStore((s) => s.currentProjectId);
  const modelBreakdown = useTokenStore((s) => s.modelBreakdown);
  const loadModelBreakdown = useTokenStore((s) => s.loadModelBreakdown);

  const [sortKey, setSortKey] = useState<SortKey>('totalTokens');
  const [sortDir, setSortDir] = useState<SortDir>('desc');

  useEffect(() => {
    if (!currentProjectId) return;
    void loadModelBreakdown(currentProjectId);
  }, [currentProjectId, loadModelBreakdown]);

  // Re-render when theme changes
  const [, setThemeTick] = useState(0);
  useEffect(() => {
    return onThemeChange(() => setThemeTick((t) => t + 1));
  }, []);

  const theme = getEChartsTheme();

  // Sorted table data
  const sortedEntries = useMemo(
    () => sortEntries(modelBreakdown ?? [], sortKey, sortDir),
    [modelBreakdown, sortKey, sortDir],
  );

  // Total tokens for percentage calculation
  const totalTokens = useMemo(
    () => (modelBreakdown ?? []).reduce((sum, e) => sum + e.totalTokens, 0),
    [modelBreakdown],
  );

  // Chart option — always by totalTokens descending
  const chartOption = useMemo<EChartsOption>(() => {
    if (!modelBreakdown || modelBreakdown.length === 0) return {};

    const sorted = [...modelBreakdown].sort((a, b) => b.totalTokens - a.totalTokens);

    return {
      ...theme.toDefaults(),
      tooltip: {
        trigger: 'axis',
        axisPointer: { type: 'shadow' },
        ...theme.toDefaults().tooltip,
      },
      grid: {
        left: '3%',
        right: '4%',
        bottom: '15%',
        top: '5%',
        containLabel: true,
      },
      xAxis: {
        type: 'category',
        data: sorted.map((e) => e.model),
        axisLabel: {
          rotate: 30,
          textStyle: { color: theme.mutedColor },
        },
      },
      yAxis: {
        type: 'value',
        axisLabel: { textStyle: { color: theme.mutedColor } },
      },
      series: [
        {
          type: 'bar',
          data: sorted.map((e) => e.totalTokens),
          itemStyle: { color: theme.colors[0] ?? '#5470c6' },
        },
      ],
    };
  }, [modelBreakdown, theme]);

  if (!modelBreakdown || modelBreakdown.length === 0) {
    return (
      <div className="flex flex-1 items-center justify-center">
        <span className="text-sm text-muted-foreground">暂无模型分解数据</span>
      </div>
    );
  }

  /** 点击列头排序 */
  function handleSort(key: SortKey) {
    if (sortKey === key) {
      setSortDir((d) => (d === 'asc' ? 'desc' : 'asc'));
    } else {
      setSortKey(key);
      setSortDir(key === 'model' ? 'asc' : 'desc');
    }
  }

  return (
    <div className="flex flex-col gap-4 p-4">
      {/* ─── 表格 ────────────────────────────────────── */}
      <div
        data-testid="token-model-table"
        className="overflow-hidden rounded-md border border-border bg-card"
      >
        <table className="w-full text-xs">
          <thead className="border-b border-border bg-muted/30">
            <tr>
              {COLUMNS.map((col) => (
                <th
                  key={col.key}
                  data-testid={`token-model-sort-${col.key}`}
                  onClick={() => handleSort(col.key)}
                  className="cursor-pointer select-none px-3 py-2 text-left font-medium text-muted-foreground hover:text-foreground"
                >
                  <span className="inline-flex items-center gap-1">
                    {col.label}
                    {sortKey === col.key && (
                      sortDir === 'desc'
                        ? <ArrowDown className="size-3" strokeWidth={2} />
                        : <ArrowUp className="size-3" strokeWidth={2} />
                    )}
                  </span>
                </th>
              ))}
              <th className="px-3 py-2 text-right font-medium text-muted-foreground">
                占比
              </th>
            </tr>
          </thead>
          <tbody>
            {sortedEntries.map((entry) => {
              const percentage = totalTokens > 0
                ? (entry.totalTokens / totalTokens) * 100
                : 0;
              return (
                <tr
                  key={entry.model}
                  data-testid={`token-model-row-${entry.model}`}
                  className="border-b border-border/50 last:border-0 hover:bg-accent/30"
                >
                  <td className="px-3 py-2 font-medium text-foreground">{entry.model}</td>
                  <td className="px-3 py-2 text-foreground">{formatTokens(entry.totalTokens)}</td>
                  <td className="px-3 py-2 text-muted-foreground">{formatTokens(entry.inputTokens)}</td>
                  <td className="px-3 py-2 text-muted-foreground">{formatTokens(entry.outputTokens)}</td>
                  <td className="px-3 py-2 text-muted-foreground">{formatTokens(entry.cacheReadTokens)}</td>
                  <td className="px-3 py-2 text-muted-foreground">{formatTokens(entry.cacheWriteTokens)}</td>
                  <td className="px-3 py-2 text-foreground">{formatCost(entry.costUsd)}</td>
                  <td className="px-3 py-2 text-right text-muted-foreground">
                    {percentage.toFixed(1)}%
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>

      {/* ─── 柱状图（按 token 降序） ─────────────────── */}
      <div
        data-testid="token-model-chart"
        className="rounded-md border border-border bg-card p-3"
      >
        <div className="mb-2 text-xs font-semibold text-muted-foreground">
          模型 Token 用量（降序）
        </div>
        <ReactECharts
          option={chartOption}
          style={{ height: '300px', width: '100%' }}
          opts={{ renderer: 'canvas' }}
        />
      </div>
    </div>
  );
}
