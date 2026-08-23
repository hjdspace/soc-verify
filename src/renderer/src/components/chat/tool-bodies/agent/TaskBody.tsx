import { cn } from '@renderer/lib/utils';
import { parseTaskItemsFromResult } from '@renderer/components/chat/tool-helpers';

export function TaskBody({ result, resultText }: { result: unknown; resultText: string }) {
  const items = parseTaskItemsFromResult(result);
  if (items.length === 0) {
    return <pre className="max-h-72 overflow-auto px-2.5 py-1.5 text-[11px] text-muted-foreground">{resultText || '\u00A0'}</pre>;
  }
  return (
    <div className="text-[11px] leading-relaxed">
      {items.map((item, i) => (
        <div key={i} className="flex items-start gap-2 border-b border-border/30 px-2.5 py-1.5 last:border-b-0">
          <span className={cn(
            'mt-0.5 flex h-4 w-4 shrink-0 items-center justify-center rounded text-[9px]',
            item.status === 'done' && 'bg-status-pass/15 text-status-pass-foreground',
            item.status === 'running' && 'bg-primary/15 text-primary',
            item.status === 'pending' && 'bg-secondary text-muted-foreground',
            item.status === 'error' && 'bg-status-fail/15 text-status-fail-foreground',
          )}>
            {item.status === 'done' ? '\u2713' : item.status === 'running' ? '\u27f3' : item.status === 'error' ? '\u2717' : '\u00b7'}
          </span>
          <div className="min-w-0 flex-1">
            <div className={cn('font-medium', item.status === 'done' ? 'text-muted-foreground line-through' : 'text-foreground')}>
              {item.title}
            </div>
            {item.meta && <div className="mt-0.5 text-[10px] text-muted-foreground/60">{item.meta}</div>}
          </div>
        </div>
      ))}
    </div>
  );
}
