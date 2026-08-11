/**
 * Git Manager cache — persistent repo info cache for fast startup.
 *
 * Ported from the Python `git_manager` plugin's `cache_manager.py`.
 * Stores scanned repo info to `.socverify/git-manager-cache.json`.
 * On subsequent loads, the cache is read immediately and individual
 * repos are refreshed in the background based on hash comparison.
 */

import { existsSync, readFileSync, writeFileSync, mkdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import type { GitRepoInfo } from './git-manager';

// ── Constants ──────────────────────────────────────────────────────

const SOCVERIFY_DIR = '.socverify';
const CACHE_FILE = 'git-manager-cache.json';
const CACHE_VERSION = '1.0.0';

// ── Types ──────────────────────────────────────────────────────────

type CachedRepo = GitRepoInfo & { _hash: string };

type CacheData = {
  version: string;
  timestamp: number;
  projectDir: string;
  rtlHash: string;
  envHash: string;
  repos: CachedRepo[];
};

// ── Hash helpers ───────────────────────────────────────────────────

/**
 * Compute a lightweight hash for a git repo to detect changes.
 * Based on `.git` dir mtime + HEAD file content + refs dir mtime.
 */
export function getRepoHash(repoPath: string): string {
  try {
    const gitDir = join(repoPath, '.git');
    if (!existsSync(gitDir)) return '';

    const gitMtime = statSync(gitDir).mtime.getTime();

    const headFile = join(gitDir, 'HEAD');
    let headContent = '';
    if (existsSync(headFile)) {
      headContent = readFileSync(headFile, 'utf-8').trim();
    }

    const refsDir = join(gitDir, 'refs');
    let refsMtime = 0;
    if (existsSync(refsDir)) {
      refsMtime = statSync(refsDir).mtime.getTime();
    }

    const hashData = `${gitMtime}:${headContent}:${refsMtime}:${repoPath}`;
    return createHash('md5').update(hashData).digest('hex');
  } catch {
    return '';
  }
}

/**
 * Compute a hash for a directory listing (to detect added/removed repos).
 */
function getDirectoryHash(dirPath: string): string {
  try {
    if (!existsSync(dirPath)) return '';

    const items: string[] = [];
    for (const item of readdirSyncSafe(dirPath)) {
      const itemPath = join(dirPath, item);
      try {
        if (statSync(itemPath).isDirectory()) {
          const mtime = statSync(itemPath).mtime.getTime();
          items.push(`${item}:${mtime}`);
        }
      } catch {
        // skip
      }
    }

    items.sort();
    return createHash('md5').update(items.join(':')).digest('hex');
  } catch {
    return '';
  }
}

function readdirSyncSafe(dir: string): string[] {
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    return require('node:fs').readdirSync(dir) as string[];
  } catch {
    return [];
  }
}

// ── Cache path ─────────────────────────────────────────────────────

function getCacheFilePath(projectDir: string): string {
  return join(projectDir, SOCVERIFY_DIR, CACHE_FILE);
}

function ensureCacheDir(projectDir: string): string {
  const dir = join(projectDir, SOCVERIFY_DIR);
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }
  return dir;
}

// ── Public API ─────────────────────────────────────────────────────

/**
 * Load cached repos for a project. Returns null if cache is missing
 * or invalid.
 */
export function loadCache(projectDir: string): GitRepoInfo[] | null {
  try {
    const cachePath = getCacheFilePath(projectDir);
    if (!existsSync(cachePath)) return null;

    const data = JSON.parse(readFileSync(cachePath, 'utf-8')) as CacheData;
    if (data.version !== CACHE_VERSION) return null;
    if (!Array.isArray(data.repos)) return null;

    // Strip the internal `_hash` field before returning
    return data.repos.map(({ _hash: _unused, ...repo }) => {
      void _unused;
      return repo as GitRepoInfo;
    });
  } catch {
    return null;
  }
}

/**
 * Save repos to cache, including computed hashes.
 */
