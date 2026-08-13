/**
 * StepClk — Step 6: CLK directory auto-inference + manual browse.
 *
 * Scans $PROJ_RTL/<subsys>/design/rtl/ for files containing `clk_max_cfg`
 * in their filename, returning the containing directory. CLK2 is optional
 * with format `<dePath>,<clkPrefix>`.
 */

import { useState, useCallback } from 'react';
import { FolderSearch, FolderOpen, AlertTriangle, Info, CheckCircle2, Loader2, Clock } from 'lucide-react';
import { useSysbaseGenStore } from '@renderer/stores/sysbase-gen';
import { trpc } from '@renderer/lib/trpc';
import { cn } from '@renderer/lib/utils';

export function StepClk() {
  const config = useSysbaseGenStore((s) => s.config);
  const updateConfig = useSysbaseGenStore((s) => s.updateConfig);
  const clkLoading = useSysbaseGenStore((s) => s.clkLoading);
  const clkError = useSysbaseGenStore((s) => s.clkError);
  const setClkLoading = useSysbaseGenStore((s) => s.setClkLoading);
  const setClkError = useSysbaseGenStore((s) => s.setClkError);

  const [inferredCount, setInferredCount] = useState(0);

  const handleInfer = useCallback(async () => {
    if (!config.subsys) return;
    setClkLoading(true);
    setClkError(null);
    try {
      const result = await trpc.tools.sysbaseGen.inferClkDirs.query({ subsys: config.subsys });
      setInferredCount(result.dirs.length);
      if (result.dirs.length > 0) {
        updateConfig({ clkDir: result.dirs[0] });
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      setClkError(msg);
    }
  }, [config.subsys, updateConfig, setClkLoading, setClkError]);

  const handleBrowse = async () => {
    try {
      const result = await trpc.tools.selectDirectory.mutate({
        title: '选择 CLK 目录',
      });
      if (result.path) {
        updateConfig({ clkDir: result.path });
      }
    } catch {
      // best-effort
    }
  };

  return (
    <div className="space-y-4">
      {/* Callout */}
      <div className="flex items-start gap-2 rounded-md border border-info/30 bg-info/5 p-3 text-xs text-info-foreground">
        <Info className="mt-0.5 h-3.5 w-3.5 shrink-0" />
        <span>
          CLK 目录通过扫描 rtl/ 下文件名包含 <code className="font-mono">clk_max_cfg</code> 的文件所在目录自动推导。
          CLK2 为可选项，格式为 <code className="font-mono">{'<de路径>,<clk文件名前缀>'}</code>。
        </span>
      </div>

      {/* Error */}
      {clkError && (
        <div className="flex items-start gap-2 rounded-md border border-status-fail/30 bg-status-fail/5 p-3 text-xs text-status-fail-foreground">
          <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
          <span>{clkError}</span>
        </div>
      )}

      {/* CLK directory */}
      <div className="space-y-1.5">
        <div className="flex items-center gap-1">
          <span className="text-xs font-medium">CLK 目录</span>
          <span className="text-destructive">*</span>
          <span className="ml-auto rounded bg-info/10 px-1.5 py-0.5 text-[10px] font-mono text-info-foreground">-clk</span>
        </div>
        <div className="flex gap-1">
          <input
            type="text"
            value={config.clkDir}
            onChange={(e) => updateConfig({ clkDir: e.target.value })}
            placeholder="点击推导或浏览选择目录..."
            className={cn(
              'flex-1 rounded-md border border-border bg-background px-3 py-1.5 font-mono text-xs',
              'focus:outline-none focus:ring-1 focus:ring-primary',
            )}
          />
          <button
            onClick={() => void handleInfer()}
            disabled={clkLoading || !config.subsys}
            className={cn(
              'flex items-center gap-1 rounded-md border border-primary/30 bg-primary/10 px-2 text-xs text-primary transition-colors hover:bg-primary/20',
              'disabled:opacity-50',
            )}
          >
            {clkLoading ? (
              <Loader2 className="h-3.5 w-3.5 animate-spin" />
            ) : (
              <FolderSearch className="h-3.5 w-3.5" />
            )}
            推导
          </button>
          <button
            onClick={handleBrowse}
            className="flex items-center gap-1 rounded-md border border-border px-2 text-xs text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
          >
            <FolderOpen className="h-3.5 w-3.5" />
            浏览
          </button>
        </div>
        {inferredCount > 0 && !clkLoading && (
          <div className="flex items-center gap-1 text-[10px] text-status-pass-foreground">
            <CheckCircle2 className="h-3 w-3" />
            推导到 {inferredCount} 个 CLK 目录{inferredCount > 1 ? '，已选择第一个' : ''}
          </div>
        )}
      </div>

      {/* CLK2 (optional) */}
      <div className="space-y-1.5">
        <div className="flex items-center gap-1">
          <span className="text-xs font-medium">CLK2</span>
          <span className="rounded bg-muted px-1.5 py-0.5 text-[10px] text-muted-foreground">可选</span>
          <span className="ml-auto rounded bg-info/10 px-1.5 py-0.5 text-[10px] font-mono text-info-foreground">-clk2</span>
        </div>
        <div className="flex gap-1">
          <input
            type="text"
            value={config.clk2Dir}
            onChange={(e) => updateConfig({ clk2Dir: e.target.value })}
            placeholder="<de路径>,<clk文件名前缀>"
            className={cn(
              'flex-1 rounded-md border border-border bg-background px-3 py-1.5 font-mono text-xs',
              'focus:outline-none focus:ring-1 focus:ring-primary',
            )}
          />
        </div>
        <p className="text-[10px] text-muted-foreground">
          例如: /proj/rtl/clk_de,clk_max_cfg_apcpu
        </p>
      </div>

      {/* CLK info indicator */}
      {config.clkDir && (
        <div className="flex items-center gap-2 rounded-md border border-status-pass/20 bg-status-pass/5 px-3 py-1.5 text-xs">
          <Clock className="h-3.5 w-3.5 text-status-pass-foreground" />
          <span className="truncate font-mono">{config.clkDir}</span>
        </div>
      )}
    </div>
  );
}
