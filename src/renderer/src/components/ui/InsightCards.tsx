import { useMemo, useState, type PointerEvent as ReactPointerEvent, type ReactNode } from 'react';
import {
  Bar,
  BarChart,
  Cell,
  Line,
  LineChart,
  ReferenceLine,
  ResponsiveContainer,
  XAxis,
  YAxis,
} from 'recharts';
import { ChevronLeft, ChevronRight } from 'lucide-react';
import { THEMES, useThemeStore, type ThemeMode } from '@renderer/stores/theme';
import { cn } from '@renderer/lib/utils';

/**
 * InsightCards — 分页洞察轮播（state 取模循环 + 前后按钮），三卡形态：
 * compare 双系列对比折线（自建 scrub：hover 竖线游标 + 数值 tooltip）、
 * anomaly 异常检测柱状（metric 切换 + 阈值参考线/阈值头）、
 * allocation 占比分段条（点选驱动大数字）。
 *
 * 视觉/交互参考 beautiful-ui:
 * D:\AI\beautiful-ui\components\primitives\InsightCards.tsx
 * （对应 CSS: D:\AI\beautiful-ui\app\globals.css 约 L1350–1400 .insight-chart-cursor/tooltip-*）
 *
 * 与参考实现的偏差：
 * - liveline 不引入——折线/柱状用项目已有 recharts 重绘；scrub 交互保留参考实现
 *   的自建方案，chartIndexFromPointer() 与 Catmull-Rom 平滑纯函数 smooth()（每段
 *   9 点）直接搬，稠密序列交给 recharts 直线连接（视觉上即平滑曲线）。
 * - 暗色检测用 theme store（参考实现是 MutationObserver 监听 documentElement）；
 *   SVG 属性不接受 var()，系列色按变量名读 :root 计算值，shade 变化触发重渲染
 *   后重读；HTML 元素（圆点/分段条）仍用 var() 内联，随主题自动取值。
 * - 参考实现的三张卡写死冰淇淋演示数据，此处全部 props 化（pages 契约），
 *   演示数据不进正式代码；宿主见 views/dashboard/InsightPanel。
 * 样式类 .ap-ins-* 落 globals.css；测试断言 external DOM（testid/aria/inline
 * style），recharts 在 jsdom 量不到尺寸，测试以透传 stub 替换（见 insight-cards.test）。
 */

/** smooth() 每段插值点数（参考实现同款 9）；稠密 index → 原始 index 换算也用它 */
export const SMOOTH_PER_SEGMENT = 9;

/* Catmull-Rom resample — turn a sparse series into a dense, smoothly curved
 * one so both the line and the hover cursor glide instead of stepping between
 * a handful of points.（参考实现原样搬移） */
export function smooth(values: number[], perSegment = SMOOTH_PER_SEGMENT): number[] {
  if (values.length < 3) return values.slice();
  const out: number[] = [];
  const n = values.length;
  for (let i = 0; i < n - 1; i += 1) {
    const p0 = values[Math.max(0, i - 1)];
    const p1 = values[i];
    const p2 = values[i + 1];
    const p3 = values[Math.min(n - 1, i + 2)];
    for (let s = 0; s < perSegment; s += 1) {
      const t = s / perSegment;
      const t2 = t * t;
      const t3 = t2 * t;
      out.push(
        0.5 *
          (2 * p1 +
            (-p0 + p2) * t +
            (2 * p0 - 5 * p1 + 4 * p2 - p3) * t2 +
            (-p0 + 3 * p1 - 3 * p2 + p3) * t3),
      );
    }
  }
  out.push(values[n - 1]);
  return out;
}

/* pointer x → 数据 index：stage 包围盒内进度取整（参考实现同款换算，
 * getBoundingClientRect 拆出参数便于脱离 DOM 单测），越界钳回数据范围。 */
export function chartIndexFromPointer(
  clientX: number,
  rect: { left: number; width: number },
  pointCount: number,
): number {
  if (pointCount < 2 || !(rect.width > 0)) return 0;
  const progress = Math.max(0, Math.min(1, (clientX - rect.left) / rect.width));
  return Math.round(progress * (pointCount - 1));
}

/** SVG 属性不接受 var()——按变量名读 :root 计算值；jsdom/未定义时回退 currentColor */
function resolveColor(colorVar: string): string {
  const value = getComputedStyle(document.documentElement).getPropertyValue(colorVar).trim();
  return value || 'currentColor';
}

