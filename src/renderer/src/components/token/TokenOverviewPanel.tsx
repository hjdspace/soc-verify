/**
 * TokenOverviewPanel — Token Monitor 概览面板。
 *
 * 展示四张 KPI 卡片：今日 Token / 本月 Token / 总 Token / 今日费用。
 * 含时间范围选择器（全部 / 7 天 / 30 天）。
 *
 * Issue #1: 最小闭环 — 仅展示 summary 汇总数据。
 * Issue #6: 热力图（365 天 GitHub 风格）+ 7 天 sparkline + 连续使用天数 streak。
 *
 * 先例：DashboardView 的 KpiRow + 时间范围选择器模式。
 */

import { useEffect, useMemo, useRef, useState } from 'react';
import { Coins, CalendarDays, TrendingUp, DollarSign, Flame, Trophy } from 'lucide-react';
import { ViewHeader } from '@renderer/components/layout/ViewHeader';
import { useTokenStore, type TokenTimeRange, type HeatmapEntry } from '@renderer/stores/token';
import { useProjectStore } from '@renderer/stores/project';
import { cn } from '@renderer/lib/utils';

/** 时间范围选项 */
const TIME_RANGE_OPTIONS: Array<{ value: TokenTimeRange; label: string }> = [
  { value: 'all', label: '全部' },
  { value: '7d', label: '近 7 天' },
  { value: '30d', label: '近 30 天' },
];

/** 时间范围选择器 */
function TimeRangeSelector() {
  const timeRange = useTokenStore((s) => s.timeRange);
  const setTimeRange = useTokenStore((s) => s.setTimeRange);
  return (
    <div className="flex items-center gap-1 rounded-lg border border-border bg-card p-0.5">
      {TIME_RANGE_OPTIONS.map((opt) => (
        <button
          key={opt.value}
          type="button"
          data-testid={`token-time-range-${opt.value}`}
          className={cn(
            'rounded-md px-2.5 py-1 text-[11px] font-medium transition-colors',
            timeRange === opt.value
              ? 'bg-primary/10 text-primary'
              : 'text-muted-foreground hover:text-foreground',
          )}
          onClick={() => setTimeRange(opt.value)}
        >
          {opt.label}
        </button>
      ))}
    </div>
  );
}

/** KPI 卡片 */
function KpiCard({
  label,
  value,
  icon: Icon,
  testId,
}: {
  label: string;
  value: string;
  icon: typeof Coins;
  testId: string;
}) {
  return (
    <div
      data-testid={testId}
      className="flex flex-col gap-2 rounded-xl border border-border bg-card p-4"
    >
      <div className="flex items-center gap-2 text-muted-foreground">
        <Icon className="size-4" strokeWidth={1.8} />
        <span className="text-xs font-medium">{label}</span>
      </div>
      <span className="text-2xl font-bold tracking-tight text-foreground">{value}</span>
    </div>
  );
}

/** Streak 卡片 */
function StreakCard({
  label,
  value,
  unit,
  icon: Icon,
  testId,
}: {
  label: string;
  value: number;
  unit: string;
  icon: typeof Flame;
  testId: string;
}) {
  return (
    <div
      data-testid={testId}
      className="flex flex-col gap-2 rounded-xl border border-border bg-card p-4"
    >
      <div className="flex items-center gap-2 text-muted-foreground">
        <Icon className="size-4" strokeWidth={1.8} />
        <span className="text-xs font-medium">{label}</span>
      </div>
      <span className="text-2xl font-bold tracking-tight text-foreground">
        {value}
        <span className="ml-1 text-xs font-normal text-muted-foreground">{unit}</span>
      </span>
    </div>
  );
}

/** 格式化 token 数量（千分位） */
function formatTokens(n: number): string {
  return n.toLocaleString('en-US');
}

/** 格式化费用（美元） */
function formatCost(usd: number): string {
  return `$${usd.toFixed(4)}`;
}

// ─── 热力图 ─────────────────────────────────────────────────

/** 热力图色阶透明度（5 级，0 = 无数据，4 = 最高）— 参考 token-monitor 的 intensity 分档 */
const HEATMAP_OPACITY = [0.35, 0.25, 0.45, 0.65, 0.9] as const;

/** 计算热力图色阶 */
function getHeatmapLevel(tokens: number, maxTokens: number): number {
  if (tokens <= 0 || maxTokens <= 0) return 0;
  const ratio = tokens / maxTokens;
  if (ratio < 0.25) return 1;
  if (ratio < 0.5) return 2;
  if (ratio < 0.75) return 3;
  return 4;
}

type HeatmapCell = { date: string; entry: HeatmapEntry | null };

