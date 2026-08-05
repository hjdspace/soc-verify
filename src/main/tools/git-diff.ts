/**
 * Git Diff — file version comparison tool.
 *
 * Ported from the Python `git_diff` plugin (`git_repository.py` + `file_diff.py`).
 * Uses child_process to call git directly (no GitPython dependency).
 * Features: open repo, list tracked files, get file commits,
 * get file content at commit, calculate diffs.
 */

import { execSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { relative, sep, isAbsolute } from 'node:path';

// ── Types ──────────────────────────────────────────────────────────

export type CommitInfo = {
  sha: string;
  shortSha: string;
  author: string;
  authorEmail: string;
  date: string;
  message: string;
  summary: string;
};

export type DiffLineType = 'context' | 'add' | 'delete' | 'modify';

export type DiffLine = {
  lineType: DiffLineType;
  oldLineNo: number | null;
  newLineNo: number | null;
  content: string;
};

export type DiffStats = {
  addedLines: number;
  deletedLines: number;
  modifiedLines: number;
  contextLines: number;
  totalChanges: number;
};

export type DiffResult = {
  diffLines: DiffLine[];
  stats: DiffStats;
  hunks: Array<{
    oldStart: number;
    oldCount: number;
    newStart: number;
    newCount: number;
    lines: DiffLine[];
  }>;
};

export type RepoInfo = {
  repoRoot: string;
  currentBranch: string;
  branches: string[];
};

// ── Git command helpers ────────────────────────────────────────────

/** Run a git command and return stdout as string. */
function runGit(repoPath: string, args: string[]): string {
  try {
    const result = execSync('git ' + args.map((a) => `"${a}"`).join(' '), {
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

/** Get the repo root directory for a given path. */
export function getRepoRoot(repoPath: string): string | null {
  try {
    const root = runGit(repoPath, ['rev-parse', '--show-toplevel']).trim();
    return root || null;
  } catch {
    return null;
  }
}

/** Check if a path is inside a git repository. */
export function isValidRepo(repoPath: string): boolean {
  return getRepoRoot(repoPath) !== null;
}

/** Get repo info: root, current branch, branch list. */
export function getRepoInfo(repoPath: string): RepoInfo {
  const repoRoot = getRepoRoot(repoPath) ?? repoPath;
  const currentBranch = runGit(repoPath, ['branch', '--show-current']).trim() || 'HEAD';
  const branchesRaw = runGit(repoPath, ['branch', '--list']);
  const branches = branchesRaw
    .split('\n')
    .map((b) => b.trim().replace(/^\* /, ''))
    .filter(Boolean);

  return { repoRoot, currentBranch, branches };
}

/** Get tracked files in the repository. */
export function getTrackedFiles(repoPath: string, directory?: string): string[] {
  const repoRoot = getRepoRoot(repoPath);
  if (!repoRoot) return [];

  const files = runGit(repoRoot, ['ls-files']).split('\n').filter(Boolean);
  const sorted = files.sort();

  if (directory) {
    let relDir = directory;
    if (isAbsolute(directory)) {
      relDir = relative(repoRoot, directory);
    }
    relDir = relDir.split(sep).join('/');
    return sorted.filter((f) => f.startsWith(relDir));
  }

  return sorted;
}

/** Get file commit history. */
export function getFileCommits(
  repoPath: string,
  filePath: string,
  maxCount = 50,
): CommitInfo[] {
  const repoRoot = getRepoRoot(repoPath);
  if (!repoRoot) return [];

  // Normalize path to be relative to repo root
  let relPath = filePath;
  if (isAbsolute(filePath)) {
    relPath = relative(repoRoot, filePath);
  }
  relPath = relPath.split(sep).join('/');

  const format = '%H%x00%h%x00%an%x00%ae%x00%ad%x00%s%x00%b%x00--COMMIT--';
  const output = runGit(repoRoot, [
    'log',
    '--follow',
    `--max-count=${maxCount}`,
    `--format=${format}`,
    '--',
    relPath,
  ]);

  if (!output.trim()) return [];

  const commits: CommitInfo[] = [];
  const rawCommits = output.split('--COMMIT--\n').filter(Boolean);

  for (const raw of rawCommits) {
    const parts = raw.split('\x00');
    if (parts.length >= 7) {
      const sha = parts[0];
      const shortSha = parts[1];
      const author = parts[2];
      const authorEmail = parts[3];
      const date = parts[4];
      const summary = parts[5];
      const body = parts[6];
      const message = (summary + (body ? '\n' + body : '')).trim();

      commits.push({
        sha,
        shortSha,
        author,
        authorEmail,
        date,
        message,
        summary,
      });
    }
  }

  return commits;
}

/** Get file content at a specific commit. */
export function getFileContentAtCommit(
  repoPath: string,
  filePath: string,
  commitSha: string,
): string {
  const repoRoot = getRepoRoot(repoPath);
  if (!repoRoot) return '';

  let relPath = filePath;
  if (isAbsolute(filePath)) {
    relPath = relative(repoRoot, filePath);
  }
  relPath = relPath.split(sep).join('/');

  const output = runGit(repoRoot, ['show', `${commitSha}:${relPath}`]);
  return output;
}

/** Get current file content from disk. */
export function getCurrentFileContent(filePath: string): string {
  try {
    if (!existsSync(filePath)) return '';
    const buffer = readFileSync(filePath);

    // Try multiple encodings
    for (const encoding of ['utf-8', 'gbk', 'latin-1']) {
      try {
        return buffer.toString(encoding as BufferEncoding);
      } catch {
        continue;
      }
    }
    return buffer.toString('utf-8');
  } catch {
    return '';
  }
}

// ── Diff calculation (ported from Python difflib) ───────────────────

/** LCS-based SequenceMatcher for diff calculation. */
function sequenceMatcher(
  oldLines: string[],
  newLines: string[],
): Array<{ tag: 'equal' | 'delete' | 'insert' | 'replace'; i1: number; i2: number; j1: number; j2: number }> {
  // Simple LCS-based diff
  const m = oldLines.length;
  const n = newLines.length;

  // Build LCS table
  const lcs: number[][] = Array(m + 1)
    .fill(null)
    .map(() => Array(n + 1).fill(0));

  for (let i = m - 1; i >= 0; i--) {
    for (let j = n - 1; j >= 0; j--) {
      if (oldLines[i] === newLines[j]) {
        lcs[i][j] = lcs[i + 1][j + 1] + 1;
      } else {
        lcs[i][j] = Math.max(lcs[i + 1][j], lcs[i][j + 1]);
      }
    }
  }

  // Extract opcodes
  const opcodes: Array<{ tag: 'equal' | 'delete' | 'insert' | 'replace'; i1: number; i2: number; j1: number; j2: number }> = [];
  let i = 0;
  let j = 0;

  while (i < m || j < n) {
    if (i < m && j < n && oldLines[i] === newLines[j]) {
      // Equal block
      const start = i;
      while (i < m && j < n && oldLines[i] === newLines[j]) {
        i++;
        j++;
      }
      opcodes.push({ tag: 'equal', i1: start, i2: i, j1: start, j2: j });
    } else {
      // Find next equal point
      const startI = i;
      const startJ = j;

      // Look ahead for matching
      let nextI = i;
      let nextJ = j;
      let found = false;

      // Simple lookahead: try to find next match within 10 lines
      const lookahead = 10;
      for (let di = 0; di <= lookahead && i + di < m; di++) {
        for (let dj = 0; dj <= lookahead && j + dj < n; dj++) {
          if (di === 0 && dj === 0) continue;
          if (i + di < m && j + dj < n && oldLines[i + di] === newLines[j + dj]) {
            nextI = i + di;
            nextJ = j + dj;
            found = true;
            break;
          }
        }
        if (found) break;
      }

      if (found) {
        // Replace block
        opcodes.push({ tag: 'replace', i1: startI, i2: nextI, j1: startJ, j2: nextJ });
        i = nextI;
        j = nextJ;
      } else {
        // Delete or insert
        if (i < m) {
          opcodes.push({ tag: 'delete', i1: i, i2: i + 1, j1: j, j2: j });
          i++;
        } else if (j < n) {
          opcodes.push({ tag: 'insert', i1: i, i2: i, j1: j, j2: j + 1 });
          j++;
        }
      }
    }
  }

  // Merge adjacent same-type opcodes
  const merged: typeof opcodes = [];
  for (const op of opcodes) {
    const last = merged[merged.length - 1];
    if (last && last.tag === op.tag) {
      last.i2 = op.i2;
      last.j2 = op.j2;
    } else {
      merged.push({ ...op });
    }
  }

  return merged;
}

/** Calculate side-by-side diff. */
export function calculateDiff(
  oldContent: string,
  newContent: string,
): DiffResult {
  const oldLines = oldContent ? oldContent.split('\n') : [];
  const newLines = newContent ? newContent.split('\n') : [];

  const opcodes = sequenceMatcher(oldLines, newLines);
  const diffLines: DiffLine[] = [];
  const stats: DiffStats = {
    addedLines: 0,
    deletedLines: 0,
    modifiedLines: 0,
    contextLines: 0,
    totalChanges: 0,
  };

  let oldLineNo = 1;
  let newLineNo = 1;

  for (const op of opcodes) {
    if (op.tag === 'equal') {
      for (let i = op.i1; i < op.i2; i++) {
        diffLines.push({
          lineType: 'context',
          oldLineNo,
          newLineNo,
          content: oldLines[i],
        });
        oldLineNo++;
        newLineNo++;
        stats.contextLines++;
      }
    } else if (op.tag === 'delete') {
      for (let i = op.i1; i < op.i2; i++) {
        diffLines.push({
          lineType: 'delete',
          oldLineNo,
          newLineNo: null,
          content: oldLines[i],
        });
        oldLineNo++;
        stats.deletedLines++;
      }
    } else if (op.tag === 'insert') {
      for (let j = op.j1; j < op.j2; j++) {
        diffLines.push({
          lineType: 'add',
          oldLineNo: null,
          newLineNo,
          content: newLines[j],
        });
        newLineNo++;
        stats.addedLines++;
      }
    } else if (op.tag === 'replace') {
      for (let i = op.i1; i < op.i2; i++) {
        diffLines.push({
          lineType: 'delete',
          oldLineNo,
          newLineNo: null,
          content: oldLines[i],
        });
        oldLineNo++;
        stats.deletedLines++;
      }
      for (let j = op.j1; j < op.j2; j++) {
        diffLines.push({
          lineType: 'add',
          oldLineNo: null,
          newLineNo,
          content: newLines[j],
        });
        newLineNo++;
        stats.addedLines++;
      }
    }
  }

  stats.totalChanges = stats.addedLines + stats.deletedLines + stats.modifiedLines;

  // Build hunks
  const contextLines = 3;
  const hunks: DiffResult['hunks'] = [];

  for (const op of opcodes) {
    if (op.tag === 'equal') continue;

    const oldStart = Math.max(0, op.i1 - contextLines);
    const oldEnd = Math.min(oldLines.length, op.i2 + contextLines);
    const newStart = Math.max(0, op.j1 - contextLines);
    const newEnd = Math.min(newLines.length, op.j2 + contextLines);

    const hunkLines: DiffLine[] = [];

    // Pre-context
    for (let i = oldStart; i < op.i1; i++) {
      hunkLines.push({
        lineType: 'context',
        oldLineNo: i + 1,
        newLineNo: newStart + (i - oldStart) + 1,
        content: oldLines[i],
      });
    }

    // Changes
    if (op.tag === 'delete') {
      for (let i = op.i1; i < op.i2; i++) {
        hunkLines.push({
          lineType: 'delete',
          oldLineNo: i + 1,
          newLineNo: null,
          content: oldLines[i],
        });
      }
    } else if (op.tag === 'insert') {
      for (let j = op.j1; j < op.j2; j++) {
        hunkLines.push({
          lineType: 'add',
          oldLineNo: null,
          newLineNo: j + 1,
          content: newLines[j],
        });
      }
    } else if (op.tag === 'replace') {
      for (let i = op.i1; i < op.i2; i++) {
        hunkLines.push({
          lineType: 'delete',
          oldLineNo: i + 1,
          newLineNo: null,
          content: oldLines[i],
        });
      }
      for (let j = op.j1; j < op.j2; j++) {
        hunkLines.push({
          lineType: 'add',
          oldLineNo: null,
          newLineNo: j + 1,
          content: newLines[j],
        });
      }
    }

    // Post-context
    for (let i = op.i2; i < oldEnd; i++) {
      hunkLines.push({
        lineType: 'context',
        oldLineNo: i + 1,
        newLineNo: newEnd - (oldEnd - i) + 1,
        content: oldLines[i],
      });
    }

    hunks.push({
      oldStart: oldStart + 1,
      oldCount: oldEnd - oldStart,
      newStart: newStart + 1,
      newCount: newEnd - newStart,
      lines: hunkLines,
    });
  }

  return { diffLines, stats, hunks };
}