/** 明暗档：theme store 当前主题 → THEMES 的 mode（参考实现 useDarkMode 的替代） */
function useShade(): ThemeMode {
  const themeId = useThemeStore((s) => s.currentTheme);
  return THEMES.find((t) => t.id === themeId)?.mode ?? 'dark';
}

// ─── 数据契约 ───────────────────────────────────────────────────

export type InsightTone = 'pass' | 'fail' | 'neutral';

/** 对比卡的单个系列（values 为原始稀疏序列，组件内做 Catmull-Rom 稠密化） */
export type InsightSeriesDef = {
  name: string;
  values: number[];
  /** 语义色变量名（如 '--status-pass'）：SVG 取计算值，legend 圆点用 var() 内联 */
  colorVar: string;
  /** 数值格式化（legend 大数字与 tooltip 共用）；缺省四舍五入取整 */
  format?: (v: number) => string;
  /** legend 大数字着色 */
  tone?: InsightTone;
  /** legend mono 副行文案 */
  sub?: string;
  subTone?: InsightTone;
};

export type InsightCompareCard = {
  kind: 'compare';
  /** 恰好双系列（首系列在前） */
  series: [InsightSeriesDef, InsightSeriesDef];
  /** 图表面板头左侧文案（悬停时切换为当前数据点标签） */
  caption?: string;
  /** 图表面板头右侧徽标（如「趋势」） */
  badge?: string;
  /** 每个数据点的标签（与 values 对齐，悬停时替换 caption，如日期） */
  labels?: string[];
};

/** 异常检测卡的单个 metric 档位 */
export type InsightMetricDef = {
  key: string;
  /** 切换按钮文案（如「失败率」） */
  label: string;
  /** 每个数据点的值 */
  values: number[];
  /** 每个数据点的标签（类目名，悬停时替换头部文案） */
  labels: string[];
  /** 未悬停时头部显示的阈值/摘要文案 */
  headerLabel: string;
  /** 阈值参考线 y 值；缺省不画线 */
  threshold?: number;
  format: (v: number) => string;
};

export type InsightAnomalyCard = {
  kind: 'anomaly';
  title: ReactNode;
  /** 恰好两档（metric 切换组） */
  metrics: [InsightMetricDef, InsightMetricDef];
  footer?: { value: string; delta?: string; deltaTone?: InsightTone; note?: string };
};

export type InsightSegment = {
  key: string;
  label: string;
  /** 分段占比（0-100，分段条宽度） */
  pct: number;
  /** 点选后展示的大数字（已格式化） */
  value: string;
  /** 分段色（任意 CSS 颜色，传 var(--chart-1) 等语义变量） */
  color: string;
  /** 详情框说明文案 */
  detail?: string;
};

export type InsightAllocationCard = {
  kind: 'allocation';
  title: ReactNode;
  segments: InsightSegment[];
};

export type InsightCardData = InsightCompareCard | InsightAnomalyCard | InsightAllocationCard;

export type InsightPage = {
  key: string;
  /** 页首叙述（宿主用行内 span 着色，组件原样渲染） */
  prose: ReactNode;
  /** 建议追问 pill 文案 */
  pill: string;
  card: InsightCardData;
};

// ─── 共用小件 ───────────────────────────────────────────────────

const formatDefault = (v: number) => String(Math.round(v));

/** tooltip 锚点水平位置钳制（参考实现同款 28–72%，防贴边溢出） */
const clampAnchor = (pct: number) => Math.min(Math.max(pct, 28), 72);

/** 稠密 index → 原始稀疏 index（smooth 每段 perSegment 点，末点收尾） */
const denseToSparse = (denseIndex: number, sparseCount: number) =>
  Math.min(sparseCount - 1, Math.floor(denseIndex / SMOOTH_PER_SEGMENT));

function ChartTooltip({ rows }: { rows: { key: string; value: string; color: string }[] }) {
  return (
    <div className="ap-ins-tooltip" data-testid="ins-tooltip">
      {rows.map((row) => (
        <span key={row.key} className="ap-ins-tooltip-item">
          <span className="ap-ins-tooltip-dot" style={{ background: row.color }} />
          {row.value}
        </span>
      ))}
    </div>
  );
}

