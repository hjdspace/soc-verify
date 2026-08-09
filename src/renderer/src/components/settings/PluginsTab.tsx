import { useEffect } from 'react';
import {
  AlertCircle,
  Box,
  ExternalLink,
  Loader2,
  Puzzle,
  RefreshCw,
} from 'lucide-react';
import type { PluginConfigEntry } from '@shared/types';
import { useProjectStore } from '@renderer/stores/project';
import { useUiStore } from '@renderer/stores/ui';
import { useWorkbenchStore } from '@renderer/stores/workbench';
import { cn } from '@renderer/lib/utils';

const KIND_LABELS: Record<PluginConfigEntry['kind'], string> = {
  'case-parser': '用例解析',
  'subsys-discoverer': '子系统发现',
  'coverage-parser': '覆盖率解析',
  'simulation-runner': '仿真执行',
  'sim-option-schema': '仿真选项',
  ui: '界面扩展',
};

const ORIGIN_LABELS = {
  builtin: '内置',
  user: '用户',
  project: '项目',
} as const;

function pluginStatus(plugin: PluginConfigEntry): {
  label: string;
  className: string;
} {
  if (plugin.error) {
    return { label: '加载失败', className: 'border-status-fail/30 bg-status-fail/10 text-status-fail-foreground' };
  }
  if (!plugin.enabled) {
    return { label: '已停用', className: 'border-border bg-muted text-muted-foreground' };
  }
  if (plugin.active) {
    return { label: '运行中', className: 'border-status-pass/30 bg-status-pass/10 text-status-pass-foreground' };
  }
  return { label: '已加载', className: 'border-primary/25 bg-primary/10 text-primary' };
}

