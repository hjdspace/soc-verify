/**
 * officecli PATH 注入（Issue #6）。
 *
 * 在启动 omp 子进程前，将内置的 officecli 二进制同步到
 * `~/.officecli/bin/officecli[.exe]`（去掉平台后缀，使用标准可执行名），
 * 并将该目录注入到 omp 子进程 `env.PATH` 前面。
 *
 * 这样 omp 子进程（及其衍生的子进程，如 AI 通过 Host Tool 调用的
 * create_docx / create_xlsx / create_pptx / create_pdf / read_document）
 * 可以直接通过 `officecli` 命令调用，无需依赖系统 PATH。
 *
 * 同步策略：
 * - 源：`resources/binaries/officecli-{platform}-{arch}[.exe]`（packaged 优先 → dev 回退）
 * - 目标：`~/.officecli/bin/officecli[.exe]`（无平台后缀）
 * - 仅在源比目标新或目标不存在时复制，避免每次启动都写盘
 *
 * 若源不存在（如开发模式未下载），跳过同步但仍注入 PATH
 * （用户可能已手动安装 officecli 到 `~/.officecli/bin/`）。
 */

import { copyFile, mkdir, stat, chmod } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { candidateNames, findInDir } from './paths';

const __dirname = dirname(fileURLToPath(import.meta.url));
const lazyRequire = createRequire(import.meta.url);

/** 平台信息 */
type OfficecliPlatform = {
  platformName: 'win' | 'mac' | 'linux';
  arch: 'x64' | 'arm64';
  isWindows: boolean;
};

/** 获取当前平台的 officecli 信息（与 binary.ts 保持一致的逻辑） */
function getPlatformInfo(): OfficecliPlatform {
  const platform = process.platform;
  const arch = process.arch;
  let platformName: 'win' | 'mac' | 'linux';
  if (platform === 'win32') platformName = 'win';
  else if (platform === 'darwin') platformName = 'mac';
  else if (platform === 'linux') platformName = 'linux';
  else throw new Error(`Unsupported platform: ${platform}`);
  if (arch !== 'x64' && arch !== 'arm64') {
    throw new Error(`Unsupported architecture: ${arch}`);
  }
  return { platformName, arch, isWindows: platform === 'win32' };
}

/** 内置二进制基础名（带平台后缀，如 officecli-win-x64） */
function getBundledBinaryBaseName(): string {
  const { platformName, arch } = getPlatformInfo();
  return `officecli-${platformName}-${arch}`;
}

/** 打包模式下 binaries 目录（process.resourcesPath/binaries） */
function packagedBinariesDir(): string {
  const resourcesPath = (process as NodeJS.Process & { resourcesPath?: string }).resourcesPath ?? '';
  return join(resourcesPath, 'binaries');
}

/** 开发模式下 resources/binaries 目录 */
function devBinariesDir(): string {
  return resolve(__dirname, '../../resources/binaries');
}

/** 用户级安装目录（~/.officecli/bin） */
function officecliInstallDir(): string {
  return join(homedir(), '.officecli', 'bin');
}

/**
 * 判断是否处于开发模式（非打包应用）。
 *
 * 在 Electron 主进程中 require('electron') 返回 electron API 对象，
 * 可通过 app.isPackaged 判断；在 Node.js 测试环境中 require('electron')
 * 返回字符串路径，视为开发模式。
 */
function isDevMode(): boolean {
  try {
    const electron = lazyRequire('electron') as unknown;
    if (typeof electron === 'object' && electron !== null && 'app' in electron) {
      const app = (electron as { app: { isPackaged: boolean } }).app;
      return !app.isPackaged;
    }
    return true;
  } catch {
    return true;
  }
}

/**
 * 同步内置 officecli 二进制到 `~/.officecli/bin/`。
 *
 * 查找 packaged → dev 目录下的内置二进制（带平台后缀），
 * 复制为标准可执行名（无平台后缀）到用户安装目录。
 * 仅在源比目标新或目标不存在时复制，避免重复 I/O。
 *
 * @returns 用户级安装目录路径（~/.officecli/bin），无论是否成功同步都返回
 */
async function syncBundledBinary(): Promise<string> {
  const installDir = officecliInstallDir();
  await mkdir(installDir, { recursive: true });

  const bundledBase = getBundledBinaryBaseName();
  // 查找内置二进制（packaged 优先 → dev 回退）
  let sourcePath: string | null = null;
  if (!isDevMode()) {
    sourcePath = findInDir(packagedBinariesDir(), bundledBase);
  }
  if (!sourcePath) {
    sourcePath = findInDir(devBinariesDir(), bundledBase);
  }

  if (!sourcePath) {
    // 内置二进制不存在，跳过同步（用户可能已手动安装）
    return installDir;
  }

  // 目标文件名（无平台后缀）：Windows 用 officecli.exe，Unix 用 officecli
  const destName = candidateNames('officecli')[0];
  const destPath = join(installDir, destName);

  // 比较源和目标的 mtime + size，若目标已是最新则跳过复制
  try {
    const srcStat = await stat(sourcePath);
    const destStat = await stat(destPath).catch(() => null);
    if (destStat && destStat.mtimeMs >= srcStat.mtimeMs && destStat.size === srcStat.size) {
      return installDir;
    }
    await copyFile(sourcePath, destPath);
    // Unix 下设置可执行权限（copyFile 不保留源文件权限）
    if (process.platform !== 'win32') {
      await chmod(destPath, 0o755);
    }
  } catch {
    // 复制失败，忽略（用户可能已有可用的 officecli）
  }

  return installDir;
}

/**
 * 确保 officecli 在子进程 PATH 中可用。
 *
 * 在启动 omp 子进程前调用：
 * 1. 同步内置 officecli 二进制到 `~/.officecli/bin/`
 * 2. 将 `~/.officecli/bin` 注入到 `env.PATH` 前面（若尚未注入）
 *
 * @param env 子进程环境变量（会被原地修改并返回）
 * @returns 修改后的环境变量（PATH 已注入）
 */
export async function ensureOfficecliOnPath(
  env: Record<string, string>,
): Promise<Record<string, string>> {
  const installDir = await syncBundledBinary();
  const pathSep = process.platform === 'win32' ? ';' : ':';
  const currentPath = env.PATH ?? process.env.PATH ?? '';
  // 避免重复注入（installDir 已在 PATH 最前面）
  if (currentPath === installDir || currentPath.startsWith(installDir + pathSep)) {
    return env;
  }
  env.PATH = `${installDir}${pathSep}${currentPath}`;
  return env;
}
