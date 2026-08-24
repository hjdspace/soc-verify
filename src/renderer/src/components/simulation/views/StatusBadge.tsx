import { cn } from '@renderer/lib/utils';
import type { SimulationStatus } from '@shared/types';

// ── 状态徽章：主题感知的点 + 文字 ────────────────────────────────
export const STATUS_BADGE_STYLES: Record<SimulationStatus, { dot: string; text: string }> = {
  pass: { dot: 'bg-status-pass-foreground', text: 'text-status-pass-foreground' },
  fail: { dot: 'bg-status-fail-foreground', text: 'text-status-fail-foreground' },
  error: { dot: 'bg-status-fail-foreground', text: 'text-status-fail-foreground' },
  aborted: { dot: 'bg-status-aborted-foreground', text: 'text-status-aborted-foreground' },
  running: { dot: 'bg-status-running-foreground animate-pulse', text: 'text-status-running-foreground' },
  pending: { dot: 'bg-status-pending-foreground', text: 'text-status-pending-foreground' },
};

export function StatusBadge({ status }: { status: SimulationStatus }) {
  const style = STATUS_BADGE_STYLES[status] ?? STATUS_BADGE_STYLES.pending;
  return (
    <span className="inline-flex items-center gap-1.5 text-[11px]">
      <span className={cn('size-[7px] rounded-full', style.dot)} />
      <span className={style.text}>{status}</span>
    </span>
  );
}
