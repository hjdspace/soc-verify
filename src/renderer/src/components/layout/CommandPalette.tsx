import { useEffect, useState, useRef, useMemo } from 'react';
import { AnimatePresence, motion } from 'motion/react';
import {
  Search,
  Terminal as TerminalIcon,
  LayoutDashboard,
  BarChart3,
  ListChecks,
  GitBranch,
  Settings,
  FileText,
  Play,
  Square,
  RotateCcw,
  Download,
  Layers,
  Folder,
  Sparkles,
  Workflow,
  Coins,
  type LucideIcon,
} from 'lucide-react';
import { useUiStore, type ActiveView } from '@renderer/stores/ui';
import { useWorkbenchStore } from '@renderer/stores/workbench';
import { useProjectStore } from '@renderer/stores/project';
import { useTerminalStore } from '@renderer/stores/terminal';
import { useSimulationStore } from '@renderer/stores/simulation';
import { useRegressionStore } from '@renderer/stores/regression';
import { useCoverageExportStore } from '@renderer/stores/coverage';
import { useToastStore } from '@renderer/stores/toast';
import { trpc } from '@renderer/lib/trpc';
import { cn } from '@renderer/lib/utils';
import { BorderBeam } from '@renderer/components/visual';
import { GlideMenu } from '@renderer/components/ui/GlideMenu';
import { SearchClearButton, SearchEmptyState, SearchMatch } from '@renderer/components/ui/SearchList';

/** 全局搜索结果（trpc.search.global） */
interface SearchResult {
  type: string;
  label: string;
  detail: string;
}

/** 面板条目：label 过滤 + hint（快捷键/计数）+ 执行动作 */
interface PaletteItem {
  key: string;
  label: string;
  hint?: string;
  icon: LucideIcon;
  action: () => void;
}

interface PaletteGroup {
  id: string;
  label: string;
  items: PaletteItem[];
}

/** 导航组：五视图切换（hint = NavRail Ctrl+1..4 快捷键） */
const NAV_VIEWS: ReadonlyArray<{ view: ActiveView; label: string; hint?: string; icon: LucideIcon }> = [
  { view: 'dashboard', label: '前往 总览', hint: 'Ctrl 1', icon: LayoutDashboard },
  { view: 'simulation', label: '前往 仿真', hint: 'Ctrl 2', icon: Play },
  { view: 'regression', label: '前往 回归', hint: 'Ctrl 3', icon: GitBranch },
  { view: 'coverage', label: '前往 覆盖率', hint: 'Ctrl 4', icon: BarChart3 },
  { view: 'token', label: '前往 Token', icon: Coins },
  { view: 'workspace', label: '前往 工作区', icon: Layers },
];

