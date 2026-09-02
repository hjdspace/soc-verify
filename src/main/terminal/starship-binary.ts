/**
 * Starship 二进制路径解析。
 *
 * Starship 是跨 shell 的 Prompt 美化引擎（Rust 编写的单二进制），
 * 由 scripts/download-starship.mjs 下载到 resources/binaries/，
 * 由 electron-builder 的 extraResources + asarUnpack 配置随包打包。
 *
 * 解析优先级（比 officecli 简化，无用户级安装和 PATH 回退）：
 *   1. 内置二进制（packaged 优先 → dev 回退）—— 文件名带平台后缀
 *   2. 系统 PATH（仅开发模式，开发机可能已安装 starship）
 *
 * 工具函数 findInDir / findInPath 复用自 src/main/agent/paths.ts，
 * 与 resolveBunPath() / resolveOfficecliPath() 保持一致的实现风格。
 */

import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { findInDir, findInPath } from '../agent/paths';

const __dirname = dirname(fileURLToPath(import.meta.url));
const lazyRequire = createRequire(import.meta.url);

/** 平台信息 */
type StarshipPlatform = {
  platformName: 'win' | 'mac' | 'linux';
  arch: 'x64' | 'arm64';
  isWindows: boolean;
};

/** 获取当前平台的 Starship 信息 */
function getPlatformInfo(): StarshipPlatform {
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

/** 内置二进制基础名（带平台后缀，如 starship-win-x64；扩展名由 candidateNames 补齐） */
function getBundledBinaryBaseName(): string {
  const { platformName, arch } = getPlatformInfo();
  return `starship-${platformName}-${arch}`;
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

/**
 * 判断是否处于开发模式（非打包应用）。
 *
 * 在 Electron 主进程中，require('electron') 返回 electron API 对象，
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
 * 解析 Starship 二进制路径。
 *
 * 优先级：
 * 1. 内置二进制（packaged 优先 → dev 回退）—— 文件名带平台后缀
 * 2. 系统 PATH（仅开发模式，生产模式不回退到 PATH 以避免版本不一致）
 *
 * @returns 二进制路径，找不到返回 null
 */
export function resolveStarshipPath(): string | null {
  const bundledBase = getBundledBinaryBaseName();

  // 1. 内置二进制（packaged 优先 → dev 回退）
  const packaged = findInDir(packagedBinariesDir(), bundledBase);
  if (packaged) return packaged;
  const dev = findInDir(devBinariesDir(), bundledBase);
  if (dev) return dev;

  // 2. 系统 PATH（仅开发模式，开发机可能已安装 starship）
  if (isDevMode()) {
    return findInPath('starship');
  }

  return null;
}

/** 检查 Starship 是否已安装且可用 */
export function isStarshipInstalled(): boolean {
  return resolveStarshipPath() !== null;
}
