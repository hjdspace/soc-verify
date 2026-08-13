/**
 * StepReview — Step 9: Config summary + command preview + execute.
 *
 * Provides:
 *   - Config summary table (two-column grid with flag + value)
 *   - Formatted command preview with syntax highlighting
 *   - "复制" button (copy command to clipboard)
 *   - "执行生成" button (trigger runGen with streaming output)
 *   - Terminal panel for execution output
 *   - Execution status badge: 待执行 → 执行中 → 执行完成
 *
 * Streaming logs are received via IPC eventBridge (sysbase-gen:run-log).
 */

import { useState, useEffect, useCallback, useRef } from 'react';
import {
  Copy,
  Check,
  Play,
  Loader2,
  Terminal,
  AlertTriangle,
  Circle,
} from 'lucide-react';
import { useSysbaseGenStore } from '@renderer/stores/sysbase-gen';
import { trpc } from '@renderer/lib/trpc';
import { cn } from '@renderer/lib/utils';
import type { SysbaseGenConfig } from '@shared/types';

/** A config parameter entry for the summary table. */
type ConfigEntry = {
  flag: string;
  value: string;
  required: boolean;
};

/** Build the list of config entries for the summary table. */
function buildEntries(config: SysbaseGenConfig): ConfigEntry[] {
  return [
    { flag: '-rtl', value: config.rtlFile, required: true },
    { flag: '-n', value: config.subsys, required: true },
    { flag: '-i', value: config.instanceName, required: true },
    { flag: '-x', value: config.dutSpecPath, required: true },
    { flag: '-mini', value: config.miniExcelPath, required: true },
    { flag: '-ral', value: config.ralDirs.join(' '), required: true },
    { flag: '-clk', value: config.clkDir, required: true },
    { flag: '-clk2', value: config.clk2Dir, required: false },
    { flag: '-mod_io', value: config.modIoPath, required: true },
    { flag: '-pinlist', value: config.pinlistPath, required: false },
    { flag: '-dmalist', value: config.dmalistPath, required: false },
    { flag: '-o', value: config.outputDir, required: true },
  ];
}

/**
 * Render a command string with syntax highlighting.
 *
 * Colors: python binary (cyan), script path (magenta), flags (yellow), values (default).
 */
function renderHighlightedCommand(command: string): React.ReactNode {
  const lines = command.split('\n');
  return lines.map((line, lineIdx) => {
    // Match tokens: flags (-word), paths, and the python binary
    const tokens = line.split(/(\s+)/);
    return (
      <div key={lineIdx}>
        {tokens.map((token, tokenIdx) => {
          if (token.trim() === '') return <span key={tokenIdx}>{token}</span>;
          // Flags start with -
          if (token.startsWith('-')) {
            return (
              <span key={tokenIdx} className="text-yellow-400">
                {token}
              </span>
            );
          }
          // python3 binary
          if (token === 'python3' || token === 'python') {
            return (
              <span key={tokenIdx} className="text-cyan-400">
                {token}
              </span>
            );
          }
          // Script path (contains .py)
          if (token.endsWith('.py') || token.includes('sysbase_gen')) {
            return (
              <span key={tokenIdx} className="text-purple-400">
                {token}
              </span>
            );
          }
          // Backslash continuation
          if (token === '\\') {
            return (
              <span key={tokenIdx} className="text-zinc-500">
                {token}
              </span>
            );
          }
          // Regular value
          return (
            <span key={tokenIdx} className="text-zinc-200">
              {token}
            </span>
          );
        })}
      </div>
    );
  });
}

