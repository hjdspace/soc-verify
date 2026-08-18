/**
 * StepModIo — Step 7: Module IO generation via Verdi getModIO_batch.p.
 *
 * Provides:
 *   - Filelist file selection (browse button)
 *   - Module name editable input (auto-filled from Step 2, but user can override)
 *   - Optional -module_list file selection (target module list file)
 *   - Optional -target_scope input (hierarchy path, e.g. tb_top.chip.dut.u_sys_cpu)
 *   - "生成 Module IO" button to trigger generateModIo
 *   - Prominent progress banner when generation is running (process is slow)
 *   - Terminal area for streaming execution output
 *   - Output file path auto-fill on success
 *
 * Streaming logs are received via IPC eventBridge (sysbase-gen:mod-io-log).
 */

import { useState, useEffect, useCallback, useRef } from 'react';
import { FolderOpen, Play, Info, AlertTriangle, Loader2, Cpu, FileText, Terminal, Clock } from 'lucide-react';
import { useSysbaseGenStore } from '@renderer/stores/sysbase-gen';
import { trpc } from '@renderer/lib/trpc';
import { cn } from '@renderer/lib/utils';

export function StepModIo() {
  const config = useSysbaseGenStore((s) => s.config);
  const updateConfig = useSysbaseGenStore((s) => s.updateConfig);
  const modIoLoading = useSysbaseGenStore((s) => s.modIoLoading);
  const modIoError = useSysbaseGenStore((s) => s.modIoError);
  const modIoLogs = useSysbaseGenStore((s) => s.modIoLogs);
  const setModIoLoading = useSysbaseGenStore((s) => s.setModIoLoading);
  const setModIoError = useSysbaseGenStore((s) => s.setModIoError);
  const setModIoLogs = useSysbaseGenStore((s) => s.setModIoLogs);
  const addModIoLog = useSysbaseGenStore((s) => s.addModIoLog);
  const clearModIoLogs = useSysbaseGenStore((s) => s.clearModIoLogs);

  const [genStatus, setGenStatus] = useState<'idle' | 'running' | 'success' | 'failed'>('idle');
  const logRef = useRef<HTMLDivElement>(null);

  // ── Real-time log streaming via IPC events ──
  useEffect(() => {
    if (!window.eventBridge) return;
    const unsubscribe = window.eventBridge.onSysbaseGenModIoLog((event) => {
      if (event.type === 'start' && event.lines) {
        setModIoLogs(event.lines);
      } else if (event.type === 'output' && event.line) {
        addModIoLog(event.line);
      } else if (event.type === 'end' && event.lines) {
        // Append end lines
        for (const line of event.lines) {
          addModIoLog(line);
        }
        // Auto-fill output file path on success
        if (event.success && event.outputFilePath) {
          updateConfig({ modIoPath: event.outputFilePath });
          setGenStatus('success');
        } else if (!event.success) {
          setGenStatus('failed');
        }
      }
    });
    return unsubscribe;
  }, [setModIoLogs, addModIoLog, updateConfig]);

  // Auto-scroll logs
  useEffect(() => {
    if (logRef.current) {
      logRef.current.scrollTop = logRef.current.scrollHeight;
    }
  }, [modIoLogs]);

  // ── Filelist browse ──
  const handleBrowse = async () => {
    try {
      const result = await trpc.tools.selectFiles.mutate({
        title: '选择 Filelist 文件',
        filters: [
          { name: 'Filelist 文件', extensions: ['f', 'flist', 'txt', 'vc'] },
          { name: '所有文件', extensions: ['*'] },
        ],
      });
      if (result.paths.length > 0) {
        updateConfig({ filelistPath: result.paths[0] });
      }
    } catch {
      // best-effort
    }
  };

  // ── Module list browse ──
  const handleBrowseModuleList = async () => {
    try {
      const result = await trpc.tools.selectFiles.mutate({
        title: '选择 Module List 文件',
        filters: [
          { name: '文本文件', extensions: ['txt', 'list', 'f'] },
          { name: '所有文件', extensions: ['*'] },
        ],
      });
      if (result.paths.length > 0) {
        updateConfig({ moduleListPath: result.paths[0] });
      }
    } catch {
      // best-effort
    }
  };

  // ── Generate Module IO ──
  const handleGenerate = useCallback(async () => {
    if (!config.filelistPath || !config.moduleName) return;

    setModIoLoading(true);
    setModIoError(null);
    clearModIoLogs();
    setGenStatus('running');

    try {
      const result = await trpc.tools.sysbaseGen.generateModIo.mutate({
        filelist: config.filelistPath,
        moduleName: config.moduleName,
        moduleList: config.moduleListPath || undefined,
        targetScope: config.targetScope || undefined,
      });

      if (result.success) {
        updateConfig({ modIoPath: result.outputFilePath });
        setGenStatus('success');
      } else {
        setGenStatus('failed');
        setModIoError(result.errorMessage ?? '生成失败');
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      setModIoError(msg);
      setGenStatus('failed');
    }
  }, [config.filelistPath, config.moduleName, config.moduleListPath, config.targetScope, setModIoLoading, setModIoError, clearModIoLogs, updateConfig]);

  const hasModule = config.moduleName.trim() !== '';

  return (
    <div className="space-y-4">
      {/* Callout */}
      <div className="flex items-start gap-2 rounded-md border border-info/30 bg-info/5 p-3 text-xs text-info-foreground">
        <Info className="mt-0.5 h-3.5 w-3.5 shrink-0" />
        <span>
          通过 Verdi 的 <code className="font-mono">getModIO_batch.p</code> 脚本从 filelist 中提取 Module IO 信息。
          需要配置 <code className="font-mono">VERDI_HOME</code> 环境变量。
          此过程可能较慢，请耐心等待。
        </span>
      </div>

      {/* ── Prominent progress banner when generating ── */}
      {modIoLoading && (
        <div className="flex items-center gap-3 rounded-md border border-primary/30 bg-primary/5 p-4">
          <Loader2 className="h-5 w-5 shrink-0 animate-spin text-primary" />
          <div className="flex-1">
            <div className="text-sm font-medium text-primary">正在生成 Module IO...</div>
            <div className="mt-0.5 text-xs text-muted-foreground">
              正在执行 Verdi getModIO 脚本，该过程可能需要较长时间，请勿关闭窗口
            </div>
          </div>
          <div className="flex items-center gap-1 rounded-full bg-primary/10 px-2.5 py-1 text-[10px] font-medium text-primary">
            <Clock className="h-3 w-3" />
            执行中
          </div>
        </div>
      )}

      {/* Error */}
      {modIoError && (
        <div className="flex items-start gap-2 rounded-md border border-status-fail/30 bg-status-fail/5 p-3 text-xs text-status-fail-foreground">
          <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
          <span>{modIoError}</span>
        </div>
      )}

      {/* Filelist file */}
      <div className="space-y-1.5">
        <div className="flex items-center gap-1">
          <span className="text-xs font-medium">Filelist 文件</span>
          <span className="text-destructive">*</span>
          <span className="ml-auto rounded bg-info/10 px-1.5 py-0.5 text-[10px] font-mono text-info-foreground">-f</span>
        </div>
        <div className="flex gap-1">
          <input
            type="text"
            value={config.filelistPath}
            onChange={(e) => updateConfig({ filelistPath: e.target.value })}
            placeholder="选择或输入 filelist 文件路径..."
            className={cn(
              'flex-1 rounded-md border border-border bg-background px-3 py-1.5 font-mono text-xs',
              'focus:outline-none focus:ring-1 focus:ring-primary',
            )}
          />
          <button
            onClick={handleBrowse}
            className="flex items-center gap-1 rounded-md border border-border px-2 text-xs text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
          >
            <FolderOpen className="h-3.5 w-3.5" />
            浏览
          </button>
        </div>
      </div>

      {/* Module name (editable, auto-filled from Step 2) */}
      <div className="space-y-1.5">
        <div className="flex items-center gap-1">
          <span className="text-xs font-medium">Module 名</span>
          <span className="ml-auto flex items-center gap-1">
            <span className="rounded bg-primary/10 px-1.5 py-0.5 text-[10px] text-primary">从 Step 2 自动填充，可修改</span>
            <span className="rounded bg-info/10 px-1.5 py-0.5 text-[10px] font-mono text-info-foreground">-modules</span>
          </span>
        </div>
        <div className="flex items-center gap-2">
          <input
            type="text"
            value={config.moduleName}
            onChange={(e) => updateConfig({ moduleName: e.target.value })}
            placeholder={hasModule ? '' : '请在 Step 2 中选择 RTL 文件以提取 module 名，或手动输入'}
            className={cn(
              'flex-1 rounded-md border border-border bg-background px-3 py-1.5 font-mono text-xs text-foreground',
              'focus:outline-none focus:ring-1 focus:ring-primary',
            )}
          />
          {!hasModule && (
            <span className="text-[10px] text-muted-foreground">未设置</span>
          )}
        </div>
      </div>

      {/* ── Optional: -module_list (Target Module List File) ── */}
      <div className="space-y-1.5">
        <div className="flex items-center gap-1">
          <span className="text-xs font-medium">Target Module List 文件</span>
          <span className="rounded bg-muted px-1.5 py-0.5 text-[10px] text-muted-foreground">可选</span>
          <span className="ml-auto rounded bg-info/10 px-1.5 py-0.5 text-[10px] font-mono text-info-foreground">-module_list</span>
        </div>
        <div className="flex gap-1">
          <input
            type="text"
            value={config.moduleListPath}
            onChange={(e) => updateConfig({ moduleListPath: e.target.value })}
            placeholder="选择或输入 module list 文件路径..."
            className={cn(
              'flex-1 rounded-md border border-border bg-background px-3 py-1.5 font-mono text-xs',
              'focus:outline-none focus:ring-1 focus:ring-primary',
            )}
          />
          <button
            onClick={handleBrowseModuleList}
            className="flex items-center gap-1 rounded-md border border-border px-2 text-xs text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
          >
            <FolderOpen className="h-3.5 w-3.5" />
            浏览
          </button>
        </div>
        <p className="text-[10px] text-muted-foreground">
          指定目标 Module 列表文件，脚本将仅生成列表中的 module IO
        </p>
      </div>

      {/* ── Optional: -target_scope (Target Scope hierarchy path) ── */}
      <div className="space-y-1.5">
        <div className="flex items-center gap-1">
          <span className="text-xs font-medium">Target Scope</span>
          <span className="rounded bg-muted px-1.5 py-0.5 text-[10px] text-muted-foreground">可选</span>
          <span className="ml-auto rounded bg-info/10 px-1.5 py-0.5 text-[10px] font-mono text-info-foreground">-target_scope</span>
        </div>
        <div className="flex items-center gap-2">
          <input
            type="text"
            value={config.targetScope}
            onChange={(e) => updateConfig({ targetScope: e.target.value })}
            placeholder="输入 hierarchy 层级路径，如 tb_top.chip.dut.u_sys_cpu"
            className={cn(
              'flex-1 rounded-md border border-border bg-background px-3 py-1.5 font-mono text-xs',
              'focus:outline-none focus:ring-1 focus:ring-primary',
            )}
          />
        </div>
        <p className="text-[10px] text-muted-foreground">
          指定目标层级路径（hierarchy path），用于限定 Module IO 生成的范围
        </p>
      </div>

      {/* Generate button */}
      <div className="flex items-center gap-2">
        <button
          onClick={() => void handleGenerate()}
          disabled={modIoLoading || !config.filelistPath || !hasModule}
          className={cn(
            'flex items-center gap-1.5 rounded-md border px-3 py-1.5 text-xs font-medium transition-colors',
            genStatus === 'success'
              ? 'border-status-pass/30 bg-status-pass/10 text-status-pass-foreground'
              : 'border-primary/30 bg-primary/10 text-primary hover:bg-primary/20',
            'disabled:opacity-50',
          )}
        >
          {modIoLoading ? (
            <Loader2 className="h-3.5 w-3.5 animate-spin" />
          ) : genStatus === 'success' ? (
            <Cpu className="h-3.5 w-3.5" />
          ) : (
            <Play className="h-3.5 w-3.5" />
          )}
          {modIoLoading ? '生成中...' : '生成 Module IO'}
        </button>
        {genStatus === 'success' && (
          <span className="flex items-center gap-1 text-[10px] text-status-pass-foreground">
            <Cpu className="h-3 w-3" />
            已生成
          </span>
        )}
        {genStatus === 'failed' && (
          <span className="flex items-center gap-1 text-[10px] text-status-fail-foreground">
            <AlertTriangle className="h-3 w-3" />
            生成失败
          </span>
        )}
      </div>

      {/* Terminal output */}
      {(modIoLogs.length > 0 || modIoLoading) && (
        <div className="overflow-hidden rounded-md border border-border">
          <div className="flex items-center justify-between border-b bg-secondary/30 px-3 py-1.5">
            <div className="flex items-center gap-1.5">
              <Terminal className="h-3 w-3 text-muted-foreground" />
              <span className="text-[11px] font-semibold">执行输出</span>
            </div>
            {modIoLoading && (
              <span className="flex items-center gap-1 text-[10px] text-muted-foreground">
                <Loader2 className="h-2.5 w-2.5 animate-spin" />
                运行中
              </span>
            )}
          </div>
          <div
            ref={logRef}
            className="max-h-48 overflow-y-auto bg-zinc-950 p-3 font-mono text-[10px] leading-relaxed text-zinc-300"
          >
            {modIoLogs.length === 0 && modIoLoading && (
              <div className="text-zinc-500">等待输出...</div>
            )}
            {modIoLogs.map((line, i) => (
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

      {/* Output file path */}
      <div className="space-y-1.5">
        <div className="flex items-center gap-1">
          <span className="text-xs font-medium">输出文件路径</span>
          <span className="ml-auto rounded bg-info/10 px-1.5 py-0.5 text-[10px] font-mono text-info-foreground">-mod_io</span>
        </div>
        <div className="flex items-center gap-2">
          <input
            type="text"
            value={config.modIoPath}
            onChange={(e) => updateConfig({ modIoPath: e.target.value })}
            placeholder="生成后自动填充，或手动输入路径..."
            className={cn(
              'flex-1 rounded-md border border-border bg-background px-3 py-1.5 font-mono text-xs',
              'focus:outline-none focus:ring-1 focus:ring-primary',
            )}
          />
          {config.modIoPath && (
            <FileText className="h-3.5 w-3.5 shrink-0 text-status-pass-foreground" />
          )}
        </div>
        <p className="text-[10px] text-muted-foreground">
          默认输出为 <code className="font-mono">getModIO.log</code>，生成成功后自动填充
        </p>
      </div>
    </div>
  );
}
