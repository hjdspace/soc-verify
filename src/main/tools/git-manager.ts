/**
 * Git Manager — multi-repository management tool.
 *
 * Ported from the Python `git_manager` plugin (`git_utils.py`).
 * Features: scan DE/DV repos, get repo info (branch, tag, commit, changes),
 * tag management (cqp_query / checkout_cqp_tag), batch git pull,
 * subsys-filtered updates.
 */

import { spawn, execSync } from 'node:child_process';
import { existsSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';

// ── Types ──────────────────────────────────────────────────────────

export type GitRepoInfo = {
  name: string;
  path: string;
  repoType: 'de' | 'dv';
  currentBranch: string;
  currentTag: string;
  lastCommitHash: string;
  lastCommitMessage: string;
  lastCommitTime: string;
  hasChanges: boolean;
  tags: string[];
  subsysTag: string | null;
};

export type UpdateResult = {
  logs: string[];
  stats: {
    total: number;
    success: number;
    failed: Array<{ name: string; reason: string }>;
  };
};

// ── Git command helpers ────────────────────────────────────────────

/** Run a git command and return stdout. */
function runGitCommand(repoPath: string, args: string[]): string {
  try {
    const result = execSync(['git', ...args].join(' '), {
      cwd: repoPath,
      encoding: 'utf-8',
      stdio: ['pipe', 'pipe', 'pipe'],
      timeout: 30000,
    });
    return result;
  } catch {
    return '';
  }
}

/** Run a git command with streaming output. */
function runGitStreaming(
  repoPath: string,
  args: string[],
  onLine: (line: string) => void,
): Promise<number> {
  return new Promise((resolve) => {
    const proc = spawn('git', args, {
      cwd: repoPath,
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    proc.stdout?.on('data', (data: Buffer) => {
      for (const line of data.toString().split('\n')) {
        const trimmed = line.trim();
        if (trimmed) onLine(trimmed);
      }
    });

    proc.stderr?.on('data', (data: Buffer) => {
      for (const line of data.toString().split('\n')) {
        const trimmed = line.trim();
        if (trimmed) onLine(trimmed);
      }
    });

    proc.on('exit', (code) => resolve(code ?? -1));
    proc.on('error', () => resolve(-1));
  });
}

// ── Repo scanning ──────────────────────────────────────────────────

/** Check if a directory is a git repository. */
function isGitRepo(path: string): boolean {
  return existsSync(join(path, '.git'));
}

/** Scan DE repos: $PROJ_DIR/de/* */
function getDeRepos(projectDir: string): GitRepoInfo[] {
  const repos: GitRepoInfo[] = [];
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
      repos.push({
        name: item,
        path: itemPath,
        repoType: 'de',
        currentBranch: 'Unknown',
        currentTag: 'No tag',
        lastCommitHash: 'Unknown',
        lastCommitMessage: 'Unknown',
        lastCommitTime: 'Unknown',
        hasChanges: false,
        tags: [],
        subsysTag: null,
      });
    }
  }

  return repos;
}

/** Scan DV repos: $PROJ_DIR/dv/* (excluding udtb) + $PROJ_DIR/dv/udtb/* */
function getDvRepos(projectDir: string): GitRepoInfo[] {
  const repos: GitRepoInfo[] = [];
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
          repos.push({
            name: `udtb/${uItem}`,
            path: uPath,
            repoType: 'dv',
            currentBranch: 'Unknown',
            currentTag: 'No tag',
            lastCommitHash: 'Unknown',
            lastCommitMessage: 'Unknown',
            lastCommitTime: 'Unknown',
            hasChanges: false,
            tags: [],
            subsysTag: null,
          });
        }
      }
    } else if (isGitRepo(itemPath)) {
      repos.push({
        name: item,
        path: itemPath,
        repoType: 'dv',
        currentBranch: 'Unknown',
        currentTag: 'No tag',
        lastCommitHash: 'Unknown',
        lastCommitMessage: 'Unknown',
        lastCommitTime: 'Unknown',
        hasChanges: false,
        tags: [],
        subsysTag: null,
      });
    }
  }

  return repos;
}

// ── Repo info update ───────────────────────────────────────────────

