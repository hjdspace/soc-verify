import { execFile } from 'node:child_process';

export type SourceControlFileStatus = {
  path: string;
  originalPath?: string;
  indexStatus: string;
  workTreeStatus: string;
  staged: boolean;
  unstaged: boolean;
};

export type SourceControlStatus = {
  isRepository: boolean;
  branch: string | null;
  ahead: number;
  behind: number;
  files: SourceControlFileStatus[];
};

export type SourceControlCommitResult = {
  commitHash: string;
  summary: string;
};

export type AiCredential = {
  providerId: string;
  apiKey: string;
  baseUrl?: string;
};

type ExecFileFn = (
  file: string,
  args: string[],
  options: { cwd?: string },
  callback: (error: Error | null, stdout: string, stderr: string) => void,
) => void;

type SourceControlServiceOptions = {
  execFileFn?: ExecFileFn;
  fetchFn?: typeof fetch;
};

type GitResult = {
  stdout: string;
  stderr: string;
};

const MAX_DIFF_CHARS = 12000;
const PROJECT_SOURCE_PATHSPEC = ['--', '.', ':(exclude).socverify'];
const IGNORED_PREFIX = '.socverify';

/**
 * Filter out files that live under an ignored directory (e.g. `.socverify`).
 * This is a safety net on top of the git pathspec exclude — if the pathspec
 * fails to filter (e.g. git version differences, Windows quirks) the files
 * will still be stripped here so the UI never offers to stage them.
 */
function isIgnoredPath(path: string): boolean {
  return path === IGNORED_PREFIX || path.startsWith(`${IGNORED_PREFIX}/`);
}

export function parseGitStatus(output: string): SourceControlStatus {
  const records = output.split('\0').filter((record) => record.length > 0);
  let branch: string | null = null;
  let ahead = 0;
  let behind = 0;
  const files: SourceControlFileStatus[] = [];

  for (let i = 0; i < records.length; i += 1) {
    const record = records[i];
    if (record.startsWith('## ')) {
      const branchLine = record.slice(3);
      branch = branchLine.split('...')[0].trim() || null;
      const aheadMatch = branchLine.match(/ahead (\d+)/);
      const behindMatch = branchLine.match(/behind (\d+)/);
      ahead = aheadMatch ? Number(aheadMatch[1]) : 0;
      behind = behindMatch ? Number(behindMatch[1]) : 0;
      continue;
    }

    const indexStatus = record[0] ?? ' ';
    const workTreeStatus = record[1] ?? ' ';
    const path = record.slice(3);
    let originalPath: string | undefined;
    if (indexStatus === 'R' || indexStatus === 'C' || workTreeStatus === 'R' || workTreeStatus === 'C') {
      originalPath = records[i + 1];
      i += 1;
    }

    if (isIgnoredPath(path)) continue;

    files.push({
      path,
      originalPath,
      indexStatus,
      workTreeStatus,
      staged: indexStatus !== ' ' && indexStatus !== '?',
      unstaged: workTreeStatus !== ' ',
    });
  }

  return { isRepository: true, branch, ahead, behind, files };
}

