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

import { useEffect, useMemo, useState, type MouseEvent as ReactMouseEvent } from 'react';
import { createPortal } from 'react-dom';
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
  // 节点用 state 持有（callback ref）：entries 为空时走早退分支、网格容器未挂载，
  // 若用「挂载时跑一次」的 effect + useRef，容器后续才挂载时 observer 永远不会建立，
  // width 恒为 0 → cell 恒为兜底 14px → 宽容器右侧留白。callback ref 在节点挂载/
  // 卸载时触发 effect 重跑，保证 AI 面板开合/数据异步到达后都能正确测量。
  const [gridNode, setGridNode] = useState<HTMLDivElement | null>(null);
  const [width, setWidth] = useState(0);
  // 自定义 tooltip 状态（参考 token-monitor 的 dash-tooltip：fixed 定位跟随鼠标，贴边翻转）
  const [tip, setTip] = useState<{ x: number; y: number; date: string; entry: HeatmapEntry | null } | null>(null);

  // 容器宽度自适应（ResizeObserver 不可用时退化为一次性测量）
  useEffect(() => {
    if (!gridNode) return;
    if (typeof ResizeObserver === 'undefined') {
      setWidth(gridNode.clientWidth);
      return;
    }
    const ro = new ResizeObserver((resizeEntries) => {
      for (const r of resizeEntries) {
        setWidth(r.contentRect.width);
      }
    });
    ro.observe(gridNode);
    return () => ro.disconnect();
  }, [gridNode]);

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

  // cell 随容器宽度自适应填满（参考 token-monitor dashboard.js：分数像素正好填满容器，
  // 设下限避免窄窗口挤压成一团；不设上限 — 否则宽窗口（如 AI 面板折叠后）网格右侧留大片空白）
  const cell =
    width > 0 ? Math.max(HEAT_CELL_MIN, (width - weeks * HEAT_GAP) / weeks) : 14;
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
      <div ref={setGridNode} className="overflow-x-auto">
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
function HeatTooltip({
  x,
  y,
  date,
  entry,
  testId = 'token-heatmap-tooltip',
}: {
  x: number;
  y: number;
  date: string;
  entry: HeatmapEntry | null;
  /** 区分调用方（热力图 / sparkline），便于测试精确断言 */
  testId?: string;
}) {
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

  // portal 到 document.body：ViewContainer 的 motion.div 带 will-change-[opacity,transform]，
  // 会成为 fixed 后代的包含块与独立层叠上下文 — 不 portal 会导致 tooltip 偏移
  // （相对视图容器而非视口定位）且被 z-50 的 AI 抽屉遮挡（portal 后 DOM 顺序 + z-[60] 均在其上）
  return createPortal(
    <div
      className="pointer-events-none fixed z-[60] min-w-[130px] rounded-lg border border-border px-3 py-2 text-xs shadow-xl"
      style={{ left, top, background: 'color-mix(in srgb, var(--card) 96%, transparent)' }}
      data-testid={testId}
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
    </div>,
    document.body,
  );
}

// ─── 7 天趋势 Sparkline ─────────────────────────────────────

/** sparkline viewBox 尺寸（SVG 宽 200 高 40，容器拉伸显示） */
const SPARK_W = 200;
const SPARK_H = 40;

/** 计算 sparkline 各数据点的 viewBox 坐标（悬停高亮点复用） */
function buildSparklinePoints(
  values: number[],
  width: number,
  height: number,
): Array<{ x: number; y: number }> {
  if (values.length === 0) return [];

  const max = Math.max(...values, 1);
  const min = Math.min(...values, 0);
  const range = max - min || 1;
  const stepX = values.length > 1 ? width / (values.length - 1) : 0;

  return values.map((v, i) => ({
    x: values.length > 1 ? i * stepX : width / 2,
    y: height - ((v - min) / range) * height,
  }));
}

/** Catmull-Rom → 三次贝塞尔平滑曲线 path（严格过数据点，悬停高亮点不偏移） */
function buildSmoothPath(points: Array<{ x: number; y: number }>): string {
  if (points.length === 0) return '';
  const f = (n: number) => n.toFixed(1);
  if (points.length === 1) return `M ${f(points[0].x)} ${f(points[0].y)}`;
  if (points.length === 2) {
    return `M ${f(points[0].x)} ${f(points[0].y)} L ${f(points[1].x)} ${f(points[1].y)}`;
  }

  let d = `M ${f(points[0].x)} ${f(points[0].y)}`;
  for (let i = 0; i < points.length - 1; i++) {
    // 端点夹取（首尾无外侧邻居时重复端点，避免曲线外甩）
    const p0 = points[Math.max(0, i - 1)];
    const p1 = points[i];
    const p2 = points[i + 1];
    const p3 = points[Math.min(points.length - 1, i + 2)];
    // Catmull-Rom（tension=1）控制点：C1 = P1 + (P2-P0)/6，C2 = P2 - (P3-P1)/6
    const c1x = p1.x + (p2.x - p0.x) / 6;
    const c1y = p1.y + (p2.y - p0.y) / 6;
    const c2x = p2.x - (p3.x - p1.x) / 6;
    const c2y = p2.y - (p3.y - p1.y) / 6;
    d += ` C ${f(c1x)} ${f(c1y)} ${f(c2x)} ${f(c2y)} ${f(p2.x)} ${f(p2.y)}`;
  }
  return d;
}

