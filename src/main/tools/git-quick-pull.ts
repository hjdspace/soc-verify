/**
 * Git Quick Pull — lightweight batch git pull tool.
 *
 * Ported from the Python `git_quick_pull` plugin (`repo_scanner.py` + `pull_log_dialog.py`).
 * Features: scan DV/DE repos (no git commands), parallel pull (8 workers),
 * real-time log output via callback, error categorization, start/end summary.
 */

import { spawn } from 'node:child_process';
import { existsSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';

// ── Types ──────────────────────────────────────────────────────────

export type RepoInfo = {
  name: string;
  path: string;
  repoType: 'dv' | 'de';
};

export type PullMode = 'pull' | 'pull_reset' | 'custom';

export type PullStats = {
  total: number;
  success: number;
  skipped: Array<{ name: string; reason: string }>;
  failed: Array<{ name: string; reason: string }>;
};

export type PullLogEntry = {
  repoName: string;
  lines: string[];
  success: boolean;
  reason: string | null;
  isSkipped: boolean;
};

export type PullResult = {
  logs: PullLogEntry[];
  stats: PullStats;
};

/** Real-time event emitted during batch pull execution. */
export type GitQuickPullEvent =
  | { type: 'start'; lines: string[] }
  | {
      type: 'repo';
      lines: string[];
      repoName: string;
      success: boolean;
      reason: string | null;
      isSkipped: boolean;
    }
  | { type: 'end'; lines: string[]; stats: PullStats };

/** Callback for real-time log streaming (matches Python's pyqtSignal pattern). */
export type PullEventCallback = (event: GitQuickPullEvent) => void;

// ── Constants ──────────────────────────────────────────────────────

/** Maximum parallel workers (matches Python's max_workers=8). */
const MAX_WORKERS = 8;

// ── Repo scanning (no git commands, just .git dir check) ────────────

/** Check if a directory is a git repository. */
function isGitRepo(path: string): boolean {
  return existsSync(join(path, '.git'));
}

/** Scan DV repos: $PROJ_DIR/dv/* (excluding udtb) + $PROJ_DIR/dv/udtb/* */
function scanDvRepos(projectDir: string): RepoInfo[] {
  const repos: RepoInfo[] = [];
  const dvPath = join(projectDir, 'dv');

  if (!existsSync(dvPath)) return repos;

  let items: string[];
  try {
    items = readdirSync(dvPath);
  } catch {
    return repos;
  }

  for (const item of items) {
    const itemPath = join(dvPath, item);
    try {
      if (!statSync(itemPath).isDirectory()) continue;
    } catch {
      continue;
    }

    if (item === 'udtb') {
      // Scan udtb subdirectory
      const udtbPath = join(dvPath, 'udtb');
      let udtbItems: string[];
      try {
        udtbItems = readdirSync(udtbPath);
      } catch {
        continue;
      }
      for (const uItem of udtbItems) {
        const uPath = join(udtbPath, uItem);
        try {
          if (!statSync(uPath).isDirectory()) continue;
        } catch {
          continue;
        }
        if (isGitRepo(uPath)) {
          repos.push({ name: `udtb/${uItem}`, path: uPath, repoType: 'dv' });
        }
      }
    } else if (isGitRepo(itemPath)) {
      repos.push({ name: item, path: itemPath, repoType: 'dv' });
    }
  }

  return repos;
}

/** Scan DE repos: $PROJ_DIR/de/* */
function scanDeRepos(projectDir: string): RepoInfo[] {
  const repos: RepoInfo[] = [];
  const dePath = join(projectDir, 'de');

  if (!existsSync(dePath)) return repos;

  let items: string[];
  try {
    items = readdirSync(dePath);
  } catch {
    return repos;
  }

  for (const item of items) {
    const itemPath = join(dePath, item);
    try {
      if (!statSync(itemPath).isDirectory()) continue;
    } catch {
      continue;
    }
    if (isGitRepo(itemPath)) {
      repos.push({ name: item, path: itemPath, repoType: 'de' });
    }
  }

  return repos;
}

/** Scan all repos: dv / de / all */
export function scanRepos(
  projectDir: string,
  repoType: 'dv' | 'de' | 'all' = 'all',
): RepoInfo[] {
  if (repoType === 'dv') return scanDvRepos(projectDir);
  if (repoType === 'de') return scanDeRepos(projectDir);
  return [...scanDvRepos(projectDir), ...scanDeRepos(projectDir)];
}

// ── Git command execution ──────────────────────────────────────────

/** Run a git command and return stdout. */
function runGitCommand(cwd: string, args: string[]): Promise<string> {
  return new Promise((resolve) => {
    const proc = spawn('git', args, { cwd, stdio: ['pipe', 'pipe', 'pipe'] });
    let stdout = '';
    proc.stdout?.on('data', (data: Buffer) => {
      stdout += data.toString();
    });
    proc.stderr?.on('data', () => {});
    proc.on('exit', () => resolve(stdout));
    proc.on('error', () => resolve(''));
  });
}

/** Extract error reason from git output lines. */
function extractErrorReason(outputLines: string[]): string | null {
  for (const line of outputLines) {
    const lineLower = line.toLowerCase();
    if (lineLower.includes('error:') || lineLower.includes('fatal:')) {
      if (line.toLowerCase().includes('error:')) {
        return line.split(/error:/i)[1]?.trim() ?? line;
      }
      if (line.toLowerCase().includes('fatal:')) {
        return line.split(/fatal:/i)[1]?.trim() ?? line;
      }
    }
    if (lineLower.includes('conflict')) {
      return '合并冲突';
    }
    if (lineLower.includes('would be overwritten')) {
      return '本地更改与远程冲突';
    }
    if (
      lineLower.includes('connection') &&
      (lineLower.includes('refused') || lineLower.includes('timed out'))
    ) {
      return '网络连接失败';
    }
  }
  // Try last non-empty line
  for (let i = outputLines.length - 1; i >= 0; i--) {
    const line = outputLines[i].trim();
    if (line && !line.startsWith(' ')) {
      return line;
    }
  }
  return null;
}

/** Execute git pull for a single repo. Returns [success, reason]. */
async function executeGitPull(
  repoPath: string,
  buf: string[],
): Promise<[boolean, string | null]> {
  buf.push('执行 git pull...');

  return new Promise((resolve) => {
    const proc = spawn('git', ['pull'], {
      cwd: repoPath,
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    const outputLines: string[] = [];

    proc.stdout?.on('data', (data: Buffer) => {
      const text = data.toString();
      for (const line of text.split('\n')) {
        const trimmed = line.trim();
        if (trimmed) {
          buf.push(`  ${trimmed}`);
          outputLines.push(trimmed);
        }
      }
    });

    proc.stderr?.on('data', (data: Buffer) => {
      const text = data.toString();
      for (const line of text.split('\n')) {
        const trimmed = line.trim();
        if (trimmed) {
          buf.push(`  ${trimmed}`);
          outputLines.push(trimmed);
        }
      }
    });

    proc.on('exit', (code) => {
      if (code === 0) {
        buf.push('✅ 更新成功');
        const isUpToDate = outputLines.some(
          (l) => l.includes('Already up to date') || l.includes('Already up-to-date'),
        );
        buf.push(isUpToDate ? '  (已是最新版本)' : '  (已更新到最新版本)');
        resolve([true, null]);
      } else {
        const reason = extractErrorReason(outputLines);
        buf.push(`❌ 更新失败 (退出码: ${code})`);
        if (reason) buf.push(`  原因: ${reason}`);
        resolve([false, reason ?? `退出码 ${code}`]);
      }
    });

    proc.on('error', (err) => {
      buf.push(`❌ 更新失败: ${err.message}`);
      resolve([false, err.message]);
    });
  });
}

/** Execute git fetch + git reset --hard origin/master (dangerous: discards local changes). */
async function executeGitPullAndReset(
  repoPath: string,
  buf: string[],
): Promise<[boolean, string | null]> {
  // Step 1: git fetch
  buf.push('执行 git fetch...');
  const fetchResult = await new Promise<[boolean, string | null]>((resolve) => {
    const proc = spawn('git', ['fetch', 'origin'], {
      cwd: repoPath,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    proc.stdout?.on('data', (data: Buffer) => {
      for (const line of data.toString().split('\n')) {
        const trimmed = line.trim();
        if (trimmed) buf.push(`  ${trimmed}`);
      }
    });
    proc.stderr?.on('data', (data: Buffer) => {
      for (const line of data.toString().split('\n')) {
        const trimmed = line.trim();
        if (trimmed) buf.push(`  ${trimmed}`);
      }
    });
    proc.on('exit', (code) => {
      if (code !== 0) {
        buf.push('❌ git fetch 失败');
        resolve([false, 'git fetch 失败']);
      } else {
        resolve([true, null]);
      }
    });
    proc.on('error', (err) => {
      buf.push(`❌ git fetch 异常: ${err.message}`);
      resolve([false, `git fetch 异常: ${err.message}`]);
    });
  });

  if (!fetchResult[0]) return fetchResult;

  // Step 2: git reset --hard origin/master
  buf.push('执行 git reset --hard origin/master...');
  return new Promise((resolve) => {
    const proc = spawn('git', ['reset', '--hard', 'origin/master'], {
      cwd: repoPath,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    proc.stdout?.on('data', (data: Buffer) => {
      for (const line of data.toString().split('\n')) {
        const trimmed = line.trim();
        if (trimmed) buf.push(`  ${trimmed}`);
      }
    });
    proc.stderr?.on('data', (data: Buffer) => {
      for (const line of data.toString().split('\n')) {
        const trimmed = line.trim();
        if (trimmed) buf.push(`  ${trimmed}`);
      }
    });
    proc.on('exit', (code) => {
      if (code === 0) {
        buf.push('✅ 已重置到远程 master 最新版本');
        resolve([true, null]);
      } else {
        buf.push('❌ git reset 失败');
        resolve([false, 'git reset 失败']);
      }
    });
    proc.on('error', (err) => {
      buf.push(`❌ git reset 异常: ${err.message}`);
      resolve([false, `git reset 异常: ${err.message}`]);
    });
  });
}

/** Execute custom git command (no shell, matching Python's subprocess.Popen behavior). */
async function executeCustomCommand(
  repoPath: string,
  customCommand: string,
  buf: string[],
): Promise<[boolean, string | null]> {
  const cmdParts = customCommand.trim().split(/\s+/).filter(Boolean);
  buf.push(`执行自定义命令: ${cmdParts.join(' ')}`);

  return new Promise((resolve) => {
    const proc = spawn(cmdParts[0], cmdParts.slice(1), {
      cwd: repoPath,
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    const outputLines: string[] = [];

    proc.stdout?.on('data', (data: Buffer) => {
      for (const line of data.toString().split('\n')) {
        const trimmed = line.trim();
        if (trimmed) {
          buf.push(`  ${trimmed}`);
          outputLines.push(trimmed);
        }
      }
    });

    proc.stderr?.on('data', (data: Buffer) => {
      for (const line of data.toString().split('\n')) {
        const trimmed = line.trim();
        if (trimmed) {
          buf.push(`  ${trimmed}`);
          outputLines.push(trimmed);
        }
      }
    });

    proc.on('exit', (code) => {
      if (code === 0) {
        buf.push('✅ 命令执行成功');
        resolve([true, null]);
      } else {
        const reason = extractErrorReason(outputLines);
        buf.push(`❌ 命令执行失败 (退出码: ${code})`);
        resolve([false, reason ?? `退出码 ${code}`]);
      }
    });

    proc.on('error', (err) => {
      buf.push(`❌ 命令执行异常: ${err.message}`);
      resolve([false, err.message]);
    });
  });
}

// ── Parallel execution helpers ─────────────────────────────────────

/**
 * Run async tasks with a concurrency limit (matches Python's ThreadPoolExecutor).
 *
 * Items are processed in parallel up to `concurrency` at a time. Each task
 * receives the original index (0-based) for log ordering.
 */
async function runWithConcurrency<T>(
  items: T[],
  concurrency: number,
  fn: (item: T, index: number) => Promise<void>,
): Promise<void> {
  let nextIndex = 0;
  const worker = async () => {
    while (nextIndex < items.length) {
      const currentIndex = nextIndex++;
      await fn(items[currentIndex], currentIndex);
    }
  };
  const workerCount = Math.min(concurrency, items.length) || 1;
  await Promise.all(Array.from({ length: workerCount }, () => worker()));
}

// ── Core: process a single repo ────────────────────────────────────

/**
 * Process a single repo: returns log entry with success/skipped/failed status.
 *
 * Core logic (matches Python's _process_single_repo):
 * 1. pull_reset mode: check uncommitted changes → skip if any
 * 2. Execute git operation based on mode
 * 3. Never throws — catches all exceptions and records as failure
 */
async function processSingleRepo(
  repo: RepoInfo,
  index: number,
  total: number,
  mode: PullMode,
  customCommand: string | null,
): Promise<PullLogEntry> {
  const buf: string[] = [];

  buf.push(`[${index}/${total}] 更新仓库: ${repo.name}`);
  buf.push(`路径: ${repo.path}`);
  buf.push('-'.repeat(40));

  let success = false;
  let reason: string | null = null;
  const isSkipped = false;

  try {
    // Only pull_reset mode skips repos with uncommitted changes (would discard them).
    // pull and custom modes are safe — git will error on conflict, not overwrite.
    if (mode === 'pull_reset') {
      const statusResult = await runGitCommand(repo.path, ['status', '--porcelain']);
      if (statusResult.trim()) {
        buf.push('⚠️ 警告: 仓库有未提交的更改，强制重置会丢失这些更改');
        buf.push('未提交的文件:');
        for (const line of statusResult.trim().split('\n')) {
          buf.push(`  ${line}`);
        }
        buf.push('跳过此仓库的更新');
        buf.push('');
        return {
          repoName: repo.name,
          lines: buf,
          success: false,
          reason: '有未提交更改',
          isSkipped: true,
        };
      }
    }

    // Execute git operation based on mode
    if (mode === 'pull') {
      [success, reason] = await executeGitPull(repo.path, buf);
    } else if (mode === 'pull_reset') {
      [success, reason] = await executeGitPullAndReset(repo.path, buf);
    } else if (mode === 'custom' && customCommand) {
      [success, reason] = await executeCustomCommand(repo.path, customCommand, buf);
    } else {
      success = false;
      reason = `未知模式: ${mode}`;
      buf.push(`❌ ${reason}`);
    }
  } catch (e) {
    const errMsg = `处理仓库时出错: ${e instanceof Error ? e.message : String(e)}`;
    buf.push(`❌ ${errMsg}`);
    success = false;
    reason = errMsg;
  }

  buf.push('');

  return {
    repoName: repo.name,
    lines: buf,
    success,
    reason,
    isSkipped,
  };
}

// ── Batch execution ────────────────────────────────────────────────

/**
 * Execute batch pull on all repos in parallel (up to 8 concurrent).
 *
 * Matches Python's PullWorker.run():
 * - Emits start summary, per-repo logs, and end summary via `onLog` callback
 * - Parallel execution with MAX_WORKERS concurrency
 * - Per-repo log buffering prevents interleaving in parallel mode
 * - Single repo failure never interrupts the batch
 */
export async function executePull(
  repos: RepoInfo[],
  mode: PullMode,
  customCommand: string | null = null,
  onLog?: PullEventCallback,
): Promise<PullResult> {
  const total = repos.length;
  const logs: PullLogEntry[] = [];
  const stats: PullStats = {
    total,
    success: 0,
    skipped: [],
    failed: [],
  };

  // Determine env name (matches Python heuristic)
  const envName =
    total > 10
      ? 'DV+DE'
      : repos.length > 0 && repos[0].repoType === 'dv'
        ? 'DV'
        : 'DE';

  // ── Start summary (matches Python's start logs) ──
  const startLines: string[] = [
    `开始更新${envName}环境Git仓库（并行模式，${MAX_WORKERS}线程）...`,
    '='.repeat(60),
    `找到 ${total} 个Git仓库`,
    '',
  ];
  onLog?.({ type: 'start', lines: startLines });

  // ── Process repos in parallel ──
  await runWithConcurrency(repos, MAX_WORKERS, async (repo, i) => {
    const entry = await processSingleRepo(repo, i + 1, total, mode, customCommand);
    logs.push(entry);

    // Update stats
    if (entry.success) {
      stats.success += 1;
    } else if (entry.isSkipped) {
      stats.skipped.push({ name: entry.repoName, reason: entry.reason ?? '跳过' });
    } else {
      stats.failed.push({
        name: entry.repoName,
        reason: entry.reason ?? '未知错误',
      });
    }

    // Emit per-repo logs (buffered, flushed atomically to prevent interleaving)
    onLog?.({
      type: 'repo',
      lines: entry.lines,
      repoName: entry.repoName,
      success: entry.success,
      reason: entry.reason,
      isSkipped: entry.isSkipped,
    });
  });

  // ── End summary (matches Python's completion logs) ──
  const endLines: string[] = [
    '',
    '='.repeat(60),
    '更新完成总结:',
    `总仓库数: ${stats.total}`,
    `成功更新: ${stats.success}`,
    `跳过数量: ${stats.skipped.length}`,
    `失败数量: ${stats.failed.length}`,
  ];

  if (stats.failed.length > 0) {
    endLines.push('');
    endLines.push('失败的仓库:');
    for (const { name, reason } of stats.failed) {
      endLines.push(`  - ${name} (${reason})`);
    }
  }

  if (stats.skipped.length > 0) {
    endLines.push('');
    endLines.push('跳过的仓库:');
    for (const { name, reason } of stats.skipped) {
      endLines.push(`  - ${name} (${reason})`);
    }
  }

  if (stats.success === total) {
    endLines.push('');
    endLines.push('🎉 所有仓库更新成功!');
  } else if (stats.success > 0) {
    endLines.push('');
    endLines.push(`⚠️ 部分仓库更新成功 (${stats.success}/${total})`);
  } else {
    endLines.push('');
    endLines.push('❌ 所有仓库更新失败');
  }

  onLog?.({ type: 'end', lines: endLines, stats });

  return { logs, stats };
}
