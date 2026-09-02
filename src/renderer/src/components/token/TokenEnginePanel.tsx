/**
 * TokenEnginePanel — Token Monitor 引擎分解面板。
 *
 * Issue #2: 三列卡片（omp / claude-code / codex），每列显示今日/本月/总 token 和 cost、
 * 占比饼图。点击某列卡片展开 cache hit/miss 细节。
 *
 * 先例：DashboardView 的 KPI 卡片模式
 */

import { useEffect, useMemo, useState } from 'react';
import ReactECharts from 'echarts-for-react';
import type { EChartsOption } from 'echarts';
import { ChevronDown, ChevronRight } from 'lucide-react';
import { useTokenStore, type EngineBreakdownEntry } from '@renderer/stores/token';
import { useProjectStore } from '@renderer/stores/project';
import { getEChartsTheme, onThemeChange } from '@renderer/lib/echarts-theme';

/** 引擎显示名 */
function engineLabel(engine: string): string {
  if (engine === 'omp') return 'OMP';
  if (engine === 'claude-code') return 'Claude Code';
  if (engine === 'codex') return 'Codex';
  return engine;
}

/** 引擎 → 语义色映射 */
function getEngineColor(engine: string, theme: ReturnType<typeof getEChartsTheme>): string {
  if (engine === 'omp') return theme.chartOmp;
  if (engine === 'claude-code') return theme.chartClaude;
  if (engine === 'codex') return theme.chartCodex;
  return theme.colors[0] ?? '#5470c6';
}

/** 格式化 token 数量 */
function formatTokens(n: number): string {
  return n.toLocaleString('en-US');
}

/** 格式化费用 */
function formatCost(usd: number): string {
  return `$${usd.toFixed(4)}`;
}

/** 占比饼图 option */
function buildPieOption(
  entries: EngineBreakdownEntry[],
  theme: ReturnType<typeof getEChartsTheme>,
): EChartsOption {
  const data = entries
    .filter((e) => e.totalTokens > 0)
    .map((e) => ({
      name: engineLabel(e.engine),
      value: e.totalTokens,
      itemStyle: { color: getEngineColor(e.engine, theme) },
    }));

  if (data.length === 0) {
    // 空数据占位
    data.push({
      name: '无数据',
      value: 1,
      itemStyle: { color: theme.borderColor },
    });
  }

  return {
    // 注意：不能整体展开 theme.toDefaults()——其中带 xAxis/yAxis 样式默认值，
    // 会让 ECharts 在饼图上渲染出默认坐标轴（轴线穿过圆环）。只取饼图需要的字段。
    backgroundColor: 'transparent',
    textStyle: { color: theme.cardForegroundColor },
    color: theme.colors,
    legend: {
      ...theme.toDefaults().legend,
      // legend 放到底部，避免与饼图重叠
      orient: 'horizontal',
      bottom: 0,
      top: 'auto',
      left: 'center',
    },
    tooltip: {
      trigger: 'item',
      formatter: (params: unknown) => {
        const p = params as { name: string; value: number; percent: number };
        return `${p.name}: ${formatTokens(p.value)} (${p.percent}%)`;
      },
      ...theme.toDefaults().tooltip,
    },
    series: [
      {
        type: 'pie',
        radius: ['40%', '70%'],
        avoidLabelOverlap: false,
        label: { show: false },
        labelLine: { show: false },
        data,
      },
    ],
  };
}

