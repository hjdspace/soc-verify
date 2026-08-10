/**
 * OverviewTab — 概览标签页：汇总指标卡片 + 子系统状态表。
 *
 * Issue 02: 从 dashboard store 读取 summary + subsysStatus 数据。
 */

import { useDashboardStore } from '@renderer/stores/dashboard';

export function OverviewTab() {
  const summary = useDashboardStore((s) => s.summary);
  const subsysStatus = useDashboardStore((s) => s.subsysStatus);

  if (!summary) return null;

  return (
    <div className="space-y-4">
      {/* ─── 汇总指标卡片 ─────────────────────────────────── */}
      <div className="grid grid-cols-4 gap-2.5">
        <MetricCard
          label="子系统"
          value={summary.subsysCount.toString()}
          variant="info"
        />
        <MetricCard
          label="用例总数"
          value={summary.caseCount.toString()}
          variant="violet"
        />
        <MetricCard
          label="通过率"
          value={`${summary.passRate}%`}
          variant="pass"
        />
        <MetricCard
          label="失败数"
          value={summary.failCount.toString()}
          variant="fail"
        />
      </div>

      {/* ─── 子系统状态表 ─────────────────────────────────── */}
      {subsysStatus && subsysStatus.length > 0 && (
        <div className="rounded-md border border-border bg-card p-3">
          <div className="mb-2 text-xs font-semibold text-muted-foreground">
            子系统通过率概览
          </div>
          <table className="w-full border-collapse text-xs">
            <thead>
              <tr>
                <th className="border-b border-border bg-secondary px-2.5 py-1.5 text-left text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">
                  子系统
                </th>
                <th className="border-b border-border bg-secondary px-2.5 py-1.5 text-right text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">
                  用例数
                </th>
                <th className="border-b border-border bg-secondary px-2.5 py-1.5 text-right text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">
                  Pass
                </th>
                <th className="border-b border-border bg-secondary px-2.5 py-1.5 text-right text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">
                  Fail
                </th>
                <th className="border-b border-border bg-secondary px-2.5 py-1.5 text-right text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">
                  通过率
                </th>
              </tr>
            </thead>
            <tbody>
              {subsysStatus.map((s) => (
                <tr key={s.name} className="hover:bg-accent">
                  <td className="border-b border-border px-2.5 py-1 text-foreground">
                    {s.name}
                  </td>
                  <td className="border-b border-border px-2.5 py-1 text-right font-semibold tabular-nums text-foreground">
                    {s.caseCount}
                  </td>
                  <td className="border-b border-border px-2.5 py-1 text-right font-semibold tabular-nums text-status-pass-foreground">
                    {s.pass}
                  </td>
                  <td className="border-b border-border px-2.5 py-1 text-right font-semibold tabular-nums text-status-fail-foreground">
                    {s.fail}
                  </td>
                  <td className="border-b border-border px-2.5 py-1 text-right font-semibold tabular-nums text-foreground">
                    {s.passRate}%
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

// ─── Metric Card ────────────────────────────────────────────

function MetricCard({
  label,
  value,
  variant,
}: {
  label: string;
  value: string;
  variant: 'pass' | 'fail' | 'info' | 'violet';
}) {
  const colorClasses: Record<typeof variant, string> = {
    pass: 'border-status-pass/30 bg-status-pass/8 text-status-pass-foreground',
    fail: 'border-status-fail/30 bg-status-fail/8 text-status-fail-foreground',
    info: 'border-primary/30 bg-primary/8 text-primary',
    violet: 'border-accent/30 bg-accent/8 text-accent-foreground',
  };

  return (
    <div className={`rounded-md border p-3 ${colorClasses[variant]}`}>
      <div className="text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">
        {label}
      </div>
      <div className="mt-1 text-lg font-bold text-foreground">{value}</div>
    </div>
  );
}
