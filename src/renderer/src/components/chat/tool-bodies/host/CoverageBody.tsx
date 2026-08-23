import { tryParseJSON, numFromObj } from '@renderer/components/chat/tool-helpers';
import { cn } from '@renderer/lib/utils';
import { GenericBody } from '../shared/GenericBody';

export function CoverageBody({ resultText }: { resultText: string }) {
  const parsed = tryParseJSON(resultText) as Record<string, unknown> | null;
  const metrics = [
    { label: 'Line', value: numFromObj(parsed, 'line', 'lineCoverage') },
    { label: 'Toggle', value: numFromObj(parsed, 'toggle', 'toggleCoverage') },
    { label: 'FSM', value: numFromObj(parsed, 'fsm', 'fsmCoverage', 'functional') },
    { label: 'Assert', value: numFromObj(parsed, 'assertion', 'assertCoverage') },
  ];

  if (!metrics.some((m) => m.value != null)) {
    return <GenericBody args={null} resultText={resultText} />;
  }

  return (
    <div className="grid grid-cols-4 gap-px bg-border/40 text-[11px] leading-relaxed">
      {metrics.map((m) => {
        const pct = m.value != null ? (m.value > 1 ? m.value : m.value * 100) : null;
        const cls = pct == null ? 'text-muted-foreground' : pct >= 85 ? 'text-status-pass-foreground' : pct >= 70 ? 'text-warning-foreground' : 'text-status-fail-foreground';
        return (
          <div key={m.label} className="bg-secondary/20 px-2 py-2 text-center">
            <div className="text-[9px] uppercase tracking-wide text-muted-foreground/60">{m.label}</div>
            <div className={cn('mt-0.5 text-base font-bold tabular-nums', cls)}>{pct != null ? `${pct.toFixed(1)}%` : '--'}</div>
          </div>
        );
      })}
    </div>
  );
}
