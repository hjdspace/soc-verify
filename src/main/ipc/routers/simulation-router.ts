/**
 * Simulation router — background runs, terminal runs, history, comparison.
 */

import { resolve, isAbsolute } from 'node:path';
import { readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { createRequire } from 'node:module';
import { dialog } from 'electron';
import { t, TRPCError } from '../router-context';
import { requireProject, ensurePluginsLoaded } from '../../services/project-service';
import { getSimulationManager } from '../../services/simulation-service';
import { pluginLoader } from '../../plugins/loader';
import { terminalManager, findSimShell } from '../../terminal/terminal-manager';
import { simTerminalLinker } from '../../simulation/sim-terminal-linker';
import { caseStatsRegistry } from '../../case/case-stats-registry';
import { getRecentSimulationRuns } from '../../case/db/case-repository';
import type { SimulationRunOptions } from '@shared/plugin-types';
import type { SimulationRunRecord } from '../../simulation/simulation-manager';
import type { SimulationStatus } from '@shared/types';

type ListedRun = {
  runId: string;
  projectId: string;
  options: { caseId: string; caseName: string; subsys: string; options: Record<string, unknown> };
  status: { runId: string; status: string; startTime: number; endTime?: number };
  startTime: number;
  endTime?: number;
  compileErrors?: SimulationRunRecord['compileErrors'];
};

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
      const project = requireProject(input.projectId);
      const manager = getSimulationManager(input.projectId);
      caseStatsRegistry.ensureTerminalListener(project.rootPath, input.projectId);
      const activeRuns: ListedRun[] = manager.getActiveRuns().map((run) => ({
        runId: run.runId,
        projectId: run.projectId,
        options: {
          caseId: run.options.caseId,
          caseName: run.options.caseName ?? run.options.caseId,
          subsys: run.options.subsys,
          options: run.options.options ?? {},
        },
        status: {
          runId: run.runId,
          status: run.status.status,
          startTime: run.status.startTime ?? run.startTime,
          endTime: run.status.endTime,
        },
        startTime: run.startTime,
        endTime: run.endTime,
        compileErrors: run.compileErrors,
      }));
      const terminalRuns: ListedRun[] = simTerminalLinker.getActiveRuns(input.projectId).map((run) => ({
        runId: run.runId,
        projectId: run.projectId,
        options: {
          caseId: run.caseId,
          caseName: run.caseName ?? run.caseId,
          subsys: run.subsys,
          options: run.options,
        },
        status: {
          runId: run.runId,
          status: run.status,
          startTime: run.startTime,
          endTime: run.endTime,
        },
        startTime: run.startTime,
        endTime: run.endTime,
        compileErrors: undefined,
      }));
      const db = caseStatsRegistry.getOrCreateDb(project.rootPath);
      const persistedRuns: ListedRun[] = getRecentSimulationRuns(db).map((run) => ({
        runId: run.runId ?? `persisted-${run.id}`,
        projectId: input.projectId,
        options: {
          caseId: run.caseName,
          caseName: run.caseName,
          subsys: run.subsys,
          options: run.optionsJson ? JSON.parse(run.optionsJson) as Record<string, unknown> : {},
        },
        status: {
          runId: run.runId ?? `persisted-${run.id}`,
          status: run.status,
          startTime: Date.parse(run.startTime),
          endTime: run.endTime ? Date.parse(run.endTime) : undefined,
        },
        startTime: Date.parse(run.startTime),
        endTime: run.endTime ? Date.parse(run.endTime) : undefined,
        compileErrors: undefined,
      }));
      // The DB stores every execution, but the run list represents each case's
      // latest state. Live records are appended last so they override history.
      const byCase = new Map<string, ListedRun>();
      for (const run of [...persistedRuns, ...activeRuns, ...terminalRuns]) {
        byCase.set(`${run.options.caseId}\u0000${run.options.subsys}`, run);
      }
      return Array.from(byCase.values()).sort((a, b) => b.startTime - a.startTime);
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

      // 1. SimulationManager.history（后台仿真的 JSON 历史）
      const fromHistory = manager.getRunDetail(input.runId);
      if (fromHistory) return fromHistory;

      // 2. simTerminalLinker（活跃的终端仿真运行）
      const terminalRun = simTerminalLinker.getRun(input.runId);
      if (terminalRun) {
        return {
          runId: terminalRun.runId,
          caseId: terminalRun.caseId,
          caseName: terminalRun.caseName ?? terminalRun.caseId,
          subsys: terminalRun.subsys,
          options: terminalRun.options,
          status: terminalRun.status,
          startTime: terminalRun.startTime,
          endTime: terminalRun.endTime ?? 0,
          duration: terminalRun.endTime != null
            ? terminalRun.endTime - terminalRun.startTime
            : Date.now() - terminalRun.startTime,
        };
      }

      // 3. DB simulation_runs 表（已持久化的终端仿真和后台仿真）
      const project = requireProject(input.projectId);
      const db = caseStatsRegistry.getOrCreateDb(project.rootPath);
      const row = db.prepare(`
        SELECT run_id, case_name, subsys, status, start_time, end_time,
          duration_ms, options_json
        FROM simulation_runs WHERE run_id = ?
      `).get(input.runId) as {
        run_id: string | null;
        case_name: string;
        subsys: string;
        status: string;
        start_time: string;
        end_time: string | null;
        duration_ms: number | null;
        options_json: string | null;
      } | undefined;

      if (row) {
        return {
          runId: input.runId,
          caseId: row.case_name,
          caseName: row.case_name,
          subsys: row.subsys,
          options: row.options_json ? JSON.parse(row.options_json) as Record<string, unknown> : {},
          status: row.status as SimulationStatus,
          startTime: Date.parse(row.start_time),
          endTime: row.end_time ? Date.parse(row.end_time) : 0,
          duration: row.duration_ms ?? 0,
        };
      }

      throw new TRPCError({ code: 'NOT_FOUND', message: `Run not found: ${input.runId}` });
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
      // 在 Linux 上，仿真命令（runsim）需要使用 csh 而非 bash，
      // 因为 EDA 环境的初始化脚本使用 csh 语法。findSimShell() 会
      // 优先查找 /bin/csh，回退到 bash/sh。
      //
      // 与 PTY 模式的区别：
      //   - 不追加 `__SIM_DONE__` 标记（不需要，直接用 exit 事件判定）
      //   - 不等待 shell 初始化（直接执行命令）
      //   - 终端为只读（无交互输入）
      const simShell = findSimShell();
      let session;
      if (await terminalManager.ensurePtyAvailable()) {
        // PTY 模式：创建交互式终端会话（使用 csh on Linux）
        session = await terminalManager.create({ cwd, shell: simShell });

        // 等待 shell 初始化完成
        await new Promise(resolve => setTimeout(resolve, 500));

        // 写入仿真命令 + 完成标记
        // 在 csh/tcsh 中，$? 后跟变量名字符会被解析为 "$?name"（检查变量是否定义），
        // 而非退出状态码。因此 csh/tcsh 使用 ${status}，bash 使用 $?
        const isCsh = simShell.endsWith('csh');
        const statusVar = isCsh ? '${status}' : '$?';
        const execCommand = `${displayCommand}; echo "__SIM_DONE__${statusVar}__"`;
        terminalManager.write(session.id, `${execCommand}\r`);
      } else {
        // Log 模式：直接执行命令，stdout/stderr 流式输出到终端视图
        // runCommand() 默认使用 findSimShell()（csh on Linux）
        console.log(`[simulation] node-pty unavailable — using log-mode execution (shell: ${simShell}).`);
        session = await terminalManager.runCommand({
          command: displayCommand,
          cwd,
          shell: simShell,
        });
      }

      // 注册仿真-终端关联（监听终端退出 → 判定 pass/fail）
      // logMode=true 时，linker 在进程退出后扫描输出中的 pass/fail 标记，
      // 而非直接使用 exit code（避免 LSF 提交成功被误判为仿真 PASS）
      const logMode = session.backend === 'log-mode';
      caseStatsRegistry.ensureTerminalListener(project.rootPath, input.projectId);
      const run = simTerminalLinker.register(
        input.projectId,
        session.id,
        displayCommand,
        cwd,
        input.options,
        logMode,
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

  // ── 回归列表文件选择（弹出原生文件对话框）──────────────────

  /**
   * 弹出原生文件选择对话框，让用户选择回归列表文件（.list / .txt）。
   * 返回选中文件的绝对路径，用户取消时返回 null。
   */
  pickRegrFile: t.procedure
    .input((raw): { projectId: string } => {
      const r = raw as Record<string, unknown>;
      if (typeof r.projectId !== 'string') {
        throw new TRPCError({ code: 'BAD_REQUEST', message: 'projectId is required' });
      }
      return { projectId: r.projectId };
    })
    .mutation(async ({ input }) => {
      const project = requireProject(input.projectId);
      const result = await dialog.showOpenDialog({
        properties: ['openFile'],
        title: '选择回归列表文件',
        defaultPath: project.rootPath,
        filters: [
          { name: '回归列表文件', extensions: ['list', 'txt', 'lst'] },
          { name: '所有文件', extensions: ['*'] },
        ],
      });
      if (result.canceled || result.filePaths.length === 0) {
        return { canceled: true as const, path: null };
      }
      return { canceled: false as const, path: result.filePaths[0] };
    }),

  // ── 仿真控制便利功能（参考 Python GUI log_panel.py）──────────

  /**
   * 使用指定命令重新执行仿真（不经过插件命令生成，直接执行用户指定的命令）。
   *
   * 用于 LogPanel 的"重新执行"按钮、以及 -fsdb / -R 选项变更后重新执行。
   * 与 runInTerminal 的区别：runInTerminal 从插件生成命令，而此接口
   * 直接使用传入的命令字符串（可能是用户修改过的命令）。
   */
  rerunWithCommand: t.procedure
    .input((raw): { projectId: string; command: string; cwd: string; caseId: string; caseName?: string; subsys: string } => {
      const r = raw as Record<string, unknown>;
      if (typeof r.projectId !== 'string') {
        throw new TRPCError({ code: 'BAD_REQUEST', message: 'projectId is required' });
      }
      if (typeof r.command !== 'string' || !r.command) {
        throw new TRPCError({ code: 'BAD_REQUEST', message: 'command is required' });
      }
      if (typeof r.cwd !== 'string') {
        throw new TRPCError({ code: 'BAD_REQUEST', message: 'cwd is required' });
      }
      return {
        projectId: r.projectId,
        command: r.command,
        cwd: r.cwd,
        caseId: typeof r.caseId === 'string' ? r.caseId : '',
        caseName: typeof r.caseName === 'string' ? r.caseName : undefined,
        subsys: typeof r.subsys === 'string' ? r.subsys : '',
      };
    })
    .mutation(async ({ input }) => {
      // 构建 displayCommand：若 $PROJ_WORK 已定义且命令中尚未包含 cd 前缀，先 cd 到项目工作目录
      // 这与 runInTerminal 的逻辑保持一致，确保 rerun 也在正确的目录下执行
      const projWork = process.env.PROJ_WORK;
      const hasCdPrefix = input.command.trimStart().startsWith('cd ');
      const cdPrefix = projWork && !hasCdPrefix ? `cd "${projWork}" && ` : '';
      const displayCommand = `${cdPrefix}${input.command}`;

      console.log(`[simulation.rerunWithCommand] command="${input.command}" → displayCommand="${displayCommand}"`);

      const simShell = findSimShell();
      let session;
      if (await terminalManager.ensurePtyAvailable()) {
        // PTY 模式
        session = await terminalManager.create({ cwd: input.cwd, shell: simShell });
        await new Promise(resolve => setTimeout(resolve, 500));
        const isCsh = simShell.endsWith('csh');
        const statusVar = isCsh ? '${status}' : '$?';
        const execCommand = `${displayCommand}; echo "__SIM_DONE__${statusVar}__"`;
        terminalManager.write(session.id, `${execCommand}\r`);
      } else {
        // Log 模式
        console.log(`[simulation] node-pty unavailable — using log-mode for rerun (shell: ${simShell}).`);
        session = await terminalManager.runCommand({
          command: displayCommand,
          cwd: input.cwd,
          shell: simShell,
        });
      }

      const logMode = session.backend === 'log-mode';
      const run = simTerminalLinker.register(
        input.projectId,
        session.id,
        displayCommand,
        input.cwd,
        {
          caseId: input.caseId,
          caseName: input.caseName,
          subsys: input.subsys,
          options: {},
        },
        logMode,
      );

      return {
        runId: run.runId,
        terminalId: session.id,
        command: displayCommand,
        cwd: input.cwd,
        backend: session.backend,
        warning: session.warning,
      };
    }),

  /**
   * 从仿真日志中提取种子号。
   *
   * 在 cwd 下查找用例的仿真日志文件（irun_sim.log / vcs_sim.log 等），
   * 读取内容并搜索 -seed <number> 模式，返回种子号字符串。
   * 如果找不到日志文件或种子号，返回 null。
   */
  getSeedFromLog: t.procedure
    .input((raw): { cwd: string; caseName?: string } => {
      const r = raw as Record<string, unknown>;
      if (typeof r.cwd !== 'string') {
        throw new TRPCError({ code: 'BAD_REQUEST', message: 'cwd is required' });
      }
      return {
        cwd: r.cwd,
        caseName: typeof r.caseName === 'string' ? r.caseName : undefined,
      };
    })
    .query(async ({ input }) => {
      // 构建可能的日志文件路径
      const { cwd, caseName } = input;
      const possiblePaths: string[] = [];

      if (caseName) {
        possiblePaths.push(join(cwd, caseName, 'log', 'irun_sim.log'));
        possiblePaths.push(join(cwd, caseName, 'log', 'vcs_sim.log'));
        possiblePaths.push(join(cwd, caseName, 'log', 'simulation.log'));
        possiblePaths.push(join(cwd, caseName, 'log', 'ncsim_sim.log'));
        possiblePaths.push(join(cwd, caseName, 'sim.log'));
      }
      possiblePaths.push(join(cwd, 'log', 'irun_sim.log'));
      possiblePaths.push(join(cwd, 'log', 'vcs_sim.log'));

      // 查找第一个存在的日志文件
      let logPath: string | null = null;
      for (const p of possiblePaths) {
        if (existsSync(p)) {
          logPath = p;
          break;
        }
      }

      if (!logPath) {
        return { seed: null, logPath: null };
      }

      try {
        const content = await readFile(logPath, 'utf-8');
        // 搜索 -seed <number> 模式
        const seedMatch = content.match(/-seed\s+(\d+)/);
        if (seedMatch) {
          return { seed: seedMatch[1], logPath };
        }
        // 也搜索 seed=<number> 模式
        const seedEqMatch = content.match(/seed\s*=\s*(\d+)/);
        if (seedEqMatch) {
          return { seed: seedEqMatch[1], logPath };
        }
        return { seed: null, logPath };
      } catch {
        return { seed: null, logPath };
      }
    }),

  /**
   * 获取终端仿真运行的完整输出内容（用于前端分析或种子号提取）。
   */
  getRunOutput: t.procedure
    .input((raw): { terminalId: string } => {
      const r = raw as Record<string, unknown>;
      if (typeof r.terminalId !== 'string') {
        throw new TRPCError({ code: 'BAD_REQUEST', message: 'terminalId is required' });
      }
      return { terminalId: r.terminalId };
    })
    .query(({ input }) => {
      return { output: terminalManager.getOutputContent(input.terminalId) };
    }),
});
