import { useEffect, useState, useMemo } from 'react';
import { ChevronDown, ChevronUp, Save, FolderOpen, Settings2 } from 'lucide-react';
import { useUiStore } from '@renderer/stores/ui';
import { useProjectStore } from '@renderer/stores/project';
import { useSimulationStore } from '@renderer/stores/simulation';
import { useToastStore } from '@renderer/stores/toast';
import { trpc } from '@renderer/lib/trpc';
import { cn } from '@renderer/lib/utils';
import type { SimOptionField } from '@shared/plugin-types';

// ─── 分组顺序定义 ──────────────────────────────────────────────
const GROUP_ORDER = ['基础参数', '波形配置', '仿真参数', '执行模式', '回归测试'];
const DEFAULT_GROUP = '其他';

export function OptionDock() {
  const expanded = useUiStore((s) => s.optionDockExpanded);
  const toggle = useUiStore((s) => s.toggleOptionDock);
  const currentProjectId = useProjectStore((s) => s.currentProjectId);
  const selectedSubsys = useProjectStore((s) => s.selectedSubsys);

  const [schema, setSchema] = useState<SimOptionField[]>([]);
  const simOptions = useSimulationStore((s) => s.simOptions);
  const setSimOption = useSimulationStore((s) => s.setSimOption);
  const setSimOptions = useSimulationStore((s) => s.setSimOptions);
  const [presets, setPresets] = useState<Record<string, Record<string, unknown>>>({});
  const [showPresetMenu, setShowPresetMenu] = useState(false);
  const [savingPreset, setSavingPreset] = useState(false);
  const [presetName, setPresetName] = useState('');

  // Load schema when project or subsys changes
  useEffect(() => {
    if (!currentProjectId) {
      setSchema([]);
      return;
    }
    let cancelled = false;
    trpc.project.getSimOptionsSchema
      .query({ projectId: currentProjectId, subsys: selectedSubsys ?? undefined })
      .then((data) => {
        if (!cancelled) {
          setSchema(data.fields ?? []);
          // Initialize values with defaults — preserve existing values for keys already set
          const defaults: Record<string, unknown> = {};
          for (const field of data.fields ?? []) {
            if (field.default !== undefined) {
              defaults[field.key] = field.default;
            }
          }
          // Merge: existing simOptions take priority over defaults
          setSimOptions({ ...defaults, ...simOptions });
        }
      })
      .catch(() => {
        if (!cancelled) setSchema([]);
      });
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [currentProjectId, selectedSubsys]);

  // Load presets
  useEffect(() => {
    if (!currentProjectId) return;
    let cancelled = false;
    trpc.project.getSimOptionPresets
      .query({ projectId: currentProjectId })
      .then((data) => {
        if (!cancelled) setPresets(data);
      })
      .catch(() => {
        if (!cancelled) setPresets({});
      });
    return () => {
      cancelled = true;
    };
  }, [currentProjectId]);

  // Group fields by their `group` property
  const groupedFields = useMemo(() => {
    const groups = new Map<string, SimOptionField[]>();
    for (const field of schema) {
      const g = field.group ?? DEFAULT_GROUP;
      if (!groups.has(g)) groups.set(g, []);
      groups.get(g)!.push(field);
    }
    // Sort groups by predefined order
    const sortedGroups = Array.from(groups.entries()).sort((a, b) => {
      const ia = GROUP_ORDER.indexOf(a[0]);
      const ib = GROUP_ORDER.indexOf(b[0]);
      return (ia === -1 ? 999 : ia) - (ib === -1 ? 999 : ib);
    });
    return sortedGroups;
  }, [schema]);

  const handleSavePreset = async () => {
    if (!currentProjectId) {
      useToastStore.getState().error('保存预设失败', '请先打开项目');
      return;
    }
    if (!presetName.trim()) return;
    setSavingPreset(true);
    try {
      await trpc.project.saveSimOptionPreset.mutate({
        projectId: currentProjectId,
        name: presetName.trim(),
        options: simOptions,
      });
      const updated = await trpc.project.getSimOptionPresets.query({ projectId: currentProjectId });
      setPresets(updated);
      setPresetName('');
      setSavingPreset(false);
    } catch (err) {
      setSavingPreset(false);
      const msg = err instanceof Error ? err.message : String(err);
      useToastStore.getState().error('保存预设失败', msg);
    }
  };

  const loadPreset = (name: string) => {
    const preset = presets[name];
    if (preset) {
      setSimOptions(preset);
    }
    setShowPresetMenu(false);
  };

  // Build a lookup map from option key → label (using schema)
  const labelMap = useMemo(() => {
    const m = new Map<string, string>();
    for (const f of schema) {
      m.set(f.key, f.label);
    }
    return m;
  }, [schema]);

  // Format a preset's options into preview entries (skip empty values)
  const formatPresetPreview = (options: Record<string, unknown>): Array<{ label: string; value: string }> => {
    const entries: Array<{ label: string; value: string }> = [];
    for (const [key, val] of Object.entries(options)) {
      if (val === undefined || val === null || val === '' || val === false) continue;
      entries.push({ label: labelMap.get(key) ?? key, value: String(val) });
    }
    return entries;
  };

  return (
    <div className="border-t bg-secondary/30">
      {/* ── Header bar ─────────────────────────────────────── */}
      <div className="flex items-center justify-between px-3 py-1.5">
        <button
          onClick={toggle}
          className="flex items-center gap-1.5 text-xs font-semibold uppercase tracking-wide text-muted-foreground transition-colors hover:text-foreground"
        >
          {expanded ? <ChevronDown className="h-3 w-3" /> : <ChevronUp className="h-3 w-3" />}
          <Settings2 className="h-3 w-3" />
          仿真 Option
          {schema.length > 0 && (
            <span className="rounded bg-primary/10 px-1 py-0.5 text-[11px] text-primary">
              {schema.length}
            </span>
          )}
        </button>

        <div className="flex items-center gap-1">
          {/* Preset selector */}
          <div className="relative">
            <button
              onClick={() => setShowPresetMenu(!showPresetMenu)}
              className="flex items-center gap-1 rounded px-1.5 py-0.5 text-[11px] text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
              title="加载已保存的仿真选项预设"
            >
              <FolderOpen className="h-3 w-3" />
              预设
            </button>
            {showPresetMenu && (
              <>
                <div className="fixed inset-0 z-40" onClick={() => setShowPresetMenu(false)} />
                <div className="absolute bottom-full right-0 z-50 mb-1 max-h-80 min-w-64 max-w-80 overflow-y-auto rounded-md border border-border bg-popover shadow-xl">
                  {Object.keys(presets).length === 0 ? (
                    <div className="px-3 py-2 text-xs text-muted-foreground">暂无已保存的预设</div>
                  ) : (
                    Object.entries(presets).map(([name, options]) => {
                      const preview = formatPresetPreview(options);
                      return (
                        <button
                          key={name}
                          onClick={() => loadPreset(name)}
                          className="block w-full border-b border-border/50 px-3 py-2 text-left transition-colors last:border-b-0 hover:bg-accent"
                        >
                          <div className="flex items-center justify-between">
                            <span className="text-xs font-semibold text-foreground">{name}</span>
                            <span className="text-[10px] text-muted-foreground">{preview.length} 项</span>
                          </div>
                          {preview.length > 0 && (
                            <div className="mt-1 flex flex-wrap gap-1">
                              {preview.slice(0, 5).map(({ label, value }) => (
                                <span
                                  key={label}
                                  className="rounded bg-secondary px-1 py-0.5 text-[10px] text-muted-foreground"
                                >
                                  {label}: {value}
                                </span>
                              ))}
                              {preview.length > 5 && (
                                <span className="text-[10px] text-muted-foreground">+{preview.length - 5}</span>
                              )}
                            </div>
                          )}
                        </button>
                      );
                    })
                  )}
                </div>
              </>
            )}
          </div>

          {/* Save preset */}
          <div className="flex items-center gap-1">
            <input
              value={presetName}
              onChange={(e) => setPresetName(e.target.value)}
              placeholder={currentProjectId ? '预设名称' : '请先打开项目'}
              title="输入名称，将当前仿真选项保存为可复用预设"
              className="w-20 rounded border border-border bg-background px-1.5 py-0.5 text-[11px] outline-none focus:border-primary"
            />
            <button
              onClick={handleSavePreset}
              disabled={!presetName.trim() || savingPreset || !currentProjectId}
              className="flex items-center gap-1 rounded px-1.5 py-0.5 text-[11px] text-muted-foreground transition-colors hover:bg-accent hover:text-foreground disabled:opacity-30"
              title="保存当前仿真选项为预设"
            >
              <Save className="h-3 w-3" />
            </button>
          </div>
        </div>
      </div>

      {/* ── Options panel ──────────────────────────────────── */}
      {expanded && (
        <div className="max-h-72 overflow-y-auto px-3 pb-3">
          {schema.length === 0 ? (
            <div className="py-2 text-xs text-muted-foreground">
              {currentProjectId
                ? '无仿真选项 schema（需 sim-option-schema 插件）'
                : '请先打开项目'}
            </div>
          ) : (
            <div className="space-y-3">
              {groupedFields.map(([groupName, fields]) => (
                <OptionGroup
                  key={groupName}
                  name={groupName}
                  fields={fields}
                  values={simOptions}
                  onChange={(key, val) => setSimOption(key, val)}
                />
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

// ─── Option Group ──────────────────────────────────────────

function OptionGroup({
  name,
  fields,
  values,
  onChange,
}: {
  name: string;
  fields: SimOptionField[];
  values: Record<string, unknown>;
  onChange: (key: string, value: unknown) => void;
}) {
  return (
    <div>
      {/* Group header */}
      <div className="mb-1.5 flex items-center gap-2">
        <span className="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground/70">
          {name}
        </span>
        <div className="h-px flex-1 bg-border/50" />
      </div>
      {/* Fields grid */}
      <div className="grid grid-cols-2 gap-x-3 gap-y-1.5 md:grid-cols-3 lg:grid-cols-4">
        {fields.map((field) => (
          <OptionField
            key={field.key}
            field={field}
            value={values[field.key]}
            onChange={(v) => onChange(field.key, v)}
          />
        ))}
      </div>
    </div>
  );
}

// ─── Option field renderer ──────────────────────────────────

function OptionField({
  field,
  value,
  onChange,
}: {
  field: SimOptionField;
  value: unknown;
  onChange: (value: unknown) => void;
}) {
  const label = (
    <label className="flex items-center gap-1 text-[11px] font-medium text-muted-foreground">
      {field.label}
      {field.description && (
        <span
          className="cursor-help text-[11px] text-muted-foreground/40 underline decoration-dotted"
          title={field.description}
        >
          (?)
        </span>
      )}
    </label>
  );

  switch (field.type) {
    case 'string':
      return (
        <div className="flex flex-col gap-0.5">
          {label}
          <input
            type="text"
            value={typeof value === 'string' ? value : ''}
            onChange={(e) => onChange(e.target.value)}
            placeholder={field.default ? String(field.default) : ''}
            className="rounded border border-border bg-background px-1.5 py-0.5 text-xs outline-none transition-colors focus:border-primary focus:ring-1 focus:ring-primary/20"
          />
        </div>
      );

    case 'number':
      return (
        <div className="flex flex-col gap-0.5">
          {label}
          <input
            type="number"
            value={typeof value === 'number' ? value : ''}
            onChange={(e) => onChange(e.target.value === '' ? undefined : Number(e.target.value))}
            placeholder={field.default !== undefined ? String(field.default) : ''}
            className="rounded border border-border bg-background px-1.5 py-0.5 text-xs outline-none transition-colors focus:border-primary focus:ring-1 focus:ring-primary/20"
          />
        </div>
      );

    case 'boolean':
      return (
        <div className="flex items-center justify-between gap-1 py-0.5">
          {label}
          <button
            onClick={() => onChange(!value)}
            className={cn(
              'relative h-4 w-7 shrink-0 rounded-full transition-colors',
              value ? 'bg-primary' : 'bg-muted-foreground/30',
            )}
            title={field.description}
          >
            <div
              className={cn(
                'absolute top-0.5 h-3 w-3 rounded-full bg-background shadow-sm transition-transform',
                value ? 'translate-x-3.5' : 'translate-x-0.5',
              )}
            />
          </button>
        </div>
      );

    case 'enum':
      return (
        <div className="flex flex-col gap-0.5">
          {label}
          <select
            value={typeof value === 'string' ? value : ''}
            onChange={(e) => onChange(e.target.value)}
            className="rounded border border-border bg-background px-1.5 py-0.5 text-xs outline-none transition-colors focus:border-primary focus:ring-1 focus:ring-primary/20"
          >
            <option value="">--</option>
            {field.enumValues?.map((v) => (
              <option key={v} value={v}>
                {v || '--'}
              </option>
            ))}
          </select>
        </div>
      );

    default:
      return null;
  }
}
