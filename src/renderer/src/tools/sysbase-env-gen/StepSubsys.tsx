/**
 * StepSubsys — Step 1: Subsys selection + instance name + script path.
 *
 * User selects a subsys from a dropdown of known names. The instance name
 * is auto-derived via `inferInstanceName` tRPC procedure and can be manually
 * overridden. The script path defaults to the standard location and is editable.
 */

import { useEffect, useCallback, useState } from 'react';
import { RefreshCw, FolderOpen, Info } from 'lucide-react';
import { useSysbaseGenStore } from '@renderer/stores/sysbase-gen';
import { useProjectStore } from '@renderer/stores/project';
import { KNOWN_SUBSYSTEMS } from '@shared/types';
import { trpc } from '@renderer/lib/trpc';
import { cn } from '@renderer/lib/utils';

export function StepSubsys() {
  const config = useSysbaseGenStore((s) => s.config);
  const scriptPath = useSysbaseGenStore((s) => s.scriptPath);
  const updateConfig = useSysbaseGenStore((s) => s.updateConfig);
  const setScriptPath = useSysbaseGenStore((s) => s.setScriptPath);
  const loading = useSysbaseGenStore((s) => s.loading);
  const projectId = useProjectStore((s) => s.currentProjectId);

  // 动态获取子系统列表，排除 usvp 伪子系统
  const [subsysOptions, setSubsysOptions] = useState<string[]>([...KNOWN_SUBSYSTEMS]);

  useEffect(() => {
    if (!projectId) return;
    void trpc.dashboard.getSubsysList.query({ projectId })
      .then((list) => {
        const filtered = list.filter((s) => s !== 'usvp' && s !== 'top');
        if (filtered.length > 0) setSubsysOptions(filtered);
      })
      .catch(() => {
        // 获取失败时保留硬编码列表作为回退
      });
  }, [projectId]);

  // Auto-infer instance name when subsys changes
  const inferInstance = useCallback(async (subsys: string) => {
    if (!subsys) {
      updateConfig({ subsys: '', instanceName: '' });
      return;
    }
    updateConfig({ subsys });
    try {
      const result = await trpc.tools.sysbaseGen.inferInstanceName.query({ subsys });
      // Only auto-fill if the user hasn't manually overridden
      updateConfig({ instanceName: result.instanceName });
    } catch {
      // Fallback: derive locally (strip _sys, prepend u_sys_)
      const prefix = subsys.endsWith('_sys') ? subsys.slice(0, -4) : subsys;
      updateConfig({ instanceName: `u_sys_${prefix}` });
    }
  }, [updateConfig]);

  // Auto-infer on mount if subsys is already set (e.g. from loaded config)
  useEffect(() => {
    if (config.subsys && !config.instanceName) {
      void inferInstance(config.subsys);
    }
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  const handleBrowseScript = async () => {
    try {
      const result = await trpc.tools.selectFiles.mutate({
        title: '选择 sysbase_gen.py 脚本',
        filters: [{ name: 'Python 脚本', extensions: ['py'] }],
      });
      if (result.paths.length > 0) {
        setScriptPath(result.paths[0]);
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
          Subsys 名称需与项目仓库名一致，保证所有环节的 subsys name 统一。
          例化名用于在 top 上例化 DUT 时的命名。
        </span>
      </div>

      {/* Two-column: Subsys + Instance Name */}
      <div className="grid grid-cols-2 gap-4">
        {/* Subsys dropdown */}
        <div className="space-y-1.5">
          <div className="flex items-center gap-1">
            <span className="text-xs font-medium">Subsystem 名称</span>
            <span className="text-destructive">*</span>
            <span className="ml-auto rounded bg-info/10 px-1.5 py-0.5 text-[10px] font-mono text-info-foreground">-n</span>
          </div>
          <select
            value={config.subsys}
            onChange={(e) => void inferInstance(e.target.value)}
            className={cn(
              'w-full rounded-md border border-border bg-background px-3 py-1.5 text-xs',
              'focus:outline-none focus:ring-1 focus:ring-primary',
            )}
          >
            <option value="">请选择 Subsys...</option>
            {subsysOptions.map((s) => (
              <option key={s} value={s}>{s}</option>
            ))}
          </select>
          <p className="text-[10px] text-muted-foreground">从项目数据库动态获取，已排除 usvp 伪子系统和 top</p>
        </div>

        {/* Instance name */}
        <div className="space-y-1.5">
          <div className="flex items-center gap-1">
            <span className="text-xs font-medium">例化名 (Instance Name)</span>
            <span className="text-destructive">*</span>
            <span className="ml-auto rounded bg-info/10 px-1.5 py-0.5 text-[10px] font-mono text-info-foreground">-i</span>
          </div>
          <div className="flex gap-1">
            <input
              type="text"
              value={config.instanceName}
              onChange={(e) => updateConfig({ instanceName: e.target.value })}
              placeholder="自动生成，可修改..."
              className={cn(
                'flex-1 rounded-md border border-border bg-background px-3 py-1.5 font-mono text-xs',
                'focus:outline-none focus:ring-1 focus:ring-primary',
              )}
            />
            <button
              onClick={() => void inferInstance(config.subsys)}
              disabled={!config.subsys || loading}
              title="重新推导"
              className="flex items-center justify-center rounded-md border border-border px-2 text-muted-foreground transition-colors hover:bg-accent hover:text-foreground disabled:opacity-30"
            >
              <RefreshCw className={cn('h-3.5 w-3.5', loading && 'animate-spin')} />
            </button>
          </div>
          <p className="text-[10px] text-muted-foreground">规则：apcpu_sys → u_sys_apcpu</p>
        </div>
      </div>

      {/* Script path */}
      <div className="space-y-1.5">
        <div className="flex items-center gap-1">
          <span className="text-xs font-medium">脚本路径 (sysbase_gen.py)</span>
          <span className="ml-auto rounded bg-muted px-1.5 py-0.5 text-[10px] text-muted-foreground">可修改</span>
        </div>
        <div className="flex gap-1">
          <input
            type="text"
            value={scriptPath}
            onChange={(e) => setScriptPath(e.target.value)}
            className={cn(
              'flex-1 rounded-md border border-border bg-background px-3 py-1.5 font-mono text-xs',
              'focus:outline-none focus:ring-1 focus:ring-primary',
            )}
          />
          <button
            onClick={handleBrowseScript}
            className="flex items-center gap-1 rounded-md border border-border px-2 text-xs text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
          >
            <FolderOpen className="h-3.5 w-3.5" />
            浏览
          </button>
        </div>
        <p className="text-[10px] text-muted-foreground">默认路径，可修改为其他版本</p>
      </div>
    </div>
  );
}
