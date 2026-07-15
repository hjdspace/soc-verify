import { useState, useEffect, useCallback } from 'react';
import {
  CircleDot,
  Play,
  Square,
  Terminal as TerminalIcon,
  CheckCircle2,
  XCircle,
  Copy,
  Trash2,
  ChevronDown,
  ChevronRight,
} from 'lucide-react';
import { useSimulationStore, type SimulationRunRecord } from '@renderer/stores/simulation';
import { useTerminalStore } from '@renderer/stores/terminal';
import { useUiStore } from '@renderer/stores/ui';
import { cn } from '@renderer/lib/utils';

const STATUS_CONFIG: Record<string, { color: string; bg: string; label: string; icon: typeof CircleDot }> = {
  running: { color: 'text-blue-500', bg: 'bg-blue-500/15', label: '运行中', icon: CircleDot },
  pending: { color: 'text-muted-foreground', bg: 'bg-muted/20', label: '等待', icon: CircleDot },
  pass: { color: 'text-green-500', bg: 'bg-green-500/15', label: '通过', icon: CheckCircle2 },
  fail: { color: 'text-red-500', bg: 'bg-red-500/15', label: '失败', icon: XCircle },
  error: { color: 'text-red-500', bg: 'bg-red-500/15', label: '错误', icon: XCircle },
  aborted: { color: 'text-orange-500', bg: 'bg-orange-500/15', label: '中止', icon: Square },
};

