import { cn } from '@renderer/lib/utils';
import { parseJobItems } from '@renderer/components/chat/tool-helpers';

export function JobBody({ resultText }: { resultText: string }) {
  const items = parseJobItems(resultText);
  if (items.length === 0) {
    return <pre className="max-h-72 overflow-auto px-2.5 py-1.5 text-[11px] text-muted-foreground">{resultText || '\u00A0'}</pre>;
  }
  return (
    <div className="text-[11px] leading-relaxed">
      {items.map((item, i) => (
        <div key={i} className="flex items-center gap-2 border-b border-border/30 px-2.5 py-1.5 last:border-b-0">
          <span className="shrink-0 font-semibold text-chart-2">{item.id}</span>
          <span className="flex-1 min-w-0 truncate text-muted-foreground">{item.desc}</span>
          {item.progress != null && (
            <div className="h-1 w-12 shrink-0 overflow-hidden rounded-full bg-secondary">
              <div className="h-full rounded-full bg-chart-2" style={{ width: `${item.progress}%` }} />
            </div>
          )}
          <span className={cn(
            'shrink-0 rounded px-1.5 py-0.5 text-[9px] font-semibold uppercase tracking-wide',
            item.status === 'done' && 'bg-status-pass/15 text-status-pass-foreground',
            item.status === 'running' && 'bg-primary/15 text-primary',
            item.status === 'failed' && 'bg-status-fail/15 text-status-fail-foreground',
          )}>{item.status}</span>
        </div>
      ))}
    </div>
  );
}
