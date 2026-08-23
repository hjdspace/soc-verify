import { useCoverageStore } from '@renderer/stores/coverage';
import { useUiStore } from '@renderer/stores/ui';
import { cn } from '@renderer/lib/utils';

/** 四类覆盖率图例（对照原型 `.cov-item`），颜色全部走语义 token */
const COV_LEGEND: { key: 'functional' | 'line' | 'branch' | 'assertion'; name: string; bar: string }[] = [
  { key: 'functional', name: '功能覆盖', bar: 'bg-primary' },
  { key: 'line', name: '代码语句', bar: 'bg-status-running' },
  { key: 'branch', name: '分支覆盖', bar: 'bg-violet' },
  { key: 'assertion', name: 'SVA 断言', bar: 'bg-warning' },
];

const RING_R = 56;
const RING_CIRC = 2 * Math.PI * RING_R;

/** 覆盖率环 + 四类图例条。数据：coverage store 汇总（overview），只读复用。 */
export function CoverageRingPanel() {
  const overview = useCoverageStore((s) => s.overview);
  const loading = useCoverageStore((s) => s.loading);
  const setActiveView = useUiStore((s) => s.setActiveView);

  const functional = overview?.functional ?? null;

  return (
    <div className="flex min-w-0 flex-col overflow-hidden rounded-xl border border-border bg-card">
      <div className="flex items-center gap-2 border-b border-border px-3.5 py-2.5 text-xs font-semibold text-foreground">
        覆盖率
        <button
          className="ml-auto cursor-pointer text-[11px] font-normal text-muted-foreground transition-colors hover:text-foreground"
          onClick={() => setActiveView('coverage')}
        >
          详情 →
        </button>
      </div>

      {loading && !overview ? (
        <div className="flex flex-col gap-2 p-4" data-testid="cov-panel-skeleton">
          <div className="h-6 w-2/3 animate-pulse rounded bg-muted" />
          <div className="h-3 w-full animate-pulse rounded bg-muted" />
          <div className="h-3 w-5/6 animate-pulse rounded bg-muted" />
          <div className="h-3 w-4/6 animate-pulse rounded bg-muted" />
        </div>
      ) : functional === null ? (
        <div className="px-3.5 py-6 text-center text-xs text-muted-foreground/70" data-testid="cov-panel-empty">
          尚无覆盖率数据 — 导入 EDA 覆盖率报告后此处展示汇总
        </div>
      ) : (
        <div className="flex items-center gap-4 p-4">
          <div className="relative size-32 shrink-0">
            <svg width="128" height="128" viewBox="0 0 128 128" className="-rotate-90">
              <circle cx="64" cy="64" r={RING_R} fill="none" strokeWidth="10" className="stroke-background" />
              <circle
                cx="64"
                cy="64"
                r={RING_R}
                fill="none"
                strokeWidth="10"
                strokeLinecap="round"
                strokeDasharray={RING_CIRC.toFixed(2)}
                strokeDashoffset={(RING_CIRC * (1 - functional / 100)).toFixed(2)}
                className="stroke-primary"
                data-testid="cov-ring-arc"
              />
            </svg>
            <div className="absolute inset-0 grid place-items-center">
              <div className="text-center">
                <div className="font-mono text-2xl font-semibold text-foreground">
                  {functional.toFixed(1)}
                  <span className="text-xs">%</span>
                </div>
                <div className="text-[10px] text-muted-foreground">功能覆盖</div>
              </div>
            </div>
          </div>
          <div className="flex min-w-0 flex-1 flex-col gap-2.5">
            {COV_LEGEND.map(({ key, name, bar }) => (
              <div key={key} data-testid={`cov-legend-${key}`}>
                <div className="flex items-center gap-2 text-xs">
                  <span className={cn('size-2 shrink-0 rounded-[2px]', bar)} />
                  <span className="text-muted-foreground">{name}</span>
                  <span className="ml-auto font-mono text-xs text-foreground">
                    {overview ? overview[key].toFixed(1) : '—'}%
                  </span>
                </div>
                <div className="mt-1 h-[3px] overflow-hidden rounded-sm bg-background">
                  <div
                    className={cn('h-full rounded-sm', bar)}
                    style={{ width: `${overview ? overview[key] : 0}%` }}
                  />
                </div>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
