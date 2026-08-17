/**
 * StepOptional — Optional parameters step.
 *
 * Subsys mode (Step 8): pinlist + dmalist + output dir.
 * Top mode (Step 5): output dir only (no pinlist/dmalist).
 *
 * Provides:
 *   - pinlist file path (optional, subsys only) + browse button
 *   - dmalist file path (optional, subsys only) + browse button
 *   - output directory (required, default ./) + browse button
 *   - Parameter explanation callout
 */

import { FolderOpen, Info, FileText } from 'lucide-react';
import { useSysbaseGenStore } from '@renderer/stores/sysbase-gen';
import { trpc } from '@renderer/lib/trpc';
import { cn } from '@renderer/lib/utils';

export function StepOptional() {
  const config = useSysbaseGenStore((s) => s.config);
  const updateConfig = useSysbaseGenStore((s) => s.updateConfig);
  const isTopLevel = config.genLevel === 'top';

  // Browse for pinlist file
  const handleBrowsePinlist = async () => {
    try {
      const result = await trpc.tools.selectFiles.mutate({
        title: '选择 Pinlist 文件',
        filters: [
          { name: 'Pinlist 文件', extensions: ['txt', 'list', 'csv'] },
          { name: '所有文件', extensions: ['*'] },
        ],
      });
      if (result.paths.length > 0) {
        updateConfig({ pinlistPath: result.paths[0] });
      }
    } catch {
      // best-effort
    }
  };

  // Browse for dmalist file
  const handleBrowseDmalist = async () => {
    try {
      const result = await trpc.tools.selectFiles.mutate({
        title: '选择 DMA List 文件',
        filters: [
          { name: 'DMA List 文件', extensions: ['txt', 'list', 'csv'] },
          { name: '所有文件', extensions: ['*'] },
        ],
      });
      if (result.paths.length > 0) {
        updateConfig({ dmalistPath: result.paths[0] });
      }
    } catch {
      // best-effort
    }
  };

  // Browse for output directory
  const handleBrowseOutputDir = async () => {
    try {
      const result = await trpc.tools.selectFiles.mutate({
        title: '选择输出目录',
        filters: [],
      });
      if (result.paths.length > 0) {
        updateConfig({ outputDir: result.paths[0] });
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
          {isTopLevel
            ? '输出目录为生成文件的存放路径。Top 级环境生成仅需要输出目录。'
            : '可选参数用于补充 Pin Mux 和 DMA 配置信息。未填写时将省略对应命令参数。输出目录为生成文件的存放路径。'}
        </span>
      </div>

      {/* pinlist (optional, subsys only) */}
      {!isTopLevel && (
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
            placeholder="可选，不填则省略 -pinlist 参数..."
            className={cn(
              'flex-1 rounded-md border border-border bg-background px-3 py-1.5 font-mono text-xs',
              'focus:outline-none focus:ring-1 focus:ring-primary',
            )}
          />
          <button
            onClick={handleBrowsePinlist}
            className="flex items-center gap-1 rounded-md border border-border px-2 text-xs text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
          >
            <FolderOpen className="h-3.5 w-3.5" />
            浏览
          </button>
        </div>
        {config.pinlistPath && (
          <div className="flex items-center gap-1.5 text-[10px] text-muted-foreground">
            <FileText className="h-3 w-3" />
            <span className="truncate font-mono">{config.pinlistPath}</span>
          </div>
        )}
      </div>
      )}

      {/* dmalist (optional, subsys only) */}
      {!isTopLevel && (
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
            placeholder="可选，不填则省略 -dmalist 参数..."
            className={cn(
              'flex-1 rounded-md border border-border bg-background px-3 py-1.5 font-mono text-xs',
              'focus:outline-none focus:ring-1 focus:ring-primary',
            )}
          />
          <button
            onClick={handleBrowseDmalist}
            className="flex items-center gap-1 rounded-md border border-border px-2 text-xs text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
          >
            <FolderOpen className="h-3.5 w-3.5" />
            浏览
          </button>
        </div>
        {config.dmalistPath && (
          <div className="flex items-center gap-1.5 text-[10px] text-muted-foreground">
            <FileText className="h-3 w-3" />
            <span className="truncate font-mono">{config.dmalistPath}</span>
          </div>
        )}
      </div>
      )}

      {/* output directory (required) */}
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
            placeholder="输出目录路径..."
            className={cn(
              'flex-1 rounded-md border border-border bg-background px-3 py-1.5 font-mono text-xs',
              'focus:outline-none focus:ring-1 focus:ring-primary',
            )}
          />
          <button
            onClick={handleBrowseOutputDir}
            className="flex items-center gap-1 rounded-md border border-border px-2 text-xs text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
          >
            <FolderOpen className="h-3.5 w-3.5" />
            浏览
          </button>
        </div>
        <p className="text-[10px] text-muted-foreground">
          默认为当前目录 <code className="font-mono">./</code>
        </p>
      </div>
    </div>
  );
}
