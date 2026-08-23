import { cn } from '@renderer/lib/utils';
import { parseTodoItems } from '@renderer/components/chat/tool-helpers';
import { GenericBody } from '../shared/GenericBody';

export function TodoBody({ args, resultText }: { args: unknown; resultText: string }) {
  const items = parseTodoItems(args, resultText);
  if (items.length === 0) return <GenericBody args={args} resultText={resultText} />;
  return (
    <div className="px-2.5 py-1.5 text-[11px] leading-relaxed">
      {items.map((item, i) => (
        <div key={i} className="flex items-center gap-2 py-0.5">
          <span className={cn(
            'flex h-3.5 w-3.5 shrink-0 items-center justify-center rounded border text-[8px]',
            item.status === 'completed' && 'border-violet-foreground bg-violet-foreground text-background',
            item.status === 'in_progress' && 'border-primary bg-primary/20 text-primary',
            item.status === 'pending' && 'border-border bg-transparent text-transparent',
            item.status === 'abandoned' && 'border-muted-foreground/40 bg-transparent text-muted-foreground/40',
          )}>
            {item.status === 'completed' ? '\u2713' : item.status === 'in_progress' ? '\u25b6' : item.status === 'abandoned' ? '\u2013' : ''}
          </span>
          <span className={cn(
            item.status === 'completed' && 'text-muted-foreground/50 line-through',
            item.status === 'in_progress' && 'font-medium text-foreground',
            item.status === 'pending' && 'text-muted-foreground',
            item.status === 'abandoned' && 'text-muted-foreground/40 line-through',
          )}>{item.text}</span>
        </div>
      ))}
    </div>
  );
}
