/**
 * Zustand store for the Sysbase Environment Generator wizard.
 *
 * Manages:
 *   - Current step (0-8)
 *   - Wizard configuration (all 14 fields)
 *   - Script path (default: /pri/project/.../sysbase_gen.py)
 *   - Loading state for async operations
 *   - Run-gen state (Step 9 execution)
 *   - Config persistence state (save/load)
 */

import { create } from 'zustand';
import {
  type SysbaseGenConfig,
  type GenLevel,
  createEmptySysbaseConfig,
  DEFAULT_SYSBASE_SCRIPT,
  getGenSteps,
  type SysbaseGenStep,
} from '@shared/types';
import type { RtlFileEntry } from '@main/tools/sysbase-gen/path-scanner';

/** Execution status for sysbase_gen.py run. */
type RunGenStatus = 'idle' | 'running' | 'success' | 'failed';

interface SysbaseGenStoreState {
  // ── Navigation ──
  step: number;
  totalSteps: number;
  steps: readonly SysbaseGenStep[];

  // ── Configuration ──
  config: SysbaseGenConfig;
  scriptPath: string;

  // ── Step 2: RTL file list ──
  rtlFiles: RtlFileEntry[];
  rtlLoading: boolean;
  rtlError: string | null;

  // ── Step 5: RAL directory inference ──
  ralLoading: boolean;
  ralError: string | null;

  // ── Step 6: CLK directory inference ──
  clkLoading: boolean;
  clkError: string | null;

  // ── Step 7: Module IO generation ──
  modIoLoading: boolean;
  modIoError: string | null;
  modIoLogs: string[];

  // ── Step 9: Run-gen execution ──
  runGenLoading: boolean;
  runGenError: string | null;
  runGenLogs: string[];
  runGenStatus: RunGenStatus;

  // ── Config persistence ──
  configSaving: boolean;
  configLoading: boolean;

  // ── Status ──
  loading: boolean;

  // ── Actions: Navigation ──
  nextStep: () => void;
  prevStep: () => void;
  setStep: (step: number) => void;

  // ── Actions: Config ──
  updateConfig: (partial: Partial<SysbaseGenConfig>) => void;
  setScriptPath: (path: string) => void;
  resetConfig: () => void;
  loadConfigIntoStore: (config: SysbaseGenConfig, scriptPath: string) => void;
  setGenLevel: (level: GenLevel) => void;

  // ── Actions: RTL files ──
  setRtlFiles: (files: RtlFileEntry[]) => void;
  setRtlLoading: (loading: boolean) => void;
  setRtlError: (error: string | null) => void;

  // ── Actions: RAL inference ──
  setRalLoading: (loading: boolean) => void;
  setRalError: (error: string | null) => void;

  // ── Actions: CLK inference ──
  setClkLoading: (loading: boolean) => void;
  setClkError: (error: string | null) => void;

  // ── Actions: Module IO generation ──
  setModIoLoading: (loading: boolean) => void;
  setModIoError: (error: string | null) => void;
  setModIoLogs: (logs: string[]) => void;
  addModIoLog: (line: string) => void;
  clearModIoLogs: () => void;

  // ── Actions: Run-gen execution ──
  setRunGenLoading: (loading: boolean) => void;
  setRunGenError: (error: string | null) => void;
  setRunGenLogs: (logs: string[]) => void;
  addRunGenLog: (line: string) => void;
  clearRunGenLogs: () => void;
  setRunGenStatus: (status: RunGenStatus) => void;

  // ── Actions: Config persistence ──
  setConfigSaving: (saving: boolean) => void;
  setConfigLoading: (loading: boolean) => void;

  // ── Validation ──
  canProceed: () => boolean;
}

