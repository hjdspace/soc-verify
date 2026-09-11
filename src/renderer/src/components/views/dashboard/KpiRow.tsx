import { cn } from '@renderer/lib/utils';

/**
 * KPI 单卡：标签 + 数值 + 趋势 delta + sparkline。
 * delta / spark 无数据源时降级隐藏（显示中性文案，不渲染空图）。
 * 样式对照原型 `.kpi-card` / `.kpi-trend` / `.kpi-spark`。
 */
export type KpiCardData = {
  id: string;
  label: string;
  /** null = 无数据（显示 —） */
  value: number | null;
  unit?: string;
  /** 与昨日差值；null = 无趋势数据源，隐藏 */
  delta?: number | null;
  /** 数值上升是否为好（默认 true；活跃失败卡为 false） */
  deltaGoodWhenUp?: boolean;
  /** 7 日序列；null/空 = 降级隐藏 sparkline */
  spark?: number[] | null;
  /** 卡片点击回调；设置时卡片可交互（光标手型 + hover 高亮） */
  onClick?: () => void;
};

/** SVG sparkline：序列归一化到 64×20 视口，颜色随好坏方向 */
function Sparkline({ points, good }: { points: number[]; good: boolean }) {
  const min = Math.min(...points);
  const max = Math.max(...points);
  const range = max - min || 1;
  const coords = points.map((v, i) => {
    const x = (i / (points.length - 1)) * 64;
    const y = 18 - ((v - min) / range) * 16;
    return `${x.toFixed(1)},${y.toFixed(1)}`;
  });
  return (
    <svg width="64" height="20" viewBox="0 0 64 20" className="ml-auto shrink-0" aria-hidden="true">
      <polyline
        points={coords.join(' ')}
        fill="none"
        stroke="currentColor"
        strokeWidth="1.5"
        strokeLinecap="round"
        className={good ? 'text-status-pass-foreground' : 'text-status-fail-foreground'}
      />
    </svg>
  );
}

function formatDelta(delta: number): string {
  const sign = delta > 0 ? '+' : '';
  return `${sign}${Number(delta.toFixed(1))}`;
}

export function KpiCard({ card }: { card: KpiCardData }) {
  const goodUp = card.deltaGoodWhenUp ?? true;
  const delta = card.delta ?? null;
  // delta 方向：与「好方向」一致为 up 色，否则 down 色，0 为持平
  const deltaTone =
    delta === null || delta === 0
      ? 'flat'
      : (delta > 0) === goodUp
        ? 'up'
        : 'down';
  const spark = card.spark && card.spark.length >= 2 ? card.spark : null;

  return (
    <div
      className={cn(
        'rounded-xl border border-border bg-card px-4 py-3.5 transition-colors',
        card.onClick ? 'cursor-pointer hover:border-primary/40' : 'hover:border-border/80',
      )}
      data-testid={`kpi-${card.id}`}
      role={card.onClick ? 'button' : undefined}
      tabIndex={card.onClick ? 0 : undefined}
      onClick={card.onClick}
      onKeyDown={(e) => {
        if (card.onClick && (e.key === 'Enter' || e.key === ' ')) card.onClick();
      }}
    >
      <div className="mb-2 text-[11px] text-muted-foreground">{card.label}</div>
      <div className="mb-2 font-mono text-[26px] font-semibold leading-none text-foreground">
        {card.value === null ? '—' : Number(card.value.toFixed(1))}
        {card.unit && <span className="text-[13px] font-normal text-muted-foreground">{card.unit}</span>}
      </div>
      <div className="flex items-center gap-1 text-[11px]">
        {delta === null ? (
          <span className="text-muted-foreground/60">暂无趋势数据</span>
        ) : (
          <span
            className={cn(
              'flex items-center gap-0.5',
              deltaTone === 'up' && 'text-status-pass-foreground',
              deltaTone === 'down' && 'text-status-fail-foreground',
              deltaTone === 'flat' && 'text-muted-foreground',
            )}
            data-testid={`kpi-${card.id}-delta`}
          >
            {formatDelta(delta)} vs 昨日
          </span>
        )}
        {spark && <Sparkline points={spark} good={goodUp} />}
      </div>
    </div>
  );
}

export function KpiRow({ cards }: { cards: KpiCardData[] }) {
  return (
    <div className="mb-3 grid grid-cols-3 gap-3" data-testid="kpi-row">
      {cards.map((card) => (
        <KpiCard key={card.id} card={card} />
      ))}
    </div>
  );
}
