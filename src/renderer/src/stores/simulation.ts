import { create } from 'zustand';
import { trpc } from '@renderer/lib/trpc';
import { useToastStore } from './toast';
import { useTerminalStore } from './terminal';
import { useSettingsStore } from './settings';
import { tRPCError } from '@renderer/lib/trpc-utils';
import type { SimulationHistoryEntry, SimulationStatus } from '@shared/types';
import type { SimulationRunStatus as PluginRunStatus } from '@shared/plugin-types';

export interface SimulationRunRecord {
  runId: string;
  projectId: string;
  caseId: string;
  caseName?: string;
  subsys: string;
  /** 仿真种子（simOptions.seed，runsim -seed 参数；未设置时缺省） */
  seed?: string;
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
  /** Terminal session ID (for terminal-based simulation runs) */
  terminalId?: string;
  /** The runsim command that was executed (for preview display) */
  command?: string;
  /** Working directory where the command was executed */
  cwd?: string;
  /** Terminal backend type — 'node-pty' (interactive) or 'log-mode' (read-only fallback) */
  backend?: string;
  /** User-facing warning when running in fallback/log-mode */
  warning?: string | null;
}

export type SimulationCase = {
  name: string;
  subsys: string;
  base?: string;
  block?: string;
};

interface SimulationStoreState {
  activeRuns: SimulationRunRecord[];
  history: SimulationHistoryEntry[];
  selectedRunId: string | null;
  detailRunId: string | null;
  detailRun: SimulationHistoryEntry | null;
  loadingDetail: boolean;
  compareRunIdA: string | null;
  compareRunIdB: string | null;
  loadingHistory: boolean;
  /** listActiveRuns 拉取进行中（仿真视图骨架屏） */
  loadingActiveRuns: boolean;
  simOptions: Record<string, unknown>;

  startCaseRun: (projectId: string, simulationCase: SimulationCase) => Promise<string | null>;
  startCaseRuns: (projectId: string, simulationCases: SimulationCase[]) => Promise<string[]>;
  abortSimulation: (projectId: string, runId: string) => Promise<void>;
  abortTerminalRun: (terminalId: string) => Promise<void>;
  /** 停止全部运行中/队列中的仿真（终端运行走 terminalId，插件运行走 runId） */
  stopAllRuns: () => Promise<void>;
  /** 按运行记录重放其命令（rerunWithCommand + 终端 Tab + activeRuns upsert）；成功返回终端 tabId，失败返回 null */
  rerunRun: (run: SimulationRunRecord) => Promise<string | null>;
  loadHistory: (projectId: string) => Promise<void>;
  loadActiveRuns: (projectId: string) => Promise<void>;
  getRunDetail: (projectId: string, runId: string) => Promise<SimulationHistoryEntry | null>;
  compareResult: { runA: SimulationHistoryEntry | null; runB: SimulationHistoryEntry | null; differences: Array<{ field: string; valueA?: unknown; valueB?: unknown }> } | null;
  compareRuns: (projectId: string, runIdA: string, runIdB: string) => Promise<void>;
  handleSimulationEvent: (type: string, record: unknown) => void;
  setSelectedRunId: (runId: string | null) => void;
  loadRunDetail: (projectId: string, runId: string) => Promise<void>;
  setDetailRunId: (runId: string | null) => void;
  setCompareRunIds: (a: string | null, b: string | null) => void;
  selectCase: (simulationCase: SimulationCase) => void;
  setSimOption: (key: string, value: unknown) => void;
  setSimOptions: (options: Record<string, unknown>) => void;
  removeCompletedRuns: () => void;
}

let eventListenerRegistered = false;

/**
 * 幂等注册 simulation:event IPC 监听（模块级仅一次）。
 *
 * 必须在所有可能启动/刷新仿真的入口调用（startCaseRun / rerunRun /
 * loadActiveRuns / AppShell 挂载），因为仿真启动入口不止 startCaseRun 一个：
 * AI 工具卡（useSimRunAction）、终端工具栏重跑（SimControlToolbar）等
 * 直接调用 tRPC，若未注册监听，渲染端收不到 run:completed 事件，
 * 运行列表状态会卡在「进行中」，直到视图重新挂载触发 loadActiveRuns 才刷新。
 */
export function ensureSimulationEventListener(): void {
  if (eventListenerRegistered) return;
  if (typeof window === 'undefined' || !window.eventBridge) return;
  eventListenerRegistered = true;
  window.eventBridge.onSimulationEvent(({ type, record }) => {
    useSimulationStore.getState().handleSimulationEvent(type, record);
  });
}

