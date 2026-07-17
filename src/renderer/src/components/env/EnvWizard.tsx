import { useEffect, useState } from 'react';
import { Search, Check, X, ChevronRight, ChevronLeft, Plus, Trash2, Loader2, Wrench } from 'lucide-react';
import { useEnvStore } from '@renderer/stores/env';
import { useProjectStore } from '@renderer/stores/project';
import { cn } from '@renderer/lib/utils';
import type { EdaToolInfo, EnvConfig } from '@shared/types';

export function EnvWizard() {
  const wizardOpen = useEnvStore((s) => s.wizardOpen);
  if (!wizardOpen) return null;
  return <WizardDialog />;
}

function WizardDialog() {
  const step = useEnvStore((s) => s.wizardStep);
  const setWizardStep = useEnvStore((s) => s.setWizardStep);
  const setWizardOpen = useEnvStore((s) => s.setWizardOpen);
  const config = useEnvStore((s) => s.config);
  const detectTools = useEnvStore((s) => s.detectTools);
  const loadKnownEnvVars = useEnvStore((s) => s.loadKnownEnvVars);
  const saveConfig = useEnvStore((s) => s.saveConfig);
  const currentProjectId = useProjectStore((s) => s.currentProjectId);

  const steps: Array<{ key: typeof step; label: string }> = [
    { key: 'detect', label: '检测工具' },
    { key: 'confirm', label: '确认路径' },
    { key: 'envvars', label: '环境变量' },
    { key: 'done', label: '完成' },
  ];

  useEffect(() => {
    detectTools();
    loadKnownEnvVars();
  }, [detectTools, loadKnownEnvVars]);

  const handleFinish = async () => {
    if (!currentProjectId || !config) return;
    await saveConfig(currentProjectId, config);
    setWizardOpen(false);
  };

  const stepIndex = steps.findIndex((s) => s.key === step);

  return (
    <div className="fixed inset-0 z-[100] flex items-center justify-center bg-black/50">
      <div className="w-[600px] max-h-[80vh] overflow-hidden rounded-lg border border-border bg-popover shadow-2xl">
        {/* Header */}
        <div className="flex items-center justify-between border-b px-4 py-3">
          <div className="flex items-center gap-2">
            <Wrench className="h-4 w-4 text-primary" />
            <span className="text-sm font-semibold">环境搭建向导</span>
          </div>
          <button
            onClick={() => setWizardOpen(false)}
            className="rounded p-1 text-muted-foreground hover:bg-accent hover:text-foreground"
          >
            <X className="h-4 w-4" />
          </button>
        </div>

        {/* Stepper */}
        <div className="flex items-center gap-1 border-b px-4 py-2">
          {steps.map((s, i) => (
            <div key={s.key} className="flex items-center gap-1">
              <div
                className={cn(
                  'flex h-6 items-center gap-1 rounded-full px-2 text-[10px] font-medium',
                  i === stepIndex
                    ? 'bg-primary/15 text-primary'
                    : i < stepIndex
                      ? 'bg-status-pass/10 text-status-pass-foreground'
                      : 'bg-muted text-muted-foreground',
                )}
              >
                {i < stepIndex && <Check className="h-2.5 w-2.5" />}
                {s.label}
              </div>
              {i < steps.length - 1 && <ChevronRight className="h-3 w-3 text-muted-foreground" />}
            </div>
          ))}
        </div>

        {/* Content */}
        <div className="max-h-[400px] overflow-y-auto p-4">
          {step === 'detect' && <DetectStep />}
          {step === 'confirm' && <ConfirmStep />}
          {step === 'envvars' && <EnvVarsStep />}
          {step === 'done' && <DoneStep />}
        </div>

        {/* Footer */}
        <div className="flex items-center justify-between border-t px-4 py-2">
          <button
            onClick={() => stepIndex > 0 && setWizardStep(steps[stepIndex - 1].key)}
            disabled={stepIndex === 0}
            className="flex items-center gap-1 rounded px-3 py-1 text-xs text-muted-foreground transition-colors hover:bg-accent hover:text-foreground disabled:opacity-30"
          >
            <ChevronLeft className="h-3 w-3" />
            上一步
          </button>
          {stepIndex < steps.length - 1 ? (
            <button
              onClick={() => setWizardStep(steps[stepIndex + 1].key)}
              className="flex items-center gap-1 rounded bg-primary/10 px-3 py-1 text-xs text-primary transition-colors hover:bg-primary/20"
            >
              下一步
              <ChevronRight className="h-3 w-3" />
            </button>
          ) : (
            <button
              onClick={handleFinish}
              className="flex items-center gap-1 rounded bg-primary/10 px-3 py-1 text-xs text-primary transition-colors hover:bg-primary/20"
            >
              <Check className="h-3 w-3" />
              完成
            </button>
          )}
        </div>
      </div>
    </div>
  );
}