/** 7 天趋势 sparkline（悬停显示当日 Token / 费用明细） */
function TokenSparkline({ entries }: { entries: HeatmapEntry[] }) {
  const sparkData = useMemo(() => {
    const now = new Date();
    const todayStart = new Date(now.getFullYear(), now.getMonth(), now.getDate(), 0, 0, 0, 0);
    const entryMap = new Map(entries.map((e) => [e.date, e]));

    const days: { date: string; entry: HeatmapEntry | null }[] = [];
    for (let i = 6; i >= 0; i--) {
      const d = new Date(todayStart.getTime() - i * 24 * 60 * 60 * 1000);
      const dateStr = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
      days.push({ date: dateStr, entry: entryMap.get(dateStr) ?? null });
    }
    return days;
  }, [entries]);

  // 悬停状态：数据点索引 + 鼠标视口坐标（tooltip 跟随鼠标）
  const [hover, setHover] = useState<{ idx: number; x: number; y: number } | null>(null);

  const values = sparkData.map((d) => d.entry?.totalTokens ?? 0);
  const hasData = values.some((v) => v > 0);
  const points = useMemo(() => buildSparklinePoints(values, SPARK_W, SPARK_H), [values]);
  const path = buildSmoothPath(points);
  // 面积填充路径：曲线 + 底边闭合（渐变从线上透明度 0.2 → 底部 0.02）
  const areaPath =
    points.length > 1
      ? `${path} L ${points[points.length - 1].x.toFixed(1)} ${SPARK_H} L ${points[0].x.toFixed(1)} ${SPARK_H} Z`
      : '';

  const handleMouseMove = (ev: ReactMouseEvent<SVGSVGElement>): void => {
    const rect = ev.currentTarget.getBoundingClientRect();
    if (rect.width <= 0 || points.length === 0) {
      setHover(null);
      return;
    }
    // 鼠标 x → 最近数据点：容器宽度按数据点数等分
    // （preserveAspectRatio=none 拉伸不影响比例，rect 换算与 viewBox 坐标对齐）
    const ratio = (ev.clientX - rect.left) / rect.width;
    const idx = Math.max(0, Math.min(points.length - 1, Math.round(ratio * (points.length - 1))));
    setHover({ idx, x: ev.clientX, y: ev.clientY });
  };

  const hoverPoint = hover ? (points[hover.idx] ?? null) : null;
  const hoverDay = hover ? (sparkData[hover.idx] ?? null) : null;

  return (
    <div className="rounded-xl border border-border bg-card p-4" data-testid="token-sparkline">
      <div className="mb-1 text-xs font-semibold text-muted-foreground">最近 7 天趋势</div>
      {hasData ? (
        <div className="relative w-full" style={{ height: SPARK_H }}>
          <svg
            viewBox={`0 0 ${SPARK_W} ${SPARK_H}`}
            className="h-full w-full"
            preserveAspectRatio="none"
            data-testid="token-sparkline-svg"
            onMouseMove={handleMouseMove}
            onMouseLeave={() => setHover(null)}
          >
            <defs>
              {/* 面积渐变：主色顶部淡入 → 底部近透明（主题感知） */}
              <linearGradient id="token-sparkline-area" x1="0" y1="0" x2="0" y2="1">
                <stop offset="0%" style={{ stopColor: 'var(--primary)', stopOpacity: 0.2 }} />
                <stop offset="100%" style={{ stopColor: 'var(--primary)', stopOpacity: 0.02 }} />
              </linearGradient>
            </defs>
            {areaPath && (
              <path d={areaPath} fill="url(#token-sparkline-area)" data-testid="token-sparkline-area" />
            )}
            {/* 平滑曲线（non-scaling-stroke：容器横向拉伸时线宽保持 2px） */}
            <path
              d={path}
              fill="none"
              stroke="currentColor"
              strokeWidth={2}
              vectorEffect="non-scaling-stroke"
              strokeLinecap="round"
              className="text-primary"
              data-testid="token-sparkline-line"
            />
          </svg>
          {/* 悬停引导线 + 高亮数据点 — HTML 覆盖层按百分比定位：
              preserveAspectRatio=none 会把 SVG 内的圆拉伸成椭圆，覆盖层不受影响 */}
          {hoverPoint && (
            <>
              <div
                className="pointer-events-none absolute inset-y-0 w-px"
                style={{
                  left: `${(hoverPoint.x / SPARK_W) * 100}%`,
                  background: 'var(--border)',
                }}
                data-testid="token-sparkline-guide"
              />
              <div
                className="pointer-events-none absolute size-2 rounded-full"
                style={{
                  left: `${(hoverPoint.x / SPARK_W) * 100}%`,
                  top: `${(hoverPoint.y / SPARK_H) * 100}%`,
                  transform: 'translate(-50%, -50%)',
                  background: 'var(--primary)',
                  border: '2px solid var(--card)',
                }}
                data-testid="token-sparkline-dot"
              />
            </>
          )}
        </div>
      ) : (
        <div className="flex h-10 items-center text-[10px] text-muted-foreground">
          暂无 7 天数据
        </div>
      )}
      {/* 悬停明细（与热力图同款：日期 + 星期 + Token + 费用） */}
      {hoverDay && hover && (
        <HeatTooltip
          x={hover.x}
          y={hover.y}
          date={hoverDay.date}
          entry={hoverDay.entry}
          testId="token-sparkline-tooltip"
        />
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
