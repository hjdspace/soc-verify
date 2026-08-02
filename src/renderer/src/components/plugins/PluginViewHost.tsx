import { useEffect, useMemo } from 'react';
import { ChevronDown, ChevronUp, Puzzle } from 'lucide-react';
import { useProjectStore } from '@renderer/stores/project';
import { useUiStore } from '@renderer/stores/ui';
import { PluginView } from './PluginView';
import type { PluginViewLocation } from '@shared/plugin-types';

type PluginViewHostProps = {
  location: PluginViewLocation;
};

export function PluginViewHost({ location }: PluginViewHostProps) {
  const projectId = useProjectStore((s) => s.currentProjectId);
  const plugins = useProjectStore((s) => s.plugins);
  const layout = useUiStore((s) => s.pluginViewLayouts[location]);
  const setActive = useUiStore((s) => s.setPluginViewActive);
  const setCollapsed = useUiStore((s) => s.setPluginViewCollapsed);

  const views = useMemo(
    () => plugins.flatMap((plugin) => (plugin.contributes?.views ?? [])
      .filter((view) => view.location === location)
      .map((view) => ({ plugin, view }))),
    [location, plugins],
  );

  const activeEntry = views.find(({ plugin, view }) => `${plugin.id}:${view.id}` === layout.activeViewId) ?? views[0];

  useEffect(() => {
    const activeKey = activeEntry ? `${activeEntry.plugin.id}:${activeEntry.view.id}` : undefined;
    if (activeKey && activeKey !== layout.activeViewId) {
      setActive(location, activeKey);
    }
  }, [activeEntry, layout.activeViewId, location, setActive]);

  if (!projectId || views.length === 0) return null;

  return (
    <section className="flex min-h-0 flex-1 flex-col border-b border-border/50 bg-sidebar/40">
      <div className="flex min-h-8 shrink-0 items-center border-b border-border/50">
        <div className="flex items-center gap-1.5 px-2 text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">
          <Puzzle className="h-3 w-3" />
          <span>插件</span>
        </div>
        <div className="flex min-w-0 flex-1 items-center gap-0.5 overflow-x-auto px-1">
          {views.map(({ plugin, view }) => (
            <button
              key={`${plugin.id}:${view.id}`}
              onClick={() => setActive(location, `${plugin.id}:${view.id}`)}
              className={[
                'max-w-40 shrink-0 truncate rounded px-1.5 py-0.5 text-[10px] transition-colors',
                activeEntry?.plugin.id === plugin.id && activeEntry.view.id === view.id
                  ? 'bg-background text-foreground'
                  : 'text-muted-foreground hover:bg-accent hover:text-foreground',
              ].join(' ')}
              title={`${plugin.name}: ${view.name}`}
            >
              {view.name}
            </button>
          ))}
        </div>
        <button
          onClick={() => setCollapsed(location, !layout.collapsed)}
          className="rounded p-1 text-muted-foreground hover:bg-accent hover:text-foreground"
          title={layout.collapsed ? '展开插件视图' : '折叠插件视图'}
        >
          {layout.collapsed ? <ChevronDown className="h-3 w-3" /> : <ChevronUp className="h-3 w-3" />}
        </button>
      </div>
      {!layout.collapsed && activeEntry && (
        <div className="flex min-h-0 flex-1 overflow-hidden">
          <PluginView
            projectId={projectId}
            pluginId={activeEntry.plugin.id}
            view={activeEntry.view}
          />
        </div>
      )}
    </section>
  );
}
