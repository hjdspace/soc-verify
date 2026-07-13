import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join, resolve } from 'node:path';
import { execFileSync } from 'node:child_process';

const __dirname = dirname(fileURLToPath(import.meta.url));

const RUNNER_REL = 'engine/oh-my-pi/packages/coding-agent/src/socverify-runner.ts';
const MIN_BUN_VERSION = [1, 3, 14];

function packagedResourcesDir(): string {
  return (process as NodeJS.Process & { resourcesPath?: string }).resourcesPath ?? '';
}

function packagedBinariesDir(): string {
  return join(packagedResourcesDir(), 'binaries');
}

function candidateNames(base: string): string[] {
  return process.platform === 'win32' ? [`${base}.exe`, base, `${base}.cmd`] : [base];
}

function findInDir(dir: string, base: string): string | null {
  if (!existsSync(dir)) return null;
  for (const name of candidateNames(base)) {
    const p = join(dir, name);
    if (existsSync(p)) return p;
  }
  return null;
}

function findInPath(executable: string): string | null {
  const cmd = process.platform === 'win32' ? 'where' : 'which';
  try {
    const out = execFileSync(cmd, [executable], { encoding: 'utf-8', stdio: ['pipe', 'pipe', 'ignore'] });
    const first = out.trim().split(/\r?\n/)[0];
    return first || null;
  } catch {
    return null;
  }
}

/** runner 脚本路径（engine/oh-my-pi/packages/coding-agent/src/socverify-runner.ts） */
export function resolveRunnerPath(): string | null {
  const candidates = [
    join(packagedResourcesDir(), RUNNER_REL),
    resolve(__dirname, '../../', RUNNER_REL),
  ];
  for (const p of candidates) {
    if (existsSync(p)) return p;
  }
  return null;
}

/** Bun 可执行文件路径：packaged 优先 → PATH 查找 */
export function resolveBunPath(): string | null {
  const packaged = findInDir(packagedBinariesDir(), 'bun');
  if (packaged) return packaged;
  return findInPath('bun');
}

/** Check if installed Bun meets the minimum version requirement. */
export function checkBunVersion(bunPath: string): { ok: boolean; version: string; required: string } {
  try {
    const output = execFileSync(bunPath, ['--version'], { encoding: 'utf-8', stdio: ['pipe', 'pipe', 'ignore'] }).trim();
    const parts = output.split('.').map(Number);
    for (let i = 0; i < MIN_BUN_VERSION.length; i++) {
      const installed = parts[i] ?? 0;
      const required = MIN_BUN_VERSION[i];
      if (installed > required) return { ok: true, version: output, required: MIN_BUN_VERSION.join('.') };
      if (installed < required) return { ok: false, version: output, required: MIN_BUN_VERSION.join('.') };
    }
    return { ok: true, version: output, required: MIN_BUN_VERSION.join('.') };
  } catch {
    return { ok: false, version: 'unknown', required: MIN_BUN_VERSION.join('.') };
  }
}

export interface AgentRuntime {
  bunPath: string;
  runnerPath: string;
  bunVersion: string;
  bunVersionOk: boolean;
}

/** 解析 agent 运行时配置：Bun 路径 + runner 脚本路径 */
export function resolveAgentRuntime(): AgentRuntime | null {
  const runnerPath = resolveRunnerPath();
  if (!runnerPath) return null;

  const bunPath = resolveBunPath();
  if (!bunPath) return null;

  const versionCheck = checkBunVersion(bunPath);
  return {
    bunPath,
    runnerPath,
    bunVersion: versionCheck.version,
    bunVersionOk: versionCheck.ok,
  };
}