export function CommandPalette() {
  const commandPaletteOpen = useUiStore((s) => s.commandPaletteOpen);
  const setCommandPaletteOpen = useUiStore((s) => s.setCommandPaletteOpen);
  const setActiveView = useUiStore((s) => s.setActiveView);
  const setSettingsOpen = useUiStore((s) => s.setSettingsOpen);
  const aiPanelMode = useUiStore((s) => s.aiPanelMode);

  const openDestination = useWorkbenchStore((s) => s.open);
  const currentProjectId = useProjectStore((s) => s.currentProjectId);

  const activeRuns = useSimulationStore((s) => s.activeRuns);
  const stopAllRuns = useSimulationStore((s) => s.stopAllRuns);
  const rerunRun = useSimulationStore((s) => s.rerunRun);

  const regressionHistory = useRegressionStore((s) => s.history);
  const runRegression = useRegressionStore((s) => s.runRegression);
  const loadRegressionHistory = useRegressionStore((s) => s.loadHistory);

  const openExportDialog = useCoverageExportStore((s) => s.openExportDialog);

  const [query, setQuery] = useState('');
  const [selectedIndex, setSelectedIndex] = useState(0);
  const [searchResults, setSearchResults] = useState<SearchResult[]>([]);
  const [searching, setSearching] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

  // 打开时复位；历史未加载则拉取（启动回归动作的数据源）
  useEffect(() => {
    if (commandPaletteOpen) {
      setQuery('');
      setSelectedIndex(0);
      setSearchResults([]);
      setTimeout(() => inputRef.current?.focus(), 0);
      if (currentProjectId && useRegressionStore.getState().history.length === 0) {
        void loadRegressionHistory(currentProjectId);
      }
    }
  }, [commandPaletteOpen, currentProjectId, loadRegressionHistory]);

  // 全局快捷键：Ctrl+K / Ctrl+P 呼出，Esc 关闭
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && (e.key === 'k' || e.key === 'p')) {
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

  // Debounced 全局搜索（保留原有能力）
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

  const close = () => setCommandPaletteOpen(false);

  // ── 动作组数据 hints ──────────────────────────────────────────
  const liveCount = activeRuns.filter((r) => r.status === 'running' || r.status === 'pending').length;
  const failedRuns = activeRuns.filter(
    (r) => (r.status === 'fail' || r.status === 'error') && r.command,
  );
  const latestRegression = useMemo(
    () => [...regressionHistory].sort((a, b) => b.submittedAt - a.submittedAt)[0] ?? null,
    [regressionHistory],
  );

  // ── 动作组：启动回归（最近一次参数重提；无历史则前往回归视图） ──
  const handleRunRegression = () => {
    if (currentProjectId && latestRegression) {
      void runRegression(
        currentProjectId,
        latestRegression.filePath,
        latestRegression.subsys,
        latestRegression.options,
      );
    } else {
      setActiveView('regression');
      useToastStore.getState().info('暂无回归历史', '请在回归视图选择回归列表启动');
    }
  };

  // ── 动作组：重跑失败用例（有可重放命令的失败运行逐个重跑） ──
  const handleRerunFailed = async () => {
    if (failedRuns.length === 0) {
      useToastStore.getState().info('没有可重跑的失败用例');
      return;
    }
    for (const run of failedRuns) {
      const tabId = await rerunRun(run);
      if (tabId) {
        openDestination({
          type: 'terminal',
          terminalTabId: tabId,
          title: `sim: ${run.caseName ?? run.caseId}`,
        });
      }
    }
  };

  // ── 面板组：打开 AI 会话（drawer 模式开右抽屉；docked 模式展开固定右栏） ──
  const handleOpenAi = () => {
    if (aiPanelMode === 'drawer') {
      useUiStore.setState({ rightDrawerOpen: true });
    } else {
      useUiStore.setState({ rightPanelCollapsed: false });
      setActiveView('workspace');
    }
  };

  // ── 分组与条目（原型：导航 / 动作 / 面板 + 搜索结果） ─────────
  const groups: PaletteGroup[] = [
    {
      id: 'nav',
      label: '导航',
      items: NAV_VIEWS.map(({ view, label, hint, icon }) => ({
        key: `nav-${view}`,
        label,
        hint,
        icon,
        action: () => {
          setActiveView(view);
          close();
        },
      })),
    },
    {
      id: 'actions',
      label: '动作',
      items: [
        {
          key: 'action-run-regression',
          label: '启动回归',
          hint: latestRegression ? `重跑 ${latestRegression.subsys} 最近回归` : '前往回归视图选择',
          icon: Play,
          action: () => {
            handleRunRegression();
            close();
          },
        },
        {
          key: 'action-stop-sims',
          label: '停止全部仿真',
          hint: liveCount > 0 ? `${liveCount} 个运行中` : '无运行中',
          icon: Square,
          action: () => {
            void stopAllRuns();
            close();
          },
        },
        {
          key: 'action-rerun-fails',
          label: '重跑失败用例',
          hint: failedRuns.length > 0 ? `${failedRuns.length} 个失败` : '无失败运行',
          icon: RotateCcw,
          action: () => {
            void handleRerunFailed();
            close();
          },
        },
        {
          key: 'action-cov-report',
          label: '生成覆盖率报告',
          icon: Download,
          action: () => {
            openExportDialog();
            close();
          },
        },
      ],
    },
    {
      id: 'panels',
      label: '面板',
      items: [
        {
          key: 'panel-terminal',
          label: '新建终端',
          icon: TerminalIcon,
          action: () => {
            useTerminalStore.getState().createTerminal(currentProjectId ?? undefined);
            close();
          },
        },
        {
          key: 'panel-file-drawer',
          label: '打开文件树',
          icon: Folder,
          action: () => {
            const { filePanelMode, filePanelCollapsed } = useUiStore.getState();
            if (filePanelMode === 'docked' && filePanelCollapsed) {
              useUiStore.setState({ filePanelCollapsed: false });
            } else {
              useUiStore.setState({ leftDrawerOpen: true });
            }
            close();
          },
        },
        {
          key: 'panel-ai-drawer',
          label: '打开 AI 会话',
          icon: Sparkles,
          action: () => {
            handleOpenAi();
            close();
          },
        },
        {
          key: 'panel-to-checklist',
          label: 'TO 检查清单',
          icon: ListChecks,
          action: () => {
            openDestination({ type: 'to-checklist' });
            close();
          },
        },
        {
          key: 'panel-sysbase-env-gen',
          label: '验证环境生成器',
          icon: Workflow,
          action: () => {
            openDestination({ type: 'sysbase-env-gen' });
            close();
          },
        },
        {
          key: 'panel-settings',
          label: '打开设置',
          icon: Settings,
          action: () => {
            setSettingsOpen(true);
            close();
          },
        },
      ],
    },
  ];

  // 输入过滤（label 包含匹配，大小写不敏感；搜索结果组不做本地过滤）
  const kw = query.trim().toLowerCase();
  const filteredGroups: PaletteGroup[] = kw
    ? groups.map((g) => ({
        ...g,
        items: g.items.filter((item) => item.label.toLowerCase().includes(kw)),
      }))
    : groups;

  const searchItems: PaletteItem[] = searchResults.map((r) => ({
    key: `search-${r.type}-${r.label}`,
    label: r.label,
    hint: r.detail,
    icon: FileText,
    action: () => {
      if (r.type === 'simulation') {
        openDestination({ type: 'simulation-history' });
      } else if (r.type === 'regression') {
        openDestination({ type: 'regression' });
      }
      close();
    },
  }));

  // 搜索结果组（仅有结果时渲染）
  if (searchItems.length > 0) {
    filteredGroups.push({ id: 'search', label: '搜索结果', items: searchItems });
  }

  // 扁平化用于键盘导航
  const flatItems = filteredGroups.flatMap((g) => g.items);

  useEffect(() => {
    if (selectedIndex >= flatItems.length) setSelectedIndex(0);
  }, [flatItems.length, selectedIndex]);

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      setSelectedIndex((i) => Math.min(i + 1, flatItems.length - 1));
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      setSelectedIndex((i) => Math.max(i - 1, 0));
    } else if (e.key === 'Enter') {
      e.preventDefault();
      flatItems[selectedIndex]?.action();
    }
  };

  let flatIndex = -1;

  return (
    <AnimatePresence>
      {commandPaletteOpen && (
        <motion.div
          className="fixed inset-0 z-[80] flex items-start justify-center bg-scrim pt-[12vh] will-change-[opacity]"
          onClick={() => setCommandPaletteOpen(false)}
          data-testid="command-palette-overlay"
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={{ opacity: 0 }}
          transition={{ duration: 0.15 }}
        >
        <motion.div
          className="w-[560px] max-w-[calc(100vw-48px)] overflow-hidden rounded-xl border border-border bg-glass shadow-2xl glass will-change-[opacity,transform]"
          onClick={(e) => e.stopPropagation()}
          data-testid="command-palette"
          initial={{ opacity: 0, scale: 0.98, y: -10 }}
          animate={{ opacity: 1, scale: 1, y: 0 }}
          exit={{ opacity: 0, scale: 0.98, y: -10 }}
          transition={{ type: 'spring', stiffness: 480, damping: 34 }}
        >
        {/* 输入区 */}
        <BorderBeam size="line" theme="dark" active={commandPaletteOpen} className="block w-full">
        <div className="flex items-center gap-2.5 border-b border-border px-4 py-3">
          <Search className="size-3.5 shrink-0 text-muted-foreground/60" />
          <input
            ref={inputRef}
            type="text"
            value={query}
            onChange={(e) => {
              setQuery(e.target.value);
              setSelectedIndex(0);
            }}
            onKeyDown={handleKeyDown}
            placeholder="输入命令或搜索…"
            className="flex-1 bg-transparent text-sm text-foreground outline-none placeholder:text-muted-foreground/60"
            data-testid="command-palette-input"
          />
          {query && (
            <SearchClearButton
              testId="command-palette-clear"
              onClear={() => {
                setQuery('');
                setSelectedIndex(0);
                inputRef.current?.focus();
              }}
            />
          )}
          {searching && <span className="text-[10px] text-muted-foreground">搜索中…</span>}
          <kbd className="shrink-0 rounded border border-border px-1.5 py-px font-mono text-[10px] text-muted-foreground/70">
            Esc
          </kbd>
        </div>
        </BorderBeam>

        {/* 分组列表：行间滑动高亮由 GlideMenu 承担（220ms 平滑滑动） */}
        <div className="max-h-[380px] overflow-y-auto p-2">
          {flatItems.length === 0 ? (
            <SearchEmptyState
              testId="command-palette-empty"
              title="没有匹配的命令"
              hint="调整关键词再试一次"
            />
          ) : (
            <GlideMenu
              className="flex flex-col"
              highlightClassName="palette-row-highlight"
              activeIndex={selectedIndex}
              scrollActiveIntoView
            >
              {filteredGroups.map((group) => (
                <div key={group.id}>
                  <div className="px-2.5 pb-1 pt-2 text-[10px] font-semibold uppercase tracking-[0.06em] text-muted-foreground/60">
                    {group.label}
                  </div>
                  {group.items.map((item) => {
                    flatIndex += 1;
                    const selected = flatIndex === selectedIndex;
                    return (
                      <button
                        key={item.key}
                        onClick={item.action}
                        onMouseEnter={() => setSelectedIndex(flatIndex)}
                        data-menu-row
                        className={cn(
                          'search-row-in relative z-10 flex w-full cursor-pointer items-center gap-2.5 rounded-lg px-2.5 py-2 text-left text-[13px] transition-colors',
                          selected ? 'text-foreground' : 'text-muted-foreground',
                        )}
                        data-testid={`palette-item-${item.key}`}
                      >
                        <item.icon
                          className={cn('size-3.5 shrink-0', selected ? 'text-primary' : 'opacity-60')}
                          strokeWidth={1.8}
                        />
                        <span className="flex-1 truncate">
                          <SearchMatch label={item.label} query={query} />
                        </span>
                        {item.hint && (
                          <span className="shrink-0 font-mono text-[10px] text-muted-foreground/60">
                            {item.hint}
                          </span>
                        )}
                      </button>
                    );
                  })}
                </div>
              ))}
            </GlideMenu>
          )}
        </div>

        {/* 底部键位提示 */}
        <div className="border-t border-border px-4 py-1.5 text-[10px] text-muted-foreground">
          ↑↓ 导航 · Enter 选择 · Esc 关闭
        </div>
        </motion.div>
        </motion.div>
      )}
    </AnimatePresence>
  );
}
