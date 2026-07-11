import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join, resolve } from 'node:path';
import { execFileSync } from 'node:child_process';

const __dirname = dirname(fileURLToPath(import.meta.url));

const OMP_ENTRY_REL = 'engine/oh-my-pi/packages/coding-agent/src/cli.ts';

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

/** omp 源码入口路径（engine/oh-my-pi/packages/coding-agent/src/cli.ts） */
export function resolveOmpEntryPath(): string | null {
  const candidates = [
    join(packagedResourcesDir(), OMP_ENTRY_REL),
    resolve(__dirname, '../../', OMP_ENTRY_REL),
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

/** 内嵌 omp 二进制路径（如果存在） */
export function resolveOmpBinaryPath(): string | null {
  return findInDir(packagedBinariesDir(), 'omp');
}

export interface OmpRuntime {
  bunPath: string;
  ompEntryPath: string;
}

/** 解析 omp 运行时配置：返回 Bun 路径 + omp 源码入口路径 */
export function resolveOmpRuntime(): OmpRuntime | null {
  const ompEntryPath = resolveOmpEntryPath();
  if (!ompEntryPath) return null;
  const bunPath = resolveBunPath();
  if (!bunPath) return null;
  return { bunPath, ompEntryPath };
}
