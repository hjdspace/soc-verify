'use strict';

/**
 * Unisoc Simulation Runner Plugin
 *
 * 实现 SimulationRunnerPlugin 接口，负责：
 *   1. 根据 SimulationRunOptions 生成 runsim 命令
 *   2. 通过 child_process.spawn 执行仿真
 *   3. 追踪仿真状态（pending → running → pass/fail/error/aborted）
 *   4. 解析编译错误
 *   5. 中止仿真
 *
 * 命令生成逻辑参考 Python runsim_r3p0/utils/command_generator.py 的
 * CommandGenerator._generate_single_command() 方法。
 */

const { spawn } = require('node:child_process');
const { existsSync, readFileSync } = require('node:fs');
const { join, basename } = require('node:path');
const { randomUUID } = require('node:crypto');

const MANIFEST = {
  id: 'unisoc-simulation-runner',
  name: 'Unisoc Simulation Runner',
  version: '1.0.0',
  kind: 'simulation-runner',
  description:
    'Unisoc 仿真执行插件：生成 runsim 命令并通过子进程执行仿真，追踪状态和编译错误。',
};

// ─── 运行状态管理 ──────────────────────────────────────────────

/**
 * @typedef {{
 *   runId: string,
 *   process: import('child_process').ChildProcess | null,
 *   status: 'pending' | 'running' | 'pass' | 'fail' | 'error' | 'aborted',
 *   startTime: number,
 *   endTime?: number,
 *   message?: string,
 *   command: string,
 *   cwd: string,
 *   logDir: string,
 *   exitCode: number | null,
 *   stdout: string,
 *   stderr: string,
 * }} RunRecord
 */

/** @type {Map<string, RunRecord>} */
const activeRuns = new Map();

// ─── 命令生成 ──────────────────────────────────────────────────

/**
 * 根据 SimulationRunOptions 生成 runsim 命令字符串
 *
 * 实现逻辑参考 Python CommandGenerator._generate_single_command()：
 *   1. 若无 regr_file，使用基础参数（base/block/case/rundir）
 *   2. 若有 regr_file，使用回归参数（regr/fm/regr_work/tag/nt/m）
 *   3. 追加波形配置选项（fsdb/vwdb/cl/dump_sva/cov/upf/dump_mem/wdd）
 *   4. 追加仿真参数（simarg/cfg_def/post）
 *   5. 追加执行模式（-R/-C）
 *   6. 追加其他选项
 *
 * @param {import('@shared/plugin-types').SimulationRunOptions} opts
 * @returns {string} runsim 命令字符串
 */
