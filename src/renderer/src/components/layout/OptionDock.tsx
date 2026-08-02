import { useEffect, useState, useMemo, useCallback } from 'react';
import {
  ChevronDown,
  ChevronUp,
  Save,
  FolderOpen,
  Play,
  Terminal,
  Copy,
  AlertCircle,
} from 'lucide-react';
import { useUiStore } from '@renderer/stores/ui';
import { useProjectStore } from '@renderer/stores/project';
import { useSimulationStore, type SimulationCase } from '@renderer/stores/simulation';
import { useToastStore } from '@renderer/stores/toast';
import { trpc } from '@renderer/lib/trpc';
import { cn } from '@renderer/lib/utils';
import { generateRunsimCommand, tokenizeRunsimCommand } from '@renderer/lib/runsim-command';
import type { SimOptionField } from '@shared/plugin-types';

// ─── 分组顺序定义 ──────────────────────────────────────────────
const GROUP_ORDER = ['基础参数', '波形配置', '仿真参数', '执行模式', '回归测试'];
const DEFAULT_GROUP = '其他';

// ─── 分组颜色映射 ──────────────────────────────────────────────
const GROUP_COLORS: Record<string, string> = {
  '基础参数': 'bg-blue-500',
  '波形配置': 'bg-violet-500',
  '仿真参数': 'bg-green-500',
  '执行模式': 'bg-amber-500',
  '回归测试': 'bg-red-500',
  [DEFAULT_GROUP]: 'bg-zinc-500',
};

function getGroupColor(name: string): string {
  return GROUP_COLORS[name] ?? GROUP_COLORS[DEFAULT_GROUP];
}

