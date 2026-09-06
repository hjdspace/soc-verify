/**
 * Design Source resolver：把 filelist 或目录扫描统一转换为 ParsedFilelist。
 * elaborator 只消费规范化结果，不关心来源类型。
 */

import { existsSync, readdirSync, statSync } from 'node:fs';
import { basename, dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { flattenFilelists, type ParsedFilelist } from './filelist';
import { inspectSourceFile } from './win-symlink';
import type { DesignSourceConfig } from './types';

export const DEFAULT_DIRECTORY_EXCLUDES = [
  '**/dv/**',
  '**/dv_sv/**',
  '**/generic_dv/**',
  '**/pre_dv/**',
  '**/fpv/**',
  '**/test/**',
  '**/tests/**',
  '**/tb/**',
  '**/vendor/**',
  '**/verilator/**',
  '**/autogen/**',
  '**/.git/**',
  '**/.socverify/**',
  '**/node_modules/**',
];

const HDL_EXTENSIONS = new Set(['.v', '.sv']);
const HDL_INCLUDE_EXTENSIONS = new Set(['.svh', '.vh']);
const MAX_DISCOVERY_FILES = 100_000;

function absolutePath(path: string, projectRoot: string): string {
  return resolve(isAbsolute(path) ? path : join(projectRoot, path));
}

function normalizeRelative(path: string): string {
  return path.replace(/\\/g, '/').replace(/^\.\//, '');
}

function escapeRegex(value: string): string {
  return value.replace(/[|\\{}()[\]^$+?.]/g, '\\$&');
}

/** 支持目录扫描所需的 *, ** 与 ? glob 子集。 */
function globRegex(pattern: string): RegExp {
  const normalized = normalizeRelative(pattern);
  let source = '';
  for (let i = 0; i < normalized.length; i++) {
    const char = normalized[i];
    if (char === '*' && normalized[i + 1] === '*') {
      if (normalized[i + 2] === '/') {
        source += '(?:.*/)?';
        i += 2;
      } else {
        source += '.*';
        i += 1;
      }
    } else if (char === '*') {
      source += '[^/]*';
    } else if (char === '?') {
      source += '[^/]';
    } else {
      source += escapeRegex(char);
    }
  }
  return new RegExp(`^${source}$`, 'i');
}

function sourcePriority(path: string): number {
  const name = basename(path).toLowerCase();
  if (/(?:^|_)pkg\.sv$/.test(name)) return 0;
  if (/(?:^|_)(?:if|interface)\.sv$/.test(name)) return 1;
  return 2;
}

function sourceExtension(path: string): string {
  const match = /\.[^.]+$/.exec(path);
  return match?.[0]?.toLowerCase() ?? '';
}

/** 真 symlink 文件（dirent.isFile() 对 DT_LNK 返回 false，需 stat 跟随判断） */
function isFileSymlink(path: string): boolean {
  try {
    return statSync(path).isFile();
  } catch {
    return false;
  }
}

export function scanHdlDirectory(
  root: string,
  excludes: string[],
  incdirs: string[],
  defines: string[],
): ParsedFilelist {
  if (!root.trim()) throw new Error('目录扫描未配置根目录');
  const scanRoot = resolve(root);
  if (!existsSync(scanRoot) || !statSync(scanRoot).isDirectory()) {
    throw new Error(`RTL 扫描目录不存在: ${scanRoot}`);
  }

  const excludeMatchers = excludes.map(globRegex);
  const sources: string[] = [];
  const seenSources = new Set<string>();
  const directories: string[] = [];
  /** 包含 .svh/.vh 文件的目录，自动加入 incdir 使 `include 可被 slang 解析 */
  const autoIncdirs = new Set<string>();
  /** 伪 symlink（Windows git symlink 退化文本）.svh/.vh 的真实目标所在目录。
   *  排在普通 autoIncdirs 之前 —— 否则 include 按目录顺序命中伪文件本身（内容是路径文本）。 */
  const symlinkIncdirs = new Set<string>();
  const visit = (directory: string): void => {
    directories.push(directory);
    const entries = readdirSync(directory, { withFileTypes: true });
    for (const entry of entries) {
      const path = join(directory, entry.name);
      const rel = normalizeRelative(relative(scanRoot, path));
      const matchPath = entry.isDirectory() ? `${rel}/` : rel;
      if (excludeMatchers.some((matcher) => matcher.test(matchPath))) continue;
      if (entry.isDirectory()) {
        if (!entry.isSymbolicLink()) visit(path);
      } else if (entry.isFile() || isFileSymlink(path)) {
        // 伪 symlink（Windows git checkout 退化文本）解析到真实目标：
        // 内容为相对路径的文本文件会让 slang 报 file.sv:1:1 expected member
        const inspected = inspectSourceFile(path);
        if (inspected.kind === 'broken') continue; // 伪 symlink 目标缺失 —— 内容为垃圾文本，跳过
        const effPath = inspected.kind === 'redirect' ? inspected.target : path;
        const ext = sourceExtension(effPath);
        if (HDL_EXTENSIONS.has(ext)) {
          const src = resolve(effPath);
          if (!seenSources.has(src)) {
            seenSources.add(src);
            sources.push(src);
            if (sources.length > MAX_DISCOVERY_FILES) {
              throw new Error(`RTL 扫描文件超过 ${MAX_DISCOVERY_FILES} 个，请缩小扫描范围`);
            }
          }
        } else if (HDL_INCLUDE_EXTENSIONS.has(ext)) {
          // .svh/.vh 文件不作为独立编译单元（只通过 `include 引入），
          // 但其所在目录自动加入 incdir，使 slang 能解析 `include "xxx.svh"
          // （伪 symlink .svh 记录真实目标所在目录）
          const dir = resolve(dirname(effPath));
          autoIncdirs.add(dir);
          if (inspected.kind === 'redirect') symlinkIncdirs.add(dir);
        }
      }
    }
  };
  visit(scanRoot);
  sources.sort((a, b) => sourcePriority(a) - sourcePriority(b) || a.localeCompare(b));

  const userIncdirs = incdirs.map((dir) => resolve(dir));
  // 合并用户显式 incdirs + 伪 symlink 目标目录 + 自动推断的 .svh 目录（去重，用户优先）
  const seenIncdirs = new Set<string>(userIncdirs);
  const allIncdirs = [...userIncdirs];
  for (const dir of [...symlinkIncdirs, ...autoIncdirs]) {
    if (!seenIncdirs.has(dir)) {
      seenIncdirs.add(dir);
      allIncdirs.push(dir);
    }
  }
  return {
    sources,
    incdirs: allIncdirs,
    defines: [...defines],
    passthrough: [],
    files: [...directories, ...allIncdirs, ...sources],
  };
}

export function resolveDesignSource(config: DesignSourceConfig, projectRoot: string): ParsedFilelist {
  if (config.source === 'directory') {
    const directory = config.directory;
    if (!directory) throw new Error('目录扫描配置缺失');
    return scanHdlDirectory(
      absolutePath(directory.root, projectRoot),
      directory.excludes,
      directory.incdirs.map((dir) => absolutePath(dir, projectRoot)),
      directory.defines,
    );
  }
  const filelists = config.filelists.map((path) => absolutePath(path, projectRoot));
  return flattenFilelists(filelists, projectRoot);
}
