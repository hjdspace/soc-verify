/**
 * Git Quick Pull — lightweight batch git pull tool.
 *
 * Ported from the Python `git_quick_pull` plugin (`repo_scanner.py` + `pull_log_dialog.py`).
 * Features: scan DV/DE repos (no git commands), parallel pull,
 * real-time log output, error categorization.
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
};

export type PullResult = {
  logs: PullLogEntry[];
  stats: PullStats;
};

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

/** Execute git pull for a single repo. Returns [success, reason, logLines]. */
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

/** Execute git fetch + git reset --hard origin/master. */
async function executeGitPullAndReset(
  repoPath: string,
  buf: string[],
): Promise<[boolean, string | null]> {
  // Step 1: Check for uncommitted changes
  const statusResult = await runGitCommand(repoPath, ['status', '--porcelain']);
  if (statusResult.trim()) {
    buf.push('⚠️ 警告: 仓库有未提交的更改，强制重置会丢失这些更改');
    buf.push('未提交的文件:');
    for (const line of statusResult.trim().split('\n')) {
      buf.push(`  ${line}`);
    }
    buf.push('跳过此仓库的更新');
    return [false, '有未提交更改（跳过）'];
  }

  // Step 2: git fetch
  buf.push('执行 git fetch...');
  const fetchResult = await new Promise<[boolean, string | null]>((resolve) => {
    const proc = spawn('git', ['fetch', 'origin'], {
      cwd: repoPath,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    const lines: string[] = [];
    proc.stdout?.on('data', (data: Buffer) => {
      for (const line of data.toString().split('\n')) {
        const trimmed = line.trim();
        if (trimmed) {
          buf.push(`  ${trimmed}`);
          lines.push(trimmed);
        }
      }
    });
    proc.stderr?.on('data', (data: Buffer) => {
      for (const line of data.toString().split('\n')) {
        const trimmed = line.trim();
        if (trimmed) {
          buf.push(`  ${trimmed}`);
          lines.push(trimmed);
        }
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

  // Step 3: git reset --hard origin/master
  buf.push('执行 git reset --hard origin/master...');
  return new Promise((resolve) => {
    const proc = spawn('git', ['reset', '--hard', 'origin/master'], {
      cwd: repoPath,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    const lines: string[] = [];
    proc.stdout?.on('data', (data: Buffer) => {
      for (const line of data.toString().split('\n')) {
        const trimmed = line.trim();
        if (trimmed) {
          buf.push(`  ${trimmed}`);
          lines.push(trimmed);
        }
      }
    });
    proc.stderr?.on('data', (data: Buffer) => {
      for (const line of data.toString().split('\n')) {
        const trimmed = line.trim();
        if (trimmed) {
          buf.push(`  ${trimmed}`);
          lines.push(trimmed);
        }
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

/** Execute custom git command. */
async function executeCustomCommand(
  repoPath: string,
  customCommand: string,
  buf: string[],
): Promise<[boolean, string | null]> {
  const cmdParts = customCommand.split(/\s+/);
  buf.push(`执行自定义命令: ${cmdParts.join(' ')}`);

  return new Promise((resolve) => {
    const proc = spawn(cmdParts[0], cmdParts.slice(1), {
      cwd: repoPath,
      stdio: ['pipe', 'pipe', 'pipe'],
      shell: true,
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

/** Process a single repo: returns log entry + updates stats. */
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

  try {
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
  };
}

/** Execute batch pull on all repos (sequential to preserve log order). */
export async function executePull(
  repos: RepoInfo[],
  mode: PullMode,
  customCommand: string | null = null,
): Promise<PullResult> {
  const total = repos.length;
  const logs: PullLogEntry[] = [];
  const stats: PullStats = {
    total,
    success: 0,
    skipped: [],
    failed: [],
  };

  for (let i = 0; i < repos.length; i++) {
    const entry = await processSingleRepo(
      repos[i],
      i + 1,
      total,
      mode,
      customCommand,
    );
    logs.push(entry);

    if (entry.success) {
      stats.success += 1;
    } else if (entry.reason && entry.reason.includes('跳过')) {
      stats.skipped.push({ name: entry.repoName, reason: entry.reason });
    } else {
      stats.failed.push({
        name: entry.repoName,
        reason: entry.reason ?? '未知错误',
      });
    }
  }

  return { logs, stats };
}