/** Update a single repo's info (branch, tag, commit, changes). */
function updateRepoInfo(repo: GitRepoInfo): void {
  // Current branch
  const branch = runGitCommand(repo.path, ['rev-parse', '--abbrev-ref', 'HEAD']).trim();
  if (branch) repo.currentBranch = branch;

  // Current tag
  repo.currentTag = getLatestCqpTag(repo.path, repo.name);

  // Subsys tag for xxx_sys repos
  const sysName = repo.name.replace('udtb/', '');
  if (sysName.endsWith('_sys')) {
    repo.subsysTag = getSubsysTag(repo.path, sysName);
  }

  // Last commit info
  const commitInfo = runGitCommand(repo.path, ['log', '-1', '--pretty=format:%h|%s|%ar']);
  if (commitInfo) {
    const parts = commitInfo.trim().split('|', 3);
    if (parts.length >= 3) {
      repo.lastCommitHash = parts[0];
      repo.lastCommitMessage = parts[1];
      repo.lastCommitTime = parts[2];
    }
  }

  // Check for uncommitted changes
  const status = runGitCommand(repo.path, ['status', '--porcelain']);
  repo.hasChanges = !!status.trim();
}

/** Get the latest CQP tag for a repo. */
function getLatestCqpTag(repoPath: string, repoName: string): string {
  // Try exact match first
  let result = runGitCommand(repoPath, ['describe', '--exact-match', '--tags', 'HEAD']).trim();
  if (result) return result;

  // Try most recent tag
  result = runGitCommand(repoPath, ['describe', '--tags', '--abbrev=0']).trim();
  if (result) return `${result} (近似)`;

  // Check if any tags exist
  result = runGitCommand(repoPath, ['tag', '-l']).trim();
  if (result) return 'No tag (有标签但不在标签上)';

  return 'No tag';
}

/** Get subsys tag for xxx_sys repos. */
function getSubsysTag(repoPath: string, sysName: string): string | null {
  if (!sysName.endsWith('_sys')) return null;

  const tagList = runGitCommand(repoPath, ['tag', '-l']).trim();
  if (!tagList) return null;

  const allTags = tagList.split('\n').map((t) => t.trim()).filter(Boolean);
  const pattern = new RegExp(`^DE_${sysName}_(\\d{4})_.*_goodcode`);

  const matchingTags: Array<{ num: number; tag: string }> = [];
  for (const tag of allTags) {
    const match = tag.match(pattern);
    if (match) {
      matchingTags.push({ num: parseInt(match[1], 10), tag });
    }
  }

  if (matchingTags.length > 0) {
    matchingTags.sort((a, b) => b.num - a.num);
    return matchingTags[0].tag;
  }

  return null;
}

// ── Tag management ─────────────────────────────────────────────────

/** Parse cqp_query output to extract tags. */
function parseCqpQueryOutput(output: string): string[] {
  const tags: string[] = [];
  const lines = output.split('\n');
  const tagPattern = /\d{4}-\d{2}-\d{2}\s+\d{2}:\d{2}:\d{2}\s+(\S+)\s+\S+/;

  for (const line of lines) {
    const trimmed = line.trim();
    if (trimmed && !trimmed.startsWith('[INFO]') && !trimmed.endsWith(':')) {
      const match = trimmed.match(tagPattern);
      if (match && !tags.includes(match[1])) {
        tags.push(match[1]);
      }
    }
  }

  return tags;
}

/** Get all tags for a repository using cqp_query command. */
export function getRepoTags(
  repo: Pick<GitRepoInfo, 'name' | 'path' | 'repoType'>,
  projectDir: string,
): string[] {
  const tags: string[] = [];

  // Try cqp_query
  try {
    const sysName = repo.name.replace('udtb/', '');
    const result = execSync(`cqp_query -dpt ${repo.repoType} -sys ${sysName}`, {
      cwd: projectDir,
      encoding: 'utf-8',
      stdio: ['pipe', 'pipe', 'pipe'],
      timeout: 30000,
    });
    if (result) {
      tags.push(...parseCqpQueryOutput(result));
    }
  } catch {
    // cqp_query might not be available
  }

  // For xxx_sys repos, also get subsys tags from local git tags
  const sysName = repo.name.replace('udtb/', '');
  if (sysName.endsWith('_sys')) {
    const tagList = runGitCommand(repo.path, ['tag', '-l']).trim();
    if (tagList) {
      const allTags = tagList.split('\n').map((t) => t.trim()).filter(Boolean);
      const pattern = new RegExp(`^DE_${sysName}_(\\d{4})_.*_goodcode`);
      const matchingTags: Array<{ num: number; tag: string }> = [];

      for (const tag of allTags) {
        const match = tag.match(pattern);
        if (match) {
          matchingTags.push({ num: parseInt(match[1], 10), tag });
        }
      }

      matchingTags.sort((a, b) => b.num - a.num);
      for (const { tag } of matchingTags) {
        if (!tags.includes(tag)) {
          tags.push(tag);
        }
      }
    }
  }

  return tags;
}

