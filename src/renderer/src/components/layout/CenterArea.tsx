import { useEffect, useState, useCallback, useMemo } from 'react';
import { FileText, Terminal as TerminalIcon, Sparkles, X, AlertCircle, History, CircleDot, GitCompare, GitGraph, BarChart3, GitBranch, LayoutDashboard, ListChecks, GitCommitHorizontal, MoreHorizontal, Plus, ArrowDownToLine, Puzzle, FileType, Database as DatabaseIcon, Workflow, XCircle, BookOpen, RotateCw } from 'lucide-react';
import { useWorkbenchStore } from '@renderer/stores/workbench';
import { useUiStore } from '@renderer/stores/ui';
import { useProjectStore } from '@renderer/stores/project';
import { useSimulationStore } from '@renderer/stores/simulation';
import { useTerminalStore } from '@renderer/stores/terminal';
import { TerminalPanel } from '@renderer/components/terminal/TerminalPanel';
import { CoveragePanel } from '@renderer/components/coverage/CoveragePanel';
import { RegressionPanel } from '@renderer/components/regression/RegressionPanel';
import { DashboardPanel } from '@renderer/components/dashboard/DashboardPanel';
import { TOChecklistPanel } from '@renderer/components/to/TOChecklistPanel';
import { SourceControlPanel } from '@renderer/components/scm/SourceControlPanel';
import { FileEditor } from '@renderer/components/editor/FileEditor';
import { CsvEditor } from '@renderer/components/editor/CsvEditor';
import { openReviewAwareFile, useDiffReviewStore, isSameFilePath } from '@renderer/stores/diff-review';
import { RunListPanel } from '@renderer/components/simulation/RunListPanel';
import { CompileErrorView } from '@renderer/components/simulation/views/CompileErrorView';
import { SimulationHistoryView } from '@renderer/components/simulation/views/SimulationHistoryView';
import { RunDetailView } from '@renderer/components/simulation/views/RunDetailView';
import { ComparisonView } from '@renderer/components/simulation/views/ComparisonView';
import { STATUS_BADGE_STYLES } from '@renderer/components/simulation/views/StatusBadge';
import { TERMINAL_TAB_MIME } from '@renderer/components/layout/BottomPanel';
import { trpc } from '@renderer/lib/trpc';
import { useToastStore } from '@renderer/stores/toast';
import { cn } from '@renderer/lib/utils';
import { PluginView } from '@renderer/components/plugins/PluginView';
import { TVDashboard } from '@renderer/components/timing-violation/TVDashboard';
import { OfficeDocumentView } from '@renderer/components/office/OfficeDocumentView';
import { DatabaseViewer } from '@renderer/components/db/DatabaseViewer';
import { DrawioPreview } from '@renderer/components/drawio/DrawioPreview';
import { Timer } from 'lucide-react';
import { BrowserView } from '@renderer/components/browser/BrowserView';
import { SysbaseEnvGen } from '@renderer/tools/sysbase-env-gen/SysbaseEnvGen';
import { KbView } from '@renderer/components/kb/KbView';

