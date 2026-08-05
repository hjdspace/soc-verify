/**
 * ToolPlaceholder — shown for tools not yet implemented (Batch 2 & 3).
 */

import { Construction } from 'lucide-react';
import { ALL_TOOLS, type ToolMeta } from '@shared/tool-types';
import type { ToolComponentProps } from './registry';

export function ToolPlaceholder(_props: ToolComponentProps) {
  const toolId = new URLSearchParams(window.location.search).get('tool')
    || window.location.hash.slice('#tool='.length);
  const tool = ALL_TOOLS.find((t: ToolMeta) => t.id === toolId);

  return (
    <div className="flex h-full flex-col items-center justify-center gap-4 p-8 text-center">
      <Construction className="h-16 w-16 text-muted-foreground/50" />
      <div>
        <h2 className="text-lg font-semibold">{tool?.name ?? '工具'}</h2>
        <p className="mt-2 text-sm text-muted-foreground">
          此工具正在开发中，将在后续版本中提供。
        </p>
        <p className="mt-1 text-xs text-muted-foreground/60">
          工具 ID: {toolId}
        </p>
      </div>
    </div>
  );
}
