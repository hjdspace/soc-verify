/**
 * officecli 二进制路径解析。
 *
 * 三级回退（参考 SpaceCode officeCliService.ts 第 92-127 行）：
 *   1. 内置二进制（packaged 优先 → dev 回退）—— 文件名带平台后缀
 *   2. 用户级安装（~/.officecli/bin/officecli[.exe]）—— 文件名无平台后缀
 *   3. 系统 PATH（仅开发模式）
 *
 * 内置二进制由 scripts/download-officecli.mjs 下载到 resources/binaries/，
 * 由 electron-builder 的 extraResources + asarUnpack 配置随包打包。
 *
 * 工具函数 findInDir / findInPath 复用自 src/main/agent/paths.ts，
 * 与 resolveBunPath() 保持一致的实现风格。
 */

import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { findInDir, findInPath } from '../agent/paths';

const __dirname = dirname(fileURLToPath(import.meta.url));
const lazyRequire = createRequire(import.meta.url);

/** 平台信息 */
type OfficecliPlatform = {
  platformName: 'win' | 'mac' | 'linux';
  arch: 'x64' | 'arm64';
  isWindows: boolean;
};

/** 获取当前平台的 officecli 信息 */
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

/** 内置二进制基础名（带平台后缀，如 officecli-win-x64；扩展名由 candidateNames 补齐） */
function getBundledBinaryBaseName(): string {
  const { platformName, arch } = getPlatformInfo();
  return `officecli-${platformName}-${arch}`;
}

/** 用户级安装的二进制基础名（无平台后缀，如 officecli；扩展名由 candidateNames 补齐） */
function getInstalledBinaryBaseName(): string {
  return 'officecli';
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
 * 解析 officecli 二进制路径。
 *
 * 三级回退：
 * 1. 内置二进制（packaged 优先 → dev 回退）—— 文件名带平台后缀
 * 2. 用户级安装（~/.officecli/bin/officecli[.exe]）—— 文件名无平台后缀
 * 3. 系统 PATH（仅开发模式）
 *
 * @returns 二进制路径，找不到返回 null
 */
export function resolveOfficecliPath(): string | null {
  const bundledBase = getBundledBinaryBaseName();

  // 1. 内置二进制（packaged 优先 → dev 回退）
  const packaged = findInDir(packagedBinariesDir(), bundledBase);
  if (packaged) return packaged;
  const dev = findInDir(devBinariesDir(), bundledBase);
  if (dev) return dev;

  // 2. 用户级安装
  const installed = findInDir(officecliInstallDir(), getInstalledBinaryBaseName());
  if (installed) return installed;

  // 3. 系统 PATH（仅开发模式，生产模式不回退到 PATH 以避免版本不一致）
  if (isDevMode()) {
    return findInPath('officecli');
  }

  return null;
}

/** 检查 officecli 是否已安装且可用 */
export function isOfficecliInstalled(): boolean {
  return resolveOfficecliPath() !== null;
}
