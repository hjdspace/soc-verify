import { useSimulationStore } from '@renderer/stores/simulation';
import { StatusBadge } from './StatusBadge';
import type { SimulationHistoryEntry } from '@shared/types';

type CompareResult = {
  runA: SimulationHistoryEntry | null;
  runB: SimulationHistoryEntry | null;
  differences: Array<{ field: string; valueA?: unknown; valueB?: unknown }>;
} | null;

export function ComparisonView() {
  const result = useSimulationStore((s) => s.compareResult) as CompareResult;

  if (!result) {
    return (
      <div className="flex flex-1 items-center justify-center text-xs text-muted-foreground">
        请从仿真历史中选择两条运行进行对比
      </div>
    );
  }

  const { runA, runB, differences } = result;

  return (
    <div className="flex flex-1 flex-col overflow-auto">
      <div className="border-b bg-secondary/20 px-3 py-1.5">
        <span className="text-xs font-semibold text-foreground">运行对比</span>
        <span className="ml-2 text-[11px] text-muted-foreground">{differences.length} 项差异</span>
      </div>
      <div className="flex-1 overflow-auto p-3">
        {/* Run summaries side by side */}
        <div className="mb-4 grid grid-cols-2 gap-3">
          {runA && (
            <div className="rounded border border-border/50 bg-secondary/20 p-3">
              <div className="mb-2 text-[11px] font-semibold uppercase text-muted-foreground">运行 A</div>
              <div className="space-y-1 text-xs">
                <div><span className="text-muted-foreground">用例:</span> <span className="text-foreground">{runA.caseName}</span></div>
                <div><span className="text-muted-foreground">子系统:</span> <span className="text-foreground">{runA.subsys}</span></div>
                <div className="flex items-center gap-1">
                  <span className="text-muted-foreground">状态:</span>{' '}
                  <StatusBadge status={runA.status} />
                </div>
                <div><span className="text-muted-foreground">耗时:</span> <span className="text-foreground">{runA.duration > 1000 ? `${(runA.duration / 1000).toFixed(1)}s` : `${runA.duration}ms`}</span></div>
                <div><span className="text-muted-foreground">时间:</span> <span className="text-foreground">{new Date(runA.startTime).toLocaleString()}</span></div>
              </div>
            </div>
          )}
          {runB && (
            <div className="rounded border border-border/50 bg-secondary/20 p-3">
              <div className="mb-2 text-[11px] font-semibold uppercase text-muted-foreground">运行 B</div>
              <div className="space-y-1 text-xs">
                <div><span className="text-muted-foreground">用例:</span> <span className="text-foreground">{runB.caseName}</span></div>
                <div><span className="text-muted-foreground">子系统:</span> <span className="text-foreground">{runB.subsys}</span></div>
                <div className="flex items-center gap-1">
                  <span className="text-muted-foreground">状态:</span>{' '}
                  <StatusBadge status={runB.status} />
                </div>
                <div><span className="text-muted-foreground">耗时:</span> <span className="text-foreground">{runB.duration > 1000 ? `${(runB.duration / 1000).toFixed(1)}s` : `${runB.duration}ms`}</span></div>
                <div><span className="text-muted-foreground">时间:</span> <span className="text-foreground">{new Date(runB.startTime).toLocaleString()}</span></div>
              </div>
            </div>
          )}
        </div>

        {/* Differences table */}
        {differences.length > 0 && (
          <div>
            <div className="mb-1 text-[11px] font-semibold uppercase tracking-[0.06em] text-muted-foreground">差异</div>
            <table className="w-full text-xs">
              <thead>
                <tr className="border-b text-left text-[11px] uppercase text-muted-foreground">
                  <th className="px-2 py-1">字段</th>
                  <th className="px-2 py-1">运行 A</th>
                  <th className="px-2 py-1">运行 B</th>
                </tr>
              </thead>
              <tbody>
                {differences.map((diff, i) => (
                  <tr key={i} className="border-b border-border/30">
                    <td className="px-2 py-1 font-medium text-foreground">{diff.field}</td>
                    <td className="px-2 py-1 text-muted-foreground">{String(diff.valueA ?? '-')}</td>
                    <td className="px-2 py-1 text-muted-foreground">{String(diff.valueB ?? '-')}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </div>
  );
}
