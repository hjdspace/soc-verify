/**
 * 仿真视图命令预览栏 + 运行按钮（Issue #3）。
 *
 * 从 SimOptionPanel 中提取的命令预览 / 复制 / 运行区域，
 * 放置在仿真视图中栏底部，避免用户滚动 Option 面板才能触达。
 *
 * 数据来源：simulation store 的 simOptions / setSimOption /
 * startCaseRun，project store 的 currentProjectId / selectedSubsys。
 */

import { useState, useMemo } from 'react';
import { Play, Copy, AlertCircle } from 'lucide-react';
import { useProjectStore } from '@renderer/stores/project';
import { useSimulationStore, type SimulationCase } from '@renderer/stores/simulation';
import { useToastStore } from '@renderer/stores/toast';
import { cn } from '@renderer/lib/utils';
import { BorderBeam } from '@renderer/components/visual';
import {
  generateRunsimCommand,
  tokenizeRunsimCommand,
} from '@renderer/lib/runsim-command';

export function SimCommandBar() {
  const currentProjectId = useProjectStore((s) => s.currentProjectId);
  const selectedSubsys = useProjectStore((s) => s.selectedSubsys);
  const simOptions = useSimulationStore((s) => s.simOptions);
  const startCaseRun = useSimulationStore((s) => s.startCaseRun);
  const [running, setRunning] = useState(false);
  const [copied, setCopied] = useState(false);

  const commandPreview = useMemo(() => generateRunsimCommand(simOptions), [simOptions]);
  const commandTokens = useMemo(() => tokenizeRunsimCommand(commandPreview), [commandPreview]);

  const handleRunSim = async () => {
    if (!currentProjectId) {
      useToastStore.getState().error('运行仿真失败', '请先打开项目');
      return;
    }
    const caseName = typeof simOptions.case === 'string' ? simOptions.case.trim() : '';
    if (!caseName) {
      useToastStore.getState().error('运行仿真失败', '请先指定 CASE 名称');
      return;
    }
    setRunning(true);
    const simCase: SimulationCase = {
      name: caseName,
      subsys: selectedSubsys ?? '',
      base: typeof simOptions.base === 'string' ? simOptions.base : undefined,
      block: typeof simOptions.block === 'string' ? simOptions.block : undefined,
    };
    await startCaseRun(currentProjectId, simCase);
    setRunning(false);
  };

  const handleCopyCommand = async () => {
    try {
      await navigator.clipboard.writeText(commandPreview);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      useToastStore.getState().error('复制失败', '无法访问剪贴板');
    }
  };

  const hasCase = typeof simOptions.case === 'string' && simOptions.case.trim() !== '';

  return (
    <div
      className="shrink-0 border-t border-border bg-background/50"
      data-testid="sim-command-bar"
    >
      <div className="flex items-stretch">
        {/* Command prefix */}
        <div className="flex items-center px-2.5 font-mono text-xs font-semibold text-status-pass-foreground">
          $
        </div>
        {/* Command text */}
        <div className="flex min-w-0 flex-1 items-center gap-1.5 py-1.5">
          <div className="min-w-0 flex-1 overflow-x-auto" data-testid="sim-option-cmd-preview">
            <code className="whitespace-nowrap font-mono text-[11px] leading-relaxed">
              {commandTokens.map((token, i) => (
                <span
                  key={i}
                  className={cn(
                    token.type === 'base' && 'font-semibold text-status-pass-foreground',
                    token.type === 'flag' && 'text-primary',
                    token.type === 'value' && 'text-violet-foreground',
                  )}
                >
                  {token.text}
                  {i < commandTokens.length - 1 ? ' ' : ''}
                </span>
              ))}
            </code>
          </div>
          {/* Copy button */}
          <button
            onClick={handleCopyCommand}
            className="flex shrink-0 items-center gap-1 rounded px-1.5 py-0.5 text-[10px] text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
            title="复制命令"
            data-testid="sim-option-copy"
          >
            {copied ? (
              <span className="text-status-pass-foreground">已复制</span>
            ) : (
              <Copy className="h-3 w-3" />
            )}
          </button>
        </div>
        {/* Run button */}
        <BorderBeam size="pulse-inner" theme="dark" colorVariant="ocean" active={hasCase && !running}>
        <button
          onClick={handleRunSim}
          disabled={running || !currentProjectId || !hasCase}
          className="flex items-center gap-1.5 bg-status-pass px-4 text-xs font-bold text-white transition-all hover:brightness-110 active:brightness-95 disabled:cursor-not-allowed disabled:opacity-40"
          title={!hasCase ? '请先指定 CASE 名称' : !currentProjectId ? '请先打开项目' : '运行仿真'}
          data-testid="sim-option-run"
        >
          {running ? (
            <>
              <span className="h-3 w-3 animate-spin rounded-full border-2 border-current border-t-transparent" />
              运行中
            </>
          ) : (
            <>
              <Play className="h-3.5 w-3.5" fill="currentColor" />
              运行仿真
            </>
          )}
        </button>
        </BorderBeam>
      </div>
      {/* ── Missing CASE hint ─────────────────────────────────── */}
      {!hasCase && currentProjectId && (
        <div
          className="flex items-center gap-1.5 border-t border-border/50 bg-warning/5 px-3 py-1 text-[10px] text-warning-foreground"
          data-testid="sim-option-no-case-hint"
        >
          <AlertCircle className="h-3 w-3" />
          未指定 CASE 名称，请填写 CASE 字段后才能运行仿真
        </div>
      )}
    </div>
  );
}
