/**
 * draw.io desktop CLI 二进制路径解析。
 *
 * 回退顺序（参考 officecli/binary.ts 的三级回退模式）：
 *   1. 内置二进制（仅 Linux，packaged 优先 → dev 回退）
 *      —— 由 scripts/download-drawio.mjs 解压 AppImage 到
 *         resources/binaries/drawio-linux-<arch>/，随 electron-builder
 *         extraResources 打包（内网 Linux 无需联网安装）
 *   2. 本机标准安装路径（Windows 安装器 / macOS .app / Linux deb|rpm）
 *   3. 系统 PATH（drawio → draw.io 两个候选名）
 *
 * Windows 端不内置：预览页检测不到时引导用户去官网下载安装。
 */

import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { existsSync } from 'node:fs';
import { findInDir, findInPath } from '../agent/paths';

const __dirname = dirname(fileURLToPath(import.meta.url));

/** 内置 drawio 目录名（AppImage 解压产物，Linux 专用） */
function bundledDrawioDirName(): string {
  const arch = process.arch === 'arm64' ? 'arm64' : 'x64';
  return `drawio-linux-${arch}`;
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

/** 内置 drawio 可执行文件路径（目录内二进制名为 drawio），不存在返回 null */
function resolveBundledDrawio(): string | null {
  // 仅 Linux 内置（Windows/macOS 走安装器/引导下载）
  if (process.platform !== 'linux') return null;
  const dirName = bundledDrawioDirName();
  const packaged = findInDir(join(packagedBinariesDir(), dirName), 'drawio');
  if (packaged) return packaged;
  return findInDir(join(devBinariesDir(), dirName), 'drawio');
}

/** 本机标准安装路径候选（按平台） */
function standardInstallCandidates(): string[] {
  if (process.platform === 'win32') {
    const localAppData = process.env.LOCALAPPDATA ?? join(homedir(), 'AppData', 'Local');
    return [
      join(localAppData, 'Programs', 'draw.io', 'draw.io.exe'),
      join('C:', 'Program Files', 'draw.io', 'draw.io.exe'),
      join('C:', 'Program Files (x86)', 'draw.io', 'draw.io.exe'),
    ];
  }
  if (process.platform === 'darwin') {
    return [
      '/Applications/draw.io.app/Contents/MacOS/draw.io',
      join(homedir(), 'Applications', 'draw.io.app', 'Contents', 'MacOS', 'draw.io'),
    ];
  }
  return ['/opt/draw.io/drawio', '/usr/local/bin/drawio'];
}

/** PATH 候选名：Homebrew/deb/rpm 用 drawio，部分旧版用 draw.io */
function findDrawioInPath(): string | null {
  return findInPath('drawio') ?? findInPath('draw.io');
}

/**
 * 解析 draw.io desktop CLI 可执行路径。
 * @returns 二进制绝对路径，找不到返回 null
 */
export function resolveDrawioPath(): string | null {
  // 1. 内置（Linux）
  const bundled = resolveBundledDrawio();
  if (bundled) return bundled;

  // 2. 标准安装路径
  for (const candidate of standardInstallCandidates()) {
    if (existsSync(candidate)) return candidate;
  }

  // 3. 系统 PATH
  return findDrawioInPath();
}

/** draw.io CLI 是否可用 */
export function isDrawioInstalled(): boolean {
  return resolveDrawioPath() !== null;
}

/** 下载引导信息（渲染端未安装时展示） */
export const DRAWIO_DOWNLOAD_URL = 'https://github.com/jgraph/drawio-desktop/releases/latest';