function DetectStep() {
  const detecting = useEnvStore((s) => s.detecting);
  const config = useEnvStore((s) => s.config);

  if (detecting) {
    return (
      <div className="flex flex-col items-center justify-center gap-3 py-12">
        <Loader2 className="h-8 w-8 animate-spin text-primary" />
        <p className="text-xs text-muted-foreground">正在扫描系统 PATH 中的 EDA 工具...</p>
      </div>
    );
  }

  const detected = config?.tools.filter((t) => t.detected) ?? [];
  const notDetected = config?.tools.filter((t) => !t.detected) ?? [];

  return (
    <div className="space-y-3">
      <div className="flex items-center gap-2 text-xs text-muted-foreground">
        <Search className="h-3.5 w-3.5" />
        扫描完成，检测到 {detected.length} 个 EDA 工具
      </div>

      {detected.length > 0 && (
        <div className="space-y-1.5">
          {detected.map((tool) => (
            <div key={tool.name} className="flex items-center gap-2 rounded border border-status-pass/30 bg-status-pass/5 px-3 py-2">
              <Check className="h-3.5 w-3.5 text-status-pass-foreground" />
              <div className="flex-1 min-w-0">
                <div className="text-xs font-medium">{tool.name}</div>
                <div className="truncate text-[10px] text-muted-foreground">{tool.path}</div>
              </div>
              {tool.version && (
                <div className="max-w-[200px] truncate text-[10px] text-muted-foreground" title={tool.version}>
                  {tool.version}
                </div>
              )}
            </div>
          ))}
        </div>
      )}

      {notDetected.length > 0 && (
        <div className="space-y-1.5">
          <div className="text-[10px] text-muted-foreground">未检测到的工具：</div>
          {notDetected.map((tool) => (
            <div key={tool.name} className="flex items-center gap-2 rounded border border-border/50 px-3 py-1.5 opacity-60">
              <X className="h-3 w-3 text-muted-foreground" />
              <span className="text-xs">{tool.name}</span>
            </div>
          ))}
        </div>
      )}

      {detected.length === 0 && (
        <div className="rounded border border-border/50 p-4 text-center text-xs text-muted-foreground">
          未检测到任何 EDA 工具，请在下一步手动指定工具路径
        </div>
      )}
    </div>
  );
}

function ConfirmStep() {
  const config = useEnvStore((s) => s.config);
  const updateConfig = useEnvStore((s) => s.updateConfig);

  const handlePathChange = (name: string, path: string) => {
    if (!config) return;
    const tools = config.tools.map((t) =>
      t.name === name ? { ...t, path, detected: path.length > 0 } : t,
    );
    updateConfig({ tools });
  };

  return (
    <div className="space-y-2">
      <p className="text-xs text-muted-foreground">确认或手动指定 EDA 工具路径</p>
      {config?.tools.map((tool) => (
        <div key={tool.name} className="flex items-center gap-2">
          <div className="w-40 shrink-0 text-xs">{tool.name}</div>
          <input
            type="text"
            value={tool.path}
            onChange={(e) => handlePathChange(tool.name, e.target.value)}
            placeholder="工具路径..."
            className="flex-1 rounded border border-border bg-background px-2 py-1 text-xs focus:outline-none focus:ring-1 focus:ring-primary"
          />
          {tool.detected ? (
            <Check className="h-3.5 w-3.5 text-status-pass-foreground" />
          ) : (
            <X className="h-3.5 w-3.5 text-muted-foreground" />
          )}
        </div>
      ))}
    </div>
  );
}