function formatDuration(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  const s = Math.floor(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  const rem = s % 60;
  if (m < 60) return `${m}m${rem}s`;
  const h = Math.floor(m / 60);
  const remM = m % 60;
  return `${h}h${remM}m`;
}

function RunCard({ run }: { run: SimulationRunRecord }) {
  const [expanded, setExpanded] = useState(false);
  const [copied, setCopied] = useState(false);
  const [elapsed, setElapsed] = useState(0);

  const abortTerminalRun = useSimulationStore((s) => s.abortTerminalRun);
  const abortSimulation = useSimulationStore((s) => s.abortSimulation);
  const createTabForSession = useTerminalStore((s) => s.createTabForSession);
  const getTabIdByTerminalId = useTerminalStore((s) => s.getTabIdByTerminalId);
  const setActiveTab = useTerminalStore((s) => s.setActiveTab);
  const setCenterView = useUiStore((s) => s.setCenterView);
  const setActiveCenterTab = useUiStore((s) => s.setActiveCenterTab);

  // Live-update elapsed time for running simulations
  useEffect(() => {
    if (run.status !== 'running' && run.status !== 'pending') return;
    const update = () => setElapsed(Date.now() - run.startTime);
    update();
    const timer = setInterval(update, 1000);
    return () => clearInterval(timer);
  }, [run.status, run.startTime]);

  const config = STATUS_CONFIG[run.status] ?? STATUS_CONFIG.pending;
  const StatusIcon = config.icon;
  const isRunning = run.status === 'running' || run.status === 'pending';
  const duration = isRunning ? elapsed : (run.endTime ? run.endTime - run.startTime : 0);

  const handleViewTerminal = useCallback(() => {
    if (!run.terminalId) return;
    const existingTabId = getTabIdByTerminalId(run.terminalId);
    let tabId: string;
    if (existingTabId) {
      tabId = existingTabId;
    } else {
      tabId = createTabForSession(run.terminalId, `sim: ${run.caseName ?? run.caseId}`, run.cwd);
    }
    // Directly set center view and active tab — don't rely on the useEffect
    // in CenterArea (which won't fire if activeTabId hasn't changed).
    setActiveTab(tabId);
    setActiveCenterTab(`term:${tabId}`);
    setCenterView('terminal');
  }, [run.terminalId, run.caseName, run.caseId, run.cwd, getTabIdByTerminalId, setActiveTab, createTabForSession, setActiveCenterTab, setCenterView]);

  const handleAbort = useCallback(() => {
    if (run.terminalId) {
      void abortTerminalRun(run.terminalId);
    } else {
      void abortSimulation(run.projectId, run.runId);
    }
  }, [run.terminalId, run.projectId, run.runId, abortTerminalRun, abortSimulation]);

  const handleCopyCommand = useCallback(() => {
    if (run.command) {
      void navigator.clipboard.writeText(run.command);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    }
  }, [run.command]);

  return (
    <div
      className={cn(
        'rounded-lg border transition-colors',
        run.status === 'running' ? 'border-blue-500/30 bg-blue-500/5' :
        run.status === 'pass' ? 'border-green-500/20 bg-green-500/5' :
        run.status === 'fail' || run.status === 'error' ? 'border-red-500/20 bg-red-500/5' :
        'border-border/50 bg-secondary/20',
      )}
    >
      {/* ── Header row ── */}
      <div className="flex items-center gap-2 px-3 py-2">
        <StatusIcon className={cn('h-3.5 w-3.5 shrink-0', config.color, run.status === 'running' && 'animate-pulse')} />

        <span className="flex-1 truncate text-xs font-medium text-foreground">
          {run.caseName ?? run.caseId}
        </span>

        <span className="shrink-0 text-[10px] text-muted-foreground">
          {formatDuration(duration)}
        </span>

        <span className={cn('shrink-0 rounded px-1.5 py-0.5 text-[9px] font-semibold', config.bg, config.color)}>
          {config.label}
        </span>

        {/* Actions */}
        <div className="flex shrink-0 items-center gap-0.5">
          {run.terminalId && (
            <button
              onClick={handleViewTerminal}
              className="rounded p-1 text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
              title="查看终端"
            >
              <TerminalIcon className="h-3 w-3" />
            </button>
          )}
          {isRunning && (
            <button
              onClick={handleAbort}
              className="rounded p-1 text-destructive/70 transition-colors hover:bg-destructive/10 hover:text-destructive"
              title="中止仿真"
            >
              <Square className="h-3 w-3" />
            </button>
          )}
          {run.command && (
            <button
              onClick={() => setExpanded(!expanded)}
              className="rounded p-1 text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
              title={expanded ? '收起命令' : '展开命令'}
            >
              {expanded ? <ChevronDown className="h-3 w-3" /> : <ChevronRight className="h-3 w-3" />}
            </button>
          )}
        </div>
      </div>

      {/* ── Expanded command preview ── */}
      {expanded && run.command && (
        <div className="border-t border-border/30 px-3 py-2">
          <div className="mb-1 flex items-center justify-between">
            <span className="text-[9px] font-semibold uppercase tracking-wide text-muted-foreground/60">
              仿真命令
            </span>
            <button
              onClick={handleCopyCommand}
              className="flex items-center gap-1 rounded px-1.5 py-0.5 text-[9px] text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
            >
              {copied ? <CheckCircle2 className="h-2.5 w-2.5 text-green-500" /> : <Copy className="h-2.5 w-2.5" />}
              {copied ? '已复制' : '复制'}
            </button>
          </div>
          <pre className="overflow-x-auto rounded bg-background/80 p-2 text-[10px] leading-relaxed text-foreground/80">
            <code>{run.command}</code>
          </pre>
          {run.cwd && (
            <div className="mt-1 text-[9px] text-muted-foreground/50">
              cwd: {run.cwd}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

export function RunningCasesPanel() {
  const activeRuns = useSimulationStore((s) => s.activeRuns);
  const removeCompletedRuns = useSimulationStore((s) => s.removeCompletedRuns);

  const runningCount = activeRuns.filter((r) => r.status === 'running' || r.status === 'pending').length;
  const completedCount = activeRuns.length - runningCount;

  return (
    <div className="flex flex-1 flex-col overflow-hidden">
      {/* ── Header ── */}
      <div className="flex items-center justify-between border-b bg-secondary/20 px-3 py-1.5">
        <div className="flex items-center gap-2">
          <span className="text-xs font-semibold text-foreground">运行用例概览</span>
          {runningCount > 0 && (
            <span className="flex items-center gap-1 rounded bg-blue-500/15 px-1.5 py-0.5 text-[9px] text-blue-500">
              <CircleDot className="h-2 w-2 animate-pulse" />
              {runningCount} 个运行中
            </span>
          )}
          {completedCount > 0 && (
            <span className="rounded bg-muted/30 px-1.5 py-0.5 text-[9px] text-muted-foreground">
              {completedCount} 个已完成
            </span>
          )}
        </div>
        {completedCount > 0 && (
          <button
            onClick={removeCompletedRuns}
            className="flex items-center gap-1 rounded px-1.5 py-0.5 text-[10px] text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
            title="清除已完成"
          >
            <Trash2 className="h-2.5 w-2.5" />
            清除已完成
          </button>
        )}
      </div>

      {/* ── Runs list ── */}
      <div className="flex-1 overflow-y-auto p-2">
        {activeRuns.length === 0 ? (
          <div className="flex flex-1 flex-col items-center justify-center gap-2 py-12 text-muted-foreground">
            <Play className="h-6 w-6 opacity-30" />
            <span className="text-xs">暂无仿真运行</span>
            <span className="text-[10px] opacity-60">从左栏用例列表点击 ▶ 按钮启动仿真</span>
          </div>
        ) : (
          <div className="space-y-1.5">
            {/* Running runs first, then completed */}
            {activeRuns
              .sort((a, b) => {
                const aRunning = a.status === 'running' || a.status === 'pending' ? 0 : 1;
                const bRunning = b.status === 'running' || b.status === 'pending' ? 0 : 1;
                if (aRunning !== bRunning) return aRunning - bRunning;
                return b.startTime - a.startTime;
              })
              .map((run) => (
                <RunCard key={run.runId} run={run} />
              ))}
          </div>
        )}
      </div>
    </div>
  );
}
