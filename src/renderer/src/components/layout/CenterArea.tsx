import { useEffect, useState } from 'react';
import { FileText, Terminal as TerminalIcon, Sparkles, X, AlertCircle, History, CircleDot } from 'lucide-react';
import { useUiStore } from '@renderer/stores/ui';
import { useProjectStore } from '@renderer/stores/project';
import { useSimulationStore } from '@renderer/stores/simulation';
import { useTerminalStore } from '@renderer/stores/terminal';
import { TerminalView } from '@renderer/components/terminal/TerminalView';
import { trpc } from '@renderer/lib/trpc';
import { cn } from '@renderer/lib/utils';
import type { SimulationHistoryEntry, CompileError } from '@shared/types';

type CenterTab = {
  id: string;
  type: 'file' | 'terminal' | 'ai-artifacts' | 'sim-errors' | 'sim-history';
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
          />
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
}: {
  history: SimulationHistoryEntry[];
  onSelectRun: (runId: string) => void;
}) {
  if (history.length === 0) {
    return (
      <div className="flex flex-1 items-center justify-center text-xs text-muted-foreground">
        无仿真历史记录
      </div>
    );
  }

  return (
    <div className="flex flex-1 flex-col overflow-auto">
      <div className="border-b bg-secondary/20 px-3 py-1.5">
        <span className="text-xs font-semibold text-foreground">仿真历史</span>
        <span className="ml-2 text-[10px] text-muted-foreground">{history.length} 条记录</span>
      </div>
      <div className="flex-1 overflow-auto p-2">
        <table className="w-full text-xs">
          <thead>
            <tr className="border-b text-left text-[10px] uppercase text-muted-foreground">
              <th className="px-2 py-1">用例</th>
              <th className="px-2 py-1">子系统</th>
              <th className="px-2 py-1">状态</th>
              <th className="px-2 py-1">耗时</th>
              <th className="px-2 py-1">时间</th>
              <th className="px-2 py-1">操作</th>
            </tr>
          </thead>
          <tbody>
            {history.map((entry) => (
              <tr key={entry.runId} className="border-b border-border/30 hover:bg-accent/30">
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
                <td className="px-2 py-1">
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