export const useSysbaseGenStore = create<SysbaseGenStoreState>((set, get) => ({
  step: 0,
  totalSteps: getGenSteps('subsys').length,
  steps: getGenSteps('subsys'),

  config: createEmptySysbaseConfig(),
  scriptPath: DEFAULT_SYSBASE_SCRIPT,

  rtlFiles: [],
  rtlLoading: false,
  rtlError: null,

  ralLoading: false,
  ralError: null,

  clkLoading: false,
  clkError: null,

  modIoLoading: false,
  modIoError: null,
  modIoLogs: [],

  runGenLoading: false,
  runGenError: null,
  runGenLogs: [],
  runGenStatus: 'idle',

  configSaving: false,
  configLoading: false,

  loading: false,

  nextStep: () => {
    const { step, totalSteps } = get();
    if (step < totalSteps - 1) {
      set({ step: step + 1 });
    }
  },

  prevStep: () => {
    const { step } = get();
    if (step > 0) {
      set({ step: step - 1 });
    }
  },

  setStep: (step) => {
    const { totalSteps } = get();
    const clamped = Math.max(0, Math.min(step, totalSteps - 1));
    set({ step: clamped });
  },

  updateConfig: (partial) => {
    set((s) => ({ config: { ...s.config, ...partial } }));
  },

  setScriptPath: (path) => {
    set({ scriptPath: path });
  },

  resetConfig: () => {
    const level = get().config.genLevel;
    const steps = getGenSteps(level);
    set({
      config: { ...createEmptySysbaseConfig(), genLevel: level },
      step: 0,
      totalSteps: steps.length,
      steps,
      rtlFiles: [],
      rtlError: null,
      ralError: null,
      clkError: null,
      modIoLogs: [],
      modIoError: null,
      runGenLogs: [],
      runGenError: null,
      runGenStatus: 'idle',
    });
  },

  loadConfigIntoStore: (config, scriptPath) => {
    const steps = getGenSteps(config.genLevel);
    set({
      config,
      scriptPath,
      step: 0,
      totalSteps: steps.length,
      steps,
      rtlError: null,
      ralError: null,
      clkError: null,
      modIoError: null,
      modIoLogs: [],
      runGenError: null,
      runGenLogs: [],
      runGenStatus: 'idle',
    });
  },

  setGenLevel: (level) => {
    const steps = getGenSteps(level);
    set((s) => ({
      config: { ...s.config, genLevel: level, subsys: '', instanceName: '' },
      step: 0,
      totalSteps: steps.length,
      steps,
      rtlFiles: [],
      rtlError: null,
      ralError: null,
      clkError: null,
      modIoLogs: [],
      modIoError: null,
      runGenLogs: [],
      runGenError: null,
      runGenStatus: 'idle',
    }));
  },

  setRtlFiles: (files) => {
    set({ rtlFiles: files, rtlError: null });
  },

  setRtlLoading: (loading) => {
    set({ rtlLoading: loading });
  },

  setRtlError: (error) => {
    set({ rtlError: error, rtlLoading: false });
  },

  setRalLoading: (loading) => {
    set({ ralLoading: loading });
  },

  setRalError: (error) => {
    set({ ralError: error, ralLoading: false });
  },

  setClkLoading: (loading) => {
    set({ clkLoading: loading });
  },

  setClkError: (error) => {
    set({ clkError: error, clkLoading: false });
  },

  setModIoLoading: (loading) => {
    set({ modIoLoading: loading });
  },

  setModIoError: (error) => {
    set({ modIoError: error, modIoLoading: false });
  },

  setModIoLogs: (logs) => {
    set({ modIoLogs: logs });
  },

  addModIoLog: (line) => {
    set((s) => ({ modIoLogs: [...s.modIoLogs, line] }));
  },

  clearModIoLogs: () => {
    set({ modIoLogs: [], modIoError: null });
  },

  setRunGenLoading: (loading) => {
    set({ runGenLoading: loading });
  },

  setRunGenError: (error) => {
    set({ runGenError: error, runGenLoading: false });
  },

  setRunGenLogs: (logs) => {
    set({ runGenLogs: logs });
  },

  addRunGenLog: (line) => {
    set((s) => ({ runGenLogs: [...s.runGenLogs, line] }));
  },

  clearRunGenLogs: () => {
    set({ runGenLogs: [], runGenError: null });
  },

  setRunGenStatus: (status) => {
    set({ runGenStatus: status });
  },

  setConfigSaving: (saving) => {
    set({ configSaving: saving });
  },

  setConfigLoading: (loading) => {
    set({ configLoading: loading });
  },

  canProceed: () => {
    const { step, config } = get();
    const level = config.genLevel;
    if (level === 'top') {
      switch (step) {
        case 0: // Step 1: top info (chip name + instanceName)
          return config.subsys.trim() !== '' && config.instanceName.trim() !== '';
        case 1: // Step 2: rtlFile
          return config.rtlFile.trim() !== '';
        case 2: // Step 3: csvPath
          return config.csvPath.trim() !== '';
        case 3: // Step 4: ralDirs
          return config.ralDirs.length > 0;
        case 4: // Step 5: outputDir
          return config.outputDir.trim() !== '';
        default:
          return true;
      }
    }
    // subsys level
    switch (step) {
      case 0: // Step 1: subsys + instanceName
        return config.subsys.trim() !== '' && config.instanceName.trim() !== '';
      case 1: // Step 2: rtlFile
        return config.rtlFile.trim() !== '';
      case 2: // Step 3: dutSpecPath
        return config.dutSpecPath.trim() !== '';
      case 3: // Step 4: miniExcelPath
        return config.miniExcelPath.trim() !== '';
      case 4: // Step 5: ralDirs
        return config.ralDirs.length > 0;
      case 5: // Step 6: clkDir
        return config.clkDir.trim() !== '';
      case 7: // Step 8: outputDir (required, default ./)
        return config.outputDir.trim() !== '';
      default:
        return true;
    }
  },
}));