/** Checkout a tag using checkout_cqp_tag command. Returns log lines. */
export async function checkoutTag(
  repo: Pick<GitRepoInfo, 'name' | 'path' | 'repoType'>,
  tag: string,
  projectDir: string,
): Promise<string[]> {
  const logs: string[] = [];
  const sysName = repo.name.replace('udtb/', '');
  const cmd = ['checkout_cqp_tag', '-dpt', repo.repoType, '-sys', sysName, '-tag', tag];

  logs.push(`Executing: ${cmd.join(' ')}`);
  logs.push(`Working directory: ${projectDir}`);
  logs.push('='.repeat(50));

  return new Promise((resolve) => {
    const proc = spawn(cmd[0], cmd.slice(1), {
      cwd: projectDir,
      stdio: ['pipe', 'pipe', 'pipe'],
      shell: true,
    });

    proc.stdout?.on('data', (data: Buffer) => {
      for (const line of data.toString().split('\n')) {
        const trimmed = line.trim();
        if (trimmed) logs.push(trimmed);
      }
    });

    proc.stderr?.on('data', (data: Buffer) => {
      for (const line of data.toString().split('\n')) {
        const trimmed = line.trim();
        if (trimmed) logs.push(trimmed);
      }
    });

    proc.on('exit', (code) => {
      logs.push('='.repeat(50));
      if (code === 0) {
        logs.push('Command completed successfully!');
      } else {
        logs.push(`Command failed with exit code: ${code}`);
      }
      resolve(logs);
    });

    proc.on('error', (err) => {
      logs.push(`Error executing command: ${err.message}`);
      resolve(logs);
    });
  });
}

// ── Batch update ───────────────────────────────────────────────────

/** Update all repos of a given type (DV/DE) with git pull. */
export async function updateAllRepos(
  projectDir: string,
  repoType: 'de' | 'dv',
): Promise<UpdateResult> {
  const logs: string[] = [];
  const envName = repoType.toUpperCase();

  logs.push(`开始更新所有${envName}环境Git仓库...`);
  logs.push('='.repeat(60));

  // Get all repos (without detailed info, just paths)
  const repos = repoType === 'de' ? getDeRepos(projectDir) : getDvRepos(projectDir);

  if (repos.length === 0) {
    logs.push(`未找到${envName} Git仓库`);
    return { logs, stats: { total: 0, success: 0, failed: [] } };
  }

  const total = repos.length;
  let success = 0;
  const failed: Array<{ name: string; reason: string }> = [];

  logs.push(`找到 ${total} 个${envName} Git仓库`);
  logs.push('');

  for (let i = 0; i < repos.length; i++) {
    const repo = repos[i];
    logs.push(`[${i + 1}/${total}] 更新仓库: ${repo.name}`);
    logs.push(`路径: ${repo.path}`);
    logs.push('-'.repeat(40));

    // Get current branch
    const branch = runGitCommand(repo.path, ['rev-parse', '--abbrev-ref', 'HEAD']).trim();
    logs.push(`当前分支: ${branch || 'unknown'}`);

    // Execute git pull
    logs.push('执行 git pull...');
    const pullOutput: string[] = [];

    const exitCode = await runGitStreaming(repo.path, ['pull'], (line) => {
      logs.push(`  ${line}`);
      pullOutput.push(line);
    });

    if (exitCode === 0) {
      logs.push('✅ 更新成功');
      success++;
      const isUpToDate = pullOutput.some(
        (l) => l.includes('Already up to date') || l.includes('Already up-to-date'),
      );
      logs.push(isUpToDate ? '  (已是最新版本)' : '  (已更新到最新版本)');
    } else {
      const errorDetail = pullOutput.join('\n') || '未知错误';
      logs.push(`❌ 更新失败 (退出码: ${exitCode})`);
      logs.push(`  错误信息: ${errorDetail}`);

      if (errorDetail.toLowerCase().includes('conflict')) {
        failed.push({ name: repo.name, reason: '代码冲突' });
      } else if (errorDetail.toLowerCase().includes('would be overwritten')) {
        failed.push({ name: repo.name, reason: '本地修改冲突' });
      } else {
        failed.push({ name: repo.name, reason: 'git pull失败' });
      }
    }

    logs.push('');
  }

  // Summary
  logs.push('='.repeat(60));
  logs.push('更新完成总结:');
  logs.push(`总仓库数: ${total}`);
  logs.push(`成功更新: ${success}`);
  logs.push(`失败数量: ${failed.length}`);

  if (failed.length > 0) {
    logs.push('');
    logs.push('失败的仓库:');
    for (const f of failed) {
      logs.push(`  - ${f.name} (${f.reason})`);
    }
  }

  if (success === total) {
    logs.push('');
    logs.push(`🎉 所有${envName}仓库更新成功!`);
  } else if (success > 0) {
    logs.push('');
    logs.push(`⚠️ 部分仓库更新成功 (${success}/${total})`);
  } else {
    logs.push('');
    logs.push(`❌ 所有${envName}仓库更新失败`);
  }

  return {
    logs,
    stats: { total, success, failed },
  };
}