/**
 * 从运行 options 提取 seed。两种来源结构不同：
 * - 终端运行（simTerminalLinker）：options 即 simOptions 本体，seed 在顶层；
 * - 插件运行（SimulationManager）：options 为 SimulationRunOptions，seed 在内层 options。
 */
function extractSeed(options: unknown): string | undefined {
  if (typeof options !== 'object' || options === null) return undefined;
  const o = options as { seed?: unknown; options?: unknown };
  if (typeof o.seed === 'string' && o.seed) return o.seed;
  if (typeof o.options === 'object' && o.options !== null) {
    const innerSeed = (o.options as { seed?: unknown }).seed;
    if (typeof innerSeed === 'string' && innerSeed) return innerSeed;
  }
  return undefined;
}

export const useSimulationStore = create<SimulationStoreState>((set, get) => ({
  activeRuns: [],
  history: [],
  selectedRunId: null,
  detailRunId: null,
  detailRun: null,
  loadingDetail: false,
  compareRunIdA: null,
  compareRunIdB: null,
  loadingHistory: false,
  loadingActiveRuns: false,
  compareResult: null,
  simOptions: {},

  startCaseRun: async (projectId, simulationCase) => {
    const options = { ...get().simOptions };
    if (simulationCase.base) options.base = simulationCase.base;
    if (simulationCase.block) options.block = simulationCase.block;
    options.case = simulationCase.name;
    set({ simOptions: options });

    try {
      const result = await trpc.simulation.runInTerminal.mutate({
        projectId,
        options: {
          caseId: simulationCase.name,
          caseName: simulationCase.name,
          subsys: simulationCase.subsys,
          options,
        },
      });
      const record: SimulationRunRecord = {
        runId: result.runId,
        projectId,
        caseId: simulationCase.name,
        caseName: simulationCase.name,
        subsys: simulationCase.subsys,
        seed: extractSeed(options),
        status: 'running',
        startTime: Date.now(),
        terminalId: result.terminalId,
        command: result.command,
        cwd: result.cwd,
        backend: (result as { backend?: string }).backend,
        warning: (result as { warning?: string | null }).warning,
      };
      // The IPC 'started' event might arrive before this mutate returns,
      // creating a record without terminalId/command/cwd. If so, update it;
      // otherwise add the new record.
      set((s) => {
        const existing = s.activeRuns.find((r) => r.runId === result.runId);
        if (existing) {
          return {
            activeRuns: s.activeRuns.map((r) =>
              r.runId === result.runId
                ? { ...r, terminalId: result.terminalId, command: result.command, cwd: result.cwd, status: 'running' as SimulationStatus, backend: (result as { backend?: string }).backend, warning: (result as { warning?: string | null }).warning }
                : r,
            ),
          };
        }
        return { activeRuns: [...s.activeRuns, record] };
      });

      useTerminalStore.getState().createTabForSession(
        result.terminalId,
        `sim: ${simulationCase.name}`,
        result.cwd,
        (result as { backend?: string }).backend === 'log-mode',
        (result as { warning?: string | null }).warning ?? null,
      );
      // Note: the terminal tab is already opened by createTabForSession
      // above. Do NOT switch to 'running-simulations' here — that would
      // immediately hide the terminal, preventing the user from seeing
      // the simulation command and output (especially in log-mode where
      // the command echo and stdout/stderr are the only visibility).

      // Show a toast depending on how log-mode was entered:
      //  - 用户在设置中启用了"日志模式执行仿真" → info 提示（预期行为）
      //  - node-pty 不可用导致的被动回退 → warning 提示（附原因与修复建议）
      if ((result as { backend?: string }).backend === 'log-mode') {
        const preferLogMode = await useSettingsStore.getState().loadPreferLogMode();
        if (preferLogMode) {
          useToastStore.getState().info(
            '仿真以日志模式运行',
            '已在设置中启用"日志模式执行仿真"，仿真以只读日志模式执行。可在 设置 → 仿真 中关闭。',
          );
        } else {
          const isLinux = navigator.userAgent.includes('Linux');
          const reason = isLinux
            ? '可能由于 AppImage 环境缺少 native 模块'
            : 'node-pty 原生模块未能加载，请尝试重新安装依赖 (npm install) 或重新构建原生模块 (npx @electron/rebuild -f -w node-pty)';
          useToastStore.getState().warning(
            '终端运行在日志模式',
            `node-pty 不可用（${reason}）。仿真将以只读日志模式运行，输出可正常查看但无法交互输入。`,
          );
        }
      }

      // Register IPC event listener once
      ensureSimulationEventListener();

      useToastStore.getState().info(`仿真已启动 (终端): ${simulationCase.name}`);
      return result.runId;
    } catch (err) {
      useToastStore.getState().error('启动终端仿真失败', tRPCError(err));
      return null;
    }
  },

  startCaseRuns: async (projectId, simulationCases) => {
    const runIds: string[] = [];
    for (const simulationCase of simulationCases) {
      const runId = await get().startCaseRun(projectId, simulationCase);
      if (runId) runIds.push(runId);
    }
    return runIds;
  },

  abortTerminalRun: async (terminalId) => {
    try {
      await trpc.simulation.abortTerminalRun.mutate({ terminalId });
      set((s) => ({
        activeRuns: s.activeRuns.map((r) =>
          r.terminalId === terminalId
            ? { ...r, status: 'aborted' as SimulationStatus, endTime: Date.now() }
            : r,
        ),
      }));
      useToastStore.getState().info('仿真已中止');
    } catch (err) {
      useToastStore.getState().error('中止仿真失败', tRPCError(err));
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

  stopAllRuns: async () => {
    const live = get().activeRuns.filter((r) => r.status === 'running' || r.status === 'pending');
    if (live.length === 0) {
      useToastStore.getState().info('没有运行中的仿真');
      return;
    }
    // 与 SimulationView 停止全部一致：终端运行走 terminalId，插件运行走 runId
    for (const run of live) {
      if (run.terminalId) await get().abortTerminalRun(run.terminalId);
      else await get().abortSimulation(run.projectId, run.runId);
    }
  },

  rerunRun: async (run) => {
    if (!run.command) {
      useToastStore.getState().error('无法重跑', '该运行没有可重放的命令');
      return null;
    }
    // rerunRun 是独立于 startCaseRun 的启动入口（运行详情「重新仿真」、
    // 命令面板重跑失败用例），同样需要确保事件监听已注册
    ensureSimulationEventListener();
    try {
      const result = await trpc.simulation.rerunWithCommand.mutate({
        projectId: run.projectId,
        command: run.command,
        cwd: run.cwd ?? '',
        caseId: run.caseId,
        caseName: run.caseName,
        subsys: run.subsys,
      });
      const terminal = useTerminalStore.getState();
      const tabId = terminal.createTabForSession(
        result.terminalId,
        `sim: ${run.caseName ?? run.caseId}`,
        run.cwd,
        (result as { backend?: string }).backend === 'log-mode',
        (result as { warning?: string | null }).warning ?? null,
      );
      terminal.setActiveTab(tabId);
      const displayCommand = result.command ?? run.command;
      // upsert：IPC run:started 事件可能先于 mutate 返回到达
      // 同时移除同 caseId×subsys 的旧终态记录（如 fail/pass/aborted），
      // 避免重新仿真后同一用例出现两条记录（旧 fail + 新 running）。
      set((s) => {
        const existing = s.activeRuns.find((r) => r.runId === result.runId);
        if (existing) {
          return {
            activeRuns: s.activeRuns.map((r) =>
              r.runId === result.runId
                ? {
                    ...r,
                    terminalId: r.terminalId ?? result.terminalId,
                    command: r.command ?? displayCommand,
                    cwd: r.cwd ?? run.cwd,
                    status: 'running' as SimulationStatus,
                    backend: (result as { backend?: string }).backend,
                    warning: (result as { warning?: string | null }).warning,
                  }
                : r,
            ),
          };
        }
        // 移除同 caseId×subsys 的旧终态记录，只保留新 running 记录
        const deduped = s.activeRuns.filter(
          (r) => !(r.caseId === run.caseId && r.subsys === run.subsys && r.runId !== result.runId),
        );
        return {
          activeRuns: [
            ...deduped,
            {
              runId: result.runId,
              projectId: run.projectId,
              caseId: run.caseId,
              caseName: run.caseName,
              subsys: run.subsys,
              seed: run.seed,
              status: 'running' as SimulationStatus,
              startTime: Date.now(),
              terminalId: result.terminalId,
              command: displayCommand,
              cwd: run.cwd,
              backend: (result as { backend?: string }).backend,
              warning: (result as { warning?: string | null }).warning,
            },
          ],
        };
      });
      useToastStore.getState().info(`重新执行仿真: ${run.caseName ?? run.caseId}`);
      return tabId;
    } catch (err) {
      useToastStore.getState().error('重新执行仿真失败', tRPCError(err));
      return null;
    }
  },

  loadHistory: async (projectId) => {
    ensureSimulationEventListener();
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
    // 仿真视图/运行列表面板/总览挂载即注册事件监听（幂等）——
    // 覆盖通过 AI 工具卡、终端工具栏等绕过 store 启动的仿真
    ensureSimulationEventListener();
    set({ loadingActiveRuns: true });
    try {
      const runs = await trpc.simulation.listActiveRuns.query({ projectId });
      set((s) => {
        // 后端 listActiveRuns 已合并三个数据源（DB persistedRuns +
        // SimulationManager activeRuns + simTerminalLinker terminalRuns）
        // 并按 caseId×subsys 去重，返回每个 case 最新一条。
        //
        // 前端以"后端返回的 runId 集合"为基准重建列表：
        // 1. 后端返回的记录 → 直接使用（保留本地 terminalId/command 等字段）
        // 2. 本地 running/pending 且不在后端列表中的记录 → 保留（安全网：
        //    刚通过 IPC started 事件添加但后端尚未返回的终端仿真）
        // 3. 本地已终态且不在后端列表中的记录 → 丢弃（同 case 旧记录已被
        //    后端新记录覆盖，不应再显示，避免同一用例出现重复条目）
        const backendRunIds = new Set(runs.map((r) => r.runId));
        const backendRuns: SimulationRunRecord[] = runs.map((r) => {
          const incoming: SimulationRunRecord = {
            runId: r.runId,
            projectId: r.projectId,
            caseId: r.options.caseId,
            caseName: r.options.caseName,
            subsys: r.options.subsys,
            seed: extractSeed(r.options),
            status: r.status.status as SimulationStatus,
            startTime: r.startTime,
            endTime: r.endTime,
            compileErrors: r.compileErrors,
            // 后端 listActiveRuns 对终端仿真来源返回 command/cwd，用于重新仿真
            command: (r as { command?: string }).command,
            cwd: (r as { cwd?: string }).cwd,
          };
          const existing = s.activeRuns.find((old) => old.runId === r.runId);
          return existing
            ? {
                ...existing,
                status: incoming.status,
                endTime: incoming.endTime,
                compileErrors: incoming.compileErrors,
                seed: incoming.seed ?? existing.seed,
                // 后端返回的 command/cwd 可能比本地旧值更准确（尤其页面刷新后本地数据丢失）
                command: incoming.command ?? existing.command,
                cwd: incoming.cwd ?? existing.cwd,
              }
            : incoming;
        });
        // 保留本地 running/pending 但后端尚未返回的记录
        const localOnlyLive = s.activeRuns.filter(
          (r) =>
            !backendRunIds.has(r.runId) &&
            (r.status === 'running' || r.status === 'pending'),
        );
        return { activeRuns: [...backendRuns, ...localOnlyLive] };
      });
    } catch {
      // best-effort
    } finally {
      set({ loadingActiveRuns: false });
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
    // The IPC record may come from two sources:
    // 1. SimulationManager: `status` is a SimulationRunStatus object {runId, status, startTime, ...}
    // 2. simTerminalLinker: `status` is a plain string, plus terminalId/command/cwd fields
    const ipcRecord = recordRaw as {
      runId: string;
      projectId: string;
      caseId?: string;
      caseName?: string;
      subsys?: string;
      options?: { caseId?: string; caseName?: string; subsys?: string; seed?: unknown; options?: { seed?: unknown } };
      status: PluginRunStatus | string;
      startTime: number;
      endTime?: number;
      compileErrors?: SimulationRunRecord['compileErrors'];
      terminalId?: string;
      command?: string;
      cwd?: string;
    };
    if (!ipcRecord || !ipcRecord.runId) return;

    // Helper: extract status string from SimulationRunStatus object or plain string
    const statusStr: SimulationStatus =
      typeof ipcRecord.status === 'object' && ipcRecord.status !== null
        ? (ipcRecord.status.status as SimulationStatus)
        : (ipcRecord.status as SimulationStatus);

    switch (type) {
      case 'started':
        set((s) => {
          const existing = s.activeRuns.find((r) => r.runId === ipcRecord.runId);
          if (existing) {
            // Update with terminal fields from IPC event if missing
            return {
              activeRuns: s.activeRuns.map((r) =>
                r.runId === ipcRecord.runId
                  ? {
                      ...r,
                      terminalId: r.terminalId ?? ipcRecord.terminalId,
                      command: r.command ?? ipcRecord.command,
                      cwd: r.cwd ?? ipcRecord.cwd,
                    }
                  : r,
              ),
            };
          }
          const newRecord: SimulationRunRecord = {
            runId: ipcRecord.runId,
            projectId: ipcRecord.projectId,
            caseId: ipcRecord.caseId ?? ipcRecord.options?.caseId ?? '',
            caseName: ipcRecord.caseName ?? ipcRecord.options?.caseName,
            subsys: ipcRecord.subsys ?? ipcRecord.options?.subsys ?? '',
            seed: extractSeed(ipcRecord.options),
            status: statusStr,
            startTime: ipcRecord.startTime,
            endTime: ipcRecord.endTime,
            compileErrors: ipcRecord.compileErrors,
            terminalId: ipcRecord.terminalId,
            command: ipcRecord.command,
            cwd: ipcRecord.cwd,
          };
          return { activeRuns: [...s.activeRuns, newRecord] };
        });
        break;

      case 'statusChanged':
        set((s) => ({
          activeRuns: s.activeRuns.map((r) =>
            r.runId === ipcRecord.runId
              ? { ...r, status: statusStr, endTime: ipcRecord.endTime, terminalId: r.terminalId ?? ipcRecord.terminalId, command: r.command ?? ipcRecord.command, cwd: r.cwd ?? ipcRecord.cwd }
              : r,
          ),
        }));
        break;

      case 'completed':
        set((s) => ({
          activeRuns: s.activeRuns.map((r) =>
            r.runId === ipcRecord.runId
              ? { ...r, status: statusStr, endTime: ipcRecord.endTime, compileErrors: ipcRecord.compileErrors }
              : r,
          ),
        }));
        // Auto-refresh history
        {
          const projectId = ipcRecord.projectId;
          if (projectId) {
            void get().loadHistory(projectId);
            // 自愈刷新：无论本地记录是否存在/runId 是否匹配，都从后端
            // 拉取一次最新运行列表（后端已合并 linker/DB 终态），确保
            // 运行列表实时反映终态，不会卡在「进行中」
            void get().loadActiveRuns(projectId);
          }
        }
        // Trigger automatic error analysis on FAIL
        if (statusStr === 'fail' || statusStr === 'error') {
          const caseName = ipcRecord.caseName ?? ipcRecord.options?.caseName ?? ipcRecord.caseId ?? ipcRecord.options?.caseId ?? '';
          const projectId = ipcRecord.projectId;
          if (caseName && projectId) {
            // Notify user that auto-analysis is starting
            useToastStore.getState().info(`检测到 ${caseName} 仿真失败，正在启动 AI 自动分析...`);
          }
        }
        break;

      case 'aborted':
        set((s) => ({
          activeRuns: s.activeRuns.map((r) =>
            r.runId === ipcRecord.runId
              ? { ...r, status: 'aborted' as SimulationStatus, endTime: ipcRecord.endTime }
              : r,
          ),
        }));
        break;
    }
  },

  setSelectedRunId: (runId) => set({ selectedRunId: runId }),
  setDetailRunId: (runId) => set({ detailRunId: runId, detailRun: null }),
  loadRunDetail: async (projectId, runId) => {
    set({ loadingDetail: true, detailRunId: runId });
    try {
      const detail = await trpc.simulation.getRunDetail.query({ projectId, runId });
      set({ detailRun: detail, loadingDetail: false });
    } catch (err) {
      set({ loadingDetail: false });
      useToastStore.getState().error('加载运行详情失败', tRPCError(err));
    }
  },
  setCompareRunIds: (a, b) => set({ compareRunIdA: a, compareRunIdB: b }),
  selectCase: (simulationCase) => set((state) => {
    const options: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(state.simOptions)) {
      if (key === 'post' || key === 'bq') {
        options[key] = value;
      } else if (key !== 'base' && key !== 'block' && key !== 'case') {
        options[key] = typeof value === 'boolean' ? false : '';
      }
    }
    if (simulationCase.base) options.base = simulationCase.base;
    if (simulationCase.block) options.block = simulationCase.block;
    options.case = simulationCase.name;
    return { simOptions: options };
  }),
  setSimOption: (key, value) => set((s) => ({ simOptions: { ...s.simOptions, [key]: value } })),
  setSimOptions: (options) => set({ simOptions: options }),
  removeCompletedRuns: () => set((s) => ({
    activeRuns: s.activeRuns.filter((r) => r.status === 'running' || r.status === 'pending'),
  })),
}));