/** scrub 状态：pointer x → 数据 index（按下/移动跟随，离开/取消/抬起清除） */
function useScrubIndex(pointCount: number) {
  const [hoverIndex, setHoverIndex] = useState<number | null>(null);
  const apply = (event: ReactPointerEvent<HTMLDivElement>) => {
    setHoverIndex(
      chartIndexFromPointer(
        event.clientX,
        event.currentTarget.getBoundingClientRect(),
        pointCount,
      ),
    );
  };
  const clear = () => setHoverIndex(null);
  const stageProps = {
    'data-testid': 'ins-stage',
    onPointerDown: apply,
    onPointerMove: apply,
    onPointerLeave: clear,
    onPointerCancel: clear,
    onPointerUp: clear,
  } as const;
  return { hoverIndex, stageProps, clear };
}

// ─── 卡 1：双系列对比折线 ────────────────────────────────────────

function CompareCardView({ data, shade }: { data: InsightCompareCard; shade: ThemeMode }) {
  const [seriesA, seriesB] = data.series;
  // 稠密化只在数据变化时重算
  const dense = useMemo(
    () => ({ a: smooth(seriesA.values), b: smooth(seriesB.values) }),
    [seriesA.values, seriesB.values],
  );
  // shade 变化 → 重渲染 → 重读 :root 计算色（SVG 属性不能用 var()；
  // applyTheme 先于 store 更新，重渲染时取到的已是新主题的计算值）
  const strokes = useMemo(
    () => {
      void shade; // 仅作重算触发器
      return [resolveColor(seriesA.colorVar), resolveColor(seriesB.colorVar)];
    },
    [seriesA.colorVar, seriesB.colorVar, shade],
  );

  const pointCount = Math.min(dense.a.length, dense.b.length);
  const chartData = useMemo(
    () => Array.from({ length: pointCount }, (_, i) => ({ i, a: dense.a[i], b: dense.b[i] })),
    [dense, pointCount],
  );

  const fmtA = seriesA.format ?? formatDefault;
  const fmtB = seriesB.format ?? formatDefault;
  const { hoverIndex, stageProps } = useScrubIndex(pointCount);

  const headerText =
    hoverIndex !== null && data.labels
      ? data.labels[denseToSparse(hoverIndex, data.labels.length)]
      : (data.caption ?? '');

  return (
    <>
      <div className="ap-ins-legend">
        {([seriesA, seriesB] as const).map((def, idx) => (
          <div key={def.name} className="ap-ins-legend-item">
            <span className="ap-ins-legend-name">
              <span className="ap-ins-dot" style={{ background: `var(${def.colorVar})` }} />
              {def.name}
            </span>
            <span className="ap-ins-legend-value" data-tone={def.tone ?? 'neutral'}>
              {(idx === 0 ? fmtA : fmtB)(def.values.at(-1) ?? 0)}
            </span>
            {def.sub && (
              <code className="ap-ins-mono" data-tone={def.subTone ?? 'neutral'}>
                {def.sub}
              </code>
            )}
          </div>
        ))}
      </div>
      <div className="ap-ins-panel">
        <div className="ap-ins-panel-head">
          <span className="ap-ins-panel-caption">{headerText}</span>
          {data.badge && <span className="ap-ins-badge">{data.badge}</span>}
        </div>
        <div className="ap-ins-stage" {...stageProps}>
          <ResponsiveContainer width="100%" height="100%">
            <LineChart data={chartData} margin={{ top: 42, right: 6, bottom: 6, left: 6 }}>
              <XAxis dataKey="i" hide />
              <YAxis hide domain={[0, (max: number) => Math.ceil(max * 1.15)]} />
              <Line dataKey="a" stroke={strokes[0]} strokeWidth={2.25} dot={false} isAnimationActive={false} />
              <Line dataKey="b" stroke={strokes[1]} strokeWidth={2.25} dot={false} isAnimationActive={false} />
            </LineChart>
          </ResponsiveContainer>
          {hoverIndex !== null && (
            <>
              <span
                className="ap-ins-cursor"
                data-testid="ins-cursor"
                style={{ left: `${(hoverIndex / Math.max(1, pointCount - 1)) * 100}%` }}
              />
              <span
                className="ap-ins-tooltip-anchor"
                style={{ left: `${clampAnchor((hoverIndex / Math.max(1, pointCount - 1)) * 100)}%` }}
              >
                <ChartTooltip
                  rows={[
                    { key: seriesA.name, value: fmtA(dense.a[hoverIndex]), color: `var(${seriesA.colorVar})` },
                    { key: seriesB.name, value: fmtB(dense.b[hoverIndex]), color: `var(${seriesB.colorVar})` },
                  ]}
                />
              </span>
            </>
          )}
        </div>
      </div>
    </>
  );
}

// ─── 卡 2：异常检测柱状 ──────────────────────────────────────────

