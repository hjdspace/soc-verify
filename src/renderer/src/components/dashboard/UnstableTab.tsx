/**
 * UnstableTab — 不稳定标签页：不稳定用例列表。
 *
 * Issue 06: 表格展示有 pass 又有 fail 的用例，按失败率降序排列。
 * 失败率用颜色标识（越高越红）。
 */

import { useDashboardStore } from '@renderer/stores/dashboard';

/** 根据失败率返回颜色类名 */
function failRateColorClass(failRate: number): string {
  if (failRate >= 75) return 'text-red-600 font-bold';
  if (failRate >= 50) return 'text-orange-500 font-semibold';
  if (failRate >= 25) return 'text-yellow-600';
  return 'text-green-600';
}

/** 将 lastStatus 转换为中文标签 */
function statusLabel(status: string): string {
  switch (status) {
    case 'pass': return '通过';
    case 'fail': return '失败';
    case 'error': return '错误';
    case 'aborted': return '中断';
    default: return status;
  }
}

/** 根据 lastStatus 返回颜色类名 */
function statusColorClass(status: string): string {
  switch (status) {
    case 'pass': return 'text-green-600';
    case 'fail': return 'text-red-600';
    case 'error': return 'text-red-500';
    case 'aborted': return 'text-muted-foreground';
    default: return 'text-muted-foreground';
  }
}

export function UnstableTab() {
  const unstableCases = useDashboardStore((s) => s.unstableCases);

  if (!unstableCases || unstableCases.length === 0) return null;

  return (
    <div className="rounded-md border border-border bg-card p-3">
      <div className="mb-2 text-xs font-semibold text-muted-foreground">
        不稳定用例（共 {unstableCases.length} 个，按失败率降序）
      </div>
      <table className="w-full border-collapse text-xs">
        <thead>
          <tr>
            <th className="border-b border-border bg-secondary px-2.5 py-1.5 text-left text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">
              用例名
            </th>
            <th className="border-b border-border bg-secondary px-2.5 py-1.5 text-left text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">
              子系统
            </th>
            <th className="border-b border-border bg-secondary px-2.5 py-1.5 text-right text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">
              Pass次数
            </th>
            <th className="border-b border-border bg-secondary px-2.5 py-1.5 text-right text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">
              Fail次数
            </th>
            <th className="border-b border-border bg-secondary px-2.5 py-1.5 text-right text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">
              总运行
            </th>
            <th className="border-b border-border bg-secondary px-2.5 py-1.5 text-right text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">
              失败率
            </th>
            <th className="border-b border-border bg-secondary px-2.5 py-1.5 text-right text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">
              最近状态
            </th>
          </tr>
        </thead>
        <tbody>
          {unstableCases.map((c, idx) => (
            <tr key={`${c.caseName}-${c.subsys}-${idx}`} className="hover:bg-accent">
              <td className="border-b border-border px-2.5 py-1 text-foreground">
                {c.caseName}
              </td>
              <td className="border-b border-border px-2.5 py-1 text-muted-foreground">
                {c.subsys}
              </td>
              <td className="border-b border-border px-2.5 py-1 text-right tabular-nums text-green-600">
                {c.passCount}
              </td>
              <td className="border-b border-border px-2.5 py-1 text-right tabular-nums text-red-600">
                {c.failCount}
              </td>
              <td className="border-b border-border px-2.5 py-1 text-right tabular-nums text-muted-foreground">
                {c.totalCount}
              </td>
              <td className={`border-b border-border px-2.5 py-1 text-right tabular-nums ${failRateColorClass(c.failRate)}`}>
                {c.failRate}%
              </td>
              <td className={`border-b border-border px-2.5 py-1 text-right ${statusColorClass(c.lastStatus)}`}>
                {statusLabel(c.lastStatus)}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
