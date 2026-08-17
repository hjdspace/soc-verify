/**
 * StepOptional — Step 8: Optional parameters (Pinlist / DMA List) + Output directory.
 *
 * Provides:
 *   - Pinlist file path input + browse button (optional, `-pinlist`)
 *   - DMA List file path input + browse button (optional, `-dmalist`)
 *   - Output directory input + browse button (required, `-o`)
 *
 * Pinlist and DMA List are optional configuration items that some subsys
 * may need. Output directory is always required — it determines where
 * sysbase_gen.py writes generated files.
 */

import { useCallback } from 'react';
import { FolderOpen, Info, FileText, Folder, CheckCircle2 } from 'lucide-react';
import { useSysbaseGenStore } from '@renderer/stores/sysbase-gen';
import { trpc } from '@renderer/lib/trpc';
import { cn } from '@renderer/lib/utils';

export function StepOptional() {
  const config = useSysbaseGenStore((s) => s.config);
  const updateConfig = useSysbaseGenStore((s) => s.updateConfig);

  // ── Pinlist file browse ──
  const handleBrowsePinlist = useCallback(async () => {
    try {
      const result = await trpc.tools.selectFiles.mutate({
        title: '选择 Pinlist 文件',
        filters: [
          { name: 'Pinlist 文件', extensions: ['f', 'flist', 'txt', 'vc'] },
          { name: '所有文件', extensions: ['*'] },
        ],
      });
      if (result.paths.length > 0) {
        updateConfig({ pinlistPath: result.paths[0] });
      }
    } catch {
      // best-effort
    }
  }, [updateConfig]);

  // ── DMA List file browse ──
  const handleBrowseDmalist = useCallback(async () => {
    try {
      const result = await trpc.tools.selectFiles.mutate({
        title: '选择 DMA List 文件',
        filters: [
          { name: 'DMA List 文件', extensions: ['f', 'flist', 'txt', 'vc'] },
          { name: '所有文件', extensions: ['*'] },
        ],
      });
      if (result.paths.length > 0) {
        updateConfig({ dmalistPath: result.paths[0] });
      }
    } catch {
      // best-effort
    }
  }, [updateConfig]);

  // ── Output directory browse ──
  const handleBrowseOutputDir = useCallback(async () => {
    try {
      const result = await trpc.tools.selectDirectory.mutate({
        title: '选择输出目录',
      });
      if (result.path) {
        updateConfig({ outputDir: result.path });
      }
    } catch {
      // best-effort
    }
  }, [updateConfig]);

  return (
    <div className="space-y-4">
      {/* Callout */}
      <div className="flex items-start gap-2 rounded-md border border-info/30 bg-info/5 p-3 text-xs text-info-foreground">
        <Info className="mt-0.5 h-3.5 w-3.5 shrink-0" />
        <span>
          Pinlist 和 DMA List 为可选项，某些 subsys 可能需要配置。输出目录为必填项，
          决定 <code className="font-mono">sysbase_gen.py</code> 生成文件的存放位置。
        </span>
      </div>

      {/* Pinlist file (optional) */}
      <div className="space-y-1.5">
        <div className="flex items-center gap-1">
          <span className="text-xs font-medium">Pinlist 文件路径</span>
          <span className="rounded bg-muted px-1.5 py-0.5 text-[10px] text-muted-foreground">可选</span>
          <span className="ml-auto rounded bg-info/10 px-1.5 py-0.5 text-[10px] font-mono text-info-foreground">-pinlist</span>
        </div>
        <div className="flex gap-1">
          <input
            type="text"
            value={config.pinlistPath}
            onChange={(e) => updateConfig({ pinlistPath: e.target.value })}
            placeholder="选择或输入 pinlist 文件路径，不需要时可留空..."
            className={cn(
              'flex-1 rounded-md border border-border bg-background px-3 py-1.5 font-mono text-xs',
              'focus:outline-none focus:ring-1 focus:ring-primary',
            )}
          />
          <button
            onClick={() => void handleBrowsePinlist()}
            className="flex items-center gap-1 rounded-md border border-border px-2 text-xs text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
          >
            <FolderOpen className="h-3.5 w-3.5" />
            浏览
          </button>
        </div>
      </div>

      {/* DMA List file (optional) */}
      <div className="space-y-1.5">
        <div className="flex items-center gap-1">
          <span className="text-xs font-medium">DMA List 文件路径</span>
          <span className="rounded bg-muted px-1.5 py-0.5 text-[10px] text-muted-foreground">可选</span>
          <span className="ml-auto rounded bg-info/10 px-1.5 py-0.5 text-[10px] font-mono text-info-foreground">-dmalist</span>
        </div>
        <div className="flex gap-1">
          <input
            type="text"
            value={config.dmalistPath}
            onChange={(e) => updateConfig({ dmalistPath: e.target.value })}
            placeholder="选择或输入 DMA list 文件路径，不需要时可留空..."
            className={cn(
              'flex-1 rounded-md border border-border bg-background px-3 py-1.5 font-mono text-xs',
              'focus:outline-none focus:ring-1 focus:ring-primary',
            )}
          />
          <button
            onClick={() => void handleBrowseDmalist()}
            className="flex items-center gap-1 rounded-md border border-border px-2 text-xs text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
          >
            <FolderOpen className="h-3.5 w-3.5" />
            浏览
          </button>
        </div>
      </div>

      {/* Output directory (required) */}
      <div className="space-y-1.5">
        <div className="flex items-center gap-1">
          <span className="text-xs font-medium">输出目录</span>
          <span className="text-destructive">*</span>
          <span className="ml-auto rounded bg-info/10 px-1.5 py-0.5 text-[10px] font-mono text-info-foreground">-o</span>
        </div>
        <div className="flex gap-1">
          <input
            type="text"
            value={config.outputDir}
            onChange={(e) => updateConfig({ outputDir: e.target.value })}
            placeholder="选择或输入输出目录路径..."
            className={cn(
              'flex-1 rounded-md border border-border bg-background px-3 py-1.5 font-mono text-xs',
              'focus:outline-none focus:ring-1 focus:ring-primary',
            )}
          />
          <button
            onClick={() => void handleBrowseOutputDir()}
            className="flex items-center gap-1 rounded-md border border-border px-2 text-xs text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
          >
            <FolderOpen className="h-3.5 w-3.5" />
            浏览
          </button>
        </div>
        {config.outputDir.trim() !== '' ? (
          <div className="flex items-center gap-2 rounded-md border border-status-pass/20 bg-status-pass/5 px-3 py-1.5 text-xs">
            {config.outputDir.includes('.') || config.outputDir.includes('/') ? (
              <Folder className="h-3.5 w-3.5 shrink-0 text-status-pass-foreground" />
            ) : (
              <CheckCircle2 className="h-3.5 w-3.5 shrink-0 text-status-pass-foreground" />
            )}
            <span className="truncate font-mono">{config.outputDir}</span>
          </div>
        ) : null}
      </div>

      {/* Summary indicator */}
      {(config.pinlistPath || config.dmalistPath) && (
        <div className="flex items-start gap-2 rounded-md border border-info/20 bg-info/5 p-3 text-xs text-info-foreground">
          <FileText className="mt-0.5 h-3.5 w-3.5 shrink-0" />
          <div className="space-y-0.5">
            {config.pinlistPath && (
              <div className="flex items-center gap-2">
                <span className="font-mono text-[10px] text-muted-foreground">-pinlist</span>
                <span className="truncate font-mono text-[11px]">{config.pinlistPath}</span>
              </div>
            )}
            {config.dmalistPath && (
              <div className="flex items-center gap-2">
                <span className="font-mono text-[10px] text-muted-foreground">-dmalist</span>
                <span className="truncate font-mono text-[11px]">{config.dmalistPath}</span>
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
