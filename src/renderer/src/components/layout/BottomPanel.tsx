import { useCallback, useEffect, useRef, useState } from 'react';
import { Terminal as TerminalIcon, Plus, X, ChevronDown, ArrowUpToLine } from 'lucide-react';
import { useTerminalStore } from '@renderer/stores/terminal';
import { useUiStore } from '@renderer/stores/ui';
import { useProjectStore } from '@renderer/stores/project';
import { TerminalView } from '@renderer/components/terminal/TerminalView';
import { cn } from '@renderer/lib/utils';
import { PluginViewHost } from '@renderer/components/plugins/PluginViewHost';

/** MIME type used for terminal tab drag-and-drop. */
export const TERMINAL_TAB_MIME = 'application/x-socverify-terminal-tab';

/**
 * Bottom terminal panel — VSCode-style integrated terminal.
 *
 * - Collapsible (toggle preserves terminal sessions, does NOT destroy them)
 * - Resizable height (drag the top edge)
 * - Accepts terminals dragged from the center tab bar
 * - Terminal tabs can be dragged back to the center
 */
export function BottomPanel() {
  const collapsed = useUiStore((s) => s.bottomPanelCollapsed);
  const height = useUiStore((s) => s.bottomPanelHeight);
  const setHeight = useUiStore((s) => s.setBottomPanelHeight);
  const setCollapsed = useUiStore((s) => s.setBottomPanelCollapsed);

  const tabs = useTerminalStore((s) => s.tabs);
  const bottomActiveTabId = useTerminalStore((s) => s.bottomActiveTabId);
  const setBottomActiveTab = useTerminalStore((s) => s.setBottomActiveTab);
  const closeTerminal = useTerminalStore((s) => s.closeTerminal);
  const createTerminal = useTerminalStore((s) => s.createTerminal);
  const moveTerminalLocation = useTerminalStore((s) => s.moveTerminalLocation);

  const currentProjectId = useProjectStore((s) => s.currentProjectId);
  const plugins = useProjectStore((s) => s.plugins);

  const [showNewMenu, setShowNewMenu] = useState(false);
  const [dropHover, setDropHover] = useState(false);

  const bottomTabs = tabs.filter((t) => t.location === 'bottom');
  const hasBottomPluginViews = plugins.some((plugin) => plugin.contributes?.views?.some((view) => view.location === 'bottom'));
  const activeTab = bottomTabs.find((t) => t.id === bottomActiveTabId) ?? bottomTabs[0] ?? null;

  // Auto-collapse when there are no bottom terminals (but only if currently expanded)
  useEffect(() => {
    if (!collapsed && bottomTabs.length === 0) {
      setCollapsed(true);
    }
  }, [bottomTabs.length, collapsed, setCollapsed]);

  // ── Resize handle (top edge) ──────────────────────────
  const startYRef = useRef(0);
  const startHeightRef = useRef(0);
  const draggingRef = useRef(false);

  const handleResizeStart = useCallback(
    (e: React.MouseEvent) => {
      e.preventDefault();
      draggingRef.current = true;
      startYRef.current = e.clientY;
      startHeightRef.current = height;
      document.body.style.cursor = 'ns-resize';
      document.body.style.userSelect = 'none';
    },
    [height],
  );

  useEffect(() => {
    const handleMouseMove = (e: MouseEvent) => {
      if (!draggingRef.current) return;
      const delta = e.clientY - startYRef.current;
      // Dragging up increases height
      const newHeight = startHeightRef.current - delta;
      setHeight(newHeight);
    };
    const handleMouseUp = () => {
      if (!draggingRef.current) return;
      draggingRef.current = false;
      document.body.style.cursor = '';
      document.body.style.userSelect = '';
    };
    window.addEventListener('mousemove', handleMouseMove);
    window.addEventListener('mouseup', handleMouseUp);
    return () => {
      window.removeEventListener('mousemove', handleMouseMove);
      window.removeEventListener('mouseup', handleMouseUp);
    };
  }, [setHeight]);

  // ── Drag-and-drop: accept terminals dragged from center ──
  const handleDragOver = useCallback((e: React.DragEvent) => {
    if (e.dataTransfer.types.includes(TERMINAL_TAB_MIME)) {
      e.preventDefault();
      e.dataTransfer.dropEffect = 'move';
      setDropHover(true);
    }
  }, []);

  const handleDragLeave = useCallback(() => {
    setDropHover(false);
  }, []);

  const handleDrop = useCallback(
    (e: React.DragEvent) => {
      e.preventDefault();
      setDropHover(false);
      const tabId = e.dataTransfer.getData(TERMINAL_TAB_MIME);
      if (tabId) {
        moveTerminalLocation(tabId, 'bottom');
      }
    },
    [moveTerminalLocation],
  );

  // ── New terminal ──────────────────────────────────────
  const handleNewTerminal = useCallback(() => {
    void createTerminal(currentProjectId ?? undefined, undefined, 'bottom');
    setShowNewMenu(false);
  }, [createTerminal, currentProjectId]);

  if (collapsed || bottomTabs.length === 0) {
    return hasBottomPluginViews ? (
      <div className="flex max-h-72 min-h-8 shrink-0 flex-col border-t border-border bg-background">
        <PluginViewHost location="bottom" />
      </div>
    ) : null;
  }

  return (
    <div
      className={cn(
        'flex shrink-0 flex-col border-t border-border bg-background',
        dropHover && 'ring-1 ring-inset ring-primary/40',
      )}
      style={{ height: `${height}px` }}
      onDragOver={handleDragOver}
      onDragLeave={handleDragLeave}
      onDrop={handleDrop}
    >
      <PluginViewHost location="bottom" />

      {/* ── Resize handle (top edge) ──────────────────────── */}
      <div
        onMouseDown={handleResizeStart}
        className="group absolute -top-0.5 left-0 right-0 z-20 h-1.5 cursor-ns-resize hover:bg-primary/30 transition-colors"
      >
        <div className="absolute inset-x-0 -top-1 -bottom-1" />
      </div>

      {/* ── Tab bar + actions ─────────────────────────────── */}
      <div className="flex h-8 shrink-0 items-center border-b bg-secondary/30">
        {/* Terminal icon */}
        <div className="flex items-center gap-1.5 px-3 text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">
          <TerminalIcon className="h-3 w-3" />
          <span>Terminal</span>
        </div>

        {/* Bottom terminal tabs */}
        <div className="flex h-full flex-1 items-center overflow-x-auto">
          {bottomTabs.map((tab) => (
            <div
              key={tab.id}
              draggable
              onDragStart={(e) => {
                e.dataTransfer.setData(TERMINAL_TAB_MIME, tab.id);
                e.dataTransfer.effectAllowed = 'move';
              }}
              onClick={() => setBottomActiveTab(tab.id)}
              className={cn(
                'flex h-full shrink-0 cursor-pointer items-center gap-1.5 border-r px-3 text-xs transition-colors',
                activeTab?.id === tab.id
                  ? 'bg-background text-foreground'
                  : 'text-muted-foreground hover:bg-background/50',
              )}
            >
              <TerminalIcon className="h-3 w-3 opacity-50" />
              <span className="max-w-32 truncate">{tab.title}</span>
              <button
                onClick={(e) => {
                  e.stopPropagation();
                  void closeTerminal(tab.id);
                }}
                className="ml-1 rounded p-0.5 opacity-50 transition-opacity hover:bg-foreground/10 hover:opacity-100"
              >
                <X className="h-3 w-3" />
              </button>
            </div>
          ))}
        </div>

        {/* Right-side actions */}
        <div className="flex items-center gap-1 px-2">
          {/* New terminal dropdown */}
          <div className="relative">
            <button
              onClick={() => setShowNewMenu(!showNewMenu)}
              title="新建终端"
              className="flex items-center rounded p-1 text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
            >
              <Plus className="h-3.5 w-3.5" />
            </button>
            {showNewMenu && (
              <>
                <div className="fixed inset-0 z-40" onClick={() => setShowNewMenu(false)} />
                <div className="absolute right-0 top-7 z-50 min-w-40 overflow-hidden rounded-md border border-border bg-popover shadow-xl">
                  <button
                    onClick={handleNewTerminal}
                    className="flex w-full items-center gap-2 px-3 py-1.5 text-left text-xs transition-colors hover:bg-accent"
                  >
                    <TerminalIcon className="h-3.5 w-3.5 opacity-70" />
                    <span>新建终端</span>
                  </button>
                </div>
              </>
            )}
          </div>

          {/* Move active terminal to center */}
          {activeTab && (
            <button
              onClick={() => moveTerminalLocation(activeTab.id, 'center')}
              title="移动到中栏"
              className="flex items-center rounded p-1 text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
            >
              <ArrowUpToLine className="h-3.5 w-3.5" />
            </button>
          )}

          {/* Collapse */}
          <button
            onClick={() => setCollapsed(true)}
            title="折叠面板"
            className="flex items-center rounded p-1 text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
          >
            <ChevronDown className="h-3.5 w-3.5" />
          </button>
        </div>
      </div>

      {/* ── Terminal content ──────────────────────────────── */}
      <div className="flex flex-1 overflow-hidden">
        {activeTab && activeTab.terminalId ? (
          <TerminalView key={activeTab.terminalId} terminalId={activeTab.terminalId} />
        ) : (
          <div className="flex flex-1 items-center justify-center text-xs text-muted-foreground">
            {activeTab?.creating ? '正在创建终端...' : '无活动终端'}
          </div>
        )}
      </div>
    </div>
  );
}
