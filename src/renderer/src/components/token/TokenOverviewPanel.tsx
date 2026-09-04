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

/** 格式化 token 数量（千分位精确值 — tooltip 括号内补充显示） */
function formatTokens(n: number): string {
  return n.toLocaleString('en-US');
}

/** 格式化 token 数量为中文紧凑单位：≥1万亿 → x.x万亿，≥1亿 → x.x亿，≥1万 → x.x万，其余千分位（KPI 卡片与热力图 tooltip 主值） */
function formatTokensCompact(n: number): string {
  if (n >= 1e12) return `${Number((n / 1e12).toFixed(2))}万亿`;
  if (n >= 1e8) return `${Number((n / 1e8).toFixed(2))}亿`;
  if (n >= 1e4) return `${Number((n / 1e4).toFixed(2))}万`;
  return n.toLocaleString('en-US');
}

/** 格式化费用（美元） */
function formatCost(usd: number): string {
  return `$${usd.toFixed(4)}`;
}

// ─── 热力图 ─────────────────────────────────────────────────

/** 热力图布局常量 — 参考 token-monitor dashboard.js 的 cell/gap 自适应策略 */
const HEAT_GAP = 4;
const HEAT_CELL_MIN = 9;
const HEAT_CELL_MAX = 22;
const HEAT_BOTTOM_PAD = 20;

/** 计算热力图色阶 0-4（阈值对齐 token-monitor 的 heatmapIntensity：0.25/0.5/0.75 分档） */
function getHeatmapLevel(tokens: number, maxTokens: number): number {
  if (tokens <= 0 || maxTokens <= 0) return 0;
  const ratio = tokens / maxTokens;
  return ratio >= 0.75 ? 4 : ratio >= 0.5 ? 3 : ratio >= 0.25 ? 2 : 1;
}

/**
 * 离散色阶填充 — 对齐 token-monitor styles.css 的 .heat.lvl-N：
 * 0 为近不可见底色，1-4 为主色递进。用 color-mix 保持主题感知，不引入固定 hex。
 */
function heatmapFill(level: number): string {
  switch (level) {
    case 1:
      return 'color-mix(in srgb, var(--primary) 20%, transparent)';
    case 2:
      return 'color-mix(in srgb, var(--primary) 48%, transparent)';
    case 3:
      return 'color-mix(in srgb, var(--primary) 78%, transparent)';
    case 4:
      return 'var(--primary)';
    default:
      return 'color-mix(in srgb, var(--muted) 45%, transparent)';
  }
}

/** 本地日期 key（YYYY-MM-DD） */
function localDateStr(d: Date): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

type HeatmapCell = { date: string; entry: HeatmapEntry | null };

/** 365 天 GitHub 风格热力图（SVG 实现，布局对齐 token-monitor 的 contribHeatmap/heatmapSvg） */
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

  // 滚动年模型（参考 token-monitor rollingYearHeatmap）：从 11 个月前的月初开始
  // （月份对齐，月份标签才能整齐落在各月首列），再回退到所在周的周日（周日起始列，GitHub 风格）。
  // 用本地时间逐天迭代，避免跨时区/夏令时偏移。
  const days = useMemo(() => {
    const now = new Date();
    const end = new Date(now.getFullYear(), now.getMonth(), now.getDate());
    const start = new Date(end.getFullYear(), end.getMonth() - 11, 1);
    const gridStart = new Date(start.getFullYear(), start.getMonth(), 1 - start.getDay());
    const result: HeatmapCell[] = [];
    const cursor = new Date(gridStart);
    while (cursor.getTime() <= end.getTime()) {
      const dateStr = localDateStr(cursor);
      result.push({ date: dateStr, entry: entryMap.get(dateStr) ?? null });
      cursor.setDate(cursor.getDate() + 1);
    }
    return result;
  }, [entryMap]);

  const weeks = Math.max(1, Math.ceil(days.length / 7));

  // cell 随容器宽度自适应（参考 token-monitor dashboard.js：分数像素正好填满容器，
  // 并设上下限，避免窄窗口挤压成一团 / 宽窗口无限拉伸）
  const cell =
    width > 0
      ? Math.max(HEAT_CELL_MIN, Math.min(HEAT_CELL_MAX, (width - weeks * HEAT_GAP) / weeks))
      : 14;
  const pitch = cell + HEAT_GAP;
  const gridWidth = weeks * pitch - HEAT_GAP;
  const gridHeight = 7 * pitch - HEAT_GAP;
  const svgWidth = gridWidth;
  const svgHeight = gridHeight + HEAT_BOTTOM_PAD;

  // 月份标签：锚定在每月 1 号所在列的正下方（参考 token-monitor 的 monthLabels）
  const monthLabels = useMemo(() => {
    const labels: Array<{ col: number; label: string }> = [];
    days.forEach((day, i) => {
      if (day.date.endsWith('-01')) {
        labels.push({ col: Math.floor(i / 7), label: `${Number(day.date.slice(5, 7))}月` });
      }
    });
    return labels;
  }, [days]);

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
          {[0, 1, 2, 3, 4].map((lvl) => (
            <span key={lvl} className="size-2.5 rounded-sm" style={{ background: heatmapFill(lvl) }} />
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
          {/* 月份标签（网格下方，锚定每月 1 号所在列） */}
          {monthLabels.map((m) => (
            <text
              key={`${m.label}-${m.col}`}
              x={m.col * pitch}
              y={gridHeight + 14}
              textAnchor="start"
              className="fill-muted-foreground"
              style={{ fontSize: 9 }}
            >
              {m.label}
            </text>
          ))}
          {/* 日期格子：固定圆角 rx=3 + 离散色阶（对齐 token-monitor 的 .heat.lvl-N） */}
          {days.map((day, i) => {
            const col = Math.floor(i / 7);
            const row = i % 7;
            const tokens = day.entry?.totalTokens ?? 0;
            const level = getHeatmapLevel(tokens, maxTokens);
            const hovered = tip?.date === day.date;
            return (
              <rect
                key={day.date}
                {...(day.entry ? { 'data-testid': `token-heatmap-cell-${day.date}` } : {})}
                x={col * pitch}
                y={row * pitch}
                width={cell}
                height={cell}
                rx={3}
                style={{ fill: heatmapFill(level) }}
                stroke={hovered ? 'var(--foreground)' : 'none'}
                strokeWidth={hovered ? 1 : 0}
                onMouseEnter={(ev) => setTip({ x: ev.clientX, y: ev.clientY, date: day.date, entry: day.entry })}
                onMouseLeave={() => setTip(null)}
              />
            );
          })}
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
  const TIP_W = 240;
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
        <span className="tabular-nums">
          {formatTokensCompact(tokens)}
          {tokens >= 1e4 && <span className="ml-1 opacity-50">({formatTokens(tokens)})</span>}
        </span>
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
              value={formatTokensCompact(summary.todayTokens)}
              icon={Coins}
              testId="token-kpi-today"
            />
            <KpiCard
              label="本月 Token"
              value={formatTokensCompact(summary.monthTokens)}
              icon={CalendarDays}
              testId="token-kpi-month"
            />
            <KpiCard
              label="总 Token"
              value={formatTokensCompact(summary.totalTokens)}
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
