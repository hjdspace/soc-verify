import { useCoverageCoreStore } from '@renderer/stores/coverage';
import { useUiStore } from '@renderer/stores/ui';

/**
 * 覆盖率环（SoC 代码覆盖率重构）：
 * 主环 = 代码覆盖率（line）；block/branch/statements 需解析 detail.txt 后补充
 * （detail 生成在百万行数量级，由用户在覆盖率视图按需触发）。
 * 数据：coverage store 汇总（overview），只读复用。
 */
export function CoverageRingPanel() {
  const overview = useCoverageCoreStore((s) => s.overview);
  const loading = useCoverageCoreStore((s) => s.loading);
  const setActiveView = useUiStore((s) => s.setActiveView);

  const codeCov = overview?.line ?? null;

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
        </div>
      ) : codeCov === null ? (
        <div className="px-3.5 py-6 text-center text-xs text-muted-foreground/70" data-testid="cov-panel-empty">
          尚无覆盖率数据 — 导入 EDA 覆盖率报告后此处展示汇总
        </div>
      ) : (
        <div className="flex flex-1 flex-col items-center justify-center gap-2 p-4" data-testid="cov-panel-body">
          <div className="relative size-28">
            <svg width="112" height="112" viewBox="0 0 112 112" className="-rotate-90">
              <circle cx="56" cy="56" r={RING_R} fill="none" strokeWidth="9" className="stroke-background" />
              <circle
                cx="56"
                cy="56"
                r={RING_R}
                fill="none"
                strokeWidth="9"
                strokeLinecap="round"
                strokeDasharray={RING_CIRC.toFixed(2)}
                strokeDashoffset={(RING_CIRC * (1 - codeCov / 100)).toFixed(2)}
                className="stroke-primary"
                data-testid="cov-ring-arc"
              />
            </svg>
            <div className="absolute inset-0 grid place-items-center">
              <div className="text-center">
                <div className="font-mono text-2xl font-semibold text-foreground">
                  {codeCov.toFixed(1)}
                  <span className="text-xs">%</span>
                </div>
                <div className="text-[10px] text-muted-foreground">代码覆盖率</div>
              </div>
            </div>
          </div>
          <div
            className="text-[10px] leading-relaxed text-muted-foreground/70"
            data-testid="cov-ring-hint"
          >
            分支 / 语句等明细需在覆盖率视图解析 detail 报告后展示
          </div>
        </div>
      )}
    </div>
  );
}

const RING_R = 46;
const RING_CIRC = 2 * Math.PI * RING_R;