/** 365 天 GitHub 风格热力图（SVG 实现，参考 token-monitor usageCharts.heatmapSvg） */
function TokenHeatmap({ entries }: { entries: HeatmapEntry[] }) {
  const containerRef = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(0);
  // 自定义 tooltip 状态（参考 token-monitor 的 dash-tooltip：fixed 定位跟随鼠标，贴边翻转）
  const [tip, setTip] = useState<{ x: number; y: number; date: string; entry: HeatmapEntry | null } | null>(null);

  // 容器宽度自适应（ResizeObserver 不可用时退化为一次性测量）
  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    if (typeof ResizeObserver === 'undefined') {
      setWidth(el.clientWidth);
      return;
    }
    const ro = new ResizeObserver((resizeEntries) => {
      for (const r of resizeEntries) {
        setWidth(r.contentRect.width);
      }
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  const maxTokens = useMemo(
    () => entries.reduce((max, e) => Math.max(max, e.totalTokens), 0),
    [entries],
  );

  const entryMap = useMemo(() => {
    const map = new Map<string, HeatmapEntry>();
    for (const e of entries) {
      map.set(e.date, e);
    }
    return map;
  }, [entries]);

  // 生成 365 天的周列网格：每列一周（7 行，行索引 = 星期几，0 = 周日顶部，GitHub 风格），
  // 起点对齐到 364 天前所在周的周日
  const weeks = useMemo(() => {
    const DAY = 24 * 60 * 60 * 1000;
    const now = new Date();
    const todayStart = new Date(now.getFullYear(), now.getMonth(), now.getDate(), 0, 0, 0, 0);
    const gridStartMs = todayStart.getTime() - 364 * DAY - todayStart.getDay() * DAY;
    const result: HeatmapCell[][] = [];
    let week: HeatmapCell[] = [];
    for (let ms = gridStartMs; ms <= todayStart.getTime(); ms += DAY) {
      const d = new Date(ms);
      const dateStr = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
      if (d.getDay() === 0 && week.length > 0) {
        result.push(week);
        week = [];
      }
      week.push({ date: dateStr, entry: entryMap.get(dateStr) ?? null });
    }
    if (week.length > 0) result.push(week);
    return result;
  }, [entryMap]);

  // 布局参数：pitch = cell + gap，cell 随容器宽度自适应（参考 token-monitor 的 pitch 计算）
  const LEFT_PAD = 26;
  const BOTTOM_PAD = 18;
  const GAP = 3;
  const cols = Math.max(weeks.length, 1);
  const innerWidth = width > 0 ? width - LEFT_PAD : 0;
  const pitch = innerWidth > 0 ? Math.max(8, innerWidth / cols) : 13;
  const cell = Math.max(5, Math.min(13, pitch - GAP));
  const gridHeight = 7 * pitch;
  const svgWidth = width > 0 ? width : LEFT_PAD + cols * pitch;
  const svgHeight = gridHeight + BOTTOM_PAD;

  // 月份标签：锚定在每月第一天所在列的下方（参考 token-monitor 的 monthLabels）
  const monthLabels = useMemo(() => {
    const labels: Array<{ x: number; label: string }> = [];
    let lastMonth = -1;
    weeks.forEach((week, wi) => {
      const first = week[0];
      if (!first) return;
      const month = Number(first.date.slice(5, 7));
      if (month !== lastMonth) {
        lastMonth = month;
        labels.push({ x: LEFT_PAD + wi * pitch, label: `${month}月` });
      }
    });
    return labels;
  }, [weeks, pitch]);

  if (entries.length === 0) {
    return (
      <div className="rounded-xl border border-border bg-card p-4" data-testid="token-heatmap">
        <div className="mb-2 text-xs font-semibold text-muted-foreground">365 天用量热力图</div>
        <div className="flex h-32 items-center justify-center text-xs text-muted-foreground">
          暂无热力图数据
        </div>
      </div>
    );
  }

  return (
    <div className="rounded-xl border border-border bg-card p-4" data-testid="token-heatmap">
      <div className="mb-2 flex items-center justify-between">
        <span className="text-xs font-semibold text-muted-foreground">365 天用量热力图</span>
        <div className="flex items-center gap-1 text-[10px] text-muted-foreground">
          <span>少</span>
          {HEATMAP_OPACITY.map((op, i) => (
            <span
              key={i}
              className="size-2.5 rounded-sm"
              style={
                i === 0
                  ? { background: 'var(--muted)', opacity: op }
                  : { background: 'var(--primary)', opacity: op }
              }
            />
          ))}
          <span>多</span>
        </div>
      </div>
      {/* SVG 网格 — 7 行（每周 7 天）× N 列周，宽度自适应 + 横向滚动兜底 */}
      <div ref={containerRef} className="overflow-x-auto">
        <svg
          width={svgWidth}
          height={svgHeight}
          viewBox={`0 0 ${svgWidth} ${svgHeight}`}
          className="block"
          data-testid="token-heatmap-svg"
        >
          {/* 星期标签（一 / 三 / 五） */}
          {[1, 3, 5].map((dow) => (
            <text
              key={dow}
              x={LEFT_PAD - 6}
              y={dow * pitch + pitch / 2}
              textAnchor="end"
              dominantBaseline="middle"
              className="fill-muted-foreground"
              style={{ fontSize: 9 }}
            >
              {['日', '一', '二', '三', '四', '五', '六'][dow]}
            </text>
          ))}
          {/* 月份标签（网格下方，锚定月份起始列） */}
          {monthLabels.map((m) => (
            <text
              key={`${m.label}-${m.x}`}
              x={m.x}
              y={gridHeight + 13}
              textAnchor="start"
              className="fill-muted-foreground"
              style={{ fontSize: 9 }}
            >
              {m.label}
            </text>
          ))}
          {/* 日期格子 */}
          {weeks.map((week, wi) =>
            week.map(({ date, entry }, di) => {
              const tokens = entry?.totalTokens ?? 0;
              const level = getHeatmapLevel(tokens, maxTokens);
              const x = LEFT_PAD + wi * pitch + (pitch - cell) / 2;
              const y = di * pitch + (pitch - cell) / 2;
              const hovered = tip?.date === date;
              return (
                <rect
                  key={date}
                  {...(entry ? { 'data-testid': `token-heatmap-cell-${date}` } : {})}
                  x={x}
                  y={y}
                  width={cell}
                  height={cell}
                  rx={Math.max(1, cell * 0.22)}
                  style={
                    level === 0
                      ? { fill: 'var(--muted)', opacity: HEATMAP_OPACITY[0] }
                      : { fill: 'var(--primary)', opacity: HEATMAP_OPACITY[level] }
                  }
                  stroke={hovered ? 'var(--foreground)' : 'none'}
                  strokeWidth={hovered ? 1 : 0}
                  onMouseEnter={(ev) => setTip({ x: ev.clientX, y: ev.clientY, date, entry: entry ?? null })}
                  onMouseLeave={() => setTip(null)}
                />
              );
            }),
          )}
        </svg>
      </div>
      {/* 自定义悬停提示（参考 token-monitor 的 dash-tooltip：fixed 定位 + 贴边翻转） */}
      {tip && (
        <HeatTooltip x={tip.x} y={tip.y} date={tip.date} entry={tip.entry} />
      )}
    </div>
  );
}

/** 热力图悬停提示 — 日期标题 + Token / Cost 行（样式对齐 token-monitor 的 tt-head/tt-row） */
function HeatTooltip({ x, y, date, entry }: { x: number; y: number; date: string; entry: HeatmapEntry | null }) {
  // 贴边自动翻转（参考 token-monitor positionTooltip）
  const TIP_W = 190;
  const TIP_H = 76;
  const PAD = 14;
  let left = x + PAD;
  let top = y + PAD;
  if (typeof window !== 'undefined') {
    if (left + TIP_W > window.innerWidth - 8) left = x - TIP_W - PAD;
    if (top + TIP_H > window.innerHeight - 8) top = y - TIP_H - PAD;
  }
  left = Math.max(8, left);
  top = Math.max(8, top);

  const d = new Date(`${date}T00:00:00`);
  const weekday = Number.isNaN(d.getTime()) ? '' : ` ${['周日', '周一', '周二', '周三', '周四', '周五', '周六'][d.getDay()]}`;
  const tokens = entry?.totalTokens ?? 0;
  const cost = entry?.costUsd ?? 0;

  return (
    <div
      className="pointer-events-none fixed z-50 min-w-[130px] rounded-lg border border-border px-3 py-2 text-xs shadow-xl"
      style={{ left, top, background: 'color-mix(in srgb, var(--card) 96%, transparent)' }}
      data-testid="token-heatmap-tooltip"
    >
      <div className="mb-1.5 font-semibold tabular-nums">
        {date}
        {weekday}
      </div>
      <div className="flex items-center justify-between gap-6 py-0.5">
        <span className="opacity-80">Token</span>
        <span className="tabular-nums">{formatTokens(tokens)}</span>
      </div>
      {cost > 0 && (
        <div className="flex items-center justify-between gap-6 py-0.5">
          <span className="opacity-80">费用</span>
          <span className="tabular-nums">{formatCost(cost)}</span>
        </div>
      )}
    </div>
  );
}

// ─── 7 天趋势 Sparkline ─────────────────────────────────────

/** 生成 SVG sparkline path */
function buildSparklinePath(values: number[], width: number, height: number): string {
  if (values.length === 0) return '';
  if (values.length === 1) return `M ${width / 2} ${height / 2}`;

  const max = Math.max(...values, 1);
  const min = Math.min(...values, 0);
  const range = max - min || 1;
  const stepX = width / (values.length - 1);

  return values
    .map((v, i) => {
      const x = i * stepX;
      const y = height - ((v - min) / range) * height;
      return `${i === 0 ? 'M' : 'L'} ${x.toFixed(1)} ${y.toFixed(1)}`;
    })
    .join(' ');
}

/** 7 天趋势 sparkline */
function TokenSparkline({ entries }: { entries: HeatmapEntry[] }) {
  const sparkData = useMemo(() => {
    const now = new Date();
    const todayStart = new Date(now.getFullYear(), now.getMonth(), now.getDate(), 0, 0, 0, 0);
    const entryMap = new Map(entries.map((e) => [e.date, e]));

    const days: { date: string; tokens: number }[] = [];
    for (let i = 6; i >= 0; i--) {
      const d = new Date(todayStart.getTime() - i * 24 * 60 * 60 * 1000);
      const dateStr = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
      const entry = entryMap.get(dateStr);
      days.push({ date: dateStr, tokens: entry?.totalTokens ?? 0 });
    }
    return days;
  }, [entries]);

  const values = sparkData.map((d) => d.tokens);
  const hasData = values.some((v) => v > 0);
  const path = buildSparklinePath(values, 200, 40);

  return (
    <div className="rounded-xl border border-border bg-card p-4" data-testid="token-sparkline">
      <div className="mb-1 text-xs font-semibold text-muted-foreground">最近 7 天趋势</div>
      {hasData ? (
        <svg viewBox="0 0 200 40" className="w-full" style={{ height: '40px' }} preserveAspectRatio="none">
          <path
            d={path}
            fill="none"
            stroke="currentColor"
            strokeWidth="1.5"
            className="text-primary"
          />
        </svg>
      ) : (
        <div className="flex h-10 items-center text-[10px] text-muted-foreground">
          暂无 7 天数据
        </div>
      )}
    </div>
  );
}

// ─── 主组件 ─────────────────────────────────────────────────

export function TokenOverviewPanel() {
  const currentProjectId = useProjectStore((s) => s.currentProjectId);
  const summary = useTokenStore((s) => s.summary);
  const heatmap = useTokenStore((s) => s.heatmap);
  const loading = useTokenStore((s) => s.loading);
  const error = useTokenStore((s) => s.error);
  const loadSummary = useTokenStore((s) => s.loadSummary);
  const loadHeatmap = useTokenStore((s) => s.loadHeatmap);

  useEffect(() => {
    if (!currentProjectId) return;
    void loadSummary(currentProjectId);
    void loadHeatmap(currentProjectId);
  }, [currentProjectId, loadSummary, loadHeatmap]);

  return (
    <div className="flex flex-1 flex-col overflow-auto p-4">
      <ViewHeader title="Token Monitor" subtitle="AI 用量概览">
        <TimeRangeSelector />
      </ViewHeader>

      {loading && !summary && (
        <div className="flex flex-1 items-center justify-center">
          <span className="text-sm text-muted-foreground">加载中…</span>
        </div>
      )}

      {error && !loading && (
        <div className="flex flex-1 items-center justify-center">
          <span className="text-sm text-status-fail">{error}</span>
        </div>
      )}

      {summary && (
        <div className="flex flex-col gap-3">
          {/* KPI 卡片 */}
          <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
            <KpiCard
              label="今日 Token"
              value={formatTokens(summary.todayTokens)}
              icon={Coins}
              testId="token-kpi-today"
            />
            <KpiCard
              label="本月 Token"
              value={formatTokens(summary.monthTokens)}
              icon={CalendarDays}
              testId="token-kpi-month"
            />
            <KpiCard
              label="总 Token"
              value={formatTokens(summary.totalTokens)}
              icon={TrendingUp}
              testId="token-kpi-total"
            />
            <KpiCard
              label="今日费用"
              value={formatCost(summary.todayCostUsd)}
              icon={DollarSign}
              testId="token-kpi-cost"
            />
          </div>

          {/* Streak 卡片 */}
          <div className="grid grid-cols-2 gap-3">
            <StreakCard
              label="连续使用天数"
              value={summary.currentStreak}
              unit="天"
              icon={Flame}
              testId="token-streak-current"
            />
            <StreakCard
              label="最长连续天数"
              value={summary.longestStreak}
              unit="天"
              icon={Trophy}
              testId="token-streak-longest"
            />
          </div>

          {/* 7 天趋势 sparkline */}
          <TokenSparkline entries={heatmap} />

          {/* 365 天热力图 */}
          <TokenHeatmap entries={heatmap} />
        </div>
      )}

      {!loading && !error && !summary && (
        <div className="flex flex-1 items-center justify-center">
          <span className="text-sm text-muted-foreground">暂无 Token 用量数据</span>
        </div>
      )}
    </div>
  );
}
