/**
 * ToolWindow — layout shell for tool windows.
 *
 * Provides a simplified frameless TitleBar (drag area + tool name + close button)
 * and a content area where the tool component renders.
 *
 * The tool name and icon are looked up from the ALL_TOOLS metadata.
 */

import { useState, useEffect, useCallback } from 'react';
import { Minus, Square, X, Copy } from 'lucide-react';
import { cn } from '@renderer/lib/utils';
import { ALL_TOOLS, type ToolMeta } from '@shared/tool-types';
import type { ToolComponentProps } from './registry';

type ToolWindowProps = {
  toolId: string;
  children: (props: ToolComponentProps) => React.ReactNode;
};

export function ToolWindow({ toolId, children }: ToolWindowProps) {
  const tool = ALL_TOOLS.find((t: ToolMeta) => t.id === toolId);
  const [isMaximized, setIsMaximized] = useState(false);
  const [projectRoot, setProjectRoot] = useState<string | null>(
    () => new URLSearchParams(window.location.search).get('project'),
  );

  // Listen for window maximize state changes
  useEffect(() => {
    const api = window.windowControls;
    if (!api) return;

    api.isMaximized().then(setIsMaximized);
    const unlisten = api.onMaximizeChange(setIsMaximized);
    return unlisten;
  }, []);

  const handleMinimize = useCallback(() => window.windowControls?.minimize(), []);
  const handleMaximize = useCallback(() => window.windowControls?.toggleMaximize(), []);
  const handleClose = useCallback(() => window.windowControls?.close(), []);

  return (
    <div className="flex h-screen w-screen flex-col overflow-hidden bg-background text-foreground">
      {/* ── Simplified TitleBar ── */}
      <header
        className={cn(
          'titlebar-drag',
          'flex h-8 shrink-0 items-center justify-between border-b border-border bg-titlebar px-3 select-none',
        )}
      >
        {/* Tool name */}
        <div className="flex items-center gap-2">
          <span className="text-xs font-medium text-titlebar-foreground">
            {tool?.name ?? '工具'}
          </span>
        </div>

        {/* Window controls */}
        <div className="flex items-center">
          <button
            onClick={handleMinimize}
            title="最小化"
            className="titlebar-no-drag flex h-6 w-7 items-center justify-center rounded transition-colors hover:bg-foreground/10"
          >
            <Minus className="h-3 w-3" />
          </button>
          <button
            onClick={handleMaximize}
            title={isMaximized ? '还原' : '最大化'}
            className="titlebar-no-drag flex h-6 w-7 items-center justify-center rounded transition-colors hover:bg-foreground/10"
          >
            {isMaximized ? <Copy className="h-2.5 w-2.5 -scale-x-100" /> : <Square className="h-2.5 w-2.5" />}
          </button>
          <button
            onClick={handleClose}
            title="关闭"
            className="titlebar-no-drag flex h-6 w-7 items-center justify-center rounded transition-colors hover:bg-destructive hover:text-destructive-foreground"
          >
            <X className="h-3 w-3" />
          </button>
        </div>
      </header>

      {/* ── Content area ── */}
      <div className="min-h-0 flex-1 overflow-auto">
        {children({ projectRoot, onProjectRootChange: setProjectRoot })}
      </div>
    </div>
  );
}
