/**
 * EDA Debug 工具启动器（隐藏子进程）。
 *
 * 移植 Python runsim_r3p0 执行日志页快捷按钮的 EDA 工具启动行为
 *（execution_controller.py open_verdi / open_verisium），但改为隐藏子进程：
 * detached + unref，不占用终端 Tab，stdout/stderr 重定向到用例目录下的日志文件。
 *
 * 工具选择：
 * - Verdi：根据用例目录的仿真产物检测
 *   simv.daidir / vcdplus.vpd 存在 → run_verdi_vcs（VCS 波形）
 *   否则 → run_verdi comp_load（Xcelium 波形）
 * - Verisium：run_vdb
 *
 * 启动 shell：
 * - Linux：优先 csh/tcsh（EDA 环境脚本以 csh 语法编写），通过 findSimShell 解析
 * - Windows：PowerShell（dev 机器，工具通常不存在 → 启动失败降级到日志文件）
 */

import { spawn } from 'node:child_process';
import { openSync, closeSync } from 'node:fs';
import { join } from 'node:path';
import { findSimShell } from '../terminal/terminal-manager';
import { resolveSimArtifacts, type SimArtifactInput } from './sim-artifact-resolver';

export interface EdaToolLaunchResult {
  /** 启动所在的用例目录 */
  caseDir: string;
  /** 完整启动命令（如 `run_verdi comp_load`） */
  command: string;
  /** 启动日志文件路径（子进程 stdout/stderr 重定向至此） */
  logPath: string;
  /** Verdi 启动模式（仅 Verdi：vcs / xrun） */
  mode?: 'vcs' | 'xrun';
}

/**
 * 构建 EDA 工具启动的 shell 参数。
 *
 * Linux（csh/bash/sh）：`-c 'cd "<caseDir>" && <command>'`
 * Windows（PowerShell）：`-Command "Set-Location -LiteralPath '<caseDir>'; <command>"`
 */
export function buildEdaToolLaunchArgs(
  caseDir: string,
  command: string,
  platform: NodeJS.Platform = process.platform,
): string[] {
  if (platform === 'win32') {
    return ['-Command', `Set-Location -LiteralPath '${caseDir}'; ${command}`];
  }
  return ['-c', `cd "${caseDir}" && ${command}`];
}

/**
 * 以隐藏子进程在指定用例目录启动 EDA 工具。
 *
 * @param caseDir 用例目录（已存在仿真产物）
 * @param command EDA 工具命令（如 `run_verdi comp_load`）
 * @param logName 启动日志文件名（如 `verdi_launch.log`）
 * @returns 启动日志文件路径
 * @throws 当 spawn 同步失败时抛出错误（shell 不存在等）
 */
export function launchDetachedEdaTool(
  caseDir: string,
  command: string,
  logName: string,
): { logPath: string } {
  const logPath = join(caseDir, logName);
  const shell = findSimShell();
  const args = buildEdaToolLaunchArgs(caseDir, command);

  // 追加模式：多次启动累积记录；子进程继承 fd，父进程关闭副本安全
  const out = openSync(logPath, 'a');
  try {
    const child = spawn(shell, args, {
      detached: true,
      stdio: ['ignore', out, out],
    });
    child.unref();
  } finally {
    closeSync(out);
  }
  return { logPath };
}

/**
 * 解析仿真产物并以隐藏子进程启动 Verdi。
 *
 * VCS 产物（simv.daidir / vcdplus.vpd）→ `run_verdi_vcs`
 * 否则（Xcelium / INCA_libs）→ `run_verdi comp_load`
 *
 * @throws 找不到用例目录时抛出 `找不到仿真用例目录`
 */
export function launchVerdiForRun(input: SimArtifactInput): EdaToolLaunchResult {
  const artifacts = resolveSimArtifacts(input);
  if (!artifacts.caseDir || !artifacts.verdiMode) {
    throw new Error('找不到仿真用例目录，无法启动 Verdi');
  }
  const command = artifacts.verdiMode === 'vcs' ? 'run_verdi_vcs' : 'run_verdi comp_load';
  const { logPath } = launchDetachedEdaTool(artifacts.caseDir, command, 'verdi_launch.log');
  return {
    caseDir: artifacts.caseDir,
    command,
    logPath,
    mode: artifacts.verdiMode,
  };
}

/**
 * 解析仿真产物并以隐藏子进程启动 Verisium（`run_vdb`）。
 *
 * @throws 找不到用例目录时抛出 `找不到仿真用例目录`
 */
export function launchVerisiumForRun(input: SimArtifactInput): EdaToolLaunchResult {
  const artifacts = resolveSimArtifacts(input);
  if (!artifacts.caseDir) {
    throw new Error('找不到仿真用例目录，无法启动 Verisium');
  }
  const command = 'run_vdb';
  const { logPath } = launchDetachedEdaTool(artifacts.caseDir, command, 'verisium_launch.log');
  return {
    caseDir: artifacts.caseDir,
    command,
    logPath,
  };
}
