/**
 * ToolsDropdown — dropdown menu for opening tool windows.
 *
 * Renders a button in the TitleBar with a dropdown showing all 18 tools
 * grouped by category. Clicking a tool calls `trpc.tools.open.mutate()`
 * which creates (or focuses) an independent BrowserWindow for that tool.
 */

import { useState, useRef, useEffect, useCallback } from 'react';
import { ChevronDown, Wrench } from 'lucide-react';
import { ALL_TOOLS, TOOL_CATEGORY_LABELS, type ToolCategory } from '@shared/tool-types';
import { trpc } from '@renderer/lib/trpc';
import { useProjectStore } from '@renderer/stores/project';
import { useToastStore } from '@renderer/stores/toast';
import { cn } from '@renderer/lib/utils';
import * as Icons from 'lucide-react';
import type { ComponentType, SVGProps } from 'react';

/** Categories in display order. */
const CATEGORY_ORDER: ToolCategory[] = [
  'version-control',
  'regression',
  'code-tools',
  'coverage',
  'simulation-monitor',
  'environment',
  'batch',
];

/** Group tools by category. */
function groupToolsByCategory() {
  const groups: Record<string, typeof ALL_TOOLS> = {};
  for (const cat of CATEGORY_ORDER) {
    groups[cat] = ALL_TOOLS.filter((t) => t.category === cat);
  }
  return groups;
}

/** Dynamically render a lucide icon by name. */
function DynamicIcon({ name, className }: { name: string; className?: string }) {
  const IconComp = (Icons as unknown as Record<string, ComponentType<SVGProps<SVGSVGElement>>>)[name];
  if (!IconComp) return <Wrench className={className} />;
  return <IconComp className={className} />;
}

export function ToolsDropdown() {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  const groups = groupToolsByCategory();

  const currentProjectId = useProjectStore((s) => s.currentProjectId);
  const projects = useProjectStore((s) => s.projects);
  const errorToast = useToastStore((s) => s.error);

  const projectRoot = projects.find((p) => p.id === currentProjectId)?.rootPath ?? undefined;

  // Close dropdown when clicking outside
  useEffect(() => {
    if (!open) return;
    const handler = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) {
        setOpen(false);
      }
    };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, [open]);

  const handleOpenTool = useCallback(
    async (toolId: string) => {
      setOpen(false);
      try {
        await trpc.tools.open.mutate({ toolId, projectRoot });
      } catch (err) {
        const detail = err instanceof Error ? err.message : String(err);
        errorToast('打开工具失败', detail);
      }
    },
    [projectRoot, errorToast],
  );

  return (
    <div ref={ref} className="relative">
      <button
        onClick={() => setOpen(!open)}
        title="工具"
        className={cn(
          'titlebar-no-drag',
          'flex h-7 items-center gap-1 rounded px-2 transition-colors',
          'hover:bg-foreground/10',
          open && 'bg-foreground/10',
        )}
      >
        <Wrench className="h-3.5 w-3.5 text-muted-foreground" />
        <span className="text-xs text-muted-foreground">工具</span>
        <ChevronDown className="h-3 w-3 text-muted-foreground" />
      </button>

      {open && (
        <div className="absolute right-0 top-full z-50 mt-1 max-h-[70vh] w-64 overflow-auto rounded-md border border-border bg-popover shadow-lg">
          {CATEGORY_ORDER.map((cat) => {
            const tools = groups[cat];
            if (!tools || tools.length === 0) return null;
            return (
              <div key={cat}>
                <div className="sticky top-0 bg-popover px-3 py-1.5 text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">
                  {TOOL_CATEGORY_LABELS[cat]}
                </div>
                {tools.map((tool) => (
                  <button
                    key={tool.id}
                    onClick={() => handleOpenTool(tool.id)}
                    title={tool.description}
                    className="flex w-full items-center gap-2.5 px-3 py-1.5 text-left transition-colors hover:bg-accent"
                  >
                    <DynamicIcon name={tool.icon} className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
                    <span className="truncate text-xs">{tool.name}</span>
                  </button>
                ))}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
