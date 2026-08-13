/**
 * StepRal — Step 5: RAL directory auto-inference + manual add/remove.
 *
 * Scans $PROJ_RTL/<subsys>/design/spec/ and $PROJ_RTL/<subsys>/design/rtl/
 * for directories containing both `for_de` and `for_dv` subdirectories.
 * Supports manual add/remove of directory entries.
 */

import { useState, useCallback } from 'react';
import { FolderSearch, Plus, X, CheckCircle2, Loader2, AlertTriangle, Info, Folder } from 'lucide-react';
import { useSysbaseGenStore } from '@renderer/stores/sysbase-gen';
import { trpc } from '@renderer/lib/trpc';
import { cn } from '@renderer/lib/utils';

export function StepRal() {
  const config = useSysbaseGenStore((s) => s.config);
  const updateConfig = useSysbaseGenStore((s) => s.updateConfig);
  const ralLoading = useSysbaseGenStore((s) => s.ralLoading);
  const ralError = useSysbaseGenStore((s) => s.ralError);
  const setRalLoading = useSysbaseGenStore((s) => s.setRalLoading);
  const setRalError = useSysbaseGenStore((s) => s.setRalError);

  const [manualDir, setManualDir] = useState('');
  const [inferred, setInferred] = useState(false);

  const handleInfer = useCallback(async () => {
    if (!config.subsys) return;
    setRalLoading(true);
    setRalError(null);
    try {
      const result = await trpc.tools.sysbaseGen.inferRalDirs.query({ subsys: config.subsys });
      updateConfig({ ralDirs: result.dirs });
      setInferred(true);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      setRalError(msg);
    }
  }, [config.subsys, updateConfig, setRalLoading, setRalError]);

  const handleAddManual = () => {
    const dir = manualDir.trim();
    if (!dir) return;
    if (!config.ralDirs.includes(dir)) {
      updateConfig({ ralDirs: [...config.ralDirs, dir] });
    }
    setManualDir('');
  };

  const handleRemove = (dir: string) => {
    updateConfig({ ralDirs: config.ralDirs.filter((d) => d !== dir) });
  };

  return (
    <div className="space-y-4">
      {/* Callout */}
      <div className="flex items-start gap-2 rounded-md border border-info/30 bg-info/5 p-3 text-xs text-info-foreground">
        <Info className="mt-0.5 h-3.5 w-3.5 shrink-0" />
        <span>
          RAL 目录需同时包含 <code className="font-mono">for_de</code> 和 <code className="font-mono">for_dv</code>
          子目录。自动推导扫描 spec/ 和 rtl/ 两个根目录（最大深度 5）。
        </span>
      </div>

      {/* Error */}
      {ralError && (
        <div className="flex items-start gap-2 rounded-md border border-status-fail/30 bg-status-fail/5 p-3 text-xs text-status-fail-foreground">
          <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
          <span>{ralError}</span>
        </div>
      )}

      {/* Infer button + status */}
      <div className="flex items-center gap-3">
        <button
          onClick={() => void handleInfer()}
          disabled={ralLoading || !config.subsys}
          className={cn(
            'flex items-center gap-1.5 rounded-md border border-primary/30 bg-primary/10 px-3 py-1.5 text-xs text-primary transition-colors hover:bg-primary/20',
            'disabled:opacity-50',
          )}
        >
          {ralLoading ? (
            <Loader2 className="h-3.5 w-3.5 animate-spin" />
          ) : (
            <FolderSearch className="h-3.5 w-3.5" />
          )}
          一键自动推导
        </button>

        {inferred && !ralLoading && (
          <span className="flex items-center gap-1 rounded bg-status-pass/10 px-2 py-1 text-[10px] text-status-pass-foreground">
            <CheckCircle2 className="h-3 w-3" />
            已推导 {config.ralDirs.length} 个目录
          </span>
        )}

        <span className="ml-auto rounded bg-info/10 px-1.5 py-0.5 text-[10px] font-mono text-info-foreground">-ral</span>
      </div>

      {/* Directory list */}
      <div className="space-y-1">
        {config.ralDirs.length === 0 && !ralLoading && (
          <div className="rounded-md border border-dashed border-border/50 py-4 text-center text-xs text-muted-foreground">
            点击「一键自动推导」或手动添加 RAL 目录
          </div>
        )}

        {config.ralDirs.length > 0 && (
          <div className="space-y-1">
            {config.ralDirs.map((dir) => (
              <div
                key={dir}
                className="flex items-center gap-2 rounded-md border border-border/50 bg-background/40 px-3 py-2 text-xs"
              >
                <Folder className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
                <span className="flex-1 truncate font-mono text-[11px]">{dir}</span>
                <span className="flex items-center gap-1 text-[10px] text-status-pass-foreground">
                  <CheckCircle2 className="h-2.5 w-2.5" />
                  for_de
                  <CheckCircle2 className="ml-1 h-2.5 w-2.5" />
                  for_dv
                </span>
                <button
                  onClick={() => handleRemove(dir)}
                  className="flex items-center justify-center rounded p-0.5 text-muted-foreground transition-colors hover:bg-destructive/10 hover:text-destructive"
                >
                  <X className="h-3.5 w-3.5" />
                </button>
              </div>
            ))}
          </div>
        )}
      </div>

      {/* Manual add */}
      <div className="space-y-1.5">
        <div className="flex items-center gap-1">
          <span className="text-xs font-medium">手动添加目录</span>
        </div>
        <div className="flex gap-1">
          <input
            type="text"
            value={manualDir}
            onChange={(e) => setManualDir(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') handleAddManual();
            }}
            placeholder="输入目录路径..."
            className={cn(
              'flex-1 rounded-md border border-border bg-background px-3 py-1.5 font-mono text-xs',
              'focus:outline-none focus:ring-1 focus:ring-primary',
            )}
          />
          <button
            onClick={handleAddManual}
            disabled={!manualDir.trim()}
            className="flex items-center gap-1 rounded-md border border-border px-2 text-xs text-muted-foreground transition-colors hover:bg-accent hover:text-foreground disabled:opacity-30"
          >
            <Plus className="h-3.5 w-3.5" />
            添加
          </button>
        </div>
      </div>
    </div>
  );
}
