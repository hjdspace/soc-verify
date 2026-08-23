import { useCallback } from 'react';
import { openReviewAwareFile } from '@renderer/stores/diff-review';

/**
 * Renders a clickable file path header used in expanded body views.
 * Clicking opens the file in the workbench editor via openFileDestination.
 */
export function ClickablePathHeader({ filePath }: { filePath: string }) {
  const handleClick = useCallback((e: React.MouseEvent) => {
    e.stopPropagation();
    const fileName = filePath.replace(/\\/g, '/').split('/').pop() ?? filePath;
    openReviewAwareFile(filePath, fileName);
  }, [filePath]);

  return (
    <div
      onClick={handleClick}
      className="cursor-pointer border-b border-border/30 bg-background/50 px-2.5 py-0.5 text-[10px] text-muted-foreground/60 hover:underline"
      title={`点击打开文件: ${filePath}`}
    >
      {filePath}
    </div>
  );
}