export function PluginsTab() {
  const currentProjectId = useProjectStore((s) => s.currentProjectId);
  const plugins = useProjectStore((s) => s.plugins);
  const loading = useProjectStore((s) => s.pluginsLoading);
  const loadPlugins = useProjectStore((s) => s.loadPlugins);
  const reloadPlugins = useProjectStore((s) => s.reloadPlugins);
  const togglePlugin = useProjectStore((s) => s.togglePlugin);
  const openDestination = useWorkbenchStore((s) => s.open);
  const setSettingsOpen = useUiStore((s) => s.setSettingsOpen);

  useEffect(() => {
    if (currentProjectId) void loadPlugins(currentProjectId);
  }, [currentProjectId, loadPlugins]);

  const openView = (plugin: PluginConfigEntry, viewId: string, title: string) => {
    openDestination({ type: 'plugin-view', pluginId: plugin.id, viewId, title });
    setSettingsOpen(false);
  };

  if (!currentProjectId) {
    return (
      <div className="flex h-full min-h-72 flex-col items-center justify-center text-center">
        <Puzzle className="mb-3 h-8 w-8 text-muted-foreground/50" />
        <h3 className="text-sm font-medium">打开项目后管理插件</h3>
        <p className="mt-1 max-w-sm text-xs leading-relaxed text-muted-foreground">
          插件以项目为运行上下文。用户插件放在 ~/.socverify/plugins 的直接子目录中。
        </p>
      </div>
    );
  }

  return (
    <div className="flex min-h-full flex-col">
      <div className="flex shrink-0 items-start justify-between gap-4 border-b border-border/60 pb-3">
        <div className="min-w-0">
          <div className="flex items-center gap-2">
            <h3 className="text-sm font-semibold">已发现插件</h3>
            <span className="rounded border border-border bg-secondary/40 px-1.5 py-0.5 text-[10px] text-muted-foreground">
              {plugins.length}
            </span>
          </div>
          <p className="mt-1 text-[11px] text-muted-foreground">
            用户目录 <span className="font-mono text-foreground/80">~/.socverify/plugins</span>
          </p>
        </div>
        <button
          type="button"
          onClick={() => void reloadPlugins()}
          disabled={loading}
          className="flex h-8 shrink-0 items-center gap-1.5 rounded border border-border bg-background px-2.5 text-xs font-medium transition-colors hover:bg-accent focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring disabled:cursor-wait disabled:opacity-60"
        >
          {loading ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <RefreshCw className="h-3.5 w-3.5" />}
          重新扫描
        </button>
      </div>

      {loading && plugins.length === 0 ? (
        <div className="space-y-2 py-4" aria-label="正在加载插件">
          {[0, 1, 2].map((item) => (
            <div key={item} className="h-16 animate-pulse rounded bg-muted/60" />
          ))}
        </div>
      ) : plugins.length === 0 ? (
        <div className="flex min-h-64 flex-col items-center justify-center text-center">
          <Box className="mb-3 h-8 w-8 text-muted-foreground/50" />
          <h3 className="text-sm font-medium">未发现插件</h3>
          <p className="mt-1 max-w-md text-xs leading-relaxed text-muted-foreground">
            将包含 package.json 和入口文件的插件目录放入 ~/.socverify/plugins，然后重新扫描。
          </p>
        </div>
      ) : (
        <div className="divide-y divide-border/60">
          {plugins.map((plugin) => {
            const status = pluginStatus(plugin);
            const views = plugin.contributes?.views ?? [];
            return (
              <section key={plugin.id} className="py-3 first:pt-3">
                <div className="flex items-start gap-3">
                  <div className="mt-0.5 flex h-8 w-8 shrink-0 items-center justify-center rounded border border-border bg-secondary/40">
                    <Puzzle className="h-4 w-4 text-muted-foreground" />
                  </div>
                  <div className="min-w-0 flex-1">
                    <div className="flex min-w-0 flex-wrap items-center gap-1.5">
                      <span className="truncate text-xs font-semibold">{plugin.name}</span>
                      <span className={cn('rounded border px-1.5 py-0.5 text-[9px] font-medium', status.className)}>
                        {status.label}
                      </span>
                      <span className="rounded border border-border px-1.5 py-0.5 text-[9px] text-muted-foreground">
                        {ORIGIN_LABELS[plugin.origin ?? 'project']}
                      </span>
                      <span className="text-[10px] text-muted-foreground">v{plugin.version}</span>
                    </div>
                    <div className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-1 text-[10px] text-muted-foreground">
                      <span>{KIND_LABELS[plugin.kind]}</span>
                      <span className="max-w-full truncate font-mono" title={plugin.path}>{plugin.path}</span>
                    </div>
                    {plugin.error && (
                      <div className="mt-2 flex items-start gap-1.5 rounded border border-status-fail/25 bg-status-fail/5 px-2 py-1.5 text-[10px] leading-relaxed text-status-fail-foreground">
                        <AlertCircle className="mt-0.5 h-3 w-3 shrink-0" />
                        <span className="break-all">{plugin.error}</span>
                      </div>
                    )}
                    {views.length > 0 && plugin.enabled && !plugin.error && (
                      <div className="mt-2 flex flex-wrap gap-1.5">
                        {views.map((view) => (
                          <button
                            key={view.id}
                            type="button"
                            onClick={() => openView(plugin, view.id, view.name)}
                            className="flex h-6 items-center gap-1 rounded border border-border bg-background px-2 text-[10px] font-medium transition-colors hover:bg-accent focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
                            title={`在工作区打开 ${view.name}`}
                          >
                            <ExternalLink className="h-3 w-3" />
                            {view.name}
                          </button>
                        ))}
                      </div>
                    )}
                  </div>
                  <button
                    type="button"
                    role="switch"
                    aria-checked={plugin.enabled}
                    aria-label={`${plugin.enabled ? '停用' : '启用'} ${plugin.name}`}
                    onClick={() => void togglePlugin(plugin.id, !plugin.enabled)}
                    disabled={loading}
                    className={cn(
                      'relative mt-1 h-5 w-9 shrink-0 rounded-full transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-1 disabled:opacity-50',
                      plugin.enabled ? 'bg-primary' : 'bg-muted',
                    )}
                  >
                    <span
                      className={cn(
                        'absolute left-0.5 top-0.5 h-4 w-4 rounded-full bg-background shadow-sm transition-transform',
                        plugin.enabled ? 'translate-x-4' : 'translate-x-0',
                      )}
                    />
                  </button>
                </div>
              </section>
            );
          })}
        </div>
      )}
    </div>
  );
}
