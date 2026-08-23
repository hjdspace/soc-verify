import { cn } from '@renderer/lib/utils';
import type { DiffLineData } from '@renderer/components/chat/tool-helpers';
import { CodeHighlight } from '../shared/CodeHighlight';

export function DiffLineView({ line, language }: { line: DiffLineData; language: string }) {
  const sign = line.type === 'add' ? '+' : line.type === 'del' ? '-' : ' ';
  return (
    <div className={cn('flex', line.type === 'add' && 'bg-diff-add/20', line.type === 'del' && 'bg-diff-del/20')}>
      <span className={cn(
        'w-8 shrink-0 select-none pr-1 text-right text-[10px]',
        line.type === 'add' && 'text-status-pass-foreground/60',
        line.type === 'del' && 'text-status-fail-foreground/60',
        line.type === 'ctx' && 'text-muted-foreground/40',
      )}>
        {line.oldLine != null ? line.oldLine : ' '}
      </span>
      <span className={cn(
        'w-4 shrink-0 select-none text-center',
        line.type === 'add' && 'text-status-pass-foreground',
        line.type === 'del' && 'text-status-fail-foreground',
        line.type === 'ctx' && 'text-muted-foreground/50',
      )}>{sign}</span>
      <span className={cn(
        'flex-1 overflow-x-auto px-1.5',
        line.type === 'add' && 'text-diff-add-foreground',
        line.type === 'del' && 'text-diff-del-foreground line-through',
        line.type === 'ctx' && 'text-muted-foreground',
      )}>
        <CodeHighlight code={line.content || '\u00A0'} language={language} />
      </span>
    </div>
  );
}
