import { useEffect, useState } from 'react';
import { ChevronDown, ChevronUp, Save, FolderOpen } from 'lucide-react';
import { useUiStore } from '@renderer/stores/ui';
import { useProjectStore } from '@renderer/stores/project';
import { useSimulationStore } from '@renderer/stores/simulation';
import { trpc } from '@renderer/lib/trpc';
import { cn } from '@renderer/lib/utils';
import type { SimOptionField } from '@shared/plugin-types';

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
          // Initialize values with defaults
          const defaults: Record<string, unknown> = {};
          for (const field of data.fields ?? []) {
            if (field.default !== undefined) {
              defaults[field.key] = field.default;
            }
          }
          setSimOptions(defaults);
        }
      })
      .catch(() => {
        if (!cancelled) setSchema([]);
      });
    return () => {
      cancelled = true;
    };
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

  const handleSavePreset = async () => {
    if (!currentProjectId || !presetName.trim()) return;
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
    } catch {
      setSavingPreset(false);
    }
  };

  const loadPreset = (name: string) => {
    const preset = presets[name];
    if (preset) {
      setSimOptions(preset);
    }
    setShowPresetMenu(false);
  };

  return (
    <div className="border-t bg-secondary/40">
      <div className="flex items-center justify-between px-3 py-1.5">
        <button
          onClick={toggle}
          className="flex items-center gap-1.5 text-xs font-semibold uppercase tracking-wide text-muted-foreground transition-colors hover:text-foreground"
        >
          {expanded ? <ChevronDown className="h-3 w-3" /> : <ChevronUp className="h-3 w-3" />}
          仿真 Option
          {schema.length > 0 && (
            <span className="rounded bg-primary/10 px-1 py-0.5 text-[9px] text-primary">
              {schema.length}
            </span>
          )}
        </button>

        <div className="flex items-center gap-1">
          {/* Preset selector */}
          <div className="relative">
            <button
              onClick={() => setShowPresetMenu(!showPresetMenu)}
              disabled={Object.keys(presets).length === 0}
              className="flex items-center gap-1 rounded px-1.5 py-0.5 text-[10px] text-muted-foreground transition-colors hover:bg-accent hover:text-foreground disabled:opacity-30"
              title="加载预设"
            >
              <FolderOpen className="h-2.5 w-2.5" />
              预设
            </button>
            {showPresetMenu && (
              <>
                <div className="fixed inset-0 z-40" onClick={() => setShowPresetMenu(false)} />
                <div className="absolute right-0 top-6 z-50 min-w-40 overflow-hidden rounded-md border border-border bg-popover shadow-xl">
                  {Object.keys(presets).map((name) => (
                    <button
                      key={name}
                      onClick={() => loadPreset(name)}
                      className="block w-full px-3 py-1.5 text-left text-xs transition-colors hover:bg-accent"
                    >
                      {name}
                    </button>
                  ))}
                </div>
              </>
            )}
          </div>

          {/* Save preset */}
          <div className="flex items-center gap-1">
            <input
              value={presetName}
              onChange={(e) => setPresetName(e.target.value)}
              placeholder="预设名称"
              className="w-20 rounded border border-border bg-background px-1.5 py-0.5 text-[10px] outline-none focus:border-primary"
            />
            <button
              onClick={handleSavePreset}
              disabled={!presetName.trim() || savingPreset}
              className="flex items-center gap-1 rounded px-1.5 py-0.5 text-[10px] text-muted-foreground transition-colors hover:bg-accent hover:text-foreground disabled:opacity-30"
              title="保存预设"
            >
              <Save className="h-2.5 w-2.5" />
            </button>
          </div>
        </div>
      </div>

      {expanded && (
        <div className="px-3 pb-3">
          {schema.length === 0 ? (
            <div className="py-2 text-xs text-muted-foreground">
              {currentProjectId
                ? '无仿真选项 schema（需 sim-option-schema 插件）'
                : '请先打开项目'}
            </div>
          ) : (
            <div className="grid grid-cols-2 gap-2 md:grid-cols-3 lg:grid-cols-4">
              {schema.map((field) => (
                <OptionField
                  key={field.key}
                  field={field}
                  value={simOptions[field.key]}
                  onChange={(v) => setSimOption(field.key, v)}
                />
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

// ── Option field renderer ──────────────────────────────

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
    <label className="flex items-center gap-1 text-[10px] font-medium text-muted-foreground">
      {field.label}
      {field.description && (
        <span className="text-[9px] text-muted-foreground/60" title={field.description}>
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
            className="rounded border border-border bg-background px-1.5 py-0.5 text-xs outline-none focus:border-primary"
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
            className="rounded border border-border bg-background px-1.5 py-0.5 text-xs outline-none focus:border-primary"
          />
        </div>
      );

    case 'boolean':
      return (
        <div className="flex flex-col gap-0.5">
          {label}
          <button
            onClick={() => onChange(!value)}
            className={cn(
              'flex h-5 w-9 items-center rounded-full px-0.5 transition-colors',
              value ? 'bg-primary' : 'bg-muted',
            )}
          >
            <div
              className={cn(
                'h-3.5 w-3.5 rounded-full bg-background transition-transform',
                value ? 'translate-x-4' : 'translate-x-0',
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
            className="rounded border border-border bg-background px-1.5 py-0.5 text-xs outline-none focus:border-primary"
          >
            <option value="">--</option>
            {field.enumValues?.map((v) => (
              <option key={v} value={v}>
                {v}
              </option>
            ))}
          </select>
        </div>
      );

    default:
      return null;
  }
}
