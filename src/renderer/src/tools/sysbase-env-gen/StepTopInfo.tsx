/**
 * StepTopInfo — Step 1 for top-level: Chip name + instance name + script path.
 *
 * For top-level env generation:
 *   - Chip name (-n) defaults to "top", user can override
 *   - Instance name (-i) defaults to "dut" per the Makefile example
 *   - Script path is editable (same as subsys mode)
 */

import { useEffect } from 'react';
import { Info, FolderOpen } from 'lucide-react';
import { useSysbaseGenStore } from '@renderer/stores/sysbase-gen';
import { trpc } from '@renderer/lib/trpc';
import { cn } from '@renderer/lib/utils';

export function StepTopInfo() {
  const config = useSysbaseGenStore((s) => s.config);
  const scriptPath = useSysbaseGenStore((s) => s.scriptPath);
  const updateConfig = useSysbaseGenStore((s) => s.updateConfig);
  const setScriptPath = useSysbaseGenStore((s) => s.setScriptPath);

  // Initialize defaults for top level on mount if empty
  useEffect(() => {
    if (config.genLevel === 'top' && !config.subsys) {
      updateConfig({ subsys: 'top', instanceName: 'dut' });
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
          Top 级环境生成用于整颗芯片的 SoC 验证环境。
          Chip 名一般与仓名一致（如 <code className="font-mono">top</code>），
          例化名默认为 <code className="font-mono">dut</code>。
          命令参数较 subsys 级精简：仅 -rtl -n -i -c -ral -o。
        </span>
      </div>

      {/* Two-column: Chip Name + Instance Name */}
      <div className="grid grid-cols-2 gap-4">
        {/* Chip name */}
        <div className="space-y-1.5">
          <div className="flex items-center gap-1">
            <span className="text-xs font-medium">Chip 名称</span>
            <span className="text-destructive">*</span>
            <span className="ml-auto rounded bg-info/10 px-1.5 py-0.5 text-[10px] font-mono text-info-foreground">-n</span>
          </div>
          <input
            type="text"
            value={config.subsys}
            onChange={(e) => updateConfig({ subsys: e.target.value })}
            placeholder="chip 名称..."
            className={cn(
              'w-full rounded-md border border-border bg-background px-3 py-1.5 font-mono text-xs',
              'focus:outline-none focus:ring-1 focus:ring-primary',
            )}
          />
          <p className="text-[10px] text-muted-foreground">默认为 top，一般与仓名一致</p>
        </div>

        {/* Instance name */}
        <div className="space-y-1.5">
          <div className="flex items-center gap-1">
            <span className="text-xs font-medium">例化名 (Instance Name)</span>
            <span className="text-destructive">*</span>
            <span className="ml-auto rounded bg-info/10 px-1.5 py-0.5 text-[10px] font-mono text-info-foreground">-i</span>
          </div>
          <input
            type="text"
            value={config.instanceName}
            onChange={(e) => updateConfig({ instanceName: e.target.value })}
            placeholder="例化名..."
            className={cn(
              'w-full rounded-md border border-border bg-background px-3 py-1.5 font-mono text-xs',
              'focus:outline-none focus:ring-1 focus:ring-primary',
            )}
          />
          <p className="text-[10px] text-muted-foreground">默认为 dut（例化 DUT 时的命名）</p>
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