function EnvVarsStep() {
  const config = useEnvStore((s) => s.config);
  const knownEnvVars = useEnvStore((s) => s.knownEnvVars);
  const updateConfig = useEnvStore((s) => s.updateConfig);
  const [newKey, setNewKey] = useState('');
  const [newVal, setNewVal] = useState('');

  const envVars = config?.envVars ?? {};

  const handleAdd = () => {
    if (!newKey.trim()) return;
    updateConfig({ envVars: { ...envVars, [newKey.trim()]: newVal } });
    setNewKey('');
    setNewVal('');
  };

  const handleRemove = (key: string) => {
    const next = { ...envVars };
    delete next[key];
    updateConfig({ envVars: next });
  };

  const handleEdit = (key: string, value: string) => {
    updateConfig({ envVars: { ...envVars, [key]: value } });
  };

  return (
    <div className="space-y-3">
      <p className="text-xs text-muted-foreground">配置环境变量（如 LICENSE_FILE 等）</p>

      {Object.entries(envVars).length > 0 && (
        <div className="space-y-1.5">
          {Object.entries(envVars).map(([key, val]) => (
            <div key={key} className="flex items-center gap-2">
              <div className="w-40 shrink-0 truncate text-xs font-mono" title={key}>{key}</div>
              <input
                type="text"
                value={val}
                onChange={(e) => handleEdit(key, e.target.value)}
                className="flex-1 rounded border border-border bg-background px-2 py-1 text-xs focus:outline-none focus:ring-1 focus:ring-primary"
              />
              <button
                onClick={() => handleRemove(key)}
                className="rounded p-1 text-muted-foreground hover:bg-destructive/10 hover:text-destructive"
              >
                <Trash2 className="h-3 w-3" />
              </button>
            </div>
          ))}
        </div>
      )}

      {/* Add new env var */}
      <div className="flex items-center gap-2 border-t pt-2">
        <input
          type="text"
          value={newKey}
          onChange={(e) => setNewKey(e.target.value)}
          list="known-env-vars"
          placeholder="变量名..."
          className="w-40 shrink-0 rounded border border-border bg-background px-2 py-1 text-xs focus:outline-none focus:ring-1 focus:ring-primary"
        />
        <datalist id="known-env-vars">
          {knownEnvVars.map((v) => <option key={v} value={v} />)}
        </datalist>
        <input
          type="text"
          value={newVal}
          onChange={(e) => setNewVal(e.target.value)}
          placeholder="变量值..."
          className="flex-1 rounded border border-border bg-background px-2 py-1 text-xs focus:outline-none focus:ring-1 focus:ring-primary"
        />
        <button
          onClick={handleAdd}
          disabled={!newKey.trim()}
          className="flex items-center gap-1 rounded bg-primary/10 px-2 py-1 text-xs text-primary hover:bg-primary/20 disabled:opacity-30"
        >
          <Plus className="h-3 w-3" />
          添加
        </button>
      </div>
    </div>
  );
}

function DoneStep() {
  const config = useEnvStore((s) => s.config);
  const detectedCount = config?.tools.filter((t) => t.detected).length ?? 0;
  const envVarCount = Object.keys(config?.envVars ?? {}).length;

  return (
    <div className="flex flex-col items-center justify-center gap-4 py-8">
      <div className="flex h-16 w-16 items-center justify-center rounded-full bg-status-pass/10">
        <Check className="h-8 w-8 text-status-pass-foreground" />
      </div>
      <div className="text-center">
        <div className="text-sm font-semibold">环境配置完成</div>
        <div className="mt-1 text-xs text-muted-foreground">
          检测到 {detectedCount} 个 EDA 工具 · 配置 {envVarCount} 个环境变量
        </div>
      </div>
      <div className="w-full rounded border border-border/50 p-3">
        <div className="mb-2 text-[10px] font-semibold uppercase text-muted-foreground">配置摘要</div>
        <div className="space-y-1">
          {config?.tools.filter((t) => t.detected).map((t) => (
            <div key={t.name} className="flex justify-between text-[10px]">
              <span>{t.name}</span>
              <span className="truncate pl-2 text-muted-foreground" title={t.path}>{t.path}</span>
            </div>
          ))}
          {Object.entries(config?.envVars ?? {}).map(([k, v]) => (
            <div key={k} className="flex justify-between text-[10px]">
              <span className="font-mono">{k}</span>
              <span className="truncate pl-2 text-muted-foreground" title={v}>{v}</span>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
