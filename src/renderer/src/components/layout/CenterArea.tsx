import { useEffect, useState } from 'react';
import { FileText, Terminal as TerminalIcon, Sparkles, X, AlertCircle, History, CircleDot, ChevronUp, ChevronDown, GitCompare, BarChart3, GitBranch, LayoutDashboard, ListChecks } from 'lucide-react';
import { useUiStore } from '@renderer/stores/ui';
import { useProjectStore } from '@renderer/stores/project';
import { useSimulationStore } from '@renderer/stores/simulation';
import { useTerminalStore } from '@renderer/stores/terminal';
import { TerminalView } from '@renderer/components/terminal/TerminalView';
import { CoveragePanel } from '@renderer/components/coverage/CoveragePanel';
import { RegressionPanel } from '@renderer/components/regression/RegressionPanel';
import { DashboardPanel } from '@renderer/components/dashboard/DashboardPanel';
import { TOChecklistPanel } from '@renderer/components/to/TOChecklistPanel';
import { trpc } from '@renderer/lib/trpc';
import { cn } from '@renderer/lib/utils';
import type { SimulationHistoryEntry, CompileError } from '@shared/types';

type CenterTab = {
  id: string;
  type: 'file' | 'terminal' | 'ai-artifacts' | 'sim-errors' | 'sim-history' | 'sim-detail' | 'sim-compare' | 'coverage' | 'regression' | 'dashboard' | 'to-checklist';
  title: string;
  closable: boolean;
};

