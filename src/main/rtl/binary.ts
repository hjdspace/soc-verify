/**
 * RTL 三工具（yosys / slang-server / verible）二进制路径解析（Windows + Linux）。
 *
 * 对齐 officecli 模式（ADR 0015 主题 1 / ADR 0032 主题 6）：
 *   1. 内置二进制（packaged resources/binaries → dev resources/binaries）
 *   2. 系统 PATH（仅开发模式）
 *
 * 产物布局由 scripts/download-rtl-tools.mjs 按当前平台生成（两平台同布局，仅文件名/附加物不同）：
 *   binaries/yosys/{yosys[.exe] + share/yosys/ + (win) 8 DLL}
 *     ← Windows: DLL 必须与 exe 同目录（S0 实测 PATH 不生效）
 *     ← Linux:   yosys 为 ELF，链接系统库（libtinfo/libffi/libz），无同目录布局问题
 *   binaries/slang-server/slang-server[.exe]
 *   binaries/verible/{verible-verilog-lint, verible-verilog-format}[.exe]
 */

import { existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { findInDir, findInPath } from '../agent/paths';

const __dirname = dirname(fileURLToPath(import.meta.url));
const lazyRequire = createRequire(import.meta.url);

/** yosys.exe 的依赖 DLL 集（S0 实测，Windows 必须与 exe 同目录，PATH 方式不生效） */
export const YOSYS_DLLS = [
  'libstdc++-6.dll',
  'libgcc_s_seh-1.dll',
  'libwinpthread-1.dll',
  'libffi-8.dll',
  'libreadline8.dll',
  'libtermcap-0.dll',
  'tcl86.dll',
  'zlib1.dll',
] as const;

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
 * 测试环境 require('electron') 返回字符串路径，视为开发模式。
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

/** 在 packaged → dev 两级 binaries 目录中查找子目录下的可执行文件 */
function findBundled(subDir: string, base: string): string | null {
  const packaged = findInDir(join(packagedBinariesDir(), subDir), base);
  if (packaged) return packaged;
  return findInDir(join(devBinariesDir(), subDir), base);
}

/**
 * 解析 yosys.exe 路径（内置 packaged → dev → 开发模式 PATH 回退）。
 * @returns exe 路径，找不到返回 null
 */
export function resolveYosysPath(): string | null {
  const bundled = findBundled('yosys', 'yosys');
  if (bundled) return bundled;
  if (isDevMode()) return findInPath('yosys');
  return null;
}

/**
 * 检查 yosys 目录布局完整性（仅 Windows）：8 个依赖 DLL 必须与 exe 同目录（S0 实测）。
 * Linux 的 yosys 是 ELF、链接系统库，无 DLL 集概念，恒返回空数组。
 * PATH 回退的 yosys 不做 DLL 检查（用户自担布局）。
 * @returns 缺失的 DLL 文件名列表；exe 不存在时返回 null（无法判定）
 */
export function yosysMissingDlls(): string[] | null {
  return missingDllsFor(resolveYosysPath());
}

/** 对已解析的 exe 路径做 DLL 完整性检查（null → 无法判定） */
function missingDllsFor(exe: string | null): string[] | null {
  if (!exe) return null;
  // Linux/macOS：ELF 链接系统库，无同目录 DLL 布局要求
  if (process.platform !== 'win32') return [];
  const dir = dirname(exe);
  // 非内置布局（PATH 回退）不检查 DLL
  if (!/binaries[\\/]+yosys$/i.test(dir)) return [];
  return YOSYS_DLLS.filter((dll) => !existsSync(join(dir, dll)));
}

/** 解析 slang-server.exe 路径（内置 → 开发模式 PATH 回退）。 */
export function resolveSlangServerPath(): string | null {
  const bundled = findBundled('slang-server', 'slang-server');
  if (bundled) return bundled;
  if (isDevMode()) return findInPath('slang-server');
  return null;
}

/** 解析 verible-verilog-lint.exe 路径（内置 → 开发模式 PATH 回退）。 */
export function resolveVeribleLintPath(): string | null {
  const bundled = findBundled('verible', 'verible-verilog-lint');
  if (bundled) return bundled;
  if (isDevMode()) return findInPath('verible-verilog-lint');
  return null;
}

/** 解析 verible-verilog-format.exe 路径（内置 → 开发模式 PATH 回退）。 */
export function resolveVeribleFormatPath(): string | null {
  const bundled = findBundled('verible', 'verible-verilog-format');
  if (bundled) return bundled;
  if (isDevMode()) return findInPath('verible-verilog-format');
  return null;
}

/** 三工具可用性状态（rtl-router.toolsStatus 的返回结构，UI 降级提示数据源） */
export type RtlToolsStatus = {
  yosys: { available: boolean; path: string | null; missingDlls: string[] };
  slangServer: { available: boolean; path: string | null };
  verible: { available: boolean; lintPath: string | null; formatPath: string | null };
};

/**
 * 汇总三工具可用性状态。yosys available 要求 exe 存在且 DLL 集完整
 * （DLL 缺失时 exe 可解析但不可执行，按不可用处理并报告缺失清单）。
 */
export function getRtlToolsStatus(): RtlToolsStatus {
  const yosysPath = resolveYosysPath();
  const missing = missingDllsFor(yosysPath) ?? [];
  const slangPath = resolveSlangServerPath();
  const lintPath = resolveVeribleLintPath();
  const formatPath = resolveVeribleFormatPath();
  return {
    yosys: {
      available: yosysPath !== null && missing.length === 0,
      path: yosysPath,
      missingDlls: missing,
    },
    slangServer: {
      available: slangPath !== null,
      path: slangPath,
    },
    verible: {
      available: lintPath !== null && formatPath !== null,
      lintPath,
      formatPath,
    },
  };
}