export function sanitizeCommitMessage(message: string): string {
  return message
    .trim()
    .replace(/^```(?:text)?/i, '')
    .replace(/```$/i, '')
    .trim()
    .replace(/^["']|["']$/g, '')
    .trim();
}

export class SourceControlService {
  private execFileFn: ExecFileFn;
  private fetchFn: typeof fetch;

  constructor(options: SourceControlServiceOptions = {}) {
    this.execFileFn = options.execFileFn ?? execFile;
    this.fetchFn = options.fetchFn ?? fetch;
  }

  async getStatus(projectRoot: string): Promise<SourceControlStatus> {
    try {
      const result = await this.runGit(projectRoot, ['status', '--porcelain=v1', '-z', '--branch', ...PROJECT_SOURCE_PATHSPEC]);
      return parseGitStatus(result.stdout);
    } catch {
      return { isRepository: false, branch: null, ahead: 0, behind: 0, files: [] };
    }
  }

  /**
   * Stage specific files (git add).
   * If no filePaths are provided, stages all non-ignored changes.
   *
   * We intentionally avoid `git add -A` because the `:(exclude)` pathspec
   * does not reliably prevent git from encountering `.gitignore`'d paths
   * (e.g. `.socverify`) on all platforms / git versions, which causes a
   * non-zero exit code and an error message.  Instead, when "stage all" is
   * requested we read the already-filtered status list and stage each file
   * explicitly.
   */
  async stageFiles(projectRoot: string, filePaths: string[]): Promise<void> {
    if (filePaths.length === 0) {
      const status = await this.getStatus(projectRoot);
      const paths = status.files.map((f) => f.path).filter((p) => !isIgnoredPath(p));
      if (paths.length > 0) {
        await this.runGit(projectRoot, ['add', '--', ...paths]);
      }
    } else {
      // Filter out ignored paths (e.g. `.socverify`) to prevent git add errors
      const safePaths = filePaths.filter((p) => !isIgnoredPath(p));
      if (safePaths.length > 0) {
        await this.runGit(projectRoot, ['add', '--', ...safePaths]);
      }
    }
  }

  /**
   * Unstage specific files (git restore --staged).
   * If no filePaths are provided, unstages all staged changes.
   */
  async unstageFiles(projectRoot: string, filePaths: string[]): Promise<void> {
    if (filePaths.length === 0) {
      await this.runGit(projectRoot, ['reset', 'HEAD', '--', '.']);
    } else {
      await this.runGit(projectRoot, ['reset', 'HEAD', '--', ...filePaths]);
    }
  }

  /**
   * Discard working-tree changes for specific files.
   * For tracked files: git checkout -- <files>
   * For untracked files: git clean -f -- <files>
   */
  async discardChanges(projectRoot: string, filePaths: string[]): Promise<void> {
    if (filePaths.length === 0) return;

    const status = await this.getStatus(projectRoot);
    const tracked: string[] = [];
    const untracked: string[] = [];

    for (const filePath of filePaths) {
      const file = status.files.find((f) => f.path === filePath);
      if (file && file.indexStatus === '?' && file.workTreeStatus === '?') {
        untracked.push(filePath);
      } else {
        tracked.push(filePath);
      }
    }

    if (tracked.length > 0) {
      await this.runGit(projectRoot, ['checkout', '--', ...tracked]);
    }
    if (untracked.length > 0) {
      await this.runGit(projectRoot, ['clean', '-f', '--', ...untracked]);
    }
  }

  /**
   * Commit only the currently staged changes (no implicit git add -A).
   */
  async commit(projectRoot: string, message: string): Promise<SourceControlCommitResult> {
    const cleanMessage = sanitizeCommitMessage(message);
    if (!cleanMessage) {
      throw new Error('Commit message is required');
    }

    const status = await this.getStatus(projectRoot);
    if (!status.isRepository) {
      throw new Error('Project root is not a Git repository');
    }

    const hasStaged = status.files.some((f) => f.staged);
    if (!hasStaged) {
      throw new Error('No staged changes to commit');
    }

    const commit = await this.runGit(projectRoot, ['commit', '-m', cleanMessage]);
    const hash = await this.runGit(projectRoot, ['rev-parse', '--short', 'HEAD']);

    return {
      commitHash: hash.stdout.trim(),
      summary: commit.stdout.trim(),
    };
  }

  /**
   * Commit all changes (stage all then commit). Kept for backward compatibility.
   */
  async commitAll(projectRoot: string, message: string): Promise<SourceControlCommitResult> {
    const cleanMessage = sanitizeCommitMessage(message);
    if (!cleanMessage) {
      throw new Error('Commit message is required');
    }

    const status = await this.getStatus(projectRoot);
    if (!status.isRepository) {
      throw new Error('Project root is not a Git repository');
    }
    if (status.files.length === 0) {
      throw new Error('No changes to commit');
    }

    const paths = status.files.map((f) => f.path).filter((p) => !isIgnoredPath(p));
    if (paths.length > 0) {
      await this.runGit(projectRoot, ['add', '--', ...paths]);
    }
    const commit = await this.runGit(projectRoot, ['commit', '-m', cleanMessage]);
    const hash = await this.runGit(projectRoot, ['rev-parse', '--short', 'HEAD']);

    return {
      commitHash: hash.stdout.trim(),
      summary: commit.stdout.trim(),
    };
  }

  /**
   * Generate a commit message using AI based on **staged** changes only.
   * If nothing is staged, falls back to all changes.
   */
  async generateCommitMessage(projectRoot: string, credential: AiCredential, modelId?: string): Promise<string> {
    const status = await this.getStatus(projectRoot);
    if (!status.isRepository) {
      throw new Error('Project root is not a Git repository');
    }

    const hasStaged = status.files.some((f) => f.staged);
    const hasChanges = status.files.length > 0;
    if (!hasChanges) {
      throw new Error('No changes to summarize');
    }

    // Prefer staged diff; fall back to all changes if nothing is staged.
    const useStagedOnly = hasStaged;

    const model = modelId ?? await this.resolveModel(credential);
    const diffContext = await this.buildStagedDiffContext(projectRoot, useStagedOnly);
    const url = this.chatCompletionsUrl(credential.baseUrl);
    const response = await this.fetchFn(url, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${credential.apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model,
        temperature: 0.3,
        max_tokens: 500,
        messages: [
          {
            role: 'system',
            content: [
              '你是一位资深的软件工程师，擅长编写清晰、规范的 Git 提交信息。',
              '遵循 Conventional Commits 规范：<type>(<可选 scope>): <简述>',
              '',
              'Type 必须是以下之一：feat, fix, docs, style, refactor, perf, test, chore, build, ci',
              '',
              '规则：',
              '- 提交信息必须全部用中文撰写（type 和 scope 保持英文）。',
              '- 标题行简洁明了地描述本次变更，不超过 72 个字符。',
              '- 标题行之后必须空一行，然后写 body 正文。',
              '- body 正文必须详细说明 *改了什么* 以及 *为什么改*，不要只是重复 diff 内容。',
              '- body 正文使用中文，可以使用无序列表（- 开头）分条列举要点。',
              '- 只返回提交信息文本，不要加引号、markdown 代码块标记或任何前言。',
            ].join('\n'),
          },
          {
            role: 'user',
            content: [
              `分析以下${useStagedOnly ? '已暂存' : '所有'}变更，并生成符合 Conventional Commits 规范的中文提交信息（包含标题和 body 正文）。\n`,
              diffContext,
            ].join('\n'),
          },
        ],
      }),
    });

    if (!response.ok) {
      const details = (await response.text()).slice(0, 300);
      throw new Error(`AI request failed (${response.status}): ${details}`);
    }

    const payload = await response.json() as Record<string, unknown>;
    const message = this.extractMessage(payload);
    if (!message) {
      throw new Error('AI response did not include a commit message');
    }
    return sanitizeCommitMessage(message);
  }

  /**
   * Build a diff context focused on staged changes.
   * When `stagedOnly` is true, only includes `git diff --cached` output.
   * When false (nothing staged), includes both staged and unstaged diffs.
   */
  private async buildStagedDiffContext(projectRoot: string, stagedOnly: boolean): Promise<string> {
    const parts: string[] = [];

    // Include status context — when stagedOnly, use cached name-status to avoid
    // leaking unstaged file names into the AI prompt.
    if (stagedOnly) {
      try {
        const stagedNames = await this.runGit(projectRoot, ['diff', '--cached', '--name-status', ...PROJECT_SOURCE_PATHSPEC]);
        const text = stagedNames.stdout.trim();
        if (text) parts.push(`## Staged Files\n${text}`);
      } catch {
        // ignore
      }
    } else {
      try {
        const statusResult = await this.runGit(projectRoot, ['status', '--short', ...PROJECT_SOURCE_PATHSPEC]);
        const statusText = statusResult.stdout.trim();
        if (statusText) parts.push(`## Git Status\n${statusText}`);
      } catch {
        // ignore
      }
    }

    // Staged diff (name-status + stat + patch)
    const stagedCommands: Array<[string, string[]]> = [
      ['Staged Changes (name-status)', ['diff', '--cached', '--name-status', ...PROJECT_SOURCE_PATHSPEC]],
      ['Staged Diff Stat', ['diff', '--cached', '--stat', ...PROJECT_SOURCE_PATHSPEC]],
      ['Staged Patch', ['diff', '--cached', '--unified=3', ...PROJECT_SOURCE_PATHSPEC]],
    ];

    for (const [label, args] of stagedCommands) {
      try {
        const result = await this.runGit(projectRoot, args);
        const text = result.stdout.trim();
        if (text) parts.push(`## ${label}\n${text}`);
      } catch {
        // no staged changes — skip
      }
    }

    // When nothing is staged, also include unstaged diff for context
    if (!stagedOnly) {
      const unstagedCommands: Array<[string, string[]]> = [
        ['Unstaged Changes (name-status)', ['diff', '--name-status', ...PROJECT_SOURCE_PATHSPEC]],
        ['Unstaged Diff Stat', ['diff', '--stat', ...PROJECT_SOURCE_PATHSPEC]],
        ['Unstaged Patch', ['diff', '--unified=3', ...PROJECT_SOURCE_PATHSPEC]],
      ];

      for (const [label, args] of unstagedCommands) {
        try {
          const result = await this.runGit(projectRoot, args);
          const text = result.stdout.trim();
          if (text) parts.push(`## ${label}\n${text}`);
        } catch {
          // ignore
        }
      }
    }

    const context = parts.join('\n\n');
    return context.length > MAX_DIFF_CHARS
      ? `${context.slice(0, MAX_DIFF_CHARS)}\n\n[diff truncated]`
      : context;
  }

  private async resolveModel(credential: AiCredential): Promise<string> {
    const response = await this.fetchFn(this.modelsUrl(credential.baseUrl), {
      headers: { Authorization: `Bearer ${credential.apiKey}` },
    });
    if (!response.ok) {
      const details = (await response.text()).slice(0, 300);
      throw new Error(`Failed to fetch AI models (${response.status}): ${details}`);
    }

    const payload = await response.json() as Record<string, unknown>;
    const models = Array.isArray(payload.data) ? payload.data : [];
    for (const item of models) {
      if (typeof item === 'object' && item !== null) {
        const id = (item as Record<string, unknown>).id;
        if (typeof id === 'string' && id) return id;
      }
    }
    throw new Error('No AI model available for commit message generation');
  }

  private extractMessage(payload: Record<string, unknown>): string | null {
    const choices = payload.choices;
    if (!Array.isArray(choices) || choices.length === 0) return null;
    const first = choices[0];
    if (typeof first !== 'object' || first === null) return null;
    const message = (first as Record<string, unknown>).message;
    if (typeof message !== 'object' || message === null) return null;
    const content = (message as Record<string, unknown>).content;
    return typeof content === 'string' ? content : null;
  }

  private modelsUrl(baseUrl?: string): string {
    const base = this.normalizeBaseUrl(baseUrl);
    return base.endsWith('/v1') ? `${base}/models` : `${base}/v1/models`;
  }

  private chatCompletionsUrl(baseUrl?: string): string {
    const base = this.normalizeBaseUrl(baseUrl);
    return base.endsWith('/v1') ? `${base}/chat/completions` : `${base}/v1/chat/completions`;
  }

  private normalizeBaseUrl(baseUrl?: string): string {
    return (baseUrl?.trim() || 'https://api.openai.com').replace(/\/+$/, '');
  }

  private runGit(cwd: string, args: string[]): Promise<GitResult> {
    return new Promise((resolve, reject) => {
      this.execFileFn('git', ['-C', cwd, ...args], { cwd }, (error, stdout, stderr) => {
        if (error) {
          reject(new Error(stderr.trim() || error.message));
          return;
        }
        resolve({ stdout, stderr });
      });
    });
  }
}

export const sourceControlService = new SourceControlService();
