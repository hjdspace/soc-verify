import { useEffect } from 'react';
import { CheckCircle2, XCircle, BarChart3, RefreshCw, Activity } from 'lucide-react';
import { useDashboardStore } from '@renderer/stores/dashboard';
import { useProjectStore } from '@renderer/stores/project';
import { cn } from '@renderer/lib/utils';

export function DashboardPanel() {
  const metrics = useDashboardStore((s) => s.metrics);
  const loading = useDashboardStore((s) => s.loading);
  const loadMetrics = useDashboardStore((s) => s.loadMetrics);
  const currentProjectId = useProjectStore((s) => s.currentProjectId);

  useEffect(() => {
    if (currentProjectId) {
      loadMetrics(currentProjectId);
    }
  }, [currentProjectId, loadMetrics]);

  if (loading && !metrics) {
    return (
      <div className="flex flex-1 items-center justify-center text-xs text-muted-foreground">
        加载仪表盘数据...
      </div>
    );
  }

  if (!metrics) {
    return (
      <div className="flex flex-1 items-center justify-center text-xs text-muted-foreground">
        暂无数据
      </div>
    );
  }

  const passRate = metrics.passRate;
  const failRate = metrics.totalRuns > 0 ? 100 - passRate : 0;

  return (
    <div className="flex-1 overflow-auto p-4">
      <div className="mb-4 flex items-center justify-between">
        <h2 className="text-sm font-semibold">项目仪表盘</h2>
        <button
          onClick={() => currentProjectId && loadMetrics(currentProjectId)}
          className="rounded p-1 text-muted-foreground hover:bg-accent hover:text-foreground"
        >
          <RefreshCw className={cn('h-3.5 w-3.5', loading && 'animate-spin')} />
        </button>
      </div>

      {/* Metric cards */}
      <div className="grid grid-cols-4 gap-3">
        {/* Pass rate */}
        <MetricCard
          icon={<CheckCircle2 className="h-5 w-5 text-status-pass-foreground" />}
          label="通过率"
          value={`${passRate.toFixed(1)}%`}
          sub={`${metrics.totalRuns} 次仿真`}
          color="pass"
        />

        {/* Fail rate */}
        <MetricCard
          icon={<XCircle className="h-5 w-5 text-status-fail-foreground" />}
          label="失败率"
          value={`${failRate.toFixed(1)}%`}
          sub={`${metrics.totalRuns > 0 ? Math.round(metrics.totalRuns * failRate / 100) : 0} 次失败`}
          color="fail"
        />

        {/* Coverage */}
        <MetricCard
          icon={<BarChart3 className="h-5 w-5 text-status-running-foreground" />}
          label="总体覆盖率"
          value={metrics.coverage ? `${metrics.coverage.overall.toFixed(1)}%` : '-'}
          sub={metrics.coverage ? `行: ${metrics.coverage.line.toFixed(0)}%` : '无数据'}
          color="info"
        />

        {/* Regression count */}
        <MetricCard
          icon={<Activity className="h-5 w-5 text-violet-foreground" />}
          label="回归次数"
          value={String(metrics.regressionCount)}
          sub="历史运行"
          color="violet"
        />
      </div>

      {/* Pass/Fail chart */}
      <div className="mt-4 grid grid-cols-2 gap-3">
        <div className="rounded-lg border border-border/50 bg-secondary/20 p-3">
          <h3 className="mb-2 text-xs font-semibold text-muted-foreground">仿真通过/失败分布</h3>
          {metrics.totalRuns > 0 ? (
            <div className="flex h-8 overflow-hidden rounded-full">
              <div
                className="flex items-center justify-center bg-status-pass text-[10px] font-semibold text-background"
                style={{ width: `${passRate}%` }}
              >
                {passRate > 10 ? `${passRate.toFixed(0)}%` : ''}
              </div>
              <div
                className="flex items-center justify-center bg-status-fail text-[10px] font-semibold text-background"
                style={{ width: `${failRate}%` }}
              >
                {failRate > 10 ? `${failRate.toFixed(0)}%` : ''}
              </div>
            </div>
          ) : (
            <p className="text-xs text-muted-foreground">无仿真记录</p>
          )}
        </div>

        {/* Coverage breakdown */}
        {metrics.coverage && (
          <div className="rounded-lg border border-border/50 bg-secondary/20 p-3">
            <h3 className="mb-2 text-xs font-semibold text-muted-foreground">覆盖率分解</h3>
            <div className="space-y-1.5">
              {([
                { label: '行覆盖率', value: metrics.coverage.line, color: 'bg-chart-1' },
                { label: '翻转覆盖率', value: metrics.coverage.toggle, color: 'bg-chart-2' },
                { label: '功能覆盖率', value: metrics.coverage.functional, color: 'bg-chart-3' },
                { label: '断言覆盖率', value: metrics.coverage.assertion, color: 'bg-chart-4' },
              ]).map((item) => (
                <div key={item.label}>
                  <div className="flex justify-between text-[10px] text-muted-foreground">
                    <span>{item.label}</span>
                    <span className="font-mono">{item.value.toFixed(1)}%</span>
                  </div>
                  <div className="h-1.5 overflow-hidden rounded-full bg-muted">
                    <div className={cn('h-full rounded-full', item.color)} style={{ width: `${item.value}%` }} />
                  </div>
                </div>
              ))}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

function MetricCard({
  icon,
  label,
  value,
  sub,
  color,
}: {
  icon: React.ReactNode;
  label: string;
  value: string;
  sub: string;
  color: 'pass' | 'fail' | 'info' | 'violet';
}) {
  const colorClasses = {
    pass: 'border-status-pass/30 bg-status-pass/10',
    fail: 'border-status-fail/30 bg-status-fail/10',
    info: 'border-info/30 bg-info/10',
    violet: 'border-violet/30 bg-violet/10',
  };

  return (
    <div className={cn('rounded-lg border p-3', colorClasses[color])}>
      <div className="flex items-center gap-2">
        {icon}
        <span className="text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">{label}</span>
      </div>
      <div className="mt-1.5 text-2xl font-bold text-foreground">{value}</div>
      <div className="text-[10px] text-muted-foreground">{sub}</div>
    </div>
  );
}