export function CenterArea() {
  const tabs = useWorkbenchStore((s) => s.tabs);
  const activeTabId = useWorkbenchStore((s) => s.activeTabId);
  const openDestination = useWorkbenchStore((s) => s.open);
  const activateTab = useWorkbenchStore((s) => s.activate);
  const closeWorkbenchTab = useWorkbenchStore((s) => s.close);
  const closeAllWorkbenchTabs = useWorkbenchStore((s) => s.closeAll);
  const activeTab = tabs.find((tab) => tab.id === activeTabId) ?? null;
  const destination = activeTab?.destination ?? null;
  const activeSurface = destination?.type === 'browser' ? destination : null;
  const currentProjectId = useProjectStore((s) => s.currentProjectId);
  const plugins = useProjectStore((s) => s.plugins);
  const pluginViews = useMemo(
    () => plugins.flatMap((plugin) => (plugin.contributes?.views ?? []).map((view) => ({ plugin, view }))),
    [plugins],
  );
  const activeRuns = useSimulationStore((s) => s.activeRuns);
  const abortSimulation = useSimulationStore((s) => s.abortSimulation);
  const rerunRun = useSimulationStore((s) => s.rerunRun);

  const terminalTabs = useTerminalStore((s) => s.tabs);
  const createTerminal = useTerminalStore((s) => s.createTerminal);
  const closeTerminal = useTerminalStore((s) => s.closeTerminal);
  const setActiveTerminalTab = useTerminalStore((s) => s.setActiveTab);

  const [moreMenuOpen, setMoreMenuOpen] = useState(false);
  const [plusMenuOpen, setPlusMenuOpen] = useState(false);
  const [dropHover, setDropHover] = useState(false);
  const setCenterMenuOpen = useUiStore((s) => s.setCenterMenuOpen);
  const runningCount = activeRuns.filter((r) => r.status === 'running' || r.status === 'pending').length;

  const moveTerminalLocation = useTerminalStore((s) => s.moveTerminalLocation);

  // Diff review queue — reactive subscription for the floating 'Review next file' button
  const diffReviewQueue = useDiffReviewStore((s) => s.queue);
  // Only count unreviewed files for the pending review count
  const pendingReviewCount = diffReviewQueue.filter((e) => !e.reviewed).length;
  const nextReviewFile = diffReviewQueue.find((e) => !e.reviewed) ?? null;
  // 当前活动 tab 是否就是下一个待审阅文件（是则隐藏浮动按钮，避免遮挡）
  const activeFilePath = destination?.type === 'file' ? destination.path : null;
  const isViewingNextReview = activeFilePath != null
    && nextReviewFile != null
    && isSameFilePath(activeFilePath, nextReviewFile.filePath);

  // Sync dropdown open state to UI store so AppShell can hide native views during overlays.
  useEffect(() => {
    setCenterMenuOpen(plusMenuOpen || moreMenuOpen);
  }, [plusMenuOpen, moreMenuOpen, setCenterMenuOpen]);

  const closeTab = (tabId: string) => {
    const tab = tabs.find((candidate) => candidate.id === tabId);
    if (tab?.destination.type === 'terminal') {
      void closeTerminal(tab.destination.terminalTabId);
      return;
    }
    closeWorkbenchTab(tabId);
  };

  // Close all open tabs, properly cleaning up terminal tabs via the terminal store.
  const handleCloseAll = useCallback(() => {
    for (const tab of tabs) {
      if (tab.destination.type === 'terminal') {
        void closeTerminal(tab.destination.terminalTabId);
      }
    }
    closeAllWorkbenchTabs();
  }, [tabs, closeTerminal, closeAllWorkbenchTabs]);

  // ── 拖拽：将中栏终端拖拽到底部面板 ────────────────
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

  // ── “+”下拉菜单动作 ────────────────────────────────────
  const handleNewTerminalCenter = useCallback(() => {
    createTerminal(currentProjectId ?? undefined, undefined, 'center');
    setPlusMenuOpen(false);
  }, [createTerminal, currentProjectId]);

  const handleNewTerminalBottom = useCallback(() => {
    createTerminal(currentProjectId ?? undefined, undefined, 'bottom');
    setPlusMenuOpen(false);
  }, [createTerminal, currentProjectId]);

  const handleOpenFile = useCallback(async () => {
    setPlusMenuOpen(false);
    if (!currentProjectId) {
      useToastStore.getState().warning('请先打开项目', '需要先打开项目才能选择文件。');
      return;
    }
    try {
      const result = await trpc.project.pickFiles.mutate({ projectId: currentProjectId });
      if (!result.canceled) {
        for (const file of result.files) {
          // 根据扩展名分发：Office 文档走 office-document 预览/编辑，其他走普通 file
          openReviewAwareFile(file.path, file.name);
        }
      }
    } catch {
      // best-effort
    }
  }, [currentProjectId]);

  const openSimErrors = (runId: string) => {
    openDestination({ type: 'simulation-errors', runId });
  };

  const openSimHistory = () => {
    openDestination({ type: 'simulation-history' });
  };

  const simErrorsRunId = destination?.type === 'simulation-errors' ? destination.runId : null;
  const simErrorsRun = activeRuns.find((r) => r.runId === simErrorsRunId);
  const simErrors = simErrorsRun?.compileErrors ?? [];

  // 更多菜单项
  const moreItems = [
    { type: 'regression' as const, label: '回归套件', icon: GitBranch },
    { type: 'to-checklist' as const, label: 'TO 检查', icon: ListChecks },
    { type: 'simulation-history' as const, label: '仿真历史', icon: History },
    { type: 'timing-violation' as const, label: '时序违例', icon: Timer },
  ];
  const centerPluginViews = pluginViews.filter(({ view }) => view.location === 'center');

  return (
    <main className="flex flex-1 flex-col overflow-hidden">
      {/* ── Tab bar ────────────────────────────────── */}
      <div className="flex h-8 shrink-0 items-center border-b bg-secondary/30">
        {tabs.length === 0 ? (
          <div className="flex items-center gap-2 px-3 text-[11px] text-muted-foreground">
            <span>多功能工作区 — 点击左栏文件或使用下方按钮</span>
          </div>
        ) : (
          <div className="flex h-full flex-1 overflow-x-auto">
            {tabs.map((tab) => (
              <div
                key={tab.id}
                draggable={tab.destination.type === 'terminal'}
                onDragStart={(e) => {
                  if (tab.destination.type === 'terminal') {
                    e.dataTransfer.setData(TERMINAL_TAB_MIME, tab.destination.terminalTabId);
                    e.dataTransfer.effectAllowed = 'move';
                  }
                }}
                className={cn(
                  'flex h-full shrink-0 items-center gap-1.5 border-r px-3 text-xs transition-colors',
                  activeTabId === tab.id
                    ? 'bg-background text-foreground'
                    : 'text-muted-foreground hover:bg-background/50',
                  tab.destination.type === 'terminal' && 'cursor-grab active:cursor-grabbing',
                )}
                onClick={() => {
                  if (tab.destination.type === 'terminal') {
                    setActiveTerminalTab(tab.destination.terminalTabId);
                  } else {
                    activateTab(tab.id);
                  }
                }}
              >
                {tab.destination.type === 'file' && <FileText className="h-3 w-3 opacity-50" />}
                {tab.destination.type === 'browser' && <FileType className="h-3 w-3 opacity-50" />}
                {tab.destination.type === 'terminal' && <TerminalIcon className="h-3 w-3 opacity-50" />}
                {tab.destination.type === 'ai-artifacts' && <Sparkles className="h-3 w-3 opacity-50" />}
                {tab.destination.type === 'simulation-errors' && <AlertCircle className="h-3 w-3 text-status-fail-foreground" />}
                {tab.destination.type === 'simulation-history' && <History className="h-3 w-3 opacity-50" />}
                {tab.destination.type === 'simulation-detail' && <FileText className="h-3 w-3 opacity-50" />}
                {tab.destination.type === 'simulation-comparison' && <GitCompare className="h-3 w-3 opacity-50" />}
                {tab.destination.type === 'running-simulations' && <CircleDot className="h-3 w-3 opacity-50" />}
                {tab.destination.type === 'coverage' && <BarChart3 className="h-3 w-3 opacity-50" />}
                {tab.destination.type === 'coverage-detail' && <BarChart3 className="h-3 w-3 opacity-50" />}
                {tab.destination.type === 'regression' && <GitBranch className="h-3 w-3 opacity-50" />}
                {tab.destination.type === 'regression-detail' && <GitBranch className="h-3 w-3 opacity-50" />}
                {tab.destination.type === 'dashboard' && <LayoutDashboard className="h-3 w-3 opacity-50" />}
                {tab.destination.type === 'to-checklist' && <ListChecks className="h-3 w-3 opacity-50" />}
                {tab.destination.type === 'source-control' && <GitCommitHorizontal className="h-3 w-3 opacity-50" />}
                {tab.destination.type === 'timing-violation' && <Timer className="h-3 w-3 opacity-50" />}
                {tab.destination.type === 'plugin-view' && <Puzzle className="h-3 w-3 opacity-50" />}
                {tab.destination.type === 'office-document' && <FileType className="h-3 w-3 opacity-50" />}
                {tab.destination.type === 'database' && <DatabaseIcon className="h-3 w-3 opacity-50" />}
                {tab.destination.type === 'drawio-diagram' && <GitGraph className="h-3 w-3 opacity-50" />}
                {tab.destination.type === 'kb' && <BookOpen className="h-3 w-3 opacity-50" />}
                {tab.destination.type === 'sysbase-env-gen' && <Workflow className="h-3 w-3 opacity-50" />}
                <span className="max-w-32 truncate">{tab.title}</span>
                {tab.closable && (
                  <button
                    onClick={(e) => {
                      e.stopPropagation();
                      closeTab(tab.id);
                    }}
                    className="ml-1 rounded p-0.5 opacity-50 transition-opacity hover:bg-foreground/10 hover:opacity-100"
                  >
                    <X className="h-3 w-3" />
                  </button>
                )}
              </div>
            ))}
          </div>
        )}

        {/* ── 关闭全部标签 ─────────────────────────────── */}
        {tabs.length > 0 && (
          <button
            onClick={handleCloseAll}
            title="关闭全部标签页"
            className="flex items-center rounded px-1.5 py-1 text-[11px] text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
          >
            <XCircle className="h-3.5 w-3.5" />
          </button>
        )}

        {/* ── 主操作（带文字）+ 溢出菜单 ──────────────────── */}
        <div className="ml-auto flex items-center gap-1 px-2">
          {/* ＋新建下拉菜单 */}
          <div className="relative">
            <button
              onClick={() => setPlusMenuOpen(!plusMenuOpen)}
              title="新建"
              className={cn(
                'flex items-center rounded px-1.5 py-1 text-[11px] transition-colors hover:bg-accent hover:text-foreground',
                plusMenuOpen ? 'bg-accent text-foreground' : 'text-muted-foreground',
              )}
            >
              <Plus className="h-3.5 w-3.5" />
            </button>
            {plusMenuOpen && (
              <>
                <div className="fixed inset-0 z-40" onClick={() => setPlusMenuOpen(false)} />
                <div className="absolute right-0 top-7 z-50 min-w-44 overflow-hidden rounded-md border border-border bg-popover shadow-xl">
                  <button
                    onClick={handleNewTerminalCenter}
                    className="flex w-full items-center gap-2 px-3 py-1.5 text-left text-xs transition-colors hover:bg-accent"
                  >
                    <TerminalIcon className="h-3.5 w-3.5 opacity-70" />
                    <span>新建终端（中栏）</span>
                  </button>
                  <button
                    onClick={handleNewTerminalBottom}
                    className="flex w-full items-center gap-2 px-3 py-1.5 text-left text-xs transition-colors hover:bg-accent"
                  >
                    <ArrowDownToLine className="h-3.5 w-3.5 opacity-70" />
                    <span>新建终端（底部）</span>
                  </button>
                  <div className="border-t border-border/50" />
                  <button
                    onClick={handleOpenFile}
                    className="flex w-full items-center gap-2 px-3 py-1.5 text-left text-xs transition-colors hover:bg-accent"
                  >
                    <FileText className="h-3.5 w-3.5 opacity-70" />
                    <span>打开文件...</span>
                  </button>
                  <button
                    onClick={() => {
                      openDestination({ type: 'browser', surfaceId: `browser-${crypto.randomUUID()}`, url: '', title: '新标签页' });
                      setPlusMenuOpen(false);
                    }}
                    className="flex w-full items-center gap-2 px-3 py-1.5 text-left text-xs transition-colors hover:bg-accent"
                  >
                    <FileType className="h-3.5 w-3.5 opacity-70" />
                    <span>新建网页</span>
                  </button>
                  <button
                    onClick={() => {
                      openDestination({ type: 'ai-artifacts' });
                      setPlusMenuOpen(false);
                    }}
                    className="flex w-full items-center gap-2 px-3 py-1.5 text-left text-xs transition-colors hover:bg-accent"
                  >
                    <Sparkles className="h-3.5 w-3.5 opacity-70" />
                    <span>AI 产物</span>
                  </button>
                </div>
              </>
            )}
          </div>

          {/* 环境生成器 */}
          <TabActionButton
            onClick={() => openDestination({ type: 'sysbase-env-gen' })}
            icon={<Workflow className="h-3.5 w-3.5" />}
            label="环境生成"
          />
          {/* 知识库 */}
          <TabActionButton
            onClick={() => openDestination({ type: 'kb' })}
            icon={<BookOpen className="h-3.5 w-3.5" />}
            label="知识库"
          />
          {/* 仪表盘 */}
          <TabActionButton
            onClick={() => openDestination({ type: 'dashboard' })}
            icon={<LayoutDashboard className="h-3.5 w-3.5" />}
            label="仪表盘"
          />
          {/* 覆盖率 */}
          <TabActionButton
            onClick={() => openDestination({ type: 'coverage' })}
            icon={<BarChart3 className="h-3.5 w-3.5" />}
            label="覆盖率"
          />
          {/* 运行中（带徽章） */}
          <TabActionButton
            onClick={() => openDestination({ type: 'running-simulations' })}
            icon={<CircleDot className="h-3.5 w-3.5" />}
            label="运行中"
            badge={runningCount > 0 ? runningCount : undefined}
          />
          {/* 更多：溢出菜单 */}
          <div className="relative">
            <button
              onClick={() => setMoreMenuOpen(!moreMenuOpen)}
              title="更多"
              className={cn(
                'flex items-center gap-1 rounded px-2 py-1 text-[11px] transition-colors hover:bg-accent hover:text-foreground',
                moreMenuOpen ? 'bg-accent text-foreground' : 'text-muted-foreground',
              )}
            >
              <MoreHorizontal className="h-3.5 w-3.5" />
              <span>更多</span>
            </button>
            {moreMenuOpen && (
              <>
                <div className="fixed inset-0 z-40" onClick={() => setMoreMenuOpen(false)} />
                <div className="absolute right-0 top-7 z-50 min-w-44 overflow-hidden rounded-md border border-border bg-popover shadow-xl">
                  {moreItems.map((item) => {
                    const Icon = item.icon;
                    return (
                      <button
                        key={item.type}
                        onClick={() => {
                          if (item.type === 'simulation-history') {
                            openSimHistory();
                          } else {
                            openDestination({ type: item.type });
                          }
                          setMoreMenuOpen(false);
                        }}
                        className="flex w-full items-center gap-2 px-3 py-1.5 text-left text-xs transition-colors hover:bg-accent"
                      >
                        <Icon className="h-3.5 w-3.5 opacity-70" />
                        <span>{item.label}</span>
                      </button>
                    );
                  })}
                  {centerPluginViews.length > 0 && <div className="border-t border-border/50" />}
                  {centerPluginViews.map(({ plugin, view }) => (
                    <button
                      key={`${plugin.id}:${view.id}`}
                      onClick={() => {
                        openDestination({ type: 'plugin-view', pluginId: plugin.id, viewId: view.id, title: view.name });
                        setMoreMenuOpen(false);
                      }}
                      className="flex w-full items-center gap-2 px-3 py-1.5 text-left text-xs transition-colors hover:bg-accent"
                    >
                      <Puzzle className="h-3.5 w-3.5 opacity-70" />
                      <span className="truncate">{view.name}</span>
                    </button>
                  ))}
                </div>
              </>
            )}
          </div>
        </div>
      </div>

      {/* ── Content area ─────────────────────────────── */}
      <div
        className="relative flex flex-1 overflow-hidden"
        onDragOver={handleDragOver}
        onDragLeave={handleDragLeave}
        onDrop={handleDrop}
      >
        {/* 拖拽到底部的提示条 */}
        {dropHover && (
          <div className="pointer-events-none absolute inset-x-0 bottom-0 z-30 h-12 border-t-2 border-dashed border-primary bg-primary/10 flex items-center justify-center text-xs text-primary">
            <ArrowDownToLine className="mr-1 h-3 w-3" />
            释放在此处将终端移动到底部面板
          </div>
        )}
        {activeSurface ? (
          <BrowserView
            surfaceId={activeSurface.surfaceId}
            url={activeSurface.url}
          />
        ) : destination?.type === 'file' && currentProjectId ? (
          destination.name.toLowerCase().endsWith('.csv') ? (
            <CsvEditor
              key={destination.path}
              projectId={currentProjectId}
              filePath={destination.path}
              fileName={destination.name}
            />
          ) : (
            <FileEditor
              key={destination.path}
              projectId={currentProjectId}
              filePath={destination.path}
              fileName={destination.name}
            />
          )
        ) : destination?.type === 'terminal' ? (
          (() => {
            const termTab = terminalTabs.find((t) => t.id === destination.terminalTabId);
            if (!termTab || !termTab.terminalId) {
              return (
                <div className="flex flex-1 items-center justify-center text-xs text-muted-foreground">
                  正在创建终端...
                </div>
              );
            }
            return <TerminalPanel key={termTab.terminalId} terminalId={termTab.terminalId} tabTitle={termTab.title} />;
          })()
        ) : destination?.type === 'simulation-errors' ? (
          <CompileErrorView errors={simErrors} runId={simErrorsRunId} />
        ) : destination?.type === 'simulation-history' ? (
          <SimulationHistoryView />
        ) : destination?.type === 'simulation-detail' ? (
          <RunDetailView />
        ) : destination?.type === 'simulation-comparison' ? (
          <ComparisonView />
        ) : destination?.type === 'running-simulations' ? (
          <RunListPanel projectId={currentProjectId ?? undefined} />
        ) : destination?.type === 'coverage' ? (
          <CoveragePanel />
        ) : destination?.type === 'coverage-detail' ? (
          <CoveragePanel />
        ) : destination?.type === 'regression' ? (
          <RegressionPanel />
        ) : destination?.type === 'regression-detail' ? (
          <RegressionPanel />
        ) : destination?.type === 'dashboard' ? (
          <DashboardPanel />
        ) : destination?.type === 'dashboard-tab' ? (
          <DashboardPanel key={destination.tab} initialTab={destination.tab} />
        ) : destination?.type === 'sysbase-env-gen' ? (
          <SysbaseEnvGen />
        ) : destination?.type === 'to-checklist' ? (
          <TOChecklistPanel />
        ) : destination?.type === 'source-control' ? (
          <SourceControlPanel />
        ) : destination?.type === 'timing-violation' ? (
          <TVDashboard />
        ) : destination?.type === 'plugin-view' ? (
          (() => {
            const entry = pluginViews.find(({ plugin, view }) => (
              plugin.id === destination.pluginId && view.id === destination.viewId
            ));
            return entry && currentProjectId ? (
              <PluginView projectId={currentProjectId} pluginId={entry.plugin.id} view={entry.view} />
            ) : (
              <div className="flex flex-1 items-center justify-center text-xs text-muted-foreground">
                插件视图不可用
              </div>
            );
          })()
        ) : destination?.type === 'office-document' ? (
          <OfficeDocumentView
            key={destination.filePath}
            filePath={destination.filePath}
            mode={destination.mode}
            previewMode={destination.previewMode}
          />
        ) : destination?.type === 'database' ? (
          <DatabaseViewer key={destination.filePath} filePath={destination.filePath} />
        ) : destination?.type === 'drawio-diagram' ? (
          <DrawioPreview key={destination.filePath} filePath={destination.filePath} />
        ) : destination?.type === 'kb' ? (
          <KbView />
        ) : (
          <div className="flex flex-1 flex-col items-center justify-center gap-3 overflow-hidden text-sm text-muted-foreground">
            {/* Active simulations — capped height with internal scroll */}
            {activeRuns.length > 0 && (
              <div className="w-full max-w-md">
                <div className="mb-1 text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">
                  正在运行的仿真
                </div>
                <div className="max-h-[240px] overflow-y-auto" data-testid="workspace-active-runs-list">
                  {activeRuns.map((run) => (
                    <div
                      key={run.runId}
                      className="flex items-center gap-2 rounded-md border border-border/50 bg-secondary/30 px-3 py-1.5"
                    >
                      <span className={cn(
                        'size-[7px] shrink-0 rounded-full',
                        STATUS_BADGE_STYLES[run.status]?.dot ?? 'bg-muted-foreground',
                      )} />
                      <span className="flex-1 truncate text-xs">{run.caseName ?? run.caseId}</span>
                      <span className="text-[10px] text-muted-foreground">{run.status}</span>
                      {run.status === 'running' || run.status === 'pending' ? (
                        <button
                          onClick={() => currentProjectId && abortSimulation(currentProjectId, run.runId)}
                          className="rounded bg-status-fail/10 px-1.5 py-0.5 text-[10px] text-status-fail-foreground hover:bg-status-fail/20"
                        >
                          中止
                        </button>
                      ) : (
                        <div className="flex items-center gap-1">
                          <button
                            onClick={() => void rerunRun(run)}
                            className="flex items-center rounded bg-primary/10 px-1.5 py-0.5 text-[10px] text-primary transition-colors hover:bg-primary/20"
                            title="重新仿真"
                            data-testid={`workspace-rerun-${run.runId}`}
                          >
                            <RotateCw className="size-2.5" />
                          </button>
                          {run.compileErrors && run.compileErrors.length > 0 && (
                            <button
                              onClick={() => openSimErrors(run.runId)}
                              className="rounded bg-status-fail/10 px-1.5 py-0.5 text-[10px] text-status-fail-foreground hover:bg-status-fail/20"
                            >
                              查看错误
                            </button>
                          )}
                        </div>
                      )}
                    </div>
                  ))}
                </div>
              </div>
            )}

            <div className="flex shrink-0 gap-2">
              <button
                onClick={() => createTerminal(currentProjectId ?? undefined)}
                className="flex items-center gap-1.5 rounded-md border border-border px-3 py-1.5 text-xs transition-colors hover:bg-accent"
              >
                <TerminalIcon className="h-3.5 w-3.5" />
                终端
              </button>
              <button
                onClick={() => openDestination({ type: 'ai-artifacts' })}
                className="flex items-center gap-1.5 rounded-md border border-border px-3 py-1.5 text-xs transition-colors hover:bg-accent"
              >
                <Sparkles className="h-3.5 w-3.5" />
                AI 产物
              </button>
            </div>
            <p className="shrink-0 text-[11px]">
              {activeTab ? `活动页签：${activeTab.title}` : '从左栏选择文件或在右栏与 AI 对话'}
            </p>
          </div>
        )}
        
        {/* ── Floating 'Review next file' button ─────────── */}
        {pendingReviewCount > 0 && !isViewingNextReview && nextReviewFile && (
          <button
            onClick={() => useDiffReviewStore.getState().openFile(nextReviewFile.filePath)}
            className="absolute bottom-3 left-1/2 z-30 flex -translate-x-1/2 items-center gap-2 rounded-lg border border-primary/30 bg-primary/10 px-4 py-2 text-xs text-primary shadow-lg backdrop-blur-sm transition-all hover:bg-primary/20 hover:shadow-xl"
            title={`审阅文件改动: ${nextReviewFile.filePath}`}
          >
            <GitCompare className="h-3.5 w-3.5" />
            <span>Review next file</span>
            <span className="max-w-[200px] truncate font-mono text-[10px] text-muted-foreground">
              {nextReviewFile.fileName}
            </span>
            {pendingReviewCount > 1 && (
              <span className="ml-1 inline-flex h-4 min-w-4 items-center justify-center rounded-full bg-primary/20 px-1 text-[10px] font-bold">
                +{pendingReviewCount - 1}
              </span>
            )}
          </button>
        )}
      </div>
    </main>
  );
}

// ── Tab bar 主操作按钮（icon + 文字） ─────────────────────────────
function TabActionButton({
  onClick,
  icon,
  label,
  badge,
}: {
  onClick: () => void;
  icon: React.ReactNode;
  label: string;
  badge?: number;
}) {
  return (
    <button
      onClick={onClick}
      className="flex items-center gap-1 rounded px-2 py-1 text-[11px] text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
    >
      {icon}
      <span>{label}</span>
      {badge !== undefined && (
        <span className="ml-0.5 inline-flex h-3.5 min-w-3.5 items-center justify-center rounded-full bg-status-running px-1 text-[9px] font-bold text-background">
          {badge}
        </span>
      )}
    </button>
  );
}