/** 单引擎卡片 */
function EngineCard({
  entry,
  totalTokens,
  theme,
}: {
  entry: EngineBreakdownEntry;
  totalTokens: number;
  theme: ReturnType<typeof getEChartsTheme>;
}) {
  const [expanded, setExpanded] = useState(false);
  const color = getEngineColor(entry.engine, theme);
  const percentage = totalTokens > 0 ? (entry.totalTokens / totalTokens) * 100 : 0;

  // Cache 命中率 = cacheRead / (cacheRead + input)
  const cacheTotal = entry.cacheReadTokens + entry.inputTokens;
  const cacheHitRate = cacheTotal > 0 ? (entry.cacheReadTokens / cacheTotal) * 100 : 0;

  // 占比进度环 — 纯 SVG：弧长 = 该引擎占全部引擎用量的百分比，
  // 0% 时只显示淡色轨道（不用 ECharts 饼图：单系列饼图会带 legend 色块，
  // 且 0% 时也会渲染完整圆环，没有信息量）
  const RING_SIZE = 120;
  const RING_STROKE = 10;
  const ringRadius = (RING_SIZE - RING_STROKE) / 2;
  const ringCircumference = 2 * Math.PI * ringRadius;
  const ringRatio = Math.min(1, Math.max(0, percentage / 100));

  return (
    <div
      data-testid={`token-engine-card-${entry.engine}`}
      className="flex flex-col gap-3 rounded-xl border border-border bg-card p-4"
    >
      {/* 引擎标题（色名以文字色区分，不用色条方块） */}
      <div className="flex items-center justify-center">
        <span className="text-sm font-semibold" style={{ color }}>
          {engineLabel(entry.engine)}
        </span>
      </div>

      {/* 占比进度环（中心显示百分比） */}
      <div className="flex flex-col items-center gap-1">
        <svg
          width={RING_SIZE}
          height={RING_SIZE}
          viewBox={`0 0 ${RING_SIZE} ${RING_SIZE}`}
          role="img"
          aria-label={`${engineLabel(entry.engine)} 占比 ${percentage.toFixed(1)}%`}
        >
          {/* 轨道 */}
          <circle
            cx={RING_SIZE / 2}
            cy={RING_SIZE / 2}
            r={ringRadius}
            fill="none"
            stroke="var(--muted)"
            strokeWidth={RING_STROKE}
          />
          {/* 进度弧（有占比才绘制） */}
          {ringRatio > 0 && (
            <circle
              cx={RING_SIZE / 2}
              cy={RING_SIZE / 2}
              r={ringRadius}
              fill="none"
              stroke={color}
              strokeWidth={RING_STROKE}
              strokeLinecap="round"
              strokeDasharray={`${ringRatio * ringCircumference} ${ringCircumference}`}
              transform={`rotate(-90 ${RING_SIZE / 2} ${RING_SIZE / 2})`}
            />
          )}
          {/* 中心百分比 */}
          <text
            x={RING_SIZE / 2}
            y={RING_SIZE / 2}
            textAnchor="middle"
            dominantBaseline="central"
            className="fill-foreground"
            style={{ fontSize: 16, fontWeight: 700 }}
          >
            {percentage.toFixed(1)}%
          </text>
        </svg>
        <div className="text-xs text-muted-foreground">占比</div>
      </div>

      {/* Token 数据行 */}
      <div className="grid grid-cols-3 gap-1 text-center">
        <div>
          <div className="text-[10px] text-muted-foreground">今日</div>
          <div className="text-sm font-bold text-foreground">{formatTokens(entry.todayTokens)}</div>
        </div>
        <div>
          <div className="text-[10px] text-muted-foreground">本月</div>
          <div className="text-sm font-bold text-foreground">{formatTokens(entry.monthTokens)}</div>
        </div>
        <div>
          <div className="text-[10px] text-muted-foreground">总计</div>
          <div className="text-sm font-bold text-foreground">{formatTokens(entry.totalTokens)}</div>
        </div>
      </div>

      {/* Cost 数据行 */}
      <div className="grid grid-cols-3 gap-1 text-center">
        <div>
          <div className="text-[10px] text-muted-foreground">今日 cost</div>
          <div className="text-xs text-foreground">{formatCost(entry.todayCost)}</div>
        </div>
        <div>
          <div className="text-[10px] text-muted-foreground">本月 cost</div>
          <div className="text-xs text-foreground">{formatCost(entry.monthCost)}</div>
        </div>
        <div>
          <div className="text-[10px] text-muted-foreground">总计 cost</div>
          <div className="text-xs text-foreground">{formatCost(entry.totalCost)}</div>
        </div>
      </div>

      {/* 展开按钮 */}
      <button
        type="button"
        data-testid={`token-engine-expand-${entry.engine}`}
        onClick={() => setExpanded((v) => !v)}
        className="flex items-center justify-center gap-1 rounded-md border border-border py-1 text-[10px] text-muted-foreground hover:bg-accent"
      >
        {expanded ? (
          <ChevronDown className="size-3" strokeWidth={2} />
        ) : (
          <ChevronRight className="size-3" strokeWidth={2} />
        )}
        Cache 细节
      </button>

      {/* Cache 展开细节 */}
      {expanded && (
        <div
          data-testid={`token-engine-cache-${entry.engine}`}
          className="flex flex-col gap-1 rounded-md bg-muted/50 p-2 text-xs"
        >
          <div className="flex justify-between">
            <span className="text-muted-foreground">Input Tokens</span>
            <span className="font-medium text-foreground">{formatTokens(entry.inputTokens)}</span>
          </div>
          <div className="flex justify-between">
            <span className="text-muted-foreground">Output Tokens</span>
            <span className="font-medium text-foreground">{formatTokens(entry.outputTokens)}</span>
          </div>
          <div className="flex justify-between">
            <span className="text-muted-foreground">Cache Read</span>
            <span className="font-medium text-foreground">{formatTokens(entry.cacheReadTokens)}</span>
          </div>
          <div className="flex justify-between">
            <span className="text-muted-foreground">Cache Write</span>
            <span className="font-medium text-foreground">{formatTokens(entry.cacheWriteTokens)}</span>
          </div>
          <div className="flex justify-between border-t border-border pt-1">
            <span className="text-muted-foreground">Cache 命中率</span>
            <span className="font-bold text-foreground">{cacheHitRate.toFixed(1)}%</span>
          </div>
        </div>
      )}
    </div>
  );
}

