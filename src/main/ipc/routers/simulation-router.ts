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

      // 创建终端 PTY 会话（初始工作目录为 resolveCwd 的结果）
      const session = await terminalManager.create({ cwd });

      // 等待 shell 初始化完成（PTY 启动后 shell 需要短暂时间初始化并显示提示符）
      await new Promise(resolve => setTimeout(resolve, 500));

      // 写入仿真命令到终端：
      //   - 若 $PROJ_WORK 环境变量已定义，先执行 cd "$PROJ_WORK" 切换到项目工作目录
      //   - 若未定义，终端已在 resolveCwd 返回的 cwd 中，直接执行 runsim 命令
      //   - 追加 '; echo "__SIM_DONE__$?__"' 作为完成标记（不执行 exit，shell 保持存活）
      //     simTerminalLinker 监听终端输出，检测到标记后判定 pass/fail
      //   - 使用 \r（回车）而非 \n 作为 PTY 的 Enter 键
      const projWork = process.env.PROJ_WORK;
      const cdPrefix = projWork ? `cd "${projWork}" && ` : '';
      const displayCommand = `${cdPrefix}${command}`;
      const execCommand = `${displayCommand}; echo "__SIM_DONE__$?__"`;
      terminalManager.write(session.id, `${execCommand}\r`);

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
