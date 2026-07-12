import { useEffect } from 'react';
import { Loader2, BarChart3 } from 'lucide-react';
import { useCoverageStore } from '@renderer/stores/coverage';
import { useProjectStore } from '@renderer/stores/project';
import { cn } from '@renderer/lib/utils';

interface CoveragePanelProps {
  projectId: string;
}

const COVERAGE_TYPES: Array<{ key: 'line' | 'toggle' | 'functional' | 'assertion'; label: string; color: string }> = [
  { key: 'line', label: '行覆盖率', color: 'bg-blue-500' },
  { key: 'toggle', label: '翻转覆盖率', color: 'bg-green-500' },
  { key: 'functional', label: '功能覆盖率', color: 'bg-purple-500' },
  { key: 'assertion', label: '断言覆盖率', color: 'bg-orange-500' },
];

export function CoveragePanel({ projectId }: CoveragePanelProps) {
  const overview = useCoverageStore((s) => s.overview);
  const subsysCoverage = useCoverageStore((s) => s.subsysCoverage);
  const loading = useCoverageStore((s) => s.loading);
  const loadOverview = useCoverageStore((s) => s.loadOverview);
  const loadBySubsys = useCoverageStore((s) => s.loadBySubsys);

  useEffect(() => {
    loadOverview(projectId);
    loadBySubsys(projectId);
  }, [projectId, loadOverview, loadBySubsys]);

  if (loading && !overview) {
    return (
      <div className="flex items-center justify-center gap-2 py-8">
        <Loader2 className="h-5 w-5 animate-spin text-primary" />
        <span className="text-xs text-muted-foreground">加载覆盖率数据...</span>
      </div>
    );
  }

  if (!overview) {
    return (
      <div className="flex flex-col items-center justify-center gap-2 py-8">
        <BarChart3 className="h-8 w-8 text-muted-foreground/50" />
        <p className="text-xs text-muted-foreground">无法加载覆盖率数据</p>
        <p className="text-[10px] text-muted-foreground/70">请确保已加载 coverage-parser 插件</p>
      </div>
    );
  }

  return (
    <div className="space-y-4 p-3">
      {/* Overview cards */}
      <div>
        <div className="mb-2 text-xs font-semibold">覆盖率概览</div>
        <div className="grid grid-cols-2 gap-2">
          {COVERAGE_TYPES.map((ct) => (
            <CoverageCard
              key={ct.key}
              label={ct.label}
              value={overview[ct.key]}
              color={ct.color}
            />
          ))}
        </div>
      </div>

      {/* Overall bar */}
      <div>
        <div className="mb-1 flex justify-between text-[10px] text-muted-foreground">
          <span>总体覆盖率</span>
          <span className="font-mono font-semibold">{overview.overall.toFixed(1)}%</span>
        </div>
        <div className="h-2 overflow-hidden rounded-full bg-muted">
          <div
            className="h-full rounded-full bg-primary transition-all"
            style={{ width: `${overview.overall}%` }}
          />
        </div>
      </div>

      {/* By subsystem */}
      {subsysCoverage.length > 0 && (
        <div>
          <div className="mb-2 text-xs font-semibold">按子系统分布</div>
          <div className="space-y-1.5">
            {subsysCoverage.map((s) => (
              <div key={s.subsys} className="rounded border border-border/50 p-2">
                <div className="mb-1 flex justify-between text-xs">
                  <span className="font-medium">{s.subsys}</span>
                  <span className="font-mono text-muted-foreground">{s.summary.overall.toFixed(1)}%</span>
                </div>
                <div className="flex gap-1">
                  {COVERAGE_TYPES.map((ct) => (
                    <div
                      key={ct.key}
                      className="flex-1"
                      title={`${ct.label}: ${s.summary[ct.key].toFixed(1)}%`}
                    >
                      <div className="h-1 overflow-hidden rounded-full bg-muted">
                        <div
                          className={cn('h-full rounded-full', ct.color)}
                          style={{ width: `${s.summary[ct.key]}%` }}
                        />
                      </div>
                    </div>
                  ))}
                </div>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

function CoverageCard({ label, value, color }: { label: string; value: number; color: string }) {
  return (
    <div className="rounded border border-border/50 p-2">
      <div className="text-[10px] text-muted-foreground">{label}</div>
      <div className="flex items-center gap-1.5">
        <div className={cn('h-2 w-2 rounded-full', color)} />
        <span className="text-sm font-mono font-semibold">{value.toFixed(1)}%</span>
      </div>
      <div className="mt-1 h-1 overflow-hidden rounded-full bg-muted">
        <div
          className={cn('h-full rounded-full', color)}
          style={{ width: `${value}%` }}
        />
      </div>
    </div>
  );
}
