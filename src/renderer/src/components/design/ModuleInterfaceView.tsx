/**
 * 模块接口视图（issue 04：选中层级树节点查看接口全貌）。
 *
 * 端口表按 Protocol Bundle 分组（AXI4/AXI4-Lite/AHB/APB/时钟/复位）+
 * leftovers 单列；组内信号名/方向/位宽（bundle 打标数据 join def 端口表）；
 * role 推断徽标；参数覆盖值展示（实例 params vs 定义 paramDefaults）。
 * 数据全部来自 tRPC getDef（渲染端零解析，打标在提炼阶段完成）。
 */

import { useEffect, useState } from 'react';
import { ArrowDown, ArrowUp, Box } from 'lucide-react';
import { trpc } from '@renderer/lib/trpc';
import { cn } from '@renderer/lib/utils';
import type { BundleGroup, DesignDefRow, DesignInstRow } from '@main/rtl/types';

type ModuleInterfaceViewProps = {
  projectId: string;
  inst: DesignInstRow;
};

export function ModuleInterfaceView({ projectId, inst }: ModuleInterfaceViewProps) {
  const [def, setDef] = useState<DesignDefRow | null>(null);

  useEffect(() => {
    let cancelled = false;
    setDef(null);
    void trpc.rtl.getDef
      .query({ projectId, name: inst.module })
      .then((d) => {
        if (!cancelled) setDef(d);
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, [projectId, inst.module]);

  if (!def) {
    return (
      <div className="p-4 text-xs text-muted-foreground" data-testid="interface-loading">
        加载模块定义...
      </div>
    );
  }

  const portsByName = new Map(def.ports.map((p) => [p.name, p]));
  const params = mergeParams(inst.params, def.paramDefaults);

  return (
    <div className="flex min-h-0 flex-1 flex-col overflow-y-auto p-3" data-testid="module-interface-view">
      <div className="mb-2 flex items-baseline gap-2" data-testid="interface-title">
        <Box className="size-4 shrink-0 self-center text-primary" />
        <span className="font-mono text-sm font-semibold text-foreground">{inst.name}</span>
        <span className="truncate font-mono text-xs text-muted-foreground">{inst.module}</span>
      </div>
      {inst.src && <div className="mb-2 font-mono text-[10px] text-muted-foreground">{inst.src}</div>}

      {params.length > 0 && (
        <div className="mb-3 rounded border border-border" data-testid="interface-params">
          <div className="border-b border-border px-2 py-1 text-[11px] font-medium text-muted-foreground">参数覆盖值</div>
          <div className="p-1">
            {params.map((p) => (
              <div
                key={p.name}
                data-testid="interface-param"
                data-param={p.name}
                className="flex items-baseline gap-2 px-2 py-0.5 font-mono text-xs"
              >
                <span className="text-foreground">{p.name}</span>
                <span className="text-primary">{fmtValue(p.value)}</span>
                {p.overridden && (
                  <span className="text-[10px] text-muted-foreground">默认 {fmtValue(p.default)}</span>
                )}
              </div>
            ))}
          </div>
        </div>
      )}

      <div className="space-y-2">
        {def.bundles.bundles.map((b, i) => (
          <BundleGroupPanel key={`${b.protocol}-${b.prefix}-${i}`} bundle={b} portsByName={portsByName} />
        ))}

        {def.bundles.leftovers.length > 0 && (
          <div className="rounded border border-dashed border-border" data-testid="interface-leftovers">
            <div className="border-b border-dashed border-border px-2 py-1 text-[11px] font-medium text-muted-foreground">
              未入束自定义信号（{def.bundles.leftovers.length}）
            </div>
            <div className="p-1">
              {def.bundles.leftovers.map((name) => (
                <SignalRow key={name} name={name} port={portsByName.get(name)} />
              ))}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

function BundleGroupPanel({ bundle, portsByName }: { bundle: BundleGroup; portsByName: Map<string, { name: string; direction: string; width: number }> }) {
  const label = bundle.singleton
    ? bundle.protocol
    : bundle.prefix
      ? `${bundle.protocol} "${bundle.prefix}"`
      : bundle.protocol;
  return (
    <div
      className="rounded border border-primary/25 bg-primary/[0.03]"
      data-testid={`interface-group-${bundle.protocol}`}
    >
      <div
        className="flex items-center gap-2 border-b border-primary/25 px-2 py-1"
        data-testid="interface-group-header"
      >
        <span className="font-mono text-[11px] font-semibold text-primary">{label}</span>
        {bundle.role && (
          <span
            className={cn(
              'rounded px-1 py-px text-[10px] font-medium',
              bundle.role === 'master' ? 'bg-sky-500/15 text-sky-600 dark:text-sky-400' : 'bg-violet-500/15 text-violet-600 dark:text-violet-400',
            )}
            data-testid="interface-role"
          >
            {bundle.role}
          </span>
        )}
        <span className="ml-auto text-[10px] text-muted-foreground">{bundle.signals.length} 信号</span>
      </div>
      <div className="p-1">
        {bundle.signals.map((s) => (
          <SignalRow key={s.name} name={s.name} port={portsByName.get(s.name)} />
        ))}
      </div>
    </div>
  );
}

function SignalRow({ name, port }: { name: string; port?: { name: string; direction: string; width: number } }) {
  const direction = port?.direction ?? '—';
  const width = port?.width ?? 0;
  return (
    <div
      className="flex items-baseline gap-2 rounded px-2 py-0.5 font-mono text-xs hover:bg-accent"
      data-testid="interface-signal"
      data-signal={name}
    >
      <span className="w-3.5 shrink-0 text-muted-foreground">
        {direction === 'input' ? <ArrowDown className="size-3" /> : direction === 'output' ? <ArrowUp className="size-3" /> : null}
      </span>
      <span className="shrink-0 text-muted-foreground">{direction}</span>
      <span className="truncate text-foreground" title={name}>
        {name}
      </span>
      <span className="ml-auto shrink-0 text-muted-foreground">[{width - 1}:0]</span>
    </div>
  );
}

type MergedParam = { name: string; value: unknown; default: unknown; overridden: boolean };

/** 实例覆盖值优先展示；定义默认值独有的参数按默认值列出（未覆盖） */
function mergeParams(instParams: Record<string, unknown>, defaults: Record<string, unknown>): MergedParam[] {
  const out = new Map<string, MergedParam>();
  for (const [name, dv] of Object.entries(defaults)) {
    out.set(name, { name, value: dv, default: dv, overridden: false });
  }
  for (const [name, v] of Object.entries(instParams)) {
    const existing = out.get(name);
    out.set(name, {
      name,
      value: v,
      default: existing?.default,
      overridden: existing !== undefined && JSON.stringify(existing.default) !== JSON.stringify(v),
    });
  }
  return [...out.values()];
}

function fmtValue(v: unknown): string {
  if (typeof v === 'number' && Number.isInteger(v)) {
    return `${v} (${v.toString(2).length}'b${v.toString(2)})`;
  }
  return String(v);
}
