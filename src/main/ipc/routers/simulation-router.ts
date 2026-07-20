/**
 * Simulation router — background runs, terminal runs, history, comparison.
 */

import { resolve, isAbsolute } from 'node:path';
import { createRequire } from 'node:module';
import { t, TRPCError, requireProject, getSimulationManager, ensurePluginsLoaded } from '../router-context';
import { pluginLoader } from '../../plugins/loader';
import { terminalManager } from '../../terminal/terminal-manager';
import { simTerminalLinker } from '../../simulation/sim-terminal-linker';
import type { SimulationRunOptions } from '@shared/plugin-types';

export const simulationRouter = t.router({
  run: t.procedure
    .input((raw): { projectId: string; options: SimulationRunOptions } => {
      const r = raw as Record<string, unknown>;
      if (typeof r.projectId !== 'string') {
        throw new TRPCError({ code: 'BAD_REQUEST', message: 'projectId is required' });
      }
      if (typeof r.options !== 'object' || r.options === null) {
        throw new TRPCError({ code: 'BAD_REQUEST', message: 'options is required' });
      }
      return { projectId: r.projectId, options: r.options as SimulationRunOptions };
    })
    .mutation(async ({ input }) => {
      const project = requireProject(input.projectId);
      const manager = getSimulationManager(input.projectId);
      if (!manager.hasRunner()) {
        throw new TRPCError({ code: 'PRECONDITION_FAILED', message: 'No simulation-runner plugin loaded' });
      }
      const handle = await manager.run({ ...input.options, projectRoot: project.rootPath });
      return { runId: handle.runId };
    }),

  getStatus: t.procedure
    .input((raw): { projectId: string; runId: string } => {
      const r = raw as Record<string, unknown>;
      if (typeof r.projectId !== 'string' || typeof r.runId !== 'string') {
        throw new TRPCError({ code: 'BAD_REQUEST', message: 'projectId and runId are required' });
      }
      return { projectId: r.projectId, runId: r.runId };
    })
    .query(async ({ input }) => {
      const manager = getSimulationManager(input.projectId);
      return manager.getStatus(input.runId);
    }),

  getCompileErrors: t.procedure
    .input((raw): { projectId: string; runId: string } => {
      const r = raw as Record<string, unknown>;
      if (typeof r.projectId !== 'string' || typeof r.runId !== 'string') {
        throw new TRPCError({ code: 'BAD_REQUEST', message: 'projectId and runId are required' });
      }
      return { projectId: r.projectId, runId: r.runId };
    })
    .query(async ({ input }) => {
      const manager = getSimulationManager(input.projectId);
      return manager.getCompileErrors(input.runId);
    }),

  abort: t.procedure
    .input((raw): { projectId: string; runId: string } => {
      const r = raw as Record<string, unknown>;
      if (typeof r.projectId !== 'string' || typeof r.runId !== 'string') {
        throw new TRPCError({ code: 'BAD_REQUEST', message: 'projectId and runId are required' });
      }
      return { projectId: r.projectId, runId: r.runId };
    })
    .mutation(async ({ input }) => {
      const manager = getSimulationManager(input.projectId);
      await manager.abort(input.runId);
      return { ok: true };
    }),

  listActiveRuns: t.procedure
    .input((raw): { projectId: string } => {
      const r = raw as Record<string, unknown>;
      if (typeof r.projectId !== 'string') {
        throw new TRPCError({ code: 'BAD_REQUEST', message: 'projectId is required' });
      }
      return { projectId: r.projectId };
    })
    .query(async ({ input }) => {
      const manager = getSimulationManager(input.projectId);
      return manager.getActiveRuns();
    }),

  getHistory: t.procedure
    .input((raw): { projectId: string } => {
      const r = raw as Record<string, unknown>;
      if (typeof r.projectId !== 'string') {
        throw new TRPCError({ code: 'BAD_REQUEST', message: 'projectId is required' });
      }
      return { projectId: r.projectId };
    })
    .query(async ({ input }) => {
      const manager = getSimulationManager(input.projectId);
      return manager.getHistory();
    }),

  getRunDetail: t.procedure
    .input((raw): { projectId: string; runId: string } => {
      const r = raw as Record<string, unknown>;
      if (typeof r.projectId !== 'string' || typeof r.runId !== 'string') {
        throw new TRPCError({ code: 'BAD_REQUEST', message: 'projectId and runId are required' });
      }
      return { projectId: r.projectId, runId: r.runId };
    })
    .query(async ({ input }) => {
      const manager = getSimulationManager(input.projectId);
      const detail = manager.getRunDetail(input.runId);
      if (!detail) {
        throw new TRPCError({ code: 'NOT_FOUND', message: `Run not found: ${input.runId}` });
      }
      return detail;
    }),

  compareRuns: t.procedure
    .input((raw): { projectId: string; runIdA: string; runIdB: string } => {
      const r = raw as Record<string, unknown>;
      if (typeof r.projectId !== 'string' || typeof r.runIdA !== 'string' || typeof r.runIdB !== 'string') {
        throw new TRPCError({ code: 'BAD_REQUEST', message: 'projectId, runIdA and runIdB are required' });
      }
      return { projectId: r.projectId, runIdA: r.runIdA, runIdB: r.runIdB };
    })
    .query(async ({ input }) => {
      const manager = getSimulationManager(input.projectId);
      return manager.compareRuns(input.runIdA, input.runIdB);
    }),

  // ── 终端仿真（在终端 PTY 中执行 runsim 命令）──────────

  /**
   * 在终端中启动仿真：创建 PTY 会话 → 写入 runsim 命令 → 注册仿真跟踪。
   *
   * 与 `simulation.run` 不同，此过程不会在隐藏子进程中执行仿真，
   * 而是在可见终端中执行，用户可以实时查看仿真输出。
   * 仿真状态通过终端退出码判定（0=pass, 非零=fail）。
   */
  runInTerminal: t.procedure
    .input((raw): { projectId: string; options: SimulationRunOptions } => {
      const r = raw as Record<string, unknown>;
      if (typeof r.projectId !== 'string') {
        throw new TRPCError({ code: 'BAD_REQUEST', message: 'projectId is required' });
      }
      if (typeof r.options !== 'object' || r.options === null) {
        throw new TRPCError({ code: 'BAD_REQUEST', message: 'options is required' });
      }
      return { projectId: r.projectId, options: r.options as SimulationRunOptions };
    })
    .mutation(async ({ input }) => {
      const project = requireProject(input.projectId);
      await ensurePluginsLoaded(project.rootPath);
      const registry = pluginLoader.getRegistry(project.rootPath);
      if (registry.simulationRunners.length === 0) {
        throw new TRPCError({ code: 'PRECONDITION_FAILED', message: 'No simulation-runner plugin loaded' });
      }

      // 获取仿真 runner 插件路径，重新 require 以访问导出的命令生成函数
      const loadResults = pluginLoader.getLoadResults(project.rootPath);
      const simRunnerResult = loadResults.find(
        (r) => r.manifest.kind === 'simulation-runner' && !r.error,
      );
      if (!simRunnerResult) {
        throw new TRPCError({ code: 'PRECONDITION_FAILED', message: 'Simulation runner plugin path not found' });
      }

      const pluginPath =
        simRunnerResult.source === 'local' && !isAbsolute(simRunnerResult.path)
          ? resolve(project.rootPath, simRunnerResult.path)
          : simRunnerResult.path;

      const nodeRequire = createRequire(import.meta.url);
      const mod = nodeRequire(pluginPath);

      const opts: SimulationRunOptions = { ...input.options, projectRoot: project.rootPath };

      // 生成 runsim 命令
      const command: string | null =
        typeof mod.generateRunsimCommand === 'function'
          ? mod.generateRunsimCommand(opts)
          : null;
      const cwd: string =
        typeof mod.resolveCwd === 'function'
          ? mod.resolveCwd(opts)
          : project.rootPath;

      if (!command) {
        throw new TRPCError({
          code: 'INTERNAL_SERVER_ERROR',
          message: 'Simulation runner plugin does not export generateRunsimCommand',
        });
      }

      // 构建 displayCommand：若 $PROJ_WORK 已定义，先 cd 到项目工作目录
      const projWork = process.env.PROJ_WORK;
      const cdPrefix = projWork ? `cd "${projWork}" && ` : '';
      const displayCommand = `${cdPrefix}${command}`;

      // ── 检查 node-pty 是否可用 ──────────────────────────────
      //
      // 当 node-pty 不可用时（如 AppImage 中 native 模块未 rebuild），
      // 使用 log-mode 直接通过 `shell -c "command"` 执行仿真命令，
      // 而非创建交互式 shell 并写入命令。这避免了 `spawn bash ENOENT`
      // 错误，并将仿真输出以只读日志形式展示在终端视图中。
      //
      // 与 PTY 模式的区别：
      //   - 不追加 `__SIM_DONE__` 标记（不需要，直接用 exit 事件判定）
      //   - 不等待 shell 初始化（直接执行命令）
      //   - 终端为只读（无交互输入）
      let session;
      if (terminalManager.isPtyAvailable()) {
        // PTY 模式：创建交互式终端会话
        session = await terminalManager.create({ cwd });

        // 等待 shell 初始化完成
        await new Promise(resolve => setTimeout(resolve, 500));

        // 写入仿真命令 + 完成标记
        const execCommand = `${displayCommand}; echo "__SIM_DONE__$?__"`;
        terminalManager.write(session.id, `${execCommand}\r`);
      } else {
        // Log 模式：直接执行命令，stdout/stderr 流式输出到终端视图
        console.log('[simulation] node-pty unavailable — using log-mode execution.');
        session = await terminalManager.runCommand({
          command: displayCommand,
          cwd,
        });
      }

      // 注册仿真-终端关联（监听终端退出 → 判定 pass/fail）
      const run = simTerminalLinker.register(
        input.projectId,
        session.id,
        displayCommand,
        cwd,
        input.options,
      );

      return {
        runId: run.runId,
        terminalId: session.id,
        command: displayCommand,
        cwd,
        backend: session.backend,
        warning: session.warning,
      };
    }),

  /**
   * 获取当前活跃的终端仿真运行列表。
   */
  getActiveTerminalRuns: t.procedure
    .input((raw): { projectId: string } => {
      const r = raw as Record<string, unknown>;
      if (typeof r.projectId !== 'string') {
        throw new TRPCError({ code: 'BAD_REQUEST', message: 'projectId is required' });
      }
      return { projectId: r.projectId };
    })
    .query(({ input }) => {
      return simTerminalLinker.getActiveRuns(input.projectId);
    }),

  /**
   * 中止终端仿真运行（销毁终端 PTY 会话）。
   */
  abortTerminalRun: t.procedure
    .input((raw): { terminalId: string } => {
      const r = raw as Record<string, unknown>;
      if (typeof r.terminalId !== 'string') {
        throw new TRPCError({ code: 'BAD_REQUEST', message: 'terminalId is required' });
      }
      return { terminalId: r.terminalId };
    })
    .mutation(({ input }) => {
      simTerminalLinker.abort(input.terminalId);
      return { ok: true };
    }),
});
