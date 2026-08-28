import { cn } from '@renderer/lib/utils';
import type { ScmDiffLine, ScmFileDiff } from '@shared/types';

/** 单行 diff：窄行号列 + 前缀符号 + 内容，增删行按语义色着底 */
function DiffRow({ line }: { line: ScmDiffLine }) {
  const gutter = line.type === 'del' ? line.oldLine : line.newLine;
  return (
    <div
      className={cn(
        'flex items-start font-mono text-[11px] leading-[16px]',
        line.type === 'add' && 'bg-diff-add text-diff-add-foreground',
        line.type === 'del' && 'bg-diff-del text-diff-del-foreground',
        line.type === 'ctx' && 'text-muted-foreground',
      )}
    >
      <span className="w-8 shrink-0 select-none pr-1 text-right text-[9px] tabular-nums opacity-60">
        {gutter ?? ''}
      </span>
      <span className="w-3 shrink-0 select-none">
        {line.type === 'add' ? '+' : line.type === 'del' ? '-' : ' '}
      </span>
      <span className="min-w-0 flex-1 overflow-x-auto whitespace-pre-wrap break-all pr-2">
        {line.content || '\u00A0'}
      </span>
    </div>
  );
}

/**
 * 源代码管理面板的内联文件 diff（只读，供人工审查 git 变更）。
 * 逐 hunk 渲染：hunk 头 + 带行号的增删/上下文行。
 */
export function InlineDiffView({ diff, className }: { diff: ScmFileDiff; className?: string }) {
  if (diff.isBinary) {
    return (
      <div className={cn('px-3 py-2 text-[11px] text-muted-foreground', className)}>
        二进制文件，无法展示文本差异
      </div>
    );
  }
  if (diff.hunks.length === 0) {
    return (
      <div className={cn('px-3 py-2 text-[11px] text-muted-foreground', className)}>无差异</div>
    );
  }

  return (
    <div className={cn('overflow-x-auto', className)}>
      {diff.hunks.map((hunk, hunkIndex) => (
        <div key={`${hunk.header}-${hunkIndex}`}>
          <div className="bg-secondary/60 px-2 py-0.5 font-mono text-[10px] text-muted-foreground">
            {hunk.header}
          </div>
          {hunk.lines.map((line, lineIndex) => (
            <DiffRow key={lineIndex} line={line} />
          ))}
        </div>
      ))}
    </div>
  );
}
