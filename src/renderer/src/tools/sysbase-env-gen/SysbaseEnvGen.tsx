/**
 * SysbaseEnvGen — 9-step wizard for generating SoC verification environment.
 *
 * Layout: header + stepper + content area + footer navigation.
 * The wizard shell supports free navigation (prev/next) across all 9 steps,
 * with the last step showing an "执行生成" button instead of "下一步".
 *
 * Header includes "保存配置" and "加载配置" buttons for config persistence.
 * Stepper pills follow the EnvWizard pattern: active / completed / pending.
 */

import { useState, useCallback } from 'react';
import {
  ChevronLeft,
  ChevronRight,
  Check,
  Workflow,
  Play,
  Save,
  FolderOpen,
  Loader2,
  X,
} from 'lucide-react';
import { useSysbaseGenStore } from '@renderer/stores/sysbase-gen';
import { SYSBASE_GEN_STEPS } from '@shared/types';
import { cn } from '@renderer/lib/utils';
import { trpc } from '@renderer/lib/trpc';
import { StepSubsys } from './StepSubsys';
import { StepRtl } from './StepRtl';
import { StepDutSpec } from './StepDutSpec';
import { StepMini } from './StepMini';
import { StepRal } from './StepRal';
import { StepClk } from './StepClk';
import { StepModIo } from './StepModIo';
import { StepOptional } from './StepOptional';
import { StepReview } from './StepReview';