function generateRunsimCommand(opts) {
  const options = opts.options || {};
  const caseName = opts.caseName || (typeof options.case === 'string' ? options.case : '') || '';
  const cmd = ['runsim'];

  if (!options.regr_file) {
    // ── 基础参数模式 ──
    if (options.base) cmd.push('-base', String(options.base));
    if (options.block) cmd.push('-block', String(options.block));
    if (caseName) cmd.push('-case', caseName);

    // rundir（支持 {case_name} 占位符替换）
    let rundir = (typeof options.rundir === 'string' ? options.rundir : '').trim();
    if (rundir) {
      if (rundir.includes('{case_name}') && caseName) {
        rundir = rundir.replace(/\{case_name\}/g, caseName);
      }
      cmd.push('-rundir', rundir);
    }
  } else {
    // ── 回归测试模式 ──
    cmd.push('-regr', String(options.regr_file));
    if (options.fm) cmd.push('-fm');
    const regrWork = (typeof options.regr_work === 'string' ? options.regr_work : '').trim();
    if (regrWork) cmd.push('-regr_work', regrWork);
    const tag = (typeof options.tag === 'string' ? options.tag : '').trim();
    if (tag) cmd.push('-tag', tag);
    const nt = (typeof options.nt === 'string' ? options.nt : '').trim();
    if (nt) cmd.push('-nt', nt);
    const dashboard = (typeof options.dashboard === 'string' ? options.dashboard : '').trim();
    if (dashboard) cmd.push('-m', dashboard);
  }

  // ── 波形配置 ──
  if (options.fsdb) {
    cmd.push('-fsdb');
    const dumpLevel = (typeof options.dump_level === 'string' ? options.dump_level : '').trim();
    const fsdbFile = (typeof options.fsdb_file === 'string' ? options.fsdb_file : '').trim();
    if (dumpLevel) {
      cmd.push(dumpLevel);
    } else if (fsdbFile) {
      cmd.push(fsdbFile);
    }
  }

  if (options.vwdb) {
    cmd.push('-vwdb');
    const dumpLevel = (typeof options.dump_level === 'string' ? options.dump_level : '').trim();
    const fsdbFile = (typeof options.fsdb_file === 'string' ? options.fsdb_file : '').trim();
    if (dumpLevel) {
      cmd.push(dumpLevel);
    } else if (fsdbFile) {
      cmd.push(fsdbFile);
    }
  }

  if (options.cl) cmd.push('-cl');
  if (options.dump_sva) cmd.push('-dump_sva');
  if (options.cov) cmd.push('-cov');
  if (options.upf) cmd.push('-upf');

  // dump_mem
  const dumpMem = (typeof options.dump_mem === 'string' ? options.dump_mem : '').trim();
  if (dumpMem) {
    if (dumpMem.includes(' ')) {
      cmd.push('-dump_mem', `"${dumpMem}"`);
    } else {
      cmd.push('-dump_mem', dumpMem);
    }
  }

  // wdd
  const wdd = (typeof options.wdd === 'string' ? options.wdd : '').trim();
  if (wdd) cmd.push('-wdd', wdd);

  // seed
  const seed = (typeof options.seed === 'string' ? options.seed : '').trim();
  if (seed) cmd.push('-seed', seed);

  // bq
  const bq = (typeof options.bq === 'string' ? options.bq : '').trim();
  if (bq) cmd.push('-bq', bq);

  // simarg
  const simarg = (typeof options.simarg === 'string' ? options.simarg : '').trim();
  if (simarg) cmd.push('-simarg', `"${simarg}"`);

  // cfg_def
  const cfgDef = (typeof options.cfg_def === 'string' ? options.cfg_def : '').trim();
  if (cfgDef) cmd.push('-cfg_def', cfgDef);

  // post
  const post = (typeof options.post === 'string' ? options.post : '').trim();
  if (post) cmd.push('-post', post);

  // ── 执行模式 ──
  if (options.sim_only) {
    cmd.push('-R');
  } else if (options.compile_only) {
    cmd.push('-C');
  }

  // ── 其他选项 ──
  const otherOptions = (typeof options.other_options === 'string' ? options.other_options : '').trim();
  if (otherOptions) cmd.push(otherOptions);

  return cmd.join(' ');
}

// ─── 工作目录解析 ──────────────────────────────────────────────

/**
 * 解析仿真工作目录
 *
 * 优先级：
 *   1. options.rundir（支持 {case_name} 替换）
 *   2. $PROJ_ENV/work/{case_name}
 *   3. projectRoot
 *
 * @param {import('@shared/plugin-types').SimulationRunOptions} opts
 * @returns {string}
 */
function resolveCwd(opts) {
  const options = opts.options || {};
  const caseName = opts.caseName || (typeof options.case === 'string' ? options.case : '') || '';
  const projectRoot = opts.projectRoot || process.cwd();

  // 1. rundir
  let rundir = (typeof options.rundir === 'string' ? options.rundir : '').trim();
  if (rundir) {
    if (rundir.includes('{case_name}') && caseName) {
      rundir = rundir.replace(/\{case_name\}/g, caseName);
    }
    return rundir;
  }

  // 2. $PROJ_ENV/work/{case_name}
  const projEnv = process.env.PROJ_ENV || '';
  if (projEnv && caseName) {
    return join(projEnv, 'work', caseName);
  }

  // 3. projectRoot
  return projectRoot;
}

/**
 * 解析仿真日志目录
 * @param {RunRecord} record
 * @returns {string}
 */
function resolveLogDir(record) {
  return join(record.cwd, 'log');
}

// ─── 仿真状态判定 ──────────────────────────────────────────────