export function CenterArea() {
  const centerView = useUiStore((s) => s.centerView);
  const selectedFile = useUiStore((s) => s.selectedFile);
  const setCenterView = useUiStore((s) => s.setCenterView);
  const activeCenterTab = useUiStore((s) => s.activeCenterTab);
  const setActiveCenterTab = useUiStore((s) => s.setActiveCenterTab);

  const [tabs, setTabs] = useState<CenterTab[]>([]);
  const [fileContent, setFileContent] = useState<string>('');
  const [loadingContent, setLoadingContent] = useState(false);

  const currentProjectId = useProjectStore((s) => s.currentProjectId);
  const activeRuns = useSimulationStore((s) => s.activeRuns);
  const history = useSimulationStore((s) => s.history);
  const loadHistory = useSimulationStore((s) => s.loadHistory);
  const abortSimulation = useSimulationStore((s) => s.abortSimulation);
  const detailRun = useSimulationStore((s) => s.detailRun);
  const loadingDetail = useSimulationStore((s) => s.loadingDetail);
  const loadRunDetail = useSimulationStore((s) => s.loadRunDetail);
  const compareResult = useSimulationStore((s) => s.compareResult);
  const compareRuns = useSimulationStore((s) => s.compareRuns);

  const terminalTabs = useTerminalStore((s) => s.tabs);
  const activeTerminalTabId = useTerminalStore((s) => s.activeTabId);
  const createTerminal = useTerminalStore((s) => s.createTerminal);
  const closeTerminal = useTerminalStore((s) => s.closeTerminal);
  const setActiveTerminalTab = useTerminalStore((s) => s.setActiveTab);

  // Sync tabs with active center tab
  useEffect(() => {
    if (!activeCenterTab) return;

    if (activeCenterTab.startsWith('file:')) {
      const name = activeCenterTab.slice(5);
      if (!tabs.find((t) => t.id === activeCenterTab)) {
        setTabs((prev) => [...prev, { id: activeCenterTab, type: 'file', title: name, closable: true }]);
      }
      setCenterView('file');
    } else if (activeCenterTab.startsWith('sim-errors:')) {
      const runId = activeCenterTab.slice('sim-errors:'.length);
      if (!tabs.find((t) => t.id === activeCenterTab)) {
        setTabs((prev) => [...prev, { id: activeCenterTab, type: 'sim-errors', title: `编译错误 ${runId.slice(-6)}`, closable: true }]);
      }
      setCenterView('sim-errors');
    } else if (activeCenterTab === 'sim-history') {
      if (!tabs.find((t) => t.id === activeCenterTab)) {
        setTabs((prev) => [...prev, { id: activeCenterTab, type: 'sim-history', title: '仿真历史', closable: true }]);
      }
      setCenterView('sim-history');
    } else if (activeCenterTab.startsWith('sim-detail:')) {
      const runId = activeCenterTab.slice('sim-detail:'.length);
      if (!tabs.find((t) => t.id === activeCenterTab)) {
        setTabs((prev) => [...prev, { id: activeCenterTab, type: 'sim-detail', title: `运行详情 ${runId.slice(-6)}`, closable: true }]);
      }
      setCenterView('sim-detail');
      if (currentProjectId) loadRunDetail(currentProjectId, runId);
    } else if (activeCenterTab === 'sim-compare') {
      if (!tabs.find((t) => t.id === activeCenterTab)) {
        setTabs((prev) => [...prev, { id: activeCenterTab, type: 'sim-compare', title: '运行对比', closable: true }]);
      }
      setCenterView('sim-compare');
    } else if (activeCenterTab === 'coverage') {
      if (!tabs.find((t) => t.id === activeCenterTab)) {
        setTabs((prev) => [...prev, { id: activeCenterTab, type: 'coverage', title: '覆盖率分析', closable: true }]);
      }
      setCenterView('coverage');
    } else if (activeCenterTab === 'regression') {
      if (!tabs.find((t) => t.id === activeCenterTab)) {
        setTabs((prev) => [...prev, { id: activeCenterTab, type: 'regression', title: '回归套件', closable: true }]);
      }
      setCenterView('regression');
    } else if (activeCenterTab === 'dashboard') {
      if (!tabs.find((t) => t.id === activeCenterTab)) {
        setTabs((prev) => [...prev, { id: activeCenterTab, type: 'dashboard', title: '仪表盘', closable: true }]);
      }
      setCenterView('dashboard');
    } else if (activeCenterTab === 'to-checklist') {
      if (!tabs.find((t) => t.id === activeCenterTab)) {
        setTabs((prev) => [...prev, { id: activeCenterTab, type: 'to-checklist', title: 'TO 检查清单', closable: true }]);
      }
      setCenterView('to-checklist');
    }
  }, [activeCenterTab]); // eslint-disable-line react-hooks/exhaustive-deps

  // Sync terminal tabs with center tabs
  useEffect(() => {
    setTabs((prev) => {
      // Remove old terminal tabs that no longer exist
      const filtered = prev.filter((t) => t.type !== 'terminal' || terminalTabs.find((tt) => `term:${tt.id}` === t.id));
      // Add new terminal tabs
      for (const tt of terminalTabs) {
        const tabId = `term:${tt.id}`;
        if (!filtered.find((t) => t.id === tabId)) {
          filtered.push({ id: tabId, type: 'terminal', title: tt.title, closable: true });
        }
      }
      // Update titles
      return filtered.map((t) => {
        if (t.type === 'terminal') {
          const tt = terminalTabs.find((tt) => `term:${tt.id}` === t.id);
          if (tt) return { ...t, title: tt.title };
        }
        return t;
      });
    });
  }, [terminalTabs]);

  // Sync active terminal tab
  useEffect(() => {
    if (activeTerminalTabId) {
      setActiveCenterTab(`term:${activeTerminalTabId}`);
      setCenterView('terminal');
    }
  }, [activeTerminalTabId]); // eslint-disable-line react-hooks/exhaustive-deps

  // Load file content when selectedFile changes
  useEffect(() => {
    if (!selectedFile || !currentProjectId) return;
    let cancelled = false;
    setLoadingContent(true);
    trpc.project.readFile
      .query({ projectId: currentProjectId, filePath: selectedFile.path })
      .then((content) => {
        if (!cancelled) setFileContent(content);
      })
      .catch((err) => {
        if (!cancelled) setFileContent(`Error loading file: ${err instanceof Error ? err.message : String(err)}`);
      })
      .finally(() => {
        if (!cancelled) setLoadingContent(false);
      });
    return () => {
      cancelled = true;
    };
  }, [selectedFile, currentProjectId]);

  // Load history when project changes
  useEffect(() => {
    if (currentProjectId) {
      loadHistory(currentProjectId);
    }
  }, [currentProjectId, loadHistory]);

  const closeTab = (tabId: string) => {
    if (tabId.startsWith('term:')) {
      const termTabId = tabId.slice(5);
      void closeTerminal(termTabId);
    }
    setTabs((prev) => {
      const filtered = prev.filter((t) => t.id !== tabId);
      if (activeCenterTab === tabId) {
        const next = filtered[filtered.length - 1];
        setActiveCenterTab(next?.id ?? null);
        setCenterView(next ? next.type : 'empty');
      }
      return filtered;
    });
  };

  const openSimErrors = (runId: string) => {
    setActiveCenterTab(`sim-errors:${runId}`);
  };

  const openSimHistory = () => {
    setActiveCenterTab('sim-history');
  };

  const openRunDetail = (runId: string) => {
    setActiveCenterTab(`sim-detail:${runId}`);
  };

  const openCompare = async (runIdA: string, runIdB: string) => {
    if (currentProjectId) {
      await compareRuns(currentProjectId, runIdA, runIdB);
    }
    setActiveCenterTab('sim-compare');
  };

  // Get compile errors for the active sim-errors tab
  const simErrorsRunId = activeCenterTab?.startsWith('sim-errors:')
    ? activeCenterTab.slice('sim-errors:'.length)
    : null;
  const simErrorsRun = activeRuns.find((r) => r.runId === simErrorsRunId);
  const simErrors = simErrorsRun?.compileErrors ?? [];

  return (
    <main className="flex flex-1 flex-col overflow-hidden">
      {/* ── Tab bar ────────────────────────────────── */}
      <div className="flex h-8 shrink-0 items-center border-b bg-secondary/30">
        {tabs.length === 0 ? (
          <div className="flex items-center gap-2 px-3 text-[10px] text-muted-foreground">
            <span>多功能工作区 — 点击左栏文件或使用下方按钮</span>
          </div>
        ) : (
          <div className="flex h-full flex-1 overflow-x-auto">
            {tabs.map((tab) => (
              <div
                key={tab.id}
                className={cn(
                  'flex h-full shrink-0 items-center gap-1.5 border-r px-3 text-xs transition-colors',
                  activeCenterTab === tab.id
                    ? 'bg-background text-foreground'
                    : 'text-muted-foreground hover:bg-background/50',
                )}
                onClick={() => {
                  setActiveCenterTab(tab.id);
                  setCenterView(tab.type);
                }}
              >
                {tab.type === 'file' && <FileText className="h-3 w-3 opacity-50" />}
                {tab.type === 'terminal' && <TerminalIcon className="h-3 w-3 opacity-50" />}
                {tab.type === 'ai-artifacts' && <Sparkles className="h-3 w-3 opacity-50" />}
                {tab.type === 'sim-errors' && <AlertCircle className="h-3 w-3 text-red-500" />}
                {tab.type === 'sim-history' && <History className="h-3 w-3 opacity-50" />}
                {tab.type === 'sim-detail' && <FileText className="h-3 w-3 opacity-50" />}
                {tab.type === 'sim-compare' && <GitCompare className="h-3 w-3 opacity-50" />}
                {tab.type === 'coverage' && <BarChart3 className="h-3 w-3 opacity-50" />}
                {tab.type === 'regression' && <GitBranch className="h-3 w-3 opacity-50" />}
                {tab.type === 'dashboard' && <LayoutDashboard className="h-3 w-3 opacity-50" />}
                {tab.type === 'to-checklist' && <ListChecks className="h-3 w-3 opacity-50" />}
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
        <div className="flex items-center gap-1 px-2">
          <button
            onClick={() => setActiveCenterTab('dashboard')}
            title="仪表盘"
            className="rounded p-1 text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
          >
            <LayoutDashboard className="h-3.5 w-3.5" />
          </button>
          <button
            onClick={() => setActiveCenterTab('coverage')}
            title="覆盖率"
            className="rounded p-1 text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
          >
            <BarChart3 className="h-3.5 w-3.5" />
          </button>
          <button
            onClick={() => setActiveCenterTab('regression')}
            title="回归套件"
            className="rounded p-1 text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
          >
            <GitBranch className="h-3.5 w-3.5" />
          </button>
          <button
            onClick={() => setActiveCenterTab('to-checklist')}
            title="TO 检查"
            className="rounded p-1 text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
          >
            <ListChecks className="h-3.5 w-3.5" />
          </button>
          <button
            onClick={openSimHistory}
            title="仿真历史"
            className="rounded p-1 text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
          >
            <History className="h-3.5 w-3.5" />
          </button>
        </div>
      </div>

      {/* ── Content area ─────────────────────────────── */}
      <div className="flex flex-1 overflow-hidden">
        {centerView === 'file' && selectedFile ? (
          <div className="flex flex-1 flex-col overflow-hidden">
            <div className="flex items-center justify-between border-b bg-secondary/20 px-3 py-1">
              <span className="text-xs text-muted-foreground">{selectedFile.path}</span>
            </div>
            <div className="flex-1 overflow-auto">
              {loadingContent ? (
                <div className="flex h-full items-center justify-center text-xs text-muted-foreground">
                  加载中...
                </div>
              ) : (
                <pre className="px-3 py-2 text-xs leading-relaxed">
                  <code>{fileContent}</code>
                </pre>
              )}
            </div>
          </div>
        ) : centerView === 'terminal' && activeCenterTab?.startsWith('term:') ? (
          (() => {
            const termTabId = activeCenterTab.slice(5);
            const termTab = terminalTabs.find((t) => t.id === termTabId);
            if (!termTab || !termTab.terminalId) {
              return (
                <div className="flex flex-1 items-center justify-center text-xs text-muted-foreground">
                  正在创建终端...
                </div>
              );
            }
            return <TerminalView terminalId={termTab.terminalId} />;
          })()
        ) : centerView === 'sim-errors' ? (
          <CompileErrorView errors={simErrors} runId={simErrorsRunId} />
        ) : centerView === 'sim-history' ? (
          <SimulationHistoryView
            history={history}
            onSelectRun={(runId) => openSimErrors(runId)}
            onViewDetail={(runId) => openRunDetail(runId)}
            onCompare={(runIdA, runIdB) => openCompare(runIdA, runIdB)}
          />
        ) : centerView === 'sim-detail' ? (
          <RunDetailView
            detailRun={detailRun}
            loading={loadingDetail}
            onViewErrors={(runId) => openSimErrors(runId)}
          />
        ) : centerView === 'sim-compare' ? (
          <ComparisonView result={compareResult} />
        ) : centerView === 'coverage' ? (
          <CoveragePanel />
        ) : centerView === 'regression' ? (
          <RegressionPanel />
        ) : centerView === 'dashboard' ? (
          <DashboardPanel />
        ) : centerView === 'to-checklist' ? (
          <TOChecklistPanel />
        ) : (
          <div className="flex flex-1 flex-col items-center justify-center gap-3 text-sm text-muted-foreground">
            {/* Active simulations */}
            {activeRuns.length > 0 && (
              <div className="w-full max-w-md">
                <div className="mb-1 text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">
                  正在运行的仿真
                </div>
                {activeRuns.map((run) => (
                  <div
                    key={run.runId}
                    className="flex items-center gap-2 rounded-md border border-border/50 bg-secondary/30 px-3 py-1.5"
                  >
                    <CircleDot className={cn('h-2.5 w-2.5 shrink-0', run.status === 'running' ? 'text-blue-500 animate-pulse' : run.status === 'pass' ? 'text-green-500' : run.status === 'fail' ? 'text-red-500' : 'text-muted-foreground')} />
                    <span className="flex-1 truncate text-xs">{run.caseName ?? run.caseId}</span>
                    <span className="text-[10px] text-muted-foreground">{run.status}</span>
                    {run.status === 'running' || run.status === 'pending' ? (
                      <button
                        onClick={() => currentProjectId && abortSimulation(currentProjectId, run.runId)}
                        className="rounded bg-destructive/10 px-1.5 py-0.5 text-[10px] text-destructive hover:bg-destructive/20"
                      >
                        中止
                      </button>
                    ) : run.compileErrors && run.compileErrors.length > 0 ? (
                      <button
                        onClick={() => openSimErrors(run.runId)}
                        className="rounded bg-red-500/10 px-1.5 py-0.5 text-[10px] text-red-500 hover:bg-red-500/20"
                      >
                        查看错误
                      </button>
                    ) : null}
                  </div>
                ))}
              </div>
            )}

            <div className="flex gap-2">
              <button
                onClick={() => createTerminal(currentProjectId ?? undefined)}
                className="flex items-center gap-1.5 rounded-md border border-border px-3 py-1.5 text-xs transition-colors hover:bg-accent"
              >
                <TerminalIcon className="h-3.5 w-3.5" />
                终端
              </button>
              <button
                onClick={() => setCenterView('ai-artifacts')}
                className="flex items-center gap-1.5 rounded-md border border-border px-3 py-1.5 text-xs transition-colors hover:bg-accent"
              >
                <Sparkles className="h-3.5 w-3.5" />
                AI 产物
              </button>
            </div>
            <p className="text-[10px]">
              {activeCenterTab ? `活动页签：${activeCenterTab}` : '从左栏选择文件或在右栏与 AI 对话'}
            </p>
          </div>
        )}
      </div>
    </main>
  );
}

// ── Compile error view ─────────────────────────────────

function CompileErrorView({ errors, runId }: { errors: CompileError[]; runId: string | null }) {
  if (!runId) {
    return <div className="flex flex-1 items-center justify-center text-xs text-muted-foreground">无选中的运行</div>;
  }

  if (errors.length === 0) {
    return (
      <div className="flex flex-1 items-center justify-center text-xs text-muted-foreground">
        无编译错误
      </div>
    );
  }

  return (
    <div className="flex flex-1 flex-col overflow-auto">
      <div className="border-b bg-secondary/20 px-3 py-1.5">
        <span className="text-xs font-semibold text-foreground">编译错误 — {runId.slice(-6)}</span>
        <span className="ml-2 text-[10px] text-muted-foreground">{errors.length} 项</span>
      </div>
      <div className="flex-1 overflow-auto p-2">
        {errors.map((err, i) => (
          <div
            key={i}
            className={cn(
              'mb-1 rounded-md border p-2 text-xs',
              err.severity === 'error'
                ? 'border-red-500/30 bg-red-500/5'
                : 'border-yellow-500/30 bg-yellow-500/5',
            )}
          >
            <div className="flex items-center gap-2">
              <span
                className={cn(
                  'rounded px-1 py-0.5 text-[9px] font-semibold uppercase',
                  err.severity === 'error'
                    ? 'bg-red-500/20 text-red-500'
                    : 'bg-yellow-500/20 text-yellow-600',
                )}
              >
                {err.severity}
              </span>
              <span className="font-medium text-foreground">{err.file}:{err.line}</span>
              {err.column && <span className="text-muted-foreground">:{err.column}</span>}
            </div>
            <div className="mt-1 text-muted-foreground">{err.message}</div>
          </div>
        ))}
      </div>
    </div>
  );
}

// ── Simulation history view ────────────────────────────

function SimulationHistoryView({
  history,
  onSelectRun,
  onViewDetail,
  onCompare,
}: {
  history: SimulationHistoryEntry[];
  onSelectRun: (runId: string) => void;
  onViewDetail: (runId: string) => void;
  onCompare: (runIdA: string, runIdB: string) => void;
}) {
  const [sortBy, setSortBy] = useState<'time' | 'case' | 'status' | 'duration'>('time');
  const [sortDir, setSortDir] = useState<'asc' | 'desc'>('desc');
  const [compareSelect, setCompareSelect] = useState<string[]>([]);

  if (history.length === 0) {
    return (
      <div className="flex flex-1 items-center justify-center text-xs text-muted-foreground">
        无仿真历史记录
      </div>
    );
  }

  const sorted = [...history].sort((a, b) => {
    let cmp = 0;
    switch (sortBy) {
      case 'time': cmp = a.startTime - b.startTime; break;
      case 'case': cmp = a.caseName.localeCompare(b.caseName); break;
      case 'status': cmp = a.status.localeCompare(b.status); break;
      case 'duration': cmp = a.duration - b.duration; break;
    }
    return sortDir === 'asc' ? cmp : -cmp;
  });

  const toggleSort = (col: typeof sortBy) => {
    if (sortBy === col) {
      setSortDir(sortDir === 'asc' ? 'desc' : 'asc');
    } else {
      setSortBy(col);
      setSortDir('desc');
    }
  };

  const sortIcon = (col: typeof sortBy) => {
    if (sortBy !== col) return null;
    return sortDir === 'asc'
      ? <ChevronUp className="inline h-2.5 w-2.5" />
      : <ChevronDown className="inline h-2.5 w-2.5" />;
  };

  const toggleCompare = (runId: string) => {
    setCompareSelect((prev) => {
      if (prev.includes(runId)) return prev.filter((r) => r !== runId);
      if (prev.length >= 2) return [prev[1], runId];
      return [...prev, runId];
    });
  };

  return (
    <div className="flex flex-1 flex-col overflow-auto">
      <div className="flex items-center justify-between border-b bg-secondary/20 px-3 py-1.5">
        <div>
          <span className="text-xs font-semibold text-foreground">仿真历史</span>
          <span className="ml-2 text-[10px] text-muted-foreground">{history.length} 条记录</span>
        </div>
        {compareSelect.length === 2 && (
          <button
            onClick={() => onCompare(compareSelect[0], compareSelect[1])}
            className="flex items-center gap-1 rounded bg-primary/10 px-2 py-0.5 text-[10px] text-primary hover:bg-primary/20"
          >
            <GitCompare className="h-3 w-3" />
            对比选中
          </button>
        )}
      </div>
      <div className="flex-1 overflow-auto p-2">
        <table className="w-full text-xs">
          <thead>
            <tr className="border-b text-left text-[10px] uppercase text-muted-foreground">
              <th className="px-2 py-1 w-6">
                <input
                  type="checkbox"
                  checked={compareSelect.length === history.length}
                  onChange={(e) => setCompareSelect(e.target.checked ? history.slice(0, 2).map((h) => h.runId) : [])}
                  className="h-2.5 w-2.5"
                  title="选择前两条用于对比"
                />
              </th>
              <th className="cursor-pointer px-2 py-1 hover:text-foreground" onClick={() => toggleSort('case')}>
                用例 {sortIcon('case')}
              </th>
              <th className="px-2 py-1">子系统</th>
              <th className="cursor-pointer px-2 py-1 hover:text-foreground" onClick={() => toggleSort('status')}>
                状态 {sortIcon('status')}
              </th>
              <th className="cursor-pointer px-2 py-1 hover:text-foreground" onClick={() => toggleSort('duration')}>
                耗时 {sortIcon('duration')}
              </th>
              <th className="cursor-pointer px-2 py-1 hover:text-foreground" onClick={() => toggleSort('time')}>
                时间 {sortIcon('time')}
              </th>
              <th className="px-2 py-1">操作</th>
            </tr>
          </thead>
          <tbody>
            {sorted.map((entry) => (
              <tr
                key={entry.runId}
                className={cn(
                  'border-b border-border/30 hover:bg-accent/30 cursor-pointer',
                  compareSelect.includes(entry.runId) && 'bg-primary/5',
                )}
                onClick={() => onViewDetail(entry.runId)}
              >
                <td className="px-2 py-1" onClick={(e) => e.stopPropagation()}>
                  <input
                    type="checkbox"
                    checked={compareSelect.includes(entry.runId)}
                    onChange={() => toggleCompare(entry.runId)}
                    className="h-2.5 w-2.5"
                  />
                </td>
                <td className="px-2 py-1 text-foreground">{entry.caseName}</td>
                <td className="px-2 py-1 text-muted-foreground">{entry.subsys}</td>
                <td className="px-2 py-1">
                  <span
                    className={cn(
                      'rounded px-1 py-0.5 text-[10px]',
                      entry.status === 'pass' && 'bg-green-500/15 text-green-500',
                      entry.status === 'fail' && 'bg-red-500/15 text-red-500',
                      entry.status === 'error' && 'bg-red-500/15 text-red-500',
                      entry.status === 'aborted' && 'bg-orange-500/15 text-orange-500',
                      (entry.status === 'pending' || entry.status === 'running') && 'bg-blue-500/15 text-blue-500',
                    )}
                  >
                    {entry.status}
                  </span>
                </td>
                <td className="px-2 py-1 text-muted-foreground">
                  {entry.duration > 1000
                    ? `${(entry.duration / 1000).toFixed(1)}s`
                    : `${entry.duration}ms`}
                </td>
                <td className="px-2 py-1 text-muted-foreground">
                  {new Date(entry.startTime).toLocaleString()}
                </td>
                <td className="px-2 py-1" onClick={(e) => e.stopPropagation()}>
                  {entry.compileErrors && entry.compileErrors.length > 0 && (
                    <button
                      onClick={() => onSelectRun(entry.runId)}
                      className="rounded bg-red-500/10 px-1.5 py-0.5 text-[10px] text-red-500 hover:bg-red-500/20"
                    >
                      查看错误
                    </button>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

// ── Run detail view ────────────────────────────────────

function RunDetailView({
  detailRun,
  loading,
  onViewErrors,
}: {
  detailRun: SimulationHistoryEntry | null;
  loading: boolean;
  onViewErrors: (runId: string) => void;
}) {
  if (loading) {
    return (
      <div className="flex flex-1 items-center justify-center text-xs text-muted-foreground">
        加载中...
      </div>
    );
  }

  if (!detailRun) {
    return (
      <div className="flex flex-1 items-center justify-center text-xs text-muted-foreground">
        无运行详情
      </div>
    );
  }

  return (
    <div className="flex flex-1 flex-col overflow-auto">
      <div className="border-b bg-secondary/20 px-3 py-1.5">
        <span className="text-xs font-semibold text-foreground">运行详情 — {detailRun.runId.slice(-6)}</span>
      </div>
      <div className="flex-1 overflow-auto p-3">
        {/* Basic info */}
        <div className="mb-4 grid grid-cols-2 gap-2 text-xs">
          <div className="rounded border border-border/50 bg-secondary/20 px-3 py-2">
            <span className="text-[10px] uppercase text-muted-foreground">用例</span>
            <div className="mt-0.5 font-medium text-foreground">{detailRun.caseName}</div>
          </div>
          <div className="rounded border border-border/50 bg-secondary/20 px-3 py-2">
            <span className="text-[10px] uppercase text-muted-foreground">子系统</span>
            <div className="mt-0.5 font-medium text-foreground">{detailRun.subsys}</div>
          </div>
          <div className="rounded border border-border/50 bg-secondary/20 px-3 py-2">
            <span className="text-[10px] uppercase text-muted-foreground">状态</span>
            <div className="mt-0.5">
              <span
                className={cn(
                  'rounded px-1 py-0.5 text-[10px]',
                  detailRun.status === 'pass' && 'bg-green-500/15 text-green-500',
                  detailRun.status === 'fail' && 'bg-red-500/15 text-red-500',
                  detailRun.status === 'error' && 'bg-red-500/15 text-red-500',
                  detailRun.status === 'aborted' && 'bg-orange-500/15 text-orange-500',
                )}
              >
                {detailRun.status}
              </span>
            </div>
          </div>
          <div className="rounded border border-border/50 bg-secondary/20 px-3 py-2">
            <span className="text-[10px] uppercase text-muted-foreground">耗时</span>
            <div className="mt-0.5 font-medium text-foreground">
              {detailRun.duration > 1000
                ? `${(detailRun.duration / 1000).toFixed(1)}s`
                : `${detailRun.duration}ms`}
            </div>
          </div>
          <div className="rounded border border-border/50 bg-secondary/20 px-3 py-2">
            <span className="text-[10px] uppercase text-muted-foreground">开始时间</span>
            <div className="mt-0.5 text-foreground">{new Date(detailRun.startTime).toLocaleString()}</div>
          </div>
          <div className="rounded border border-border/50 bg-secondary/20 px-3 py-2">
            <span className="text-[10px] uppercase text-muted-foreground">结束时间</span>
            <div className="mt-0.5 text-foreground">{new Date(detailRun.endTime).toLocaleString()}</div>
          </div>
        </div>

        {/* Options */}
        <div className="mb-4">
          <div className="mb-1 text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">仿真选项</div>
          <div className="rounded border border-border/50 bg-secondary/20 p-2">
            {Object.keys(detailRun.options).length === 0 ? (
              <span className="text-[10px] text-muted-foreground">无选项</span>
            ) : (
              <div className="grid grid-cols-2 gap-1 text-xs">
                {Object.entries(detailRun.options).map(([key, value]) => (
                  <div key={key} className="flex justify-between">
                    <span className="text-muted-foreground">{key}:</span>
                    <span className="font-mono text-foreground">{String(value)}</span>
                  </div>
                ))}
              </div>
            )}
          </div>
        </div>

        {/* Compile errors */}
        {detailRun.compileErrors && detailRun.compileErrors.length > 0 && (
          <div className="mb-4">
            <div className="mb-1 flex items-center justify-between">
              <span className="text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">
                编译错误 ({detailRun.compileErrors.length})
              </span>
              <button
                onClick={() => onViewErrors(detailRun.runId)}
                className="rounded bg-red-500/10 px-1.5 py-0.5 text-[10px] text-red-500 hover:bg-red-500/20"
              >
                查看全部
              </button>
            </div>
            <div className="space-y-1">
              {detailRun.compileErrors.slice(0, 5).map((err, i) => (
                <div
                  key={i}
                  className={cn(
                    'rounded border p-2 text-xs',
                    err.severity === 'error'
                      ? 'border-red-500/30 bg-red-500/5'
                      : 'border-yellow-500/30 bg-yellow-500/5',
                  )}
                >
                  <span className="font-medium text-foreground">{err.file}:{err.line}</span>
                  <span className="ml-2 text-muted-foreground">{err.message}</span>
                </div>
              ))}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

// ── Comparison view ────────────────────────────────────

function ComparisonView({
  result,
}: {
  result: {
    runA: SimulationHistoryEntry | null;
    runB: SimulationHistoryEntry | null;
    differences: Array<{ field: string; valueA?: unknown; valueB?: unknown }>;
  } | null;
}) {
  if (!result) {
    return (
      <div className="flex flex-1 items-center justify-center text-xs text-muted-foreground">
        请从仿真历史中选择两条运行进行对比
      </div>
    );
  }

  const { runA, runB, differences } = result;

  return (
    <div className="flex flex-1 flex-col overflow-auto">
      <div className="border-b bg-secondary/20 px-3 py-1.5">
        <span className="text-xs font-semibold text-foreground">运行对比</span>
        <span className="ml-2 text-[10px] text-muted-foreground">{differences.length} 项差异</span>
      </div>
      <div className="flex-1 overflow-auto p-3">
        {/* Run summaries side by side */}
        <div className="mb-4 grid grid-cols-2 gap-3">
          {runA && (
            <div className="rounded border border-border/50 bg-secondary/20 p-3">
              <div className="mb-2 text-[10px] font-semibold uppercase text-muted-foreground">运行 A</div>
              <div className="space-y-1 text-xs">
                <div><span className="text-muted-foreground">用例:</span> <span className="text-foreground">{runA.caseName}</span></div>
                <div><span className="text-muted-foreground">子系统:</span> <span className="text-foreground">{runA.subsys}</span></div>
                <div>
                  <span className="text-muted-foreground">状态:</span>{' '}
                  <span className={cn(
                    'rounded px-1 py-0.5 text-[10px]',
                    runA.status === 'pass' && 'bg-green-500/15 text-green-500',
                    runA.status === 'fail' && 'bg-red-500/15 text-red-500',
                  )}>{runA.status}</span>
                </div>
                <div><span className="text-muted-foreground">耗时:</span> <span className="text-foreground">{runA.duration > 1000 ? `${(runA.duration / 1000).toFixed(1)}s` : `${runA.duration}ms`}</span></div>
                <div><span className="text-muted-foreground">时间:</span> <span className="text-foreground">{new Date(runA.startTime).toLocaleString()}</span></div>
              </div>
            </div>
          )}
          {runB && (
            <div className="rounded border border-border/50 bg-secondary/20 p-3">
              <div className="mb-2 text-[10px] font-semibold uppercase text-muted-foreground">运行 B</div>
              <div className="space-y-1 text-xs">
                <div><span className="text-muted-foreground">用例:</span> <span className="text-foreground">{runB.caseName}</span></div>
                <div><span className="text-muted-foreground">子系统:</span> <span className="text-foreground">{runB.subsys}</span></div>
                <div>
                  <span className="text-muted-foreground">状态:</span>{' '}
                  <span className={cn(
                    'rounded px-1 py-0.5 text-[10px]',
                    runB.status === 'pass' && 'bg-green-500/15 text-green-500',
                    runB.status === 'fail' && 'bg-red-500/15 text-red-500',
                  )}>{runB.status}</span>
                </div>
                <div><span className="text-muted-foreground">耗时:</span> <span className="text-foreground">{runB.duration > 1000 ? `${(runB.duration / 1000).toFixed(1)}s` : `${runB.duration}ms`}</span></div>
                <div><span className="text-muted-foreground">时间:</span> <span className="text-foreground">{new Date(runB.startTime).toLocaleString()}</span></div>
              </div>
            </div>
          )}
        </div>

        {/* Differences table */}
        {differences.length > 0 && (
          <div>
            <div className="mb-1 text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">差异</div>
            <table className="w-full text-xs">
              <thead>
                <tr className="border-b text-left text-[10px] uppercase text-muted-foreground">
                  <th className="px-2 py-1">字段</th>
                  <th className="px-2 py-1">运行 A</th>
                  <th className="px-2 py-1">运行 B</th>
                </tr>
              </thead>
              <tbody>
                {differences.map((diff, i) => (
                  <tr key={i} className="border-b border-border/30">
                    <td className="px-2 py-1 font-medium text-foreground">{diff.field}</td>
                    <td className="px-2 py-1 text-muted-foreground">{String(diff.valueA ?? '-')}</td>
                    <td className="px-2 py-1 text-muted-foreground">{String(diff.valueB ?? '-')}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </div>
  );
}
