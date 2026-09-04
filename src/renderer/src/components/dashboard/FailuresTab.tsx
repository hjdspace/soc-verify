/**
 * FailuresTab — 失败标签页：最近失败用例列表。
 *
 * Issue 05: 从 dashboard store 读取 recentFailures 数据。
 * Update: 添加状态列，展示状态圆点+状态文本。
 */

import { useDashboardStore } from '@renderer/stores/dashboard';

/** 将毫秒耗时格式化为可读字符串 */
function formatDuration(ms: number | null): string {
  if (ms === null || ms === undefined) return '—';
  if (ms < 1000) return `${ms}ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`;
  const min = Math.floor(ms / 60_000);
  const sec = Math.round((ms % 60_000) / 1000);
  return `${min}m${sec}s`;
}

/** 将 ISO 时间字符串格式化为本地日期时间 */
function formatTime(iso: string): string {
  try {
    const d = new Date(iso);
    const yyyy = d.getFullYear();
    const mm = String(d.getMonth() + 1).padStart(2, '0');
    const dd = String(d.getDate()).padStart(2, '0');
    const hh = String(d.getHours()).padStart(2, '0');
    const mi = String(d.getMinutes()).padStart(2, '0');
    return `${yyyy}-${mm}-${dd} ${hh}:${mi}`;
  } catch {
    return iso;
  }
}

/** 根据 status 返回颜色类名 */
function statusColorClass(status: string): string {
  switch (status) {
    case 'fail': return 'text-status-fail-foreground';
    case 'error': return 'text-status-fail-foreground';
    case 'aborted': return 'text-muted-foreground';
    default: return 'text-muted-foreground';
  }
}

export function FailuresTab() {
  const recentFailures = useDashboardStore((s) => s.recentFailures);

  if (!recentFailures || recentFailures.length === 0) return null;

  return (
    <div className="rounded-md border border-border bg-card p-3">
      <div className="mb-2 text-xs font-semibold text-muted-foreground">
        最近失败用例（共 {recentFailures.length} 条）
      </div>
      <table className="w-full border-collapse text-xs">
        <thead>
          <tr>
            <th className="border-b border-border bg-secondary px-2.5 py-1.5 text-left text-[10px] font-semibold uppercase tracking-[0.06em] text-muted-foreground">
              用例名
            </th>
            <th className="border-b border-border bg-secondary px-2.5 py-1.5 text-left text-[10px] font-semibold uppercase tracking-[0.06em] text-muted-foreground">
              子系统
            </th>
            <th className="border-b border-border bg-secondary px-2.5 py-1.5 text-left text-[10px] font-semibold uppercase tracking-[0.06em] text-muted-foreground">
              状态
            </th>
            <th className="border-b border-border bg-secondary px-2.5 py-1.5 text-right text-[10px] font-semibold uppercase tracking-[0.06em] text-muted-foreground">
              失败时间
            </th>
            <th className="border-b border-border bg-secondary px-2.5 py-1.5 text-right text-[10px] font-semibold uppercase tracking-[0.06em] text-muted-foreground">
              耗时
            </th>
          </tr>
        </thead>
        <tbody>
          {recentFailures.map((f, idx) => (
            <tr key={`${f.caseName}-${f.startTime}-${idx}`} className="hover:bg-accent">
              <td className="border-b border-border px-2.5 py-1 text-foreground">
                {f.caseName}
              </td>
              <td className="border-b border-border px-2.5 py-1 text-muted-foreground">
                {f.subsys}
              </td>
              <td className={`border-b border-border px-2.5 py-1 ${statusColorClass(f.status)}`}>
                <span className="mr-1.5 inline-block h-1.5 w-1.5 rounded-full bg-status-fail align-middle" />
                {f.status}
              </td>
              <td className="border-b border-border px-2.5 py-1 text-right tabular-nums text-muted-foreground">
                {formatTime(f.startTime)}
              </td>
              <td className="border-b border-border px-2.5 py-1 text-right tabular-nums text-foreground">
                {formatDuration(f.durationMs)}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
