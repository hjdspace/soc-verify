import { execFile } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { buildDirectChatRequest, ensureV1Prefix, extractOpenAiFamilyContent } from '../agent/openai-compatible';
import type { OpenAiApiFormat, ScmFileDiff } from '@shared/types';
import { buildUntrackedFileDiff, parseUnifiedDiff } from './scm-diff';

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
  /**
   * 状态获取失败/降级原因（如 dubious ownership、git 不可用、stdout 超限）。
   * 仅在 isRepository 为 false 时由 getStatus 填充，供 UI 展示诊断信息。
   */
  notice?: string;
};

export type SourceControlCommitResult = {
  commitHash: string;
  summary: string;
};

export type AiCredential = {
  providerId: string;
  apiKey: string;
  baseUrl?: string;
  /** OpenAI 兼容端点的 API wire 格式，缺省 openai-completions。 */
  api?: OpenAiApiFormat;
};

type ExecFileError = Error & { code?: string | number };

export type ExecFileFn = (
  file: string,
  args: string[],
  options: { cwd?: string; maxBuffer?: number },
  callback: (error: ExecFileError | null, stdout: string, stderr: string) => void,
) => void;

type SourceControlServiceOptions = {
  execFileFn?: ExecFileFn;
  fetchFn?: typeof fetch;
};

type GitResult = {
  stdout: string;
  stderr: string;
};

const MAX_DIFF_CHARS = 16000;
const MAX_RECENT_COMMITS = 10;
const COMMIT_TYPE_PATTERN = '(?:feat|fix|docs|style|refactor|perf|test|chore|build|ci)';
const COMMIT_TITLE_RE = new RegExp(
  COMMIT_TYPE_PATTERN + '(?:\\([^)\\r\\n]+\\))?\\s*:\\s*[^\\r\\n`"“”‘’「」]+',
  'g',
);
const PROJECT_SOURCE_PATHSPEC = ['--', '.', ':(exclude).socverify'];
const IGNORED_PREFIX = '.socverify';
/**
 * execFile 默认 maxBuffer 仅 1MB。Linux 端 EDA 工程树常含海量未跟踪文件
 * （仿真产物等），`git status --untracked-files=all` 会逐个列出导致输出超限，
 * 整个 status 命令因此失败。提升到 64MB 以容纳超大仓库的状态输出。
 */
const GIT_MAX_BUFFER = 64 * 1024 * 1024;
/** Linux 桌面环境（如 .desktop 启动器）PATH 可能被精简，找不到 git 时的回退路径。 */
const LINUX_FALLBACK_GIT = ['/usr/bin/git', '/usr/local/bin/git'];

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
  let result = message.replace(/\r\n/g, '\n').trim();

  // Prefer an explicitly delimited final answer when a thinking model emits
  // analysis before or after the commit message.
  const taggedMessage = result.match(/<commit-message>\s*([\s\S]*?)\s*<\/commit-message>/i);
  if (taggedMessage) result = taggedMessage[1].trim();

  // Strip markdown code fences (```text ... ``` or ``` ... ```)
  result = result.replace(/^```[a-zA-Z]*\n?/m, '').replace(/\n?```$/m, '');
  result = result.trim();

  // Strip wrapping quotes
  result = result.replace(/^["']+|["']+$/g, '').trim();

  // Models sometimes include several candidate titles in their reasoning.
  // Prefer a title at the start of a line (the normal format); otherwise use
  // the last inline candidate, which is usually the model's final choice.
  const lines = result.split('\n');
  const candidates: Array<{ title: string; lineIndex: number; lineStart: boolean }> = [];
  lines.forEach((line, lineIndex) => {
    for (const match of line.matchAll(COMMIT_TITLE_RE)) {
      const prefix = line.slice(0, match.index ?? 0).trim();
      const lineStart = prefix === '' || /^[-*]\s+$/.test(line.slice(0, match.index ?? 0))
        || /^\d+[.)]\s+$/.test(line.slice(0, match.index ?? 0));
      candidates.push({ title: cleanCommitTitle(match[0]), lineIndex, lineStart });
    }
  });

  const lineCandidate = [...candidates].reverse().find((candidate) => candidate.lineStart);
  const selected = lineCandidate ?? candidates[candidates.length - 1];
  if (selected?.title) {
    const titleLine = selected.title;

    // Inline candidates are embedded in prose; keep only the title. For a
    // normal line-start title, preserve valid list-style body lines below it.
    if (!selected.lineStart) return titleLine;

    const afterTitle = lines.slice(selected.lineIndex + 1).join('\n');

    // Collect body lines after the required title/body separator. Models may
    // return a normal paragraph instead of a Markdown list, so accept both
    // forms while stopping at common reasoning prose.
    const bodyLines: string[] = [];
    let seenBody = false;
    let separatorSeen = false;
    for (const line of afterTitle.split('\n')) {
      const trimmed = line.trim();
      if (trimmed === '') {
        if (seenBody) bodyLines.push('');
        else separatorSeen = true;
        continue;
      }
      const isListItem = /^[-*+]\s+/.test(trimmed) || /^\d+[.)]\s+/.test(trimmed);
      if (isListItem || (separatorSeen && !isLikelyReasoningLine(trimmed))) {
        seenBody = true;
        bodyLines.push(line);
        continue;
      }
      break;
    }

    // Trim trailing blank lines from body
    while (bodyLines.length > 0 && bodyLines[bodyLines.length - 1] === '') {
      bodyLines.pop();
    }

    return bodyLines.length > 0
      ? `${titleLine}\n\n${bodyLines.join('\n')}`
      : titleLine;
  }

  return result;
}