/** Update repos matching a subsys prefix. */
export async function updateSubsysRepos(
  projectDir: string,
  subsysName: string,
  repoType: 'de' | 'dv',
): Promise<UpdateResult> {
  const logs: string[] = [];
  const envName = repoType.toUpperCase();

  logs.push(`开始更新 ${subsysName} subsys 的所有${envName}仓库...`);
  logs.push('='.repeat(60));

  // Get all repos
  const allRepos = repoType === 'de' ? getDeRepos(projectDir) : getDvRepos(projectDir);

  // Filter by subsys prefix
  const matchedRepos = allRepos.filter((repo) => {
    let repoName = repo.name;
    if (repoName.startsWith('udtb/')) {
      repoName = repoName.substring(5);
    }
    return repoName.startsWith(`${subsysName}_`) || repoName === `${subsysName}_sys`;
  });

  if (matchedRepos.length === 0) {
    logs.push(`未找到匹配 ${subsysName} 的仓库`);
    return { logs, stats: { total: 0, success: 0, failed: [] } };
  }

  const total = matchedRepos.length;
  let success = 0;
  const failed: Array<{ name: string; reason: string }> = [];

  logs.push(`找到 ${total} 个匹配的仓库:`);
  for (const repo of matchedRepos) {
    logs.push(`  - ${repo.name}`);
  }
  logs.push('');

  for (let i = 0; i < matchedRepos.length; i++) {
    const repo = matchedRepos[i];
    logs.push(`[${i + 1}/${total}] 更新仓库: ${repo.name}`);
    logs.push(`路径: ${repo.path}`);
    logs.push('-'.repeat(40));

    const branch = runGitCommand(repo.path, ['rev-parse', '--abbrev-ref', 'HEAD']).trim();
    logs.push(`当前分支: ${branch || 'unknown'}`);

    logs.push('执行 git pull...');
    const pullOutput: string[] = [];

    const exitCode = await runGitStreaming(repo.path, ['pull'], (line) => {
      logs.push(`  ${line}`);
      pullOutput.push(line);
    });

    if (exitCode === 0) {
      logs.push('✅ 更新成功');
      success++;
      const isUpToDate = pullOutput.some(
        (l) => l.includes('Already up to date') || l.includes('Already up-to-date'),
      );
      logs.push(isUpToDate ? '  (已是最新版本)' : '  (已更新到最新版本)');
    } else {
      const errorDetail = pullOutput.join('\n') || '未知错误';
      logs.push(`❌ 更新失败 (退出码: ${exitCode})`);
      logs.push(`  错误信息: ${errorDetail}`);

      if (errorDetail.toLowerCase().includes('conflict')) {
        failed.push({ name: repo.name, reason: '代码冲突' });
      } else if (errorDetail.toLowerCase().includes('would be overwritten')) {
        failed.push({ name: repo.name, reason: '本地修改冲突' });
      } else {
        failed.push({ name: repo.name, reason: 'git pull失败' });
      }
    }

    logs.push('');
  }

  // Summary
  logs.push('='.repeat(60));
  logs.push('更新完成总结:');
  logs.push(`总仓库数: ${total}`);
  logs.push(`成功更新: ${success}`);
  logs.push(`失败数量: ${failed.length}`);

  if (failed.length > 0) {
    logs.push('');
    logs.push('失败的仓库:');
    for (const f of failed) {
      logs.push(`  - ${f.name} (${f.reason})`);
    }
  }

  return {
    logs,
    stats: { total, success, failed },
  };
}

// ── Discover repos ─────────────────────────────────────────────────

/** Discover all repos and update their info. */
export function discoverRepos(
  projectDir: string,
  repoType: 'de' | 'dv' | 'all' = 'all',
): GitRepoInfo[] {
  let repos: GitRepoInfo[] = [];

  if (repoType === 'de' || repoType === 'all') {
    repos = repos.concat(getDeRepos(projectDir));
  }
  if (repoType === 'dv' || repoType === 'all') {
    repos = repos.concat(getDvRepos(projectDir));
  }

  // Update info for each repo
  for (const repo of repos) {
    updateRepoInfo(repo);
  }

  return repos;
}