export function saveCache(projectDir: string, repos: GitRepoInfo[]): void {
  try {
    ensureCacheDir(projectDir);

    const rtlPath = resolveRtlPath(projectDir);
    const envPath = resolveEnvPath(projectDir);

    const data: CacheData = {
      version: CACHE_VERSION,
      timestamp: Date.now(),
      projectDir,
      rtlHash: rtlPath ? getDirectoryHash(rtlPath) : '',
      envHash: envPath ? getDirectoryHash(envPath) : '',
      repos: repos.map((repo) => ({
        ...repo,
        _hash: getRepoHash(repo.path),
      })),
    };

    const cachePath = getCacheFilePath(projectDir);
    writeFileSync(cachePath, JSON.stringify(data, null, 2), 'utf-8');
  } catch {
    // Cache save failure is non-fatal
  }
}

/**
 * Update a single repo's info in the cache (used during background refresh).
 */
export function updateSingleRepoCache(
  projectDir: string,
  repoPath: string,
  updatedRepo: GitRepoInfo,
): void {
  try {
    const cachePath = getCacheFilePath(projectDir);
    if (!existsSync(cachePath)) return;

    const data = JSON.parse(readFileSync(cachePath, 'utf-8')) as CacheData;
    if (data.version !== CACHE_VERSION) return;

    const idx = data.repos.findIndex((r) => r.path === repoPath);
    if (idx >= 0) {
      data.repos[idx] = { ...updatedRepo, _hash: getRepoHash(repoPath) };
    } else {
      data.repos.push({ ...updatedRepo, _hash: getRepoHash(repoPath) });
    }

    data.timestamp = Date.now();
    writeFileSync(cachePath, JSON.stringify(data, null, 2), 'utf-8');
  } catch {
    // Non-fatal
  }
}

/**
 * Compare cached repo hashes with current filesystem hashes.
 * Returns paths of repos that have changed (or new repos not in cache).
 */
export function getOutdatedRepoPaths(projectDir: string): string[] {
  try {
    const cachePath = getCacheFilePath(projectDir);
    if (!existsSync(cachePath)) return [];

    const data = JSON.parse(readFileSync(cachePath, 'utf-8')) as CacheData;
    if (data.version !== CACHE_VERSION) return [];

    const outdated: string[] = [];
    for (const cachedRepo of data.repos) {
      const currentHash = getRepoHash(cachedRepo.path);
      if (currentHash && cachedRepo._hash !== currentHash) {
        outdated.push(cachedRepo.path);
      }
    }
    return outdated;
  } catch {
    return [];
  }
}

/**
 * Check if the DE/DV directory structure has changed since cache was created.
 */
export function hasDirectoryStructureChanged(projectDir: string): boolean {
  try {
    const cachePath = getCacheFilePath(projectDir);
    if (!existsSync(cachePath)) return true;

    const data = JSON.parse(readFileSync(cachePath, 'utf-8')) as CacheData;
    if (data.version !== CACHE_VERSION) return true;

    const rtlPath = resolveRtlPath(projectDir);
    const envPath = resolveEnvPath(projectDir);

    const currentRtlHash = rtlPath ? getDirectoryHash(rtlPath) : '';
    const currentEnvHash = envPath ? getDirectoryHash(envPath) : '';

    return data.rtlHash !== currentRtlHash || data.envHash !== currentEnvHash;
  } catch {
    return true;
  }
}

// ── Env var resolution (mirrors git-manager.ts) ────────────────────

function resolveRtlPath(projectDir: string): string | null {
  const envVal = process.env.PROJ_RTL;
  if (envVal && envVal.trim()) return envVal.trim();

  try {
    const configPath = join(projectDir, SOCVERIFY_DIR, 'env.json');
    if (!existsSync(configPath)) return null;
    const config = JSON.parse(readFileSync(configPath, 'utf-8')) as {
      envVars?: Record<string, string>;
    };
    const configured = config?.envVars?.PROJ_RTL;
    if (typeof configured === 'string' && configured.trim()) {
      return configured.trim();
    }
  } catch {
    // ignore
  }
  return null;
}

function resolveEnvPath(projectDir: string): string | null {
  const envVal = process.env.PROJ_ENV;
  if (envVal && envVal.trim()) return envVal.trim();

  try {
    const configPath = join(projectDir, SOCVERIFY_DIR, 'env.json');
    if (!existsSync(configPath)) return null;
    const config = JSON.parse(readFileSync(configPath, 'utf-8')) as {
      envVars?: Record<string, string>;
    };
    const configured = config?.envVars?.PROJ_ENV;
    if (typeof configured === 'string' && configured.trim()) {
      return configured.trim();
    }
  } catch {
    // ignore
  }
  return null;
}