export function OptionDock() {
  const expanded = useUiStore((s) => s.optionDockExpanded);
  const toggle = useUiStore((s) => s.toggleOptionDock);
  const currentProjectId = useProjectStore((s) => s.currentProjectId);
  const selectedSubsys = useProjectStore((s) => s.selectedSubsys);

  const [schema, setSchema] = useState<SimOptionField[]>([]);
  const simOptions = useSimulationStore((s) => s.simOptions);
  const setSimOption = useSimulationStore((s) => s.setSimOption);
  const setSimOptions = useSimulationStore((s) => s.setSimOptions);
  const startCaseRun = useSimulationStore((s) => s.startCaseRun);
  const [presets, setPresets] = useState<Record<string, Record<string, unknown>>>({});
  const [showPresetMenu, setShowPresetMenu] = useState(false);
  const [savingPreset, setSavingPreset] = useState(false);
  const [presetName, setPresetName] = useState('');
  const [running, setRunning] = useState(false);
  const [copied, setCopied] = useState(false);

  // Load schema when project or subsys changes
  useEffect(() => {
    if (!currentProjectId) {
      setSchema([]);
      return;
    }
    let cancelled = false;
    (async () => {
      try {
        const data = await trpc.project.getSimOptionsSchema.query({
          projectId: currentProjectId,
          subsys: selectedSubsys ?? undefined,
        });
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
      } catch {
        if (!cancelled) setSchema([]);
      }
    })();
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [currentProjectId, selectedSubsys]);

  // Load presets
  useEffect(() => {
    if (!currentProjectId) return;
    let cancelled = false;
    (async () => {
      try {
        const data = await trpc.project.getSimOptionPresets.query({ projectId: currentProjectId });
        if (!cancelled) setPresets(data);
      } catch {
        if (!cancelled) setPresets({});
      }
    })();
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

  // Build a lookup map from option key → label (using schema)
  const labelMap = useMemo(() => {
    const m = new Map<string, string>();
    for (const f of schema) m.set(f.key, f.label);
    return m;
  }, [schema]);

  // Format a preset's options into preview entries (skip empty values)
  const formatPresetPreview = useCallback(
    (options: Record<string, unknown>): Array<{ label: string; value: string }> => {
      const entries: Array<{ label: string; value: string }> = [];
      for (const [key, val] of Object.entries(options)) {
        if (val === undefined || val === null || val === '' || val === false) continue;
        entries.push({ label: labelMap.get(key) ?? key, value: String(val) });
      }
      return entries;
    },
    [labelMap],
  );

  // Generate command preview
  const commandPreview = useMemo(() => {
    return generateRunsimCommand(simOptions);
  }, [simOptions]);

  const commandTokens = useMemo(() => {
    return tokenizeRunsimCommand(commandPreview);
  }, [commandPreview]);

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
    if (preset) setSimOptions(preset);
    setShowPresetMenu(false);
  };

  const handleRunSim = async () => {
    if (!currentProjectId) {
      useToastStore.getState().error('运行仿真失败', '请先打开项目');
      return;
    }
    const caseName = typeof simOptions.case === 'string' ? simOptions.case.trim() : '';
    if (!caseName) {
      useToastStore.getState().error('运行仿真失败', '请先指定 CASE 名称');
      return;
    }
    setRunning(true);
    const simCase: SimulationCase = {
      name: caseName,
      subsys: selectedSubsys ?? '',
      base: typeof simOptions.base === 'string' ? simOptions.base : undefined,
      block: typeof simOptions.block === 'string' ? simOptions.block : undefined,
    };
    await startCaseRun(currentProjectId, simCase);
    setRunning(false);
  };

  const handleCopyCommand = async () => {
    try {
      await navigator.clipboard.writeText(commandPreview);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      useToastStore.getState().error('复制失败', '无法访问剪贴板');
    }
  };

  const hasCase = typeof simOptions.case === 'string' && simOptions.case.trim() !== '';

  return (
    <div className="border-t bg-secondary/30">
      {/* ── Header bar ─────────────────────────────────────── */}
      <div className="flex items-center justify-between px-3 py-1.5">
        <button
          onClick={toggle}
          className="flex items-center gap-1.5 text-xs font-semibold uppercase tracking-wide text-muted-foreground transition-colors hover:text-foreground"
        >
          {expanded ? <ChevronDown className="h-3 w-3" /> : <ChevronUp className="h-3 w-3" />}
          <Terminal className="h-3 w-3" />
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

      {/* ── Options panel — Minimalist Card layout ─────────── */}
      {expanded && (
        <div className="max-h-72 overflow-y-auto px-3 pb-2">
          {schema.length === 0 ? (
            <div className="py-2 text-xs text-muted-foreground">
              {currentProjectId
                ? '无仿真选项 schema（需 sim-option-schema 插件）'
                : '请先打开项目'}
            </div>
          ) : (
            <div className="grid grid-cols-1 gap-2 sm:grid-cols-2 lg:grid-cols-3">
              {groupedFields.map(([groupName, fields]) => (
                <OptionCard
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

      {/* ── Command preview bar + Run button ─────────────────── */}
      <div className="flex items-stretch border-t border-border bg-background/50">
        {/* Command prefix */}
        <div className="flex items-center px-2.5 font-mono text-xs font-semibold text-status-pass-foreground">
          $
        </div>
        {/* Command text */}
        <div className="flex min-w-0 flex-1 items-center gap-1.5 py-1.5">
          <div className="min-w-0 flex-1 overflow-x-auto">
            <code className="whitespace-nowrap font-mono text-[11px] leading-relaxed">
              {commandTokens.map((token, i) => (
                <span
                  key={i}
                  className={cn(
                    token.type === 'base' && 'font-semibold text-status-pass-foreground',
                    token.type === 'flag' && 'text-primary',
                    token.type === 'value' && 'text-violet-foreground',
                  )}
                >
                  {token.text}
                  {i < commandTokens.length - 1 ? ' ' : ''}
                </span>
              ))}
            </code>
          </div>
          {/* Copy button */}
          <button
            onClick={handleCopyCommand}
            className="flex shrink-0 items-center gap-1 rounded px-1.5 py-0.5 text-[10px] text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
            title="复制命令"
          >
            {copied ? (
              <span className="text-status-pass-foreground">已复制</span>
            ) : (
              <Copy className="h-3 w-3" />
            )}
          </button>
        </div>
        {/* Run button */}
        <button
          onClick={handleRunSim}
          disabled={running || !currentProjectId || !hasCase}
          className="flex items-center gap-1.5 bg-status-pass px-4 text-xs font-bold text-white transition-all hover:brightness-110 active:brightness-95 disabled:cursor-not-allowed disabled:opacity-40"
          title={!hasCase ? '请先指定 CASE 名称' : !currentProjectId ? '请先打开项目' : '运行仿真'}
        >
          {running ? (
            <>
              <span className="h-3 w-3 animate-spin rounded-full border-2 border-current border-t-transparent" />
              运行中
            </>
          ) : (
            <>
              <Play className="h-3.5 w-3.5" fill="currentColor" />
              运行仿真
            </>
          )}
        </button>
      </div>

      {/* ── Missing CASE hint ─────────────────────────────────── */}
      {!hasCase && expanded && schema.length > 0 && currentProjectId && (
        <div className="flex items-center gap-1.5 border-t border-border/50 bg-warning/5 px-3 py-1 text-[10px] text-warning-foreground">
          <AlertCircle className="h-3 w-3" />
          未指定 CASE 名称，请填写 CASE 字段后才能运行仿真
        </div>
      )}
    </div>
  );
}

// ─── Option Card (Minimalist Card group) ──────────────────────

function OptionCard({
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
  const color = getGroupColor(name);
  return (
    <div className="rounded border border-border bg-card/50 transition-colors hover:border-primary/30">
      {/* Card header */}
      <div className="flex items-center gap-1.5 px-2.5 py-1.5">
        <span className={cn('h-1.5 w-1.5 rounded-full', color)} />
        <span className="text-[10px] font-bold uppercase tracking-wider text-muted-foreground">
          {name}
        </span>
        <span className="text-[9px] text-muted-foreground/50">({fields.length})</span>
      </div>
      {/* Card fields */}
      <div className="flex flex-col gap-1 px-2.5 pb-2">
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

// ─── Option field renderer (inline minimalist style) ──────────

function OptionField({
  field,
  value,
  onChange,
}: {
  field: SimOptionField;
  value: unknown;
  onChange: (value: unknown) => void;
}) {
  const labelText = (
    <span
      className="w-16 shrink-0 truncate text-[10px] font-medium text-muted-foreground"
      title={field.key}
    >
      {field.label}
    </span>
  );

  const hint =
    field.description ? (
      <span
        className="cursor-help text-[9px] text-muted-foreground/40"
        title={field.description}
      >
        (?)
      </span>
    ) : null;

  switch (field.type) {
    case 'string':
      return (
        <div className="flex items-center gap-1.5">
          {labelText}
          {hint}
          <input
            type="text"
            value={typeof value === 'string' ? value : ''}
            onChange={(e) => onChange(e.target.value)}
            placeholder={field.default ? String(field.default) : ''}
            className="min-w-0 flex-1 rounded border border-border bg-background/60 px-1.5 py-0.5 font-mono text-[11px] outline-none transition-colors focus:border-primary"
          />
        </div>
      );

    case 'number':
      return (
        <div className="flex items-center gap-1.5">
          {labelText}
          {hint}
          <input
            type="number"
            value={typeof value === 'number' ? value : ''}
            onChange={(e) => onChange(e.target.value === '' ? undefined : Number(e.target.value))}
            placeholder={field.default !== undefined ? String(field.default) : ''}
            className="min-w-0 flex-1 rounded border border-border bg-background/60 px-1.5 py-0.5 font-mono text-[11px] outline-none transition-colors focus:border-primary"
          />
        </div>
      );

    case 'boolean':
      return (
        <div className="flex items-center justify-between gap-1.5 py-0.5">
          <div className="flex items-center gap-1.5">
            {labelText}
            {hint}
          </div>
          <button
            onClick={() => onChange(!value)}
            className={cn(
              'relative h-3.5 w-7 shrink-0 rounded-full transition-colors',
              value ? 'bg-primary' : 'bg-muted-foreground/30',
            )}
            title={field.description}
          >
            <div
              className={cn(
                'absolute top-0.5 h-2.5 w-2.5 rounded-full bg-background shadow-sm transition-transform',
                value ? 'translate-x-3.5' : 'translate-x-0.5',
              )}
            />
          </button>
        </div>
      );

    case 'enum':
      return (
        <div className="flex items-center gap-1.5">
          {labelText}
          {hint}
          <select
            value={typeof value === 'string' ? value : ''}
            onChange={(e) => onChange(e.target.value)}
            className="min-w-0 flex-1 rounded border border-border bg-background/60 px-1.5 py-0.5 text-[11px] outline-none transition-colors focus:border-primary"
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
