import { existsSync } from 'node:fs';
import { join } from 'node:path';

// M0 占位：omp / Bun 二进制路径解析
// 策略（用户确认）：两者都内嵌打包 → 生产从 process.resourcesPath 读
// 开发时回退到 PATH / 用户配置
// M1 将接入实际 RpcClient 进程启动

function packagedBinariesDir(): string {
  return join(process.resourcesPath, 'binaries');
}

function candidateNames(base: string): string[] {
  return process.platform === 'win32' ? [`${base}.exe`, base] : [base];
}

function findInDir(dir: string, base: string): string | null {
  if (!existsSync(dir)) return null;
  for (const name of candidateNames(base)) {
    const p = join(dir, name);
    if (existsSync(p)) return p;
  }
  return null;
}

export async function resolveOmpPath(): Promise<string | null> {
  // 1. 打包内嵌优先
  const packaged = findInDir(packagedBinariesDir(), 'omp');
  if (packaged) return packaged;
  // 2. 开发回退：PATH 上的 omp（M1 可扩展用户配置覆盖）
  // TODO(M1): 接入 which/用户配置
  return null;
}

export async function resolveBunPath(): Promise<string | null> {
  const packaged = findInDir(packagedBinariesDir(), 'bun');
  if (packaged) return packaged;
  return null;
}
