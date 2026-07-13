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

    await this.runGit(projectRoot, ['add', '-A', ...PROJECT_SOURCE_PATHSPEC]);
    const commit = await this.runGit(projectRoot, ['commit', '-m', cleanMessage]);
    const hash = await this.runGit(projectRoot, ['rev-parse', '--short', 'HEAD']);

    return {
      commitHash: hash.stdout.trim(),
      summary: commit.stdout.trim(),
    };
  }

  async generateCommitMessage(projectRoot: string, credential: AiCredential, modelId?: string): Promise<string> {
    const status = await this.getStatus(projectRoot);
    if (!status.isRepository) {
      throw new Error('Project root is not a Git repository');
    }
    if (status.files.length === 0) {
      throw new Error('No changes to summarize');
    }

    const model = modelId ?? await this.resolveModel(credential);
    const diffContext = await this.buildDiffContext(projectRoot);
    const url = this.chatCompletionsUrl(credential.baseUrl);
    const response = await this.fetchFn(url, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${credential.apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model,
        temperature: 0.2,
        max_tokens: 80,
        messages: [
          {
            role: 'system',
            content: 'You write concise Git commit messages. Return only one single-line commit message, no quotes, no markdown.',
          },
          {
            role: 'user',
            content: `Write a commit message for these changes:\n\n${diffContext}`,
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
    return sanitizeCommitMessage(message).split('\n')[0].trim();
  }

  private async buildDiffContext(projectRoot: string): Promise<string> {
    const parts: string[] = [];
    const commands: Array<[string, string[]]> = [
      ['Status', ['status', '--short', ...PROJECT_SOURCE_PATHSPEC]],
      ['Staged names', ['diff', '--cached', '--name-status', ...PROJECT_SOURCE_PATHSPEC]],
      ['Unstaged names', ['diff', '--name-status', ...PROJECT_SOURCE_PATHSPEC]],
      ['Untracked names', ['ls-files', '--others', '--exclude-standard', ...PROJECT_SOURCE_PATHSPEC]],
      ['Diff stat', ['diff', '--stat', ...PROJECT_SOURCE_PATHSPEC]],
      ['Staged diff stat', ['diff', '--cached', '--stat', ...PROJECT_SOURCE_PATHSPEC]],
      ['Patch sample', ['diff', '--unified=3', ...PROJECT_SOURCE_PATHSPEC]],
      ['Staged patch sample', ['diff', '--cached', '--unified=3', ...PROJECT_SOURCE_PATHSPEC]],
    ];

    for (const [label, args] of commands) {
      try {
        const result = await this.runGit(projectRoot, args);
        const text = result.stdout.trim();
        if (text) parts.push(`## ${label}\n${text}`);
      } catch {
        // Some diff commands legitimately return nothing for a change class.
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