/**
 * 从仿真日志内容判断仿真是否通过
 *
 * 参考Python runsim_r3p0/utils/log_analyze_utils.py 的 check_simulation_status_from_log_content()。
 * 判定规则：
 *   - 包含 "TEST PASS" / "Simulation PASSED" / "$finish" 且无 "TEST FAIL" → pass
 *   - 包含 "TEST FAIL" / "Simulation FAILED" / "Error:" → fail
 *   - 其他 → 根据退出码判断
 *
 * @param {string} content 日志内容
 * @returns {'pass' | 'fail' | null}
 */
function checkSimStatusFromLog(content) {
  if (!content) return null;

  const lower = content.toLowerCase();

  // 明确失败标志
  if (
    lower.includes('test fail') ||
    lower.includes('simulation failed') ||
    lower.includes('fatal error') ||
    lower.includes('error: simulation')
  ) {
    return 'fail';
  }

  // 明确通过标志
  if (
    lower.includes('test pass') ||
    lower.includes('simulation passed') ||
    lower.includes('simulation complete') ||
    (lower.includes('$finish') && !lower.includes('error'))
  ) {
    return 'pass';
  }

  return null;
}

/**
 * 从编译日志中解析编译错误
 *
 * @param {string} logContent 编译日志内容
 * @returns {Array<{file: string, line: number, column?: number, severity: 'error' | 'warning', message: string}>}
 */
function parseCompileErrors(logContent) {
  if (!logContent) return [];

  const errors = [];
  const lines = logContent.split('\n');

  // 匹配常见编译错误格式：
  //   file.sv(123): error: message
  //   file.sv:123: error: message
  //   Error: file.sv line 123: message
  //   *E,TESTERR: file.sv,123: message
  const patterns = [
    // irun/xrun 格式: file.sv(123): error: message
    /^(.+?)\((\d+)\):\s*(error|warning):\s*(.+)$/i,
    // GCC 格式: file.sv:123: error: message
    /^(.+?):(\d+):\s*(error|warning):\s*(.+)$/i,
    // Verilator 格式: %Error: file.sv:123: message
    /^%?(error|warning):\s*(.+?):(\d+):\s*(.+)$/i,
    // 通用格式: Error: file.sv line 123: message
    /^(error|warning):\s*(.+?)\s+line\s+(\d+):\s*(.+)$/i,
  ];

  for (const line of lines) {
    for (const pattern of patterns) {
      const match = line.trim().match(pattern);
      if (match) {
        let file, lineNum, severity, message;

        if (pattern.source.startsWith('^(.+?)\\(')) {
          // irun/xrun 格式
          [, file, lineNum, severity, message] = match;
        } else if (pattern.source.startsWith('^(.+?):')) {
          // GCC 格式
          [, file, lineNum, severity, message] = match;
        } else if (pattern.source.startsWith('^%?')) {
          // Verilator 格式
          [, severity, file, lineNum, message] = match;
        } else {
          // 通用格式
          [, severity, file, lineNum, message] = match;
        }

        errors.push({
          file: file.trim(),
          line: parseInt(lineNum, 10) || 0,
          severity: severity.toLowerCase().includes('err') ? 'error' : 'warning',
          message: message.trim(),
        });
        break;
      }
    }
  }

  return errors;
}

// ─── Plugin 实现 ───────────────────────────────────────────────

