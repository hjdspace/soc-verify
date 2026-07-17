import { useEffect, useState, useRef, useCallback } from 'react';
import { Search, Terminal as TerminalIcon, LayoutDashboard, BarChart3, ListChecks, GitBranch, Settings, FileText } from 'lucide-react';
import { useUiStore } from '@renderer/stores/ui';
import { useWorkbenchStore } from '@renderer/stores/workbench';
import { useProjectStore } from '@renderer/stores/project';
import { trpc } from '@renderer/lib/trpc';
import { cn } from '@renderer/lib/utils';

interface SearchResult {
  type: string;
  label: string;
  detail: string;
}

interface CommandItem {
  id: string;
  label: string;
  detail?: string;
  icon: typeof Search;
  action: () => void;
}

export function CommandPalette() {
  const commandPaletteOpen = useUiStore((s) => s.commandPaletteOpen);
  const setCommandPaletteOpen = useUiStore((s) => s.setCommandPaletteOpen);
  const openDestination = useWorkbenchStore((s) => s.open);
  const setSettingsOpen = useUiStore((s) => s.setSettingsOpen);
  const currentProjectId = useProjectStore((s) => s.currentProjectId);

  const [query, setQuery] = useState('');
  const [selectedIndex, setSelectedIndex] = useState(0);
  const [searchResults, setSearchResults] = useState<SearchResult[]>([]);
  const [searching, setSearching] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (commandPaletteOpen) {
      setQuery('');
      setSelectedIndex(0);
      setSearchResults([]);
      setTimeout(() => inputRef.current?.focus(), 0);
    }
  }, [commandPaletteOpen]);

  // Global shortcut: Ctrl+P / Cmd+P
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key === 'p') {
        e.preventDefault();
        setCommandPaletteOpen(!useUiStore.getState().commandPaletteOpen);
      }
      if (e.key === 'Escape' && useUiStore.getState().commandPaletteOpen) {
        setCommandPaletteOpen(false);
      }
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [setCommandPaletteOpen]);

  // Debounced search
  useEffect(() => {
    if (!query.trim() || !currentProjectId) {
      setSearchResults([]);
      return;
    }
    setSearching(true);
    const timer = setTimeout(async () => {
      try {
        const results = await trpc.search.global.query({ projectId: currentProjectId, query: query.trim() });
        setSearchResults(results);
      } catch {
        setSearchResults([]);
      } finally {
        setSearching(false);
      }
      setSelectedIndex(0);
    }, 200);
    return () => clearTimeout(timer);
  }, [query, currentProjectId]);

  const commands: CommandItem[] = [
    { id: 'cmd-terminal', label: '新建终端', icon: TerminalIcon, action: () => {
      import('@renderer/stores/terminal').then((m) => m.useTerminalStore.getState().createTerminal(currentProjectId ?? undefined));
      setCommandPaletteOpen(false);
    }},
    { id: 'cmd-dashboard', label: '打开仪表盘', icon: LayoutDashboard, action: () => {
      openDestination({ type: 'dashboard' });
      setCommandPaletteOpen(false);
    }},
    { id: 'cmd-coverage', label: '覆盖率分析', icon: BarChart3, action: () => {
      openDestination({ type: 'coverage' });
      setCommandPaletteOpen(false);
    }},
    { id: 'cmd-regression', label: '回归套件管理', icon: GitBranch, action: () => {
      openDestination({ type: 'regression' });
      setCommandPaletteOpen(false);
    }},
    { id: 'cmd-to', label: 'TO 检查清单', icon: ListChecks, action: () => {
      openDestination({ type: 'to-checklist' });
      setCommandPaletteOpen(false);
    }},
    { id: 'cmd-settings', label: '打开设置', icon: Settings, action: () => {
      setSettingsOpen(true);
      setCommandPaletteOpen(false);
    }},
  ];

  const filteredCommands = query.trim()
    ? commands.filter((c) => c.label.toLowerCase().includes(query.toLowerCase()))
    : commands;

  const allItems: Array<{ key: string; label: string; detail?: string; icon: typeof Search; action: () => void }> = [
    ...filteredCommands.map((c) => ({ key: c.id, label: c.label, detail: c.detail, icon: c.icon, action: c.action })),
    ...searchResults.map((r) => ({
      key: `search-${r.type}-${r.label}`,
      label: r.label,
      detail: r.detail,
      icon: FileText,
      action: () => {
        if (r.type === 'simulation') {
          openDestination({ type: 'simulation-history' });
        } else if (r.type === 'regression') {
          openDestination({ type: 'regression' });
        }
        setCommandPaletteOpen(false);
      },
    })),
  ];

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      setSelectedIndex((i) => Math.min(i + 1, allItems.length - 1));
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      setSelectedIndex((i) => Math.max(i - 1, 0));
    } else if (e.key === 'Enter') {
      e.preventDefault();
      allItems[selectedIndex]?.action();
    }
  };

  if (!commandPaletteOpen) return null;

  return (
    <div className="fixed inset-0 z-50 flex items-start justify-center bg-black/30 pt-20" onClick={() => setCommandPaletteOpen(false)}>
      <div
        className="w-[480px] overflow-hidden rounded-lg border border-border bg-popover shadow-2xl"
        onClick={(e) => e.stopPropagation()}
      >
        {/* Search input */}
        <div className="flex items-center gap-2 border-b px-3 py-2">
          <Search className="h-4 w-4 text-muted-foreground" />
          <input
            ref={inputRef}
            type="text"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={handleKeyDown}
            placeholder="搜索或输入命令... (Ctrl+P)"
            className="flex-1 bg-transparent text-sm outline-none placeholder:text-muted-foreground"
          />
          {searching && <span className="text-[10px] text-muted-foreground">搜索中...</span>}
        </div>

        {/* Results */}
        <div className="max-h-72 overflow-y-auto p-1">
          {allItems.length === 0 ? (
            <div className="py-4 text-center text-xs text-muted-foreground">
              {query.trim() ? '无匹配结果' : '开始输入以搜索...'}
            </div>
          ) : (
            allItems.map((item, idx) => (
              <button
                key={item.key}
                onClick={item.action}
                className={cn(
                  'flex w-full items-center gap-2 rounded px-2 py-1.5 text-left text-xs transition-colors',
                  idx === selectedIndex ? 'bg-accent text-foreground' : 'text-muted-foreground hover:bg-accent/50',
                )}
              >
                <item.icon className="h-3.5 w-3.5 shrink-0 opacity-60" />
                <div className="flex-1 min-w-0">
                  <div className="truncate">{item.label}</div>
                  {item.detail && <div className="truncate text-[10px] text-muted-foreground/70">{item.detail}</div>}
                </div>
              </button>
            ))
          )}
        </div>

        {/* Footer */}
        <div className="border-t px-3 py-1.5 text-[10px] text-muted-foreground">
          ↑↓ 导航 · Enter 选择 · Esc 关闭
        </div>
      </div>
    </div>
  );
}