export function SysbaseEnvGen() {
  const step = useSysbaseGenStore((s) => s.step);
  const totalSteps = useSysbaseGenStore((s) => s.totalSteps);
  const nextStep = useSysbaseGenStore((s) => s.nextStep);
  const prevStep = useSysbaseGenStore((s) => s.prevStep);
  const canProceed = useSysbaseGenStore((s) => s.canProceed);
  const config = useSysbaseGenStore((s) => s.config);
  const scriptPath = useSysbaseGenStore((s) => s.scriptPath);
  const configSaving = useSysbaseGenStore((s) => s.configSaving);
  const setConfigSaving = useSysbaseGenStore((s) => s.setConfigSaving);
  const configLoading = useSysbaseGenStore((s) => s.configLoading);
  const setConfigLoading = useSysbaseGenStore((s) => s.setConfigLoading);
  const loadConfigIntoStore = useSysbaseGenStore((s) => s.loadConfigIntoStore);

  const [showLoadDialog, setShowLoadDialog] = useState(false);
  const [savedConfigs, setSavedConfigs] = useState<{ subsys: string }[]>([]);

  const currentStep = SYSBASE_GEN_STEPS[step];
  const isLastStep = step === totalSteps - 1;
  const isFirstStep = step === 0;

  // Save config
  const handleSaveConfig = useCallback(async () => {
    if (!config.subsys.trim()) return;
    setConfigSaving(true);
    try {
      await trpc.tools.sysbaseGen.saveConfig.mutate({
        config,
        scriptPath,
      });
    } catch {
      // best-effort
    } finally {
      setConfigSaving(false);
    }
  }, [config, scriptPath, setConfigSaving]);

  // Load config list
  const handleLoadConfigList = useCallback(async () => {
    setConfigLoading(true);
    try {
      const result = await trpc.tools.sysbaseGen.listSavedConfigs.query({});
      setSavedConfigs(result.configs.map((c) => ({ subsys: c.subsys })));
      setShowLoadDialog(true);
    } catch {
      // best-effort
    } finally {
      setConfigLoading(false);
    }
  }, [setConfigLoading]);

  // Load a specific config
  const handleLoadConfig = useCallback(async (subsys: string) => {
    setConfigLoading(true);
    try {
      const result = await trpc.tools.sysbaseGen.loadConfig.query({ subsys });
      if (result.config) {
        loadConfigIntoStore(result.config, result.scriptPath);
      }
      setShowLoadDialog(false);
    } catch {
      // best-effort
    } finally {
      setConfigLoading(false);
    }
  }, [setConfigLoading, loadConfigIntoStore]);

  return (
    <div className="flex h-full w-full flex-col bg-background">
      {/* ── Header ── */}
      <div className="flex items-center gap-2 border-b px-4 py-3">
        <Workflow className="h-4 w-4 text-primary" />
        <span className="text-sm font-semibold">验证环境生成器</span>
        <span className="text-xs text-muted-foreground">sysbase_gen.py</span>
        <div className="ml-auto flex items-center gap-1">
          <button
            onClick={() => void handleSaveConfig()}
            disabled={configSaving || !config.subsys.trim()}
            className="flex items-center gap-1 rounded px-2 py-1 text-[10px] text-muted-foreground transition-colors hover:bg-accent hover:text-foreground disabled:opacity-30"
          >
            {configSaving ? (
              <Loader2 className="h-3 w-3 animate-spin" />
            ) : (
              <Save className="h-3 w-3" />
            )}
            保存配置
          </button>
          <button
            onClick={() => void handleLoadConfigList()}
            disabled={configLoading}
            className="flex items-center gap-1 rounded px-2 py-1 text-[10px] text-muted-foreground transition-colors hover:bg-accent hover:text-foreground disabled:opacity-30"
          >
            {configLoading ? (
              <Loader2 className="h-3 w-3 animate-spin" />
            ) : (
              <FolderOpen className="h-3 w-3" />
            )}
            加载配置
          </button>
        </div>
      </div>

      {/* ── Stepper ── */}
      <div className="flex items-center gap-1 overflow-x-auto border-b px-4 py-2">
        {SYSBASE_GEN_STEPS.map((s, i) => (
          <div key={s.key} className="flex items-center gap-1">
            <div
              className={cn(
                'flex h-6 items-center gap-1 rounded-full px-2 text-[10px] font-medium whitespace-nowrap',
                i === step
                  ? 'bg-primary/15 text-primary'
                  : i < step
                    ? 'bg-status-pass/10 text-status-pass-foreground'
                    : 'bg-muted text-muted-foreground',
              )}
            >
              {i < step && <Check className="h-2.5 w-2.5" />}
              {s.label}
            </div>
            {i < SYSBASE_GEN_STEPS.length - 1 && (
              <ChevronRight className="h-3 w-3 shrink-0 text-muted-foreground" />
            )}
          </div>
        ))}
      </div>

      {/* ── Content ── */}
      <div className="flex-1 overflow-y-auto p-6">
        <div className="mx-auto max-w-3xl">
          <h2 className="mb-1 text-base font-semibold">{currentStep.label}</h2>
          <p className="mb-4 text-xs text-muted-foreground">
            步骤 {step + 1} / {totalSteps}
          </p>

          {/* Step content */}
          {step === 0 ? (
            <StepSubsys />
          ) : step === 1 ? (
            <StepRtl />
          ) : step === 2 ? (
            <StepDutSpec />
          ) : step === 3 ? (
            <StepMini />
          ) : step === 4 ? (
            <StepRal />
          ) : step === 5 ? (
            <StepClk />
          ) : step === 6 ? (
            <StepModIo />
          ) : step === 7 ? (
            <StepOptional />
          ) : (
            <StepReview />
          )}
        </div>
      </div>

      {/* ── Footer ── */}
      <div className="flex items-center justify-between border-t px-4 py-2">
        <div className="flex items-center gap-2 text-xs text-muted-foreground">
          <span>步骤 {step + 1} / {totalSteps}</span>
          <span className="opacity-30">·</span>
          <span>{currentStep.label}</span>
        </div>
        <div className="flex items-center gap-2">
          <button
            onClick={prevStep}
            disabled={isFirstStep}
            className="flex items-center gap-1 rounded px-3 py-1 text-xs text-muted-foreground transition-colors hover:bg-accent hover:text-foreground disabled:opacity-30"
          >
            <ChevronLeft className="h-3 w-3" />
            上一步
          </button>
          {isLastStep ? (
            <button
              className="flex items-center gap-1 rounded bg-primary/10 px-3 py-1 text-xs text-primary transition-colors hover:bg-primary/20"
            >
              <Play className="h-3 w-3" />
              执行生成
            </button>
          ) : (
            <button
              onClick={nextStep}
              disabled={!canProceed()}
              className="flex items-center gap-1 rounded bg-primary/10 px-3 py-1 text-xs text-primary transition-colors hover:bg-primary/20 disabled:opacity-30"
            >
              下一步
              <ChevronRight className="h-3 w-3" />
            </button>
          )}
        </div>
      </div>

      {/* ── Load Config Dialog ── */}
      {showLoadDialog && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50">
          <div className="w-80 rounded-lg border border-border bg-background p-4 shadow-lg">
            <div className="mb-3 flex items-center justify-between">
              <span className="text-sm font-semibold">加载已保存的配置</span>
              <button
                onClick={() => setShowLoadDialog(false)}
                className="text-muted-foreground hover:text-foreground"
              >
                <X className="h-4 w-4" />
              </button>
            </div>
            {savedConfigs.length === 0 ? (
              <p className="py-4 text-center text-xs text-muted-foreground">
                暂无已保存的配置
              </p>
            ) : (
              <div className="space-y-1">
                {savedConfigs.map((c) => (
                  <button
                    key={c.subsys}
                    onClick={() => void handleLoadConfig(c.subsys)}
                    className="flex w-full items-center gap-2 rounded-md border border-border px-3 py-2 text-xs transition-colors hover:bg-accent"
                  >
                    <Workflow className="h-3.5 w-3.5 text-primary" />
                    <span className="font-mono">{c.subsys}</span>
                  </button>
                ))}
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