export function StepReview() {
  const config = useSysbaseGenStore((s) => s.config);
  const scriptPath = useSysbaseGenStore((s) => s.scriptPath);
  const runGenLoading = useSysbaseGenStore((s) => s.runGenLoading);
  const runGenError = useSysbaseGenStore((s) => s.runGenError);
  const runGenLogs = useSysbaseGenStore((s) => s.runGenLogs);
  const runGenStatus = useSysbaseGenStore((s) => s.runGenStatus);
  const setRunGenLoading = useSysbaseGenStore((s) => s.setRunGenLoading);
  const setRunGenError = useSysbaseGenStore((s) => s.setRunGenError);
  const setRunGenLogs = useSysbaseGenStore((s) => s.setRunGenLogs);
  const addRunGenLog = useSysbaseGenStore((s) => s.addRunGenLog);
  const clearRunGenLogs = useSysbaseGenStore((s) => s.clearRunGenLogs);
  const setRunGenStatus = useSysbaseGenStore((s) => s.setRunGenStatus);

  const [command, setCommand] = useState('');
  const [copied, setCopied] = useState(false);
  const logRef = useRef<HTMLDivElement>(null);

  const entries = buildEntries(config);

  // Fetch command preview via tRPC
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const result = await trpc.tools.sysbaseGen.previewCommand.query({
          config,
          scriptPath,
        });
        if (!cancelled) setCommand(result.command);
      } catch {
        // best-effort
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [config, scriptPath]);

  // Real-time log streaming via IPC events
  useEffect(() => {
    if (!window.eventBridge) return;
    const unsubscribe = window.eventBridge.onSysbaseGenRunLog((event) => {
      if (event.type === 'start' && event.lines) {
        setRunGenLogs(event.lines);
      } else if (event.type === 'output' && event.line) {
        addRunGenLog(event.line);
      } else if (event.type === 'end' && event.lines) {
        for (const line of event.lines) {
          addRunGenLog(line);
        }
        if (event.success) {
          setRunGenStatus('success');
        } else {
          setRunGenStatus('failed');
        }
      }
    });
    return unsubscribe;
  }, [setRunGenLogs, addRunGenLog, setRunGenStatus]);

  // Auto-scroll logs
  useEffect(() => {
    if (logRef.current) {
      logRef.current.scrollTop = logRef.current.scrollHeight;
    }
  }, [runGenLogs]);

  // Copy command to clipboard
  const handleCopy = useCallback(async () => {
    try {
      await navigator.clipboard.writeText(command);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      // best-effort
    }
  }, [command]);

  // Execute sysbase_gen.py
  const handleExecute = useCallback(async () => {
    if (!command) return;

    setRunGenLoading(true);
    setRunGenError(null);
    clearRunGenLogs();
    setRunGenStatus('running');

    try {
      const result = await trpc.tools.sysbaseGen.runGen.mutate({
        command,
      });

      if (result.success) {
        setRunGenStatus('success');
      } else {
        setRunGenStatus('failed');
        setRunGenError(result.errorMessage ?? '执行失败');
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      setRunGenError(msg);
      setRunGenStatus('failed');
    }
  }, [command, setRunGenLoading, setRunGenError, clearRunGenLogs, setRunGenStatus]);

  const statusBadge = {
    idle: { label: '待执行', color: 'bg-muted text-muted-foreground', icon: Circle },
    running: { label: '执行中', color: 'bg-primary/15 text-primary', icon: Loader2 },
    success: { label: '执行完成', color: 'bg-status-pass/10 text-status-pass-foreground', icon: Check },
    failed: { label: '执行失败', color: 'bg-status-fail/10 text-status-fail-foreground', icon: AlertTriangle },
  }[runGenStatus];

  const StatusIcon = statusBadge.icon;

  return (
    <div className="space-y-4">
      {/* Config summary table */}
      <div className="overflow-hidden rounded-md border border-border">
        <div className="border-b bg-secondary/30 px-3 py-1.5">
          <span className="text-[11px] font-semibold">配置摘要</span>
        </div>
        <div className="grid grid-cols-2 gap-px bg-border">
          {entries.map((entry) => {
            const isSet = entry.value.trim() !== '';
            return (
              <div key={entry.flag} className="flex items-center gap-2 bg-background px-3 py-1.5">
                <span className="font-mono text-[10px] font-medium text-yellow-600 dark:text-yellow-400">
                  {entry.flag}
                </span>
                {isSet ? (
                  <span className="truncate font-mono text-[10px] text-foreground">
                    {entry.value}
                  </span>
                ) : (
                  <span className="text-[10px] text-muted-foreground/50">未设置</span>
                )}
                {!entry.required && (
                  <span className="ml-auto rounded bg-muted px-1 py-0.5 text-[9px] text-muted-foreground">
                    可选
                  </span>
                )}
              </div>
            );
          })}
        </div>
      </div>

      {/* Command preview */}
      <div className="overflow-hidden rounded-md border border-border">
        <div className="flex items-center justify-between border-b bg-secondary/30 px-3 py-1.5">
          <div className="flex items-center gap-1.5">
            <Terminal className="h-3 w-3 text-muted-foreground" />
            <span className="text-[11px] font-semibold">命令预览</span>
          </div>
          <button
            onClick={handleCopy}
            className="flex items-center gap-1 rounded px-2 py-0.5 text-[10px] text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
          >
            {copied ? (
              <>
                <Check className="h-3 w-3 text-status-pass-foreground" />
                <span className="text-status-pass-foreground">已复制</span>
              </>
            ) : (
              <>
                <Copy className="h-3 w-3" />
                复制
              </>
            )}
          </button>
        </div>
        <div className="overflow-x-auto bg-zinc-950 p-3 font-mono text-[10px] leading-relaxed">
          {command ? (
            renderHighlightedCommand(command)
          ) : (
            <span className="text-zinc-500">生成命令预览...</span>
          )}
        </div>
      </div>

      {/* Execute button + status badge */}
      <div className="flex items-center gap-3">
        <button
          onClick={() => void handleExecute()}
          disabled={runGenLoading || !command}
          className={cn(
            'flex items-center gap-1.5 rounded-md border px-3 py-1.5 text-xs font-medium transition-colors',
            runGenStatus === 'success'
              ? 'border-status-pass/30 bg-status-pass/10 text-status-pass-foreground'
              : 'border-primary/30 bg-primary/10 text-primary hover:bg-primary/20',
            'disabled:opacity-50',
          )}
        >
          {runGenLoading ? (
            <Loader2 className="h-3.5 w-3.5 animate-spin" />
          ) : (
            <Play className="h-3.5 w-3.5" />
          )}
          {runGenLoading ? '执行中...' : '执行生成'}
        </button>

        {/* Status badge */}
        <span className={cn('flex items-center gap-1 rounded-full px-2 py-0.5 text-[10px] font-medium', statusBadge.color)}>
          <StatusIcon className={cn('h-3 w-3', runGenStatus === 'running' && 'animate-spin')} />
          {statusBadge.label}
        </span>
      </div>

      {/* Error */}
      {runGenError && (
        <div className="flex items-start gap-2 rounded-md border border-status-fail/30 bg-status-fail/5 p-3 text-xs text-status-fail-foreground">
          <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
          <span>{runGenError}</span>
        </div>
      )}

      {/* Terminal output */}
      {(runGenLogs.length > 0 || runGenLoading) && (
        <div className="overflow-hidden rounded-md border border-border">
          <div className="flex items-center justify-between border-b bg-secondary/30 px-3 py-1.5">
            <div className="flex items-center gap-1.5">
              <Terminal className="h-3 w-3 text-muted-foreground" />
              <span className="text-[11px] font-semibold">执行输出</span>
            </div>
            {runGenLoading && (
              <span className="flex items-center gap-1 text-[10px] text-muted-foreground">
                <Loader2 className="h-2.5 w-2.5 animate-spin" />
                运行中
              </span>
            )}
          </div>
          <div
            ref={logRef}
            className="max-h-64 overflow-y-auto bg-zinc-950 p-3 font-mono text-[10px] leading-relaxed text-zinc-300"
          >
            {runGenLogs.length === 0 && runGenLoading && (
              <div className="text-zinc-500">等待输出...</div>
            )}
            {runGenLogs.map((line, i) => (
              <div
                key={i}
                className={cn(
                  line.includes('成功') && 'text-green-400',
                  line.includes('失败') && 'text-red-400',
                  line.includes('错误') && 'text-red-400',
                  line.includes('Error') && 'text-red-400',
                  line.includes('Warning') && 'text-yellow-400',
                )}
              >
                {line}
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
