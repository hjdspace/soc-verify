import { cn } from '@renderer/lib/utils';
import type { DiffLineData } from '@renderer/components/chat/tool-helpers';
import { CodeHighlight } from '../shared/CodeHighlight';

/**
 * Diff 行（DSH §6.4）：无行号无底色，`- `/`+ ` 前缀红/绿着色。
 */
export function DiffLineView({ line, language }: { line: DiffLineData; language: string }) {
  const sign = line.type === 'add' ? '+ ' : line.type === 'del' ? '- ' : '  ';
  return (
    <div
      className={cn(
        'flex whitespace-pre font-mono text-[11px] leading-[18px]',
        line.type === 'add' && 'ap-diff-add',
        line.type === 'del' && 'ap-diff-del',
      )}
    >
      <span className="w-4 shrink-0 select-none">{sign}</span>
      <span className={cn(
        'min-w-0 flex-1 overflow-x-auto pr-2',
        line.type === 'ctx' && 'text-muted-foreground',
      )}>
        <CodeHighlight code={line.content || '\u00A0'} language={language} />
      </span>
    </div>
  );
}
