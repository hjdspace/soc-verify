/**
 * 仿真视图中间 Option 面板（Issue #3）。
 *
 * 从 OptionDock 提取核心逻辑，作为仿真视图中间区域的上半部分。
 * 不包含全局浮窗 toggle 机制，Option 卡片始终可见。
 * 面板标题动态显示当前选中用例名（`仿真 Option · {caseName}`）。
 *
 * 命令预览栏 + 运行按钮已提取到 SimCommandBar 组件，放置在
 * SimulationView 中栏底部，避免用户滚动 Option 面板才能触达。
 */

import { useEffect, useState, useMemo, useCallback } from 'react';
import {
  Save,
  FolderOpen,
  Wand2,
  X,
  Terminal,
} from 'lucide-react';
import { useProjectStore } from '@renderer/stores/project';
import { useSimulationStore } from '@renderer/stores/simulation';
import { useToastStore } from '@renderer/stores/toast';
import { trpc } from '@renderer/lib/trpc';
import { parseRunsimCommand } from '@renderer/lib/runsim-command';
import type { SimOptionField } from '@shared/plugin-types';
import {
  OptionCard,
  GROUP_ORDER,
  DEFAULT_GROUP,
} from '@renderer/components/layout/option-card';

export function SimOptionPanel() {
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
  const [showParseDialog, setShowParseDialog] = useState(false);
  const [parseCommandText, setParseCommandText] = useState('');

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

  // ── 回归列表文件浏览 ──────────────────────────────────────
  const handleBrowseRegrFile = async () => {
    if (!currentProjectId) {
      useToastStore.getState().error('浏览文件失败', '请先打开项目');
      return;
    }
    try {
      const result = await trpc.simulation.pickRegrFile.mutate({ projectId: currentProjectId });
      if (result.canceled || !result.path) return;
      setSimOption('regr_file', result.path);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      useToastStore.getState().error('浏览文件失败', msg);
    }
  };

  // ── 解析回归指令 ──────────────────────────────────────────
  const handleParseCommand = () => {
    const text = parseCommandText.trim();
    if (!text) {
      useToastStore.getState().error('解析失败', '请输入回归指令');
      return;
    }
    const parsed = parseRunsimCommand(text);
    if (Object.keys(parsed).length === 0) {
      useToastStore.getState().error('解析失败', '未找到有效的 runsim 命令');
      return;
    }
    // 合并解析结果到当前选项（解析结果覆盖已有值）
    setSimOptions({ ...simOptions, ...parsed });
    setShowParseDialog(false);
    setParseCommandText('');
    useToastStore.getState().success('解析完成', `已提取 ${Object.keys(parsed).length} 个参数`);
  };

  const hasCase = typeof simOptions.case === 'string' && simOptions.case.trim() !== '';
  const caseName = hasCase ? (simOptions.case as string).trim() : '';

  return (
    <div className="border-b border-border bg-secondary/30" data-testid="sim-option-panel">
      {/* ── Header bar ─────────────────────────────────────── */}
      <div className="flex items-center justify-between px-3 py-1.5">
        <div className="flex items-center gap-1.5 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
          <Terminal className="h-3 w-3" />
          <span data-testid="sim-option-title">
            仿真 Option{caseName ? ` · ${caseName}` : ''}
          </span>
          {schema.length > 0 && (
            <span className="rounded bg-primary/10 px-1 py-0.5 text-[11px] text-primary">
              {schema.length}
            </span>
          )}
        </div>

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
                onBrowseRegrFile={handleBrowseRegrFile}
                onParseCommand={() => setShowParseDialog(true)}
                canBrowse={!!currentProjectId}
              />
            ))}
          </div>
        )}
      </div>

      {/* ── Parse Regression Command Dialog ──────────────────── */}
      {showParseDialog && (
        <ParseCommandDialog
          text={parseCommandText}
          onChange={setParseCommandText}
          onParse={handleParseCommand}
          onClose={() => {
            setShowParseDialog(false);
            setParseCommandText('');
          }}
        />
      )}
    </div>
  );
}

// ─── Parse Command Dialog ──────────────────────────────────────

function ParseCommandDialog({
  text,
  onChange,
  onParse,
  onClose,
}: {
  text: string;
  onChange: (value: string) => void;
  onParse: () => void;
  onClose: () => void;
}) {
  return (
    <div className="fixed inset-0 z-[100] flex items-center justify-center bg-black/50" onClick={onClose}>
      <div
        className="w-full max-w-2xl rounded-lg border border-border bg-popover p-4 shadow-2xl"
        onClick={(e) => e.stopPropagation()}
      >
        {/* Dialog header */}
        <div className="mb-3 flex items-center justify-between">
          <div className="flex items-center gap-2">
            <Wand2 className="h-4 w-4 text-primary" />
            <h3 className="text-sm font-semibold text-foreground">解析回归指令</h3>
          </div>
          <button
            onClick={onClose}
            className="rounded p-1 text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
          >
            <X className="h-4 w-4" />
          </button>
        </div>

        {/* Hint */}
        <p className="mb-2 text-xs text-muted-foreground">
          请粘贴回归用例指令（支持从网页直接复制粘贴，系统会自动提取 runsim 命令）
        </p>

        {/* Textarea */}
        <textarea
          value={text}
          onChange={(e) => onChange(e.target.value)}
          placeholder={'可以直接粘贴从网页复制的完整回归指令，系统会自动提取 runsim 命令部分\n\n示例:\n1. 完整指令: [其他文本] runsim -base top -block udtb/usvp -case apcpu_hello_world ...\n2. 简化指令: runsim -base top -block udtb/usvp -case apcpu_hello_world ...'}
          className="h-32 w-full resize-y rounded border border-border bg-background/60 px-2.5 py-2 font-mono text-[11px] outline-none transition-colors focus:border-primary"
          autoFocus
          onKeyDown={(e) => {
            if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
              onParse();
            }
          }}
        />

        {/* Dialog footer */}
        <div className="mt-3 flex items-center justify-between">
          <span className="text-[10px] text-muted-foreground/60">
            Ctrl+Enter 解析
          </span>
          <div className="flex items-center gap-2">
            <button
              onClick={onClose}
              className="rounded border border-border px-3 py-1 text-xs text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
            >
              取消
            </button>
            <button
              onClick={onParse}
              disabled={!text.trim()}
              className="flex items-center gap-1.5 rounded bg-primary px-4 py-1 text-xs font-semibold text-primary-foreground transition-all hover:brightness-110 disabled:cursor-not-allowed disabled:opacity-40"
            >
              <Wand2 className="h-3 w-3" />
              解析
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