function cleanCommitTitle(title: string): string {
  return title
    .trim()
    .replace(/^[-*]\s+|^\d+[.)]\s+/, '')
    .replace(/[\s`"'“”‘’「」]+$/g, '')
    .replace(/[。．.!！?？；;，,、]+$/g, '')
    .trim();
}

function isLikelyReasoningLine(line: string): boolean {
  return /^(?:我们需要|需要先|让我们|首先|其次|然后|也许|可以考虑|考虑到|因此|所以|可能|但(?:[，,：:「"“\s]|$)|或者|我认为|应该|不妨|按照要求|题目|分析|总结|we need|let's|maybe|consider|therefore)/iu.test(line);
}

function isCommitMessageTitle(message: string): boolean {
  return new RegExp(`^${COMMIT_TYPE_PATTERN}(?:\\([^)]+\\))?\\s*:\\s*\\S+`).test(message.trim());
}

function hasCommitMessageBody(message: string): boolean {
  return message.split('\n').slice(1).some((line) => line.trim().length > 0);
}

export class SourceControlService {
  private execFileFn: ExecFileFn;
  private fetchFn: typeof fetch;
  /** 非 PATH 解析出的 git 二进制回退路径缓存（Linux PATH 精简时命中）。 */
  private gitBinary: string | null = null;

  constructor(options: SourceControlServiceOptions = {}) {
    this.execFileFn = options.execFileFn ?? execFile;
    this.fetchFn = options.fetchFn ?? fetch;
  }

  /**
   * 获取 git 状态。
   *
   * @param options.maxAgeMs 允许复用的缓存最大时长（毫秒）。默认 0 = 总是实时执行。
   *   git status 在 Linux 端大工程树上可能耗时数秒~十几秒，挂载类调用
   *   （文件树/面板重复挂载）应传入 maxAgeMs 复用近期结果；
   *   watcher 触发的刷新与 stage/commit 后的刷新必须保持默认 0（实时）。
   */
  async getStatus(projectRoot: string, options: { maxAgeMs?: number } = {}): Promise<SourceControlStatus> {
    const maxAgeMs = options.maxAgeMs ?? 0;
    if (maxAgeMs > 0) {
      const cached = this.statusCache.get(projectRoot);
      if (cached && Date.now() - cached.cachedAt <= maxAgeMs) {
        return cached.status;
      }
    }
    const status = await this.computeStatus(projectRoot);
    if (maxAgeMs > 0) {
      this.statusCache.set(projectRoot, { status, cachedAt: Date.now() });
    }
    return status;
  }

  private async computeStatus(projectRoot: string): Promise<SourceControlStatus> {
    try {
      const result = await this.runGitStatus(projectRoot, true);
      return parseGitStatus(result.stdout);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      console.warn(`[scm] git status failed for "${projectRoot}": ${message}`);
      return this.recoverFromStatusFailure(projectRoot, message);
    }
  }

  /** 状态缓存：key = 项目根路径。仅 maxAgeMs > 0 的调用读写。 */
  private statusCache = new Map<string, { status: SourceControlStatus; cachedAt: number }>();

  /**
   * git status 失败后的恢复策略，按 Linux 端已知失败模式逐一尝试：
   * 1. 老版本 git（<1.9，如 CentOS 7 自带 1.8.3.1）不支持 `:(exclude)`
   *    pathspec magic —— 去掉 exclude 重试（.socverify 已由 .gitignore 兜底）。
   * 2. git ≥2.35.2 的 "dubious ownership"（共享服务器/代理 view 下仓库属主
   *    与运行用户不同）—— 幂等地将仓库目录加入全局 safe.directory 后重试。
   * 全部失败则返回 isRepository:false + notice（供 UI 展示原因）。
   */
  private async recoverFromStatusFailure(projectRoot: string, message: string): Promise<SourceControlStatus> {
    const emptyStatus = (notice?: string): SourceControlStatus => ({
      isRepository: false,
      branch: null,
      ahead: 0,
      behind: 0,
      files: [],
      ...(notice ? { notice } : {}),
    });

    if (/pathspec magic/i.test(message)) {
      try {
        const result = await this.execGit(
          ['-C', projectRoot, 'status', '--porcelain=v1', '-z', '--untracked-files=all', '--branch', '--', '.'],
          { cwd: projectRoot },
        );
        console.warn('[scm] git status recovered without :(exclude) pathspec (legacy git)');
        return parseGitStatus(result.stdout);
      } catch (retryErr) {
        console.warn('[scm] git status retry without :(exclude) pathspec failed:', retryErr);
      }
    }

    const ownershipMatch = message.match(/dubious ownership in repository at '(.+?)'/);
    if (ownershipMatch) {
      const repoPath = ownershipMatch[1];
      const added = await this.ensureSafeDirectory(repoPath);
      if (added) {
        try {
          const result = await this.runGitStatus(projectRoot, true);
          console.warn(`[scm] added "${repoPath}" to git global safe.directory; status retry succeeded`);
          return parseGitStatus(result.stdout);
        } catch (retryErr) {
          console.warn('[scm] git status retry after safe.directory fix failed:', retryErr);
        }
      }
      return emptyStatus(message);
    }

    return emptyStatus(message);
  }

  /**
   * 幂等地确保仓库目录在全局 safe.directory 白名单中（dubious ownership 修复）。
   * 返回 true 表示路径已在白名单或添加成功（值得重试 status）；仅添加失败返回 false。
   * 仅影响本桌面应用的运行用户全局 git 配置，属低风险白名单标记。
   */
  private async ensureSafeDirectory(repoPath: string): Promise<boolean> {
    try {
      const existing = await this.execGit(['config', '--global', '--get-all', 'safe.directory'], {});
      if (existing.stdout.split('\n').some((line) => line.trim() === repoPath)) return true;
    } catch {
      // safe.directory key 尚不存在（get-all 非零退出）——继续添加
    }
    try {
      await this.execGit(['config', '--global', '--add', 'safe.directory', repoPath], {});
      return true;
    } catch (err) {
      console.warn(`[scm] failed to add safe.directory for "${repoPath}":`, err);
      return false;
    }
  }

  private runGitStatus(projectRoot: string, withExclude: boolean): Promise<GitResult> {
    const pathspec = withExclude ? PROJECT_SOURCE_PATHSPEC : ['--', '.'];
    return this.execGit(
      // --no-optional-locks：status 不写 index（untracked cache 等），
      // 避免与用户终端里的 git 争抢 index.lock 导致互相阻塞（VS Code 同款做法）。
      ['-C', projectRoot, '--no-optional-locks', 'status', '--porcelain=v1', '-z', '--untracked-files=all', '--branch', ...pathspec],
      { cwd: projectRoot },
    );
  }

  /**
   * 单文件范围化的状态查询：仅对 filePath 执行 status（不做全树扫描）。
   * 全树 status 在大工程树上可能耗时数秒~十几秒，而展开文件 diff 只需要
   * 判断该文件是否 untracked——范围化查询耗时与之无关。
   */
  private async isUntrackedFile(projectRoot: string, filePath: string): Promise<boolean> {
    try {
      const result = await this.execGit(
        ['-C', projectRoot, '--no-optional-locks', 'status', '--porcelain=v1', '-z', '--untracked-files=all', '--', filePath],
        { cwd: projectRoot },
      );
      const record = result.stdout.split('\0').find((r) => r.length > 3 && r.slice(3) === filePath);
      return record?.startsWith('??') ?? false;
    } catch (err) {
      console.warn(`[scm] scoped git status failed for "${filePath}":`, err);
      return false;
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
   * Get the structured diff of a single file for manual review.
   *
   * - staged:   HEAD vs index (`git diff --cached`)
   * - unstaged: index vs worktree (`git diff`)
   * - untracked files have no git diff output — the whole file is shown
   *   as additions read from disk.
   */
  async getFileDiff(projectRoot: string, filePath: string, options: { staged: boolean }): Promise<ScmFileDiff> {
    if (options.staged) {
      const result = await this.runGit(projectRoot, ['diff', '--cached', '--unified=3', '--no-ext-diff', '--', filePath]);
      return parseUnifiedDiff(result.stdout, { path: filePath, staged: true });
    }

    const isUntracked = await this.isUntrackedFile(projectRoot, filePath);
    if (isUntracked) {
      let content = '';
      try {
        content = await readFile(join(projectRoot, filePath), 'utf-8');
      } catch {
        // 文件读取失败（权限等）——按空文件展示
      }
      return buildUntrackedFileDiff(filePath, content);
    }

    const result = await this.runGit(projectRoot, ['diff', '--unified=3', '--no-ext-diff', '--', filePath]);
    return parseUnifiedDiff(result.stdout, { path: filePath, staged: false });
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
   *
   * The method tolerates a wide variety of OpenAI-compatible response shapes
   * (string content, array content, reasoning_content, delta, etc.) and will
   * retry once with a stricter prompt if the first attempt yields no usable
   * text.
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

    // Gather diff context, recent commit messages (for style reference),
    // and a high-level file change summary — in parallel for lower latency.
    const [diffContext, recentCommits, fileSummary] = await Promise.all([
      this.buildStagedDiffContext(projectRoot, useStagedOnly),
      this.getRecentCommitSubjects(projectRoot, MAX_RECENT_COMMITS),
      this.buildFileSummary(status, useStagedOnly),
    ]);

    const systemPrompt = [
      '资深发布工程师，擅长编写精准、规范的 Git 提交信息。',
      '',
      '## 格式',
      '遵循 Conventional Commits：`<type>(<scope>): <简述>`',
      'Type: feat | fix | refactor | perf | docs | test | build | ci | chore | style',
      '全部用中文撰写（type 和 scope 保持英文）。',
      '',
      '## 标题行',
      '- 以中文动词开头，描述具体行为（如"添加""修复""重构""移除"）',
      '- 不超过 72 个字符，末尾不加句号',
      '- 标题后必须空一行，并写至少 1 条 body；禁止只输出标题',
      '',
      '## Scope 判定',
      '- 60% 以上行变更集中在同一模块/组件时才加 scope，否则省略',
      '- scope 用小写英文，限 1-2 段，只用字母/数字/连字符',
      '- 禁用泛化 scope：src, lib, tests, project, app, main, all, misc',
      '',
      '## Body 正文',
      '- 必须输出 1-6 条，每条以 `-` 开头，每条不超过 120 个字符',
      '- 每条以动词开头，说明做了什么 + 为什么（不重复 diff 字面内容）',
      '- 优先级：用户可见行为 → 性能/安全 → 架构 → 内部实现',
      '- 排除琐碎项：import 顺序、空白、格式化、纯重命名、注释微调',
      '- 3 条以上同类变更合并：如"更新 5 个测试文件以适配新接口"',
      '',
      '## 禁止',
      '- 禁用填充词：全面的、各种、若干、改进的、增强的、更好的、简单地、基本上',
      '- 禁用元描述：本次提交、本次变更、修改了代码、更新了文件',
      '- 你可以在内部分析，但禁止输出思考过程、备选方案或理由推导',
      '- 禁止输出前言（"以下是提交信息"）、解释、代码块标记、引号',
      '- 最终结果必须包在 `<commit-message>` 和 `</commit-message>` 中，标签外不要输出任何文字',
      '',
      '## 正面示例',
      'feat(auth): 添加令牌过期自动刷新',
      '',
      '- 新增 TokenRefreshGuard 防止并发刷新',
      '- 集成 429 重试中间件',
      '',
      '## 反面示例（不要这样写）',
      'feat: 全面的改进和增强 ← 使用了禁用词',
      'fix: 本次提交修复了空指针 ← 使用了元描述',
      'refactor: 各种重构 ← scope 和描述都太泛',
    ].join('\n');

    // Build user prompt sections — each part is optional so we don't
    // include empty headers that confuse the model.
    const userSections: string[] = [];

    if (recentCommits) {
      userSections.push(
        `## 最近提交记录（用于风格参考，不要复制内容）`,
        recentCommits,
      );
    }

    if (fileSummary) {
      userSections.push(
        `## 变更文件概览`,
        fileSummary,
      );
    }

    userSections.push(
      `## ${useStagedOnly ? '已暂存' : '所有'}变更 Diff`,
      diffContext,
    );

    const userPrompt = [
      `以下是${useStagedOnly ? '已暂存' : '所有'}变更，请生成包含标题和至少 1 条 body 的提交信息。不得只输出标题。`,
      '',
      ...userSections,
    ].join('\n');

    // 按凭证的 apiFormat 分派 /chat/completions 或 /responses；
    // ensureV1Prefix 保证请求落到 /v1/<endpoint>（用户 baseUrl 可能缺 /v1）。
    const request = buildDirectChatRequest({
      baseUrl: ensureV1Prefix(this.normalizeBaseUrl(credential.baseUrl)),
      apiFormat: credential.api,
      model,
      system: systemPrompt,
      user: userPrompt,
      maxTokens: 800,
      temperature: 0.2,
    });
    const url = request.url;

    const response = await this.fetchFn(url, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${credential.apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(request.body),
    });

    if (!response.ok) {
      const details = (await response.text()).slice(0, 300);
      throw this.classifyApiError(response.status, details);
    }

    const payload = await response.json() as Record<string, unknown>;
    const message = this.extractMessage(payload);

    let titleOnlyFallback: string | null = null;
    if (message) {
      const cleanMessage = sanitizeCommitMessage(message);
      if (isCommitMessageTitle(cleanMessage)) {
        if (hasCommitMessageBody(cleanMessage)) return cleanMessage;
        titleOnlyFallback = cleanMessage;
      }
    }

    // ── Retry once with an even stricter prompt ──────────────────────
    // Some models ignore the system prompt and wrap the answer in prose.
    // A second call with an explicit example usually recovers a usable message.
    const retryUserSections: string[] = [];

    if (recentCommits) {
      retryUserSections.push('## 最近提交记录', recentCommits);
    }
    if (fileSummary) {
      retryUserSections.push('## 变更文件概览', fileSummary);
    }
    retryUserSections.push(
      '## 变更 Diff',
      diffContext.slice(0, MAX_DIFF_CHARS),
    );

    const retryRequest = buildDirectChatRequest({
      baseUrl: ensureV1Prefix(this.normalizeBaseUrl(credential.baseUrl)),
      apiFormat: credential.api,
      model,
      system: [
        '只输出 Git 提交信息，不要包含任何其他文字。',
        '格式：<type>(<scope>): <简述>，空行后必须有至少 1 条以 - 开头的 body；不得只输出标题。',
        '禁用词：全面的、各种、若干、改进的、增强的、本次提交、本次变更',
        '最终结果必须包在 <commit-message> 和 </commit-message> 中，标签外不要输出任何文字。',
      ].join('\n'),
      user: [
        '根据以下变更生成包含标题和至少 1 条 body 的中文提交信息，不得只输出标题。',
        '',
        '示例：',
        'feat(auth): 添加令牌过期自动刷新',
        '',
        '- 新增 TokenRefreshGuard 防止并发刷新',
        '- 集成 429 重试中间件',
        '',
        ...retryUserSections,
      ].join('\n'),
      maxTokens: 800,
      temperature: 0.15,
    });

    const retryResponse = await this.fetchFn(retryRequest.url, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${credential.apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(retryRequest.body),
    });

    if (retryResponse.ok) {
      const retryPayload = await retryResponse.json() as Record<string, unknown>;
      const retryMessage = this.extractMessage(retryPayload);
      if (retryMessage) {
        const cleanMessage = sanitizeCommitMessage(retryMessage);
        if (isCommitMessageTitle(cleanMessage)) {
          if (hasCommitMessageBody(cleanMessage)) return cleanMessage;
          titleOnlyFallback ??= cleanMessage;
        }
      }
    }

    if (titleOnlyFallback) return titleOnlyFallback;
    throw new Error('AI response did not include a commit message');
  }

  /**
   * Fetch recent commit subjects for style reference.
   * Returns a newline-separated list of subjects, or an empty string if
   * the repository has no commits yet (or git log fails).
   */
  private async getRecentCommitSubjects(projectRoot: string, count: number): Promise<string> {
    try {
      const result = await this.runGit(projectRoot, [
        'log', `--max-count=${count}`, '--pretty=format:%s', '--no-color',
      ]);
      const text = result.stdout.trim();
      return text || '';
    } catch {
      // New repo with no commits yet, or git log failed — not critical
      return '';
    }
  }

  /**
   * Build a high-level file change summary from the status object.
   * This gives the AI a compact overview of what changed at the file level,
   * complementing the detailed diff below.
   *
   * When `stagedOnly` is true, only staged files are included.
   */
  private buildFileSummary(status: SourceControlStatus, stagedOnly: boolean): string {
    const files = stagedOnly
      ? status.files.filter((f) => f.staged)
      : status.files;

    if (files.length === 0) return '';

    const lines: string[] = [];
    for (const file of files) {
      const staged = file.staged ? '已暂存' : '未暂存';
      lines.push(`  ${file.indexStatus}${file.workTreeStatus} ${staged} ${file.path}`);
    }
    return lines.join('\n');
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

  /**
   * Classify HTTP error responses from the AI API into user-friendly
   * messages. Common error codes (401, 403, 429, 5xx) get specific hints;
   * everything else falls through to a generic message with the raw body.
   */
  private classifyApiError(status: number, details: string): Error {
    if (status === 401 || status === 403) {
      return new Error('AI 认证失败：API Key 无效或权限不足，请在设置中检查凭证配置。');
    }
    if (status === 429) {
      return new Error('AI 请求频率超限（429），请稍后重试或降低请求频率。');
    }
    if (status >= 500) {
      return new Error(`AI 服务端错误（${status}），请稍后重试。详情：${details.slice(0, 150)}`);
    }
    return new Error(`AI 请求失败（${status}）：${details.slice(0, 200)}`);
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

  /**
   * Extract a text message from an OpenAI-compatible chat completion
   * response, tolerating a wide variety of provider-specific shapes:
   *
   * 1. Standard:   choices[0].message.content  (string)
   * 2. Array:      choices[0].message.content  [{type:"text", text:"…"}]
   * 3. Reasoning:  choices[0].message.content === null, text in
   *                reasoning_content (DeepSeek-R1 etc.)
   * 4. Streaming:  choices[0].delta.content (string)
   * 5. Non-standard: payload.data[...] wrapper used by some gateways
   *
   * Returns the first non-empty text fragment, or null if nothing usable
   * was found.
   */
  private extractMessage(payload: Record<string, unknown>): string | null {
    // ── Helper: pull text from a "message" or "delta" object ─────────
    const extractFromObj = (obj: Record<string, unknown>): string | null => {
      // 1. content as string (most common)
      const content = obj.content;
      if (typeof content === 'string' && content.trim()) {
        return content;
      }
      // 2. content as array of content parts (OpenAI vision / some providers)
      if (Array.isArray(content)) {
        const texts: string[] = [];
        for (const part of content) {
          if (typeof part === 'object' && part !== null) {
            const text = (part as Record<string, unknown>).text;
            if (typeof text === 'string') texts.push(text);
          }
        }
        const joined = texts.join('').trim();
        if (joined) return joined;
      }
      // 3. reasoning_content fallback (DeepSeek-R1 / thinking models)
      const reasoning = obj.reasoning_content;
      if (typeof reasoning === 'string' && reasoning.trim()) {
        return reasoning;
      }
      return null;
    };

    // ── Standard: choices array ───────────────────────────────────────
    const choices = payload.choices;
    if (Array.isArray(choices) && choices.length > 0) {
      for (const choice of choices) {
        if (typeof choice !== 'object' || choice === null) continue;
        const choiceObj = choice as Record<string, unknown>;
        // message (non-streaming)
        const message = choiceObj.message;
        if (typeof message === 'object' && message !== null) {
          const text = extractFromObj(message as Record<string, unknown>);
          if (text) return text;
        }
        // delta (streaming-style payload returned as a single object)
        const delta = choiceObj.delta;
        if (typeof delta === 'object' && delta !== null) {
          const text = extractFromObj(delta as Record<string, unknown>);
          if (text) return text;
        }
      }
    }

    // ── Non-standard: some gateways wrap in payload.data ─────────────
    const data = payload.data;
    if (Array.isArray(data) && data.length > 0) {
      const first = data[0];
      if (typeof first === 'object' && first !== null) {
        // could be {content: ...} or {message: {content: ...}}
        const text = extractFromObj(first as Record<string, unknown>);
        if (text) return text;
        const message = (first as Record<string, unknown>).message;
        if (typeof message === 'object' && message !== null) {
          const innerText = extractFromObj(message as Record<string, unknown>);
          if (innerText) return innerText;
        }
      }
    }

    // ── Last resort: top-level content / text field ───────────────────
    const topContent = payload.content;
    if (typeof topContent === 'string' && topContent.trim()) {
      return topContent;
    }
    const topText = payload.text;
    if (typeof topText === 'string' && topText.trim()) {
      return topText;
    }

    // ── Responses API shapes (output_text / output[].message) ─────────
    return extractOpenAiFamilyContent(payload);
  }

  private modelsUrl(baseUrl?: string): string {
    const base = this.normalizeBaseUrl(baseUrl);
    return base.endsWith('/v1') ? `${base}/models` : `${base}/v1/models`;
  }

  private normalizeBaseUrl(baseUrl?: string): string {
    return (baseUrl?.trim() || 'https://api.openai.com').replace(/\/+$/, '');
  }

  /**
   * 执行 git 命令（业务入口）。始终携带放大的 maxBuffer；
   * Linux 端 PATH 精简找不到 git 时自动回退常见安装路径并缓存。
   */
  private runGit(cwd: string, args: string[]): Promise<GitResult> {
    return this.execGit(['-C', cwd, ...args], { cwd });
  }

  private async execGit(args: string[], options: { cwd?: string }): Promise<GitResult> {
    const binaries = this.gitBinary
      ? [this.gitBinary]
      : process.platform === 'linux'
        ? ['git', ...LINUX_FALLBACK_GIT]
        : ['git'];
    let lastError: unknown;
    for (const bin of binaries) {
      try {
        const result = await this.invokeExecFile(bin, args, options);
        if (bin !== 'git') this.gitBinary = bin;
        return result;
      } catch (err) {
        lastError = err;
        if ((err as ExecFileError)?.code !== 'ENOENT') throw err;
      }
    }
    throw lastError;
  }

  private invokeExecFile(bin: string, args: string[], options: { cwd?: string }): Promise<GitResult> {
    return new Promise((resolve, reject) => {
      this.execFileFn(bin, args, { ...options, maxBuffer: GIT_MAX_BUFFER }, (error, stdout, stderr) => {
        if (error) {
          const wrapped = new Error(stderr.trim() || error.message) as ExecFileError;
          wrapped.code = error.code;
          reject(wrapped);
          return;
        }
        resolve({ stdout, stderr });
      });
    });
  }
}

export const sourceControlService = new SourceControlService();