export function TokenEnginePanel() {
  const currentProjectId = useProjectStore((s) => s.currentProjectId);
  const engineBreakdown = useTokenStore((s) => s.engineBreakdown);
  const loadEngineBreakdown = useTokenStore((s) => s.loadEngineBreakdown);

  useEffect(() => {
    if (!currentProjectId) return;
    void loadEngineBreakdown(currentProjectId);
  }, [currentProjectId, loadEngineBreakdown]);

  // Re-render when theme changes
  const [, setThemeTick] = useState(0);
  useEffect(() => {
    return onThemeChange(() => setThemeTick((t) => t + 1));
  }, []);

  const theme = getEChartsTheme();

  const totalTokens = useMemo(
    () => (engineBreakdown ?? []).reduce((sum, e) => sum + e.totalTokens, 0),
    [engineBreakdown],
  );

  const pieOption = useMemo(
    () => buildPieOption(engineBreakdown ?? [], theme),
    [engineBreakdown, theme],
  );

  if (!engineBreakdown || engineBreakdown.length === 0) {
    return (
      <div className="flex flex-1 items-center justify-center">
        <span className="text-sm text-muted-foreground">暂无引擎分解数据</span>
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-4 p-4">
      {/* ─── 总占比饼图 ───────────────────────────────────── */}
      <div className="rounded-md border border-border bg-card p-3">
        <div className="mb-2 text-xs font-semibold text-muted-foreground">引擎用量占比</div>
        <ReactECharts
          option={pieOption}
          style={{ height: '200px', width: '100%' }}
          opts={{ renderer: 'canvas' }}
          data-testid="token-engine-overall-pie"
        />
      </div>

      {/* ─── 三列卡片 ────────────────────────────────────── */}
      <div className="grid grid-cols-1 gap-3 md:grid-cols-3">
        {engineBreakdown.map((entry) => (
          <EngineCard
            key={entry.engine}
            entry={entry}
            totalTokens={totalTokens}
            theme={theme}
          />
        ))}
      </div>
    </div>
  );
}