const plugin = {
  manifest: MANIFEST,

  /**
   * 启动仿真
   *
   * @param {import('@shared/plugin-types').SimulationRunOptions} opts
   * @returns {Promise<{ runId: string }>}
   */
  async run(opts) {
    const runId = randomUUID();
    const command = generateRunsimCommand(opts);
    const cwd = resolveCwd(opts);

    /** @type {RunRecord} */
    const record = {
      runId,
      process: null,
      status: 'pending',
      startTime: Date.now(),
      command,
      cwd,
      logDir: '',
      exitCode: null,
      stdout: '',
      stderr: '',
    };
    record.logDir = resolveLogDir(record);

    activeRuns.set(runId, record);

    // 启动子进程
    try {
      const child = spawn(command, {
        cwd,
        shell: true,
        env: { ...process.env },
      });

      record.process = child;
      record.status = 'running';

      child.stdout?.on('data', (data) => {
        record.stdout += data.toString();
      });

      child.stderr?.on('data', (data) => {
        record.stderr += data.toString();
      });

      child.on('error', (err) => {
        record.status = 'error';
        record.endTime = Date.now();
        record.message = err.message;
      });

      child.on('exit', (code, signal) => {
        record.exitCode = code;

        if (signal === 'SIGTERM' || signal === 'SIGKILL') {
          record.status = 'aborted';
        } else if (code === 0) {
          // 尝试从仿真日志判断 pass/fail
          const logStatus = checkSimStatusFromLog(record.stdout + record.stderr);
          if (logStatus) {
            record.status = logStatus;
          } else {
            // 尝试读取仿真日志文件
            const simLogPath = join(record.logDir, 'irun_sim.log');
            if (existsSync(simLogPath)) {
              try {
                const logContent = readFileSync(simLogPath, 'utf-8');
                const fileStatus = checkSimStatusFromLog(logContent);
                record.status = fileStatus || 'pass';
              } catch {
                record.status = 'pass';
              }
            } else {
              record.status = 'pass';
            }
          }
        } else {
          // 非零退出码
          const logStatus = checkSimStatusFromLog(record.stdout + record.stderr);
          record.status = logStatus === 'pass' ? 'pass' : 'fail';
        }

        record.endTime = Date.now();
        record.process = null;
      });
    } catch (err) {
      record.status = 'error';
      record.endTime = Date.now();
      record.message = err instanceof Error ? err.message : String(err);
    }

    return { runId };
  },

  /**
   * 获取仿真状态
   *
   * @param {string} runId
   * @returns {Promise<import('@shared/plugin-types').SimulationRunStatus>}
   */
  async getStatus(runId) {
    const record = activeRuns.get(runId);
    if (!record) {
      return {
        runId,
        status: 'error',
        message: `Run not found: ${runId}`,
      };
    }

    return {
      runId,
      status: record.status,
      startTime: record.startTime,
      endTime: record.endTime,
      message: record.message,
    };
  },

  /**
   * 获取编译错误
   *
   * 优先从 stdout/stderr 中解析，其次读取编译日志文件。
   *
   * @param {string} runId
   * @returns {Promise<import('@shared/plugin-types').CompileError[]>}
   */
  async getCompileErrors(runId) {
    const record = activeRuns.get(runId);
    if (!record) return [];

    // 1. 从 stdout/stderr 中解析
    let errors = parseCompileErrors(record.stdout + '\n' + record.stderr);
    if (errors.length > 0) return errors;

    // 2. 读取编译日志文件
    const compileLogPath = join(record.logDir, 'irun_compile.log');
    if (existsSync(compileLogPath)) {
      try {
        const logContent = readFileSync(compileLogPath, 'utf-8');
        errors = parseCompileErrors(logContent);
      } catch {
        // 读取失败，返回空
      }
    }

    // 3. 尝试其他日志文件名
    if (errors.length === 0) {
      const altLogNames = ['compile.log', 'xrun.log', 'irun.log', 'sim.log'];
      for (const logName of altLogNames) {
        const altPath = join(record.logDir, logName);
        if (existsSync(altPath)) {
          try {
            const logContent = readFileSync(altPath, 'utf-8');
            errors = parseCompileErrors(logContent);
            if (errors.length > 0) break;
          } catch {
            // continue
          }
        }
      }
    }

    return errors;
  },

  /**
   * 中止仿真
   *
   * @param {string} runId
   * @returns {Promise<void>}
   */
  async abort(runId) {
    const record = activeRuns.get(runId);
    if (!record || !record.process) return;

    try {
      record.process.kill('SIGTERM');
      record.status = 'aborted';
      record.endTime = Date.now();
    } catch {
      // 进程可能已经退出
    }

    // 清理：一段时间后移除记录
    setTimeout(() => {
      activeRuns.delete(runId);
    }, 60000);
  },
};

module.exports = plugin;
module.exports.default = plugin;
module.exports.generateRunsimCommand = generateRunsimCommand;
module.exports.resolveCwd = resolveCwd;
module.exports.checkSimStatusFromLog = checkSimStatusFromLog;
module.exports.parseCompileErrors = parseCompileErrors;
