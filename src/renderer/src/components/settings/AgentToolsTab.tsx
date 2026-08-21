import { useCallback, useEffect, useState } from 'react';
import { Loader2, RefreshCw, Wrench } from 'lucide-react';
import { trpc } from '@renderer/lib/trpc';
import { cn } from '@renderer/lib/utils';

/**
 * Agent 工具开关 Tab — 控制每个工具是否暴露给 LLM。
 *
 * 分两组展示：
 *  - SoC Verify 工具：静态目录（host-tools 注册的验证/覆盖率/文档等工具）
 *  - omp 引擎内置工具：从活跃会话枚举（无会话时展示最近一次缓存的清单）
 *
 * 开关即时保存并推送到所有活跃会话；新会话创建时自动应用。
 */

type HostToolMeta = { name: string; label: string };
type HostToolGroup = { id: string; label: string; tools: HostToolMeta[] };
type BuiltinToolInfo = { name: string; description: string };

type AgentToolSettings = {
  disabledTools: string[];
  hostGroups: HostToolGroup[];
  builtinTools: BuiltinToolInfo[];
};

export function AgentToolsTab() {
  const [settings, setSettings] = useState<AgentToolSettings | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      setSettings(await trpc.settings.getAgentToolSettings.query());
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const toggle = async (name: string, disable: boolean) => {
    if (!settings) return;
    const next = disable
      ? Array.from(new Set([...settings.disabledTools, name]))
      : settings.disabledTools.filter((n) => n !== name);
    setSettings({ ...settings, disabledTools: next });
    try {
      const result = await trpc.settings.setAgentToolSettings.mutate({ disabledTools: next });
      setSettings((s) => (s ? { ...s, disabledTools: result.disabledTools } : s));
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      void load();
    }
  };

  if (loading && !settings) {
    return (
      <div className="flex h-40 items-center justify-center text-muted-foreground">
        <Loader2 className="h-4 w-4 animate-spin" />
      </div>
    );
  }

  if (error && !settings) {
    return (
      <div className="space-y-3">
        <p className="text-xs text-destructive">{error}</p>
        <button onClick={() => void load()} className="rounded border border-border px-3 py-1.5 text-xs hover:bg-accent">
          重试
        </button>
      </div>
    );
  }

  const disabled = new Set(settings?.disabledTools ?? []);
  const builtinTools = settings?.builtinTools ?? [];

  return (
    <div className="space-y-6">
      <div className="flex items-start justify-between">
        <div>
          <h3 className="flex items-center gap-2 text-sm font-semibold">
            <Wrench className="h-4 w-4" />
            Agent 工具开关
          </h3>
          <p className="mt-1 text-xs text-muted-foreground">
            关闭的工具不会暴露给 LLM，立即对活跃会话生效。恢复默认可逐个重新打开。
          </p>
        </div>
        <button
          onClick={() => void load()}
          className="rounded p-1.5 text-muted-foreground hover:bg-accent hover:text-foreground"
          title="刷新工具列表"
        >
          <RefreshCw className={cn('h-3.5 w-3.5', loading && 'animate-spin')} />
        </button>
      </div>

      {error && <p className="text-xs text-destructive">{error}</p>}

      {(settings?.hostGroups ?? []).map((group) => (
        <section key={group.id} className="space-y-2">
          <h4 className="text-xs font-semibold text-foreground">{group.label}</h4>
          <div className="grid grid-cols-2 gap-1.5">
            {group.tools.map((tool) => (
              <ToolToggle
                key={tool.name}
                name={tool.name}
                label={tool.label}
                checked={!disabled.has(tool.name)}
                onToggle={(v) => void toggle(tool.name, !v)}
              />
            ))}
          </div>
        </section>
      ))}

      <section className="space-y-2">
        <h4 className="text-xs font-semibold text-foreground">omp 引擎内置工具</h4>
        {builtinTools.length === 0 ? (
          <p className="text-xs text-muted-foreground">
            暂无内置工具清单——创建一个 Agent 会话后回到此页即可枚举并配置。
          </p>
        ) : (
          <div className="grid grid-cols-2 gap-1.5">
            {builtinTools.map((tool) => (
              <ToolToggle
                key={tool.name}
                name={tool.name}
                label={tool.name}
                description={tool.description}
                checked={!disabled.has(tool.name)}
                onToggle={(v) => void toggle(tool.name, !v)}
              />
            ))}
          </div>
        )}
      </section>
    </div>
  );
}

function ToolToggle({
  name,
  label,
  description,
  checked,
  onToggle,
}: {
  name: string;
  label: string;
  description?: string;
  checked: boolean;
  onToggle: (value: boolean) => void;
}) {
  return (
    <label
      className={cn(
        'flex cursor-pointer items-center justify-between gap-2 rounded-md border px-2.5 py-2 transition-colors',
        checked ? 'border-border bg-background' : 'border-border/50 bg-background/40 opacity-70',
      )}
      title={description ?? name}
    >
      <span className="min-w-0 truncate text-xs" title={label}>
        {label}
      </span>
      <input
        type="checkbox"
        checked={checked}
        onChange={(e) => onToggle(e.target.checked)}
        className="h-3.5 w-3.5 shrink-0 accent-[hsl(var(--primary))]"
      />
    </label>
  );
}
