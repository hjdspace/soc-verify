/**
 * RTL 三工具（yosys / slang-server / verible）二进制路径解析（Windows + Linux）。
 *
 * 对齐 officecli 模式（ADR 0015 主题 1 / ADR 0032 主题 6）：
 *   1. 内置二进制（packaged resources/binaries → dev resources/binaries）
 *   2. 系统 PATH（仅开发模式）
 *
 * 产物布局由 scripts/download-rtl-tools.mjs 按当前平台生成（两平台同布局，仅文件名/附加物不同）：
 *   binaries/yosys/{bin/yosys + share/yosys/ + (win) 8 DLL | (linux) libexec/yosys + lib/**}
 *     ← Windows: DLL 必须与 exe 同目录（S0 实测 PATH 不生效）
 *     ← Linux:   yosys 是 OSS CAD Suite 的 bash wrapper（非 ELF），第 9 行 exec
 *                ../lib/ld-linux-x86-64.so.2（套件自带 glibc loader）+ --library-path ../lib
 *                加载 ../libexec/yosys 真身。lib/ 运行库闭包由下载脚本一并提取。
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

/**
 * yosys Linux 运行库闭包（2026-09-02 套件 readelf -d libexec/yosys 递归解析实测）。
 * wrapper 通过自带 loader + --library-path ../lib 独占解析这些库，与宿主 glibc 解耦。
 */
export const YOSYS_LINUX_LIBS = [
  'ld-linux-x86-64.so.2',
  'libc.so.6',
  'libm.so.6',
  'libgcc_s.so.1',
  'libstdc++.so.6',
  'libffi.so.8',
  'libz.so.1',
  'libtcl8.6.so',
  'libreadline.so.8',
  'libtinfo.so.6',
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
  // Linux 的 OSS CAD Suite wrapper 必须留在 bin/，否则其 ../lib 相对路径会
  // 解析到 binaries/lib 而不是 binaries/yosys/lib（见 download-rtl-tools）。
  const bundled = process.platform === 'win32'
    ? findBundled('yosys', 'yosys')
    : findBundled('yosys/bin', 'yosys');
  if (bundled) return bundled;
  if (isDevMode()) return findInPath('yosys');
  return null;
}

/**
 * 检查 yosys 目录布局完整性：Windows 查 8 个依赖 DLL；Linux 查 libexec/yosys 真身
 * 与 lib/ 运行库闭包（bin/yosys 是 wrapper 脚本，单独存在不代表可执行）。
 * PATH 回退的 yosys 不做检查（用户自担布局）。
 * @returns 缺失的依赖文件名列表；exe 不存在时返回 null（无法判定）
 */
export function yosysMissingDlls(): string[] | null {
  return missingDllsFor(resolveYosysPath());
}

/** 对已解析的 exe 路径做依赖完整性检查（null → 无法判定） */
function missingDllsFor(exe: string | null): string[] | null {
  if (!exe) return null;
  const dir = dirname(exe);
  // 非内置布局（PATH 回退）不检查依赖。Linux wrapper 在 yosys/bin，
  // Windows 可执行文件仍在 yosys 根目录。
  const bundledRoot = /binaries[\\/]+yosys(?:[\\/]+bin)?$/i.test(dir)
    ? (/[\\/]bin$/i.test(dir) ? dirname(dir) : dir)
    : null;
  if (!bundledRoot) return [];
  if (process.platform === 'win32') {
    return YOSYS_DLLS.filter((dll) => !existsSync(join(bundledRoot, dll)));
  }
  // Linux：wrapper 缺 libexec/yosys → 退出码 127；缺 lib/ 闭包 → loader 找不到库
  const missing: string[] = [];
  if (!existsSync(join(bundledRoot, 'libexec', 'yosys'))) missing.push('libexec/yosys');
  for (const lib of YOSYS_LINUX_LIBS) {
    if (!existsSync(join(bundledRoot, 'lib', lib))) missing.push(`lib/${lib}`);
  }
  return missing;
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
 * 汇总三工具可用性状态。yosys available 要求 exe 存在且依赖布局完整
 * （依赖缺失时 exe 可解析但不可执行，按不可用处理并报告缺失清单）。
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
