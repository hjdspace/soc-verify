/**
 * StepRtl — Step 2: RTL top-level file selection + module name extraction.
 *
 * Lists all .v files from $PROJ_RTL/<subsys>/design/rtl/top/. When a file is
 * selected, the module name is auto-extracted via `extractModuleName` tRPC
 * procedure. A browse button allows manual file selection.
 */

import { useEffect, useCallback } from 'react';
import { FileCode, FolderOpen, AlertTriangle, CheckCircle2, Loader2 } from 'lucide-react';
import { useSysbaseGenStore } from '@renderer/stores/sysbase-gen';
import { trpc } from '@renderer/lib/trpc';
import { cn } from '@renderer/lib/utils';

export function StepRtl() {
  const config = useSysbaseGenStore((s) => s.config);
  const updateConfig = useSysbaseGenStore((s) => s.updateConfig);
  const rtlFiles = useSysbaseGenStore((s) => s.rtlFiles);
  const rtlLoading = useSysbaseGenStore((s) => s.rtlLoading);
  const rtlError = useSysbaseGenStore((s) => s.rtlError);
  const setRtlFiles = useSysbaseGenStore((s) => s.setRtlFiles);
  const setRtlLoading = useSysbaseGenStore((s) => s.setRtlLoading);
  const setRtlError = useSysbaseGenStore((s) => s.setRtlError);

  // Load RTL files when subsys/chip is set
  const loadRtlFiles = useCallback(async (subsys: string) => {
    if (!subsys) {
      setRtlFiles([]);
      return;
    }
    setRtlLoading(true);
    setRtlError(null);
    try {
      const result = await trpc.tools.sysbaseGen.listRtlFiles.query({ subsys });
      setRtlFiles(result.files);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      setRtlError(msg);
      setRtlFiles([]);
    }
  }, [setRtlFiles, setRtlLoading, setRtlError]);

  // Auto-load on mount
  useEffect(() => {
    void loadRtlFiles(config.subsys);
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  // Extract module name when a file is selected
  const handleSelectFile = useCallback(async (filePath: string) => {
    updateConfig({ rtlFile: filePath, moduleName: '' });
    try {
      const result = await trpc.tools.sysbaseGen.extractModuleName.query({ filePath });
      updateConfig({ moduleName: result.moduleName ?? '' });
    } catch {
      updateConfig({ moduleName: '' });
    }
  }, [updateConfig]);

  // Browse for file manually
  const handleBrowse = async () => {
    try {
      const result = await trpc.tools.selectFiles.mutate({
        title: '选择 RTL 顶层文件',
        filters: [{ name: 'Verilog 文件', extensions: ['v'] }],
      });
      if (result.paths.length > 0) {
        const filePath = result.paths[0];
        await handleSelectFile(filePath);
      }
    } catch {
      // best-effort
    }
  };

  const selectedFileName = config.rtlFile
    ? config.rtlFile.split(/[\\/]/).pop()
    : '';

  return (
    <div className="space-y-4">
      {/* Callout */}
      <div className={cn(
        'flex items-start gap-2 rounded-md border p-3 text-xs',
        rtlError
          ? 'border-status-fail/30 bg-status-fail/5 text-status-fail-foreground'
          : 'border-warning/30 bg-warning/5 text-warning-foreground',
      )}>
        <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
        <span>
          {rtlError
            ? rtlError
            : `从 $PROJ_RTL/${config.subsys || '<subsys>'}/design/rtl/top/ 目录下选择顶层 .v 文件`}
        </span>
      </div>

      {/* RTL file path + browse */}
      <div className="space-y-1.5">
        <div className="flex items-center gap-1">
          <span className="text-xs font-medium">DUT 顶层文件 (.v)</span>
          <span className="text-destructive">*</span>
          <span className="ml-auto rounded bg-info/10 px-1.5 py-0.5 text-[10px] font-mono text-info-foreground">-rtl</span>
        </div>
        <div className="flex gap-1">
          <input
            type="text"
            value={config.rtlFile}
            onChange={(e) => updateConfig({ rtlFile: e.target.value })}
            placeholder="选择下方文件或手动输入路径..."
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

      {/* File list */}
      <div className="space-y-1">
        <p className="text-[10px] text-muted-foreground">
          扫描 $PROJ_RTL/{config.subsys || '<subsys>'}/design/rtl/top/ 下的 .v 文件：
        </p>

        {rtlLoading && (
          <div className="flex items-center gap-2 py-4 text-xs text-muted-foreground">
            <Loader2 className="h-3.5 w-3.5 animate-spin" />
            扫描中...
          </div>
        )}

        {!rtlLoading && rtlFiles.length === 0 && !rtlError && (
          <div className="rounded-md border border-dashed border-border/50 py-4 text-center text-xs text-muted-foreground">
            未找到 .v 文件
          </div>
        )}

        {!rtlLoading && rtlFiles.length > 0 && (
          <div className="space-y-1">
            {rtlFiles.map((file) => {
              const isSelected = config.rtlFile === file.path;
              return (
                <button
                  key={file.path}
                  onClick={() => void handleSelectFile(file.path)}
                  className={cn(
                    'flex w-full items-center gap-2 rounded-md border px-3 py-2 text-left text-xs transition-colors',
                    isSelected
                      ? 'border-primary/30 bg-primary/10 text-foreground'
                      : 'border-border/50 bg-background/40 text-muted-foreground hover:bg-accent/30 hover:text-foreground',
                  )}
                >
                  <FileCode className="h-4 w-4 shrink-0 opacity-60" />
                  <span className="font-mono font-medium">{file.name}</span>
                  {isSelected && config.moduleName && (
                    <span className="flex items-center gap-1 rounded bg-status-pass/10 px-1.5 py-0.5 text-[10px] text-status-pass-foreground">
                      <CheckCircle2 className="h-2.5 w-2.5" />
                      module: {config.moduleName}
                    </span>
                  )}
                  <span className="ml-auto truncate text-[10px] opacity-50">
                    {file.path}
                  </span>
                </button>
              );
            })}
          </div>
        )}
      </div>

      {/* Module name (auto-extracted) */}
      {config.rtlFile && (
        <div className="space-y-1.5">
          <div className="flex items-center gap-1">
            <span className="text-xs font-medium">Module 名（自动提取）</span>
          </div>
          <div className="flex items-center gap-2">
            <input
              type="text"
              value={config.moduleName}
              readOnly
              placeholder="未检测到 module 声明"
              className={cn(
                'flex-1 rounded-md border border-border bg-background/50 px-3 py-1.5 font-mono text-xs opacity-70',
              )}
            />
            {config.moduleName && (
              <span className="rounded bg-status-pass/10 px-1.5 py-0.5 text-[10px] text-status-pass-foreground">
                已提取
              </span>
            )}
          </div>
          <p className="text-[10px] text-muted-foreground">
            选中文件: {selectedFileName}
          </p>
        </div>
      )}
    </div>
  );
}