function AnomalyCardView({ data, shade }: { data: InsightAnomalyCard; shade: ThemeMode }) {
  const [metricIndex, setMetricIndex] = useState(0);
  const metric = data.metrics[metricIndex] ?? data.metrics[0];
  const { hoverIndex, stageProps, clear } = useScrubIndex(metric.values.length);
  const colors = useMemo(
    () => {
      void shade; // 仅作重算触发器（主题切换后重读计算色）
      return {
        bar: resolveColor('--status-fail'),
        barVar: '--status-fail',
        threshold: resolveColor('--status-aborted'),
      };
    },
    [shade],
  );

  // 悬停 index 越过新档位点数时钳回安全范围（切换档位本身也会清空）
  const activeIndex = hoverIndex !== null && hoverIndex < metric.values.length ? hoverIndex : null;
  const barData = metric.values.map((value, i) => ({ i, value }));
  const yMax = Math.max(...metric.values, metric.threshold ?? 0) * 1.2;

  const selectMetric = (index: number) => {
    clear();
    setMetricIndex(index);
  };

  return (
    <>
      <span className="ap-ins-card-title">{data.title}</span>
      <div className="ap-ins-panel">
        <div className="ap-ins-panel-head">
          <span className="ap-ins-panel-caption">
            {activeIndex !== null
              ? `${metric.labels[activeIndex]} · ${metric.format(metric.values[activeIndex])}`
              : metric.headerLabel}
          </span>
          <span className="ap-ins-metric-group" role="group" aria-label="指标切换">
            {data.metrics.map((m, index) => (
              <button
                key={m.key}
                type="button"
                className="ap-ins-metric-btn"
                aria-pressed={metricIndex === index}
                data-testid={`ins-metric-${m.key}`}
                onClick={() => selectMetric(index)}
              >
                {m.label}
              </button>
            ))}
          </span>
        </div>
        <div className="ap-ins-stage" {...stageProps}>
          <ResponsiveContainer width="100%" height="100%">
            <BarChart data={barData} margin={{ top: 42, right: 6, bottom: 6, left: 6 }}>
              <XAxis dataKey="i" hide />
              <YAxis hide domain={[0, yMax]} />
              <Bar dataKey="value" isAnimationActive={false} radius={[3, 3, 0, 0]}>
                {barData.map((_, i) => (
                  <Cell
                    key={i}
                    fill={colors.bar}
                    fillOpacity={activeIndex === null ? 0.55 : activeIndex === i ? 1 : 0.3}
                  />
                ))}
              </Bar>
              {typeof metric.threshold === 'number' && (
                <ReferenceLine
                  y={metric.threshold}
                  stroke={colors.threshold}
                  strokeDasharray="4 4"
                  ifOverflow="extendDomain"
                />
              )}
            </BarChart>
          </ResponsiveContainer>
          {activeIndex !== null && (
            <>
              <span
                className="ap-ins-cursor"
                data-testid="ins-cursor"
                style={{ left: `${(activeIndex / Math.max(1, metric.values.length - 1)) * 100}%` }}
              />
              <span
                className="ap-ins-tooltip-anchor"
                style={{ left: `${clampAnchor((activeIndex / Math.max(1, metric.values.length - 1)) * 100)}%` }}
              >
                <ChartTooltip
                  rows={[{ key: metric.key, value: metric.format(metric.values[activeIndex]), color: `var(${colors.barVar})` }]}
                />
              </span>
            </>
          )}
        </div>
      </div>
      {data.footer && (
        <div className="ap-ins-footer">
          <span className="ap-ins-footer-value">{data.footer.value}</span>
          {data.footer.delta && (
            <code className="ap-ins-mono" data-tone={data.footer.deltaTone ?? 'neutral'}>
              {data.footer.delta}
            </code>
          )}
          {data.footer.note && <span className="ap-ins-footer-note">{data.footer.note}</span>}
        </div>
      )}
    </>
  );
}

// ─── 卡 3：占比分段条 ────────────────────────────────────────────

