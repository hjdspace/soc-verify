/**
 * Design Source resolver：把 filelist 或目录扫描统一转换为 ParsedFilelist。
 * elaborator 只消费规范化结果，不关心来源类型。
 */

import { existsSync, readdirSync, statSync } from 'node:fs';
import { basename, isAbsolute, join, relative, resolve } from 'node:path';
import { flattenFilelists, type ParsedFilelist } from './filelist';
import type { DesignSourceConfig } from './types';

export const DEFAULT_DIRECTORY_EXCLUDES = [
  '**/dv/**',
  '**/test/**',
  '**/tests/**',
  '**/vendor/**',
  '**/verilator/**',
  '**/.git/**',
  '**/.socverify/**',
  '**/node_modules/**',
];

const HDL_EXTENSIONS = new Set(['.v', '.sv']);
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
  const directories: string[] = [];
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
      } else if (entry.isFile() && HDL_EXTENSIONS.has(sourceExtension(entry.name))) {
        sources.push(resolve(path));
        if (sources.length > MAX_DISCOVERY_FILES) {
          throw new Error(`RTL 扫描文件超过 ${MAX_DISCOVERY_FILES} 个，请缩小扫描范围`);
        }
      }
    }
  };
  visit(scanRoot);
  sources.sort((a, b) => sourcePriority(a) - sourcePriority(b) || a.localeCompare(b));

  const normalizedIncdirs = incdirs.map((dir) => resolve(dir));
  return {
    sources,
    incdirs: normalizedIncdirs,
    defines: [...defines],
    passthrough: [],
    files: [...directories, ...normalizedIncdirs, ...sources],
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
