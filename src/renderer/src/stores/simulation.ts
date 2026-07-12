import { create } from 'zustand';
import { trpc } from '@renderer/lib/trpc';
import { useToastStore } from './toast';
import type { SimulationHistoryEntry, SimulationStatus } from '@shared/types';

export interface SimulationRunRecord {
  runId: string;
  projectId: string;
  caseId: string;
  caseName?: string;
  subsys: string;
  status: SimulationStatus;
  startTime: number;
  endTime?: number;
  compileErrors?: Array<{
    file: string;
    line: number;
    column?: number;
    severity: 'error' | 'warning';
    message: string;
  }>;
}

interface SimulationStoreState {
  activeRuns: SimulationRunRecord[];
  history: SimulationHistoryEntry[];
  selectedRunId: string | null;
  compareRunIdA: string | null;
  compareRunIdB: string | null;
  loadingHistory: boolean;
  simOptions: Record<string, unknown>;

  runSimulation: (projectId: string, caseId: string, caseName: string, subsys: string, options?: Record<string, unknown>) => Promise<string | null>;
  abortSimulation: (projectId: string, runId: string) => Promise<void>;
  loadHistory: (projectId: string) => Promise<void>;
  loadActiveRuns: (projectId: string) => Promise<void>;
  getRunDetail: (projectId: string, runId: string) => Promise<SimulationHistoryEntry | null>;
  compareResult: { runA: SimulationHistoryEntry | null; runB: SimulationHistoryEntry | null; differences: Array<{ field: string; valueA?: unknown; valueB?: unknown }> } | null;
  compareRuns: (projectId: string, runIdA: string, runIdB: string) => Promise<void>;
  handleSimulationEvent: (type: string, record: unknown) => void;
  setSelectedRunId: (runId: string | null) => void;
  setCompareRunIds: (a: string | null, b: string | null) => void;
  setSimOption: (key: string, value: unknown) => void;
  setSimOptions: (options: Record<string, unknown>) => void;
}

function tRPCError(err: unknown): string {
  if (err instanceof Error) return err.message;
  if (typeof err === 'object' && err !== null && 'message' in err) {
    return String((err as Record<string, unknown>).message);
  }
  return String(err);
}

let eventListenerRegistered = false;

export const useSimulationStore = create<SimulationStoreState>((set, get) => ({
  activeRuns: [],
  history: [],
  selectedRunId: null,
  compareRunIdA: null,
  compareRunIdB: null,
  loadingHistory: false,
  compareResult: null,
  simOptions: {},

  runSimulation: async (projectId, caseId, caseName, subsys, options) => {
    try {
      const result = await trpc.simulation.run.mutate({
        projectId,
        options: { caseId, caseName, subsys, options },
      });
      const record: SimulationRunRecord = {
        runId: result.runId,
        projectId,
        caseId,
        caseName,
        subsys,
        status: 'pending',
        startTime: Date.now(),
      };
      set((s) => ({ activeRuns: [...s.activeRuns, record] }));

      // Register IPC event listener once
      if (!eventListenerRegistered && window.eventBridge) {
        eventListenerRegistered = true;
        window.eventBridge.onSimulationEvent(({ type, record }) => {
          get().handleSimulationEvent(type, record);
        });
      }

      useToastStore.getState().info(`仿真已启动: ${caseName}`);
      return result.runId;
    } catch (err) {
      useToastStore.getState().error('启动仿真失败', tRPCError(err));
      return null;
    }
  },

  abortSimulation: async (projectId, runId) => {
    try {
      await trpc.simulation.abort.mutate({ projectId, runId });
      set((s) => ({
        activeRuns: s.activeRuns.map((r) =>
          r.runId === runId ? { ...r, status: 'aborted', endTime: Date.now() } : r,
        ),
      }));
      useToastStore.getState().info('仿真已中止');
    } catch (err) {
      useToastStore.getState().error('中止仿真失败', tRPCError(err));
    }
  },

  loadHistory: async (projectId) => {
    set({ loadingHistory: true });
    try {
      const history = await trpc.simulation.getHistory.query({ projectId });
      set({ history, loadingHistory: false });
    } catch (err) {
      set({ loadingHistory: false });
      useToastStore.getState().error('加载仿真历史失败', tRPCError(err));
    }
  },

  loadActiveRuns: async (projectId) => {
    try {
      const runs = await trpc.simulation.listActiveRuns.query({ projectId });
      set({
        activeRuns: runs.map((r) => ({
          runId: r.runId,
          projectId: r.projectId,
          caseId: r.options.caseId,
          caseName: r.options.caseName,
          subsys: r.options.subsys,
          status: r.status.status as SimulationStatus,
          startTime: r.startTime,
          endTime: r.endTime,
          compileErrors: r.compileErrors,
        })),
      });
    } catch {
      // best-effort
    }
  },

  getRunDetail: async (projectId, runId) => {
    try {
      return await trpc.simulation.getRunDetail.query({ projectId, runId });
    } catch (err) {
      useToastStore.getState().error('获取运行详情失败', tRPCError(err));
      return null;
    }
  },

  compareRuns: async (projectId, runIdA, runIdB) => {
    try {
      const result = await trpc.simulation.compareRuns.query({ projectId, runIdA, runIdB });
      set({ compareRunIdA: runIdA, compareRunIdB: runIdB, compareResult: result });
    } catch (err) {
      useToastStore.getState().error('对比运行失败', tRPCError(err));
    }
  },

  handleSimulationEvent: (type, recordRaw) => {
    const record = recordRaw as SimulationRunRecord;
    if (!record) return;

    switch (type) {
      case 'started':
        set((s) => {
          if (s.activeRuns.find((r) => r.runId === record.runId)) return s;
          return { activeRuns: [...s.activeRuns, record] };
        });
        break;

      case 'statusChanged':
        set((s) => ({
          activeRuns: s.activeRuns.map((r) =>
            r.runId === record.runId
              ? { ...r, status: record.status, endTime: record.endTime }
              : r,
          ),
        }));
        break;

      case 'completed':
        set((s) => ({
          activeRuns: s.activeRuns.map((r) =>
            r.runId === record.runId
              ? { ...r, status: record.status, endTime: record.endTime, compileErrors: record.compileErrors }
              : r,
          ),
        }));
        // Auto-refresh history
        {
          const projectId = record.projectId;
          void get().loadHistory(projectId);
        }
        break;

      case 'aborted':
        set((s) => ({
          activeRuns: s.activeRuns.map((r) =>
            r.runId === record.runId
              ? { ...r, status: 'aborted', endTime: record.endTime }
              : r,
          ),
        }));
        break;
    }
  },

  setSelectedRunId: (runId) => set({ selectedRunId: runId }),
  setCompareRunIds: (a, b) => set({ compareRunIdA: a, compareRunIdB: b }),
  setSimOption: (key, value) => set((s) => ({ simOptions: { ...s.simOptions, [key]: value } })),
  setSimOptions: (options) => set({ simOptions: options }),
}));