function AllocationCardView({ data }: { data: InsightAllocationCard }) {
  const [selectedKey, setSelectedKey] = useState(data.segments[0]?.key ?? '');
  const active = data.segments.find((s) => s.key === selectedKey) ?? data.segments[0];
  if (!active) return null;

  return (
    <>
      <span className="ap-ins-card-title">{data.title}</span>
      <span className="ap-ins-hero" data-testid="ins-hero">
        {active.value}
      </span>
      <div className="ap-ins-segbar" role="group" aria-label="占比分段">
        {data.segments.map((seg) => (
          <button
            key={seg.key}
            type="button"
            className="ap-ins-seg"
            aria-pressed={seg.key === active.key}
            aria-label={`${seg.label}：${seg.pct}%`}
            data-testid={`ins-seg-${seg.key}`}
            style={{ width: `${seg.pct}%`, background: seg.color }}
            data-selected={seg.key === active.key ? 'true' : 'false'}
            onClick={() => setSelectedKey(seg.key)}
          >
            <span className="ap-ins-seg-sheen" />
          </button>
        ))}
      </div>
      <div className="ap-ins-seglegend">
        {data.segments.map((seg) => (
          <button
            key={seg.key}
            type="button"
            className="ap-ins-legend-btn"
            aria-pressed={seg.key === active.key}
            data-testid={`ins-legend-${seg.key}`}
            onClick={() => setSelectedKey(seg.key)}
          >
            <span className="ap-ins-dot" style={{ background: seg.color }} />
            {seg.label}&nbsp;<span className="ap-ins-legend-pct">{seg.pct}%</span>
          </button>
        ))}
      </div>
      <div className="ap-ins-detail" data-testid="ins-detail">
        <span className="ap-ins-detail-label">{active.label}</span>
        {active.detail && <span className="ap-ins-detail-text">{active.detail}</span>}
      </div>
    </>
  );
}

function InsightCardView({ card, shade }: { card: InsightCardData; shade: ThemeMode }) {
  if (card.kind === 'compare') return <CompareCardView data={card} shade={shade} />;
  if (card.kind === 'anomaly') return <AnomalyCardView data={card} shade={shade} />;
  return <AllocationCardView data={card} />;
}

// ─── 轮播 ───────────────────────────────────────────────────────

type InsightCardsProps = {
  /** 页序列（key 唯一）；空数组渲染 null */
  pages: InsightPage[];
  /** 分页头标题 */
  title?: string;
  /** 追问 pill 点击回调（pill 文案即建议追问）；缺省时 pill 渲染为非交互文本 */
  onAskPill?: (pill: string) => void;
  testId?: string;
  className?: string;
};

/**
 * 洞察轮播。页选中态按 key 记忆（数据刷新页序变化/页数增减时不跳页，
 * key 消失自动回落首页）；前后按钮取模循环（末页 → 首页）。
 */
export function InsightCards({ pages, title = '洞察', onAskPill, testId, className }: InsightCardsProps) {
  const shade = useShade();
  const [activeKey, setActiveKey] = useState(pages[0]?.key ?? '');
  const activeIndex = Math.max(0, pages.findIndex((p) => p.key === activeKey));
  const page = pages[activeIndex];

  if (!page) return null;

  const move = (direction: -1 | 1) => {
    const next = pages[(activeIndex + direction + pages.length) % pages.length];
    if (next) setActiveKey(next.key);
  };

  return (
    <div className={cn('ap-ins', className)} data-testid={testId} data-shade={shade}>
      <div className="ap-ins-pager">
        <span className="ap-ins-pager-title">
          {title}
          <span className="ap-ins-pager-count">{pages.length}</span>
        </span>
        <span className="ap-ins-pager-btns">
          <button
            type="button"
            aria-label="上一条洞察"
            data-testid="ins-prev"
            className="ap-ins-pager-btn"
            onClick={() => move(-1)}
          >
            <ChevronLeft size={13} strokeWidth={2.2} />
          </button>
          <button
            type="button"
            aria-label="下一条洞察"
            data-testid="ins-next"
            className="ap-ins-pager-btn"
            onClick={() => move(1)}
          >
            <ChevronRight size={13} strokeWidth={2.2} />
          </button>
        </span>
      </div>
      {/* key 重挂载承载页切换交叉淡入（fade-in 纯 opacity，符合 reduced-motion 保留策略） */}
      <div className="ap-ins-page" key={page.key}>
        <p className="ap-ins-prose">{page.prose}</p>
        <div className="ap-ins-card" data-testid={`ins-card-${page.card.kind}`}>
          <InsightCardView card={page.card} shade={shade} />
        </div>
        {onAskPill ? (
          <button
            type="button"
            className="ap-ins-pill"
            data-testid="ins-pill"
            onClick={() => onAskPill(page.pill)}
          >
            {page.pill}
          </button>
        ) : (
          <span className="ap-ins-pill" data-testid="ins-pill" data-static="true">
            {page.pill}
          </span>
        )}
      </div>
    </div>
  );
}
