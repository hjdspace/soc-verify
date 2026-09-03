import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { describe, expect, it, vi } from 'vitest';
import {
  parseGitStatus,
  sanitizeCommitMessage,
  SourceControlService,
  type ExecFileFn,
} from '../../src/main/scm/source-control';

const execFileAsync = promisify(execFile);

describe('source control service', () => {
  it('parses porcelain status output', () => {
    const status = parseGitStatus(
      '## main...origin/main [ahead 1, behind 2]\0 M src/a.ts\0?? src/new.ts\0R  src/new-name.ts\0src/old-name.ts\0',
    );

    expect(status.branch).toBe('main');
    expect(status.ahead).toBe(1);
    expect(status.behind).toBe(2);
    expect(status.files).toEqual([
      {
        path: 'src/a.ts',
        indexStatus: ' ',
        workTreeStatus: 'M',
        staged: false,
        unstaged: true,
      },
      {
        path: 'src/new.ts',
        indexStatus: '?',
        workTreeStatus: '?',
        staged: false,
        unstaged: true,
      },
      {
        path: 'src/new-name.ts',
        originalPath: 'src/old-name.ts',
        indexStatus: 'R',
        workTreeStatus: ' ',
        staged: true,
        unstaged: false,
      },
    ]);
  });

  it('sanitizes fenced or quoted AI messages', () => {
    expect(sanitizeCommitMessage('```text\n"feat: add scm panel"\n```')).toBe('feat: add scm panel');
  });

  it('sanitizes conversational filler before the commit type', () => {
    expect(sanitizeCommitMessage('以下是提交信息：\n\nfeat: add scm panel')).toBe('feat: add scm panel');
    expect(sanitizeCommitMessage('Here is the commit message:\nfix: resolve null pointer')).toBe('fix: resolve null pointer');
  });

  it('sanitizes multi-line code fences with body', () => {
    const msg = '```\nfeat: add feature\n\n- detail line\n```';
    expect(sanitizeCommitMessage(msg)).toBe('feat: add feature\n\n- detail line');
  });

  it('strips reasoning process leaked after commit message', () => {
    // Thinking models sometimes leak their reasoning into the output
    const msg = [
      'feat(scm): 优化提交信息生成的提示词与参数',
      '',
      '- 重写 system prompt 加入禁用词和示例',
      '- 调整 temperature 和 max_tokens',
      '',
      '但 "优化" 可能有点泛，我们可以更具体："feat(scm): 增强提交信息生成规则与提示词"。',
      '或者考虑到核心是改进提示词的格式和约束，可以写："feat(scm): 完善提交信息生成提示词并调整模型参数"。',
      '我们需要简洁。我认为："feat(scm): 完善提交信息生成的提示词与重试逻辑" 比较好。',
    ].join('\n');
    expect(sanitizeCommitMessage(msg)).toBe(
      'feat(scm): 优化提交信息生成的提示词与参数\n\n- 重写 system prompt 加入禁用词和示例\n- 调整 temperature 和 max_tokens',
    );
  });

  it('strips reasoning process when no body is present', () => {
    const msg = [
      'feat: 添加用户登录功能',
      '',
      '我们需要考虑安全性。',
      '也许应该用 OAuth？',
    ].join('\n');
    expect(sanitizeCommitMessage(msg)).toBe('feat: 添加用户登录功能');
  });

  it('extracts the final inline candidate from a reasoning response', () => {
    const msg = [
      '我们需要分析变更内容并判断 type 和 scope。',
      '标题可以考虑：`feat(scm): 生成提交信息时引入最近提交与文件摘要并优化解析`。',
      '也许更准确：`feat(scm): 增强提交信息生成的上下文与健壮性`？',
      '最终建议使用：`feat(scm): 添加最近提交参考与输出解析`。',
    ].join('\n');
    expect(sanitizeCommitMessage(msg)).toBe('feat(scm): 添加最近提交参考与输出解析');
  });

  it('prefers the explicitly delimited final answer', () => {
    const msg = [
      '分析过程不应出现在提交信息中。',
      '<commit-message>feat(scm): 清理 AI 提交信息输出</commit-message>',
      '后续解释也不应保留。',
    ].join('\n');
    expect(sanitizeCommitMessage(msg)).toBe('feat(scm): 清理 AI 提交信息输出');
  });

  it('preserves body with blank lines between dash items', () => {
    // Body lines starting with - should be preserved even if separated by blank lines
    const msg = [
      'feat: 添加新功能',
      '',
      '- 第一点',
      '',
      '- 第二点',
    ].join('\n');
    // Note: current implementation treats blank lines after body started as preserved
    expect(sanitizeCommitMessage(msg)).toBe('feat: 添加新功能\n\n- 第一点\n\n- 第二点');
  });

  it('preserves a paragraph body returned without list markers', () => {
    const msg = [
      'feat: 添加提交信息生成',
      '',
      '根据变更文件生成符合规范的提交信息。',
      '通过最近提交记录保持项目现有风格。',
    ].join('\n');
    expect(sanitizeCommitMessage(msg)).toBe(msg);
  });

  it('generates commit messages through an OpenAI-compatible endpoint', async () => {
    let requestBody = '';
    const execFileFn = vi.fn((file, args, _options, callback) => {
      const gitArgs = args.filter((a: string, idx: number) => a !== '--no-optional-locks' && a !== '-C' && args[idx - 1] !== '-C');
      if (file !== 'git') {
        callback(new Error('unexpected binary'), '', '');
        return;
      }
      if (gitArgs[0] === 'status') {
        callback(null, '## main\0 M src/a.ts\0', '');
        return;
      }
      if (gitArgs[0] === 'log') {
        callback(null, 'feat: initial commit\nfix: bug fix\n', '');
        return;
      }
      callback(null, 'M\tsrc/a.ts\n', '');
    });
    const fetchFn = (async (_input: RequestInfo | URL, init?: RequestInit) => {
      requestBody = String(init?.body ?? '');
      return new Response(JSON.stringify({
        choices: [{ message: { content: 'feat: add source control workflow' } }],
      }), { status: 200 });
    }) as typeof fetch;

    const service = new SourceControlService({ execFileFn, fetchFn });
    const message = await service.generateCommitMessage(
      'D:\\repo',
      { providerId: 'openai-compatible', apiKey: 'test-key', baseUrl: 'https://example.test/v1' },
      'test-model',
    );

    expect(message).toBe('feat: add source control workflow');
    expect(requestBody).toContain('test-model');
    expect(requestBody).toContain('src/a.ts');
    // Recent commits should be included for style reference
    expect(requestBody).toContain('最近提交记录');
    expect(requestBody).toContain('feat: initial commit');
    // File summary should be included
    expect(requestBody).toContain('变更文件概览');
    expect(requestBody).toContain('至少 1 条 body');
    expect(requestBody).toContain('不得只输出标题');
  });

  it('generates commit messages using staged diff when files are staged', async () => {
    let requestBody = '';
    const execFileFn = vi.fn((file, args, _options, callback) => {
      const gitArgs = args.filter((a: string, idx: number) => a !== '--no-optional-locks' && a !== '-C' && args[idx - 1] !== '-C');
      if (file !== 'git') {
        callback(new Error('unexpected binary'), '', '');
        return;
      }
      if (gitArgs[0] === 'status') {
        // One staged file (M in index), one unstaged file
        callback(null, '## main\0M  src/staged.ts\0 M src/unstaged.ts\0', '');
        return;
      }
      // For staged diff commands (git diff --cached ...), return staged file
      if (gitArgs[0] === 'diff' && gitArgs.includes('--cached')) {
        callback(null, 'M\tsrc/staged.ts\n', '');
        return;
      }
      // For unstaged diff commands, return unstaged file
      if (gitArgs[0] === 'diff') {
        callback(null, 'M\tsrc/unstaged.ts\n', '');
        return;
      }
      if (gitArgs[0] === 'log') {
        callback(null, 'feat: previous staged commit\n', '');
        return;
      }
      callback(null, '', '');
    });
    const fetchFn = (async (_input: RequestInfo | URL, init?: RequestInit) => {
      requestBody = String(init?.body ?? '');
      return new Response(JSON.stringify({
        choices: [{ message: { content: 'feat: staged changes commit' } }],
      }), { status: 200 });
    }) as typeof fetch;

    const service = new SourceControlService({ execFileFn, fetchFn });
    const message = await service.generateCommitMessage(
      'D:\\repo',
      { providerId: 'openai-compatible', apiKey: 'test-key', baseUrl: 'https://example.test/v1' },
      'test-model',
    );

    expect(message).toBe('feat: staged changes commit');
    // The prompt should include the staged file
    expect(requestBody).toContain('src/staged.ts');
    // When staged files exist, unstaged diff should NOT be included
    expect(requestBody).not.toContain('src/unstaged.ts');
  });

  // ── Helper: create a fake execFile that always returns staged src/a.ts ─
  const fakeExecFileFn = vi.fn((file, args, _options, callback) => {
    const gitArgs = args.filter((a: string, idx: number) => a !== '--no-optional-locks' && a !== '-C' && args[idx - 1] !== '-C');
    if (file !== 'git') {
      callback(new Error('unexpected binary'), '', '');
      return;
    }
    if (gitArgs[0] === 'status') {
      callback(null, '## main\0M  src/a.ts\0', '');
      return;
    }
    if (gitArgs[0] === 'log') {
      callback(null, 'feat: previous commit\n', '');
      return;
    }
    callback(null, 'M\tsrc/a.ts\n', '');
  });

  it('extracts message from array content format', async () => {
    const fetchFn = vi.fn((async () => {
      return new Response(JSON.stringify({
        choices: [{ message: { content: [{ type: 'text', text: 'feat: array content support' }] } }],
      }), { status: 200 });
    }) as typeof fetch);
    const service = new SourceControlService({ execFileFn: fakeExecFileFn, fetchFn });
    const message = await service.generateCommitMessage(
      'D:\\repo',
      { providerId: 'openai-compatible', apiKey: 'test-key', baseUrl: 'https://example.test/v1' },
      'test-model',
    );
    expect(message).toBe('feat: array content support');
  });

  it('uses the /responses endpoint and Responses request shape when credential api is openai-responses', async () => {
    const calls: Array<{ url: string; body: Record<string, unknown> }> = [];
    const fakeExec = vi.fn((file: string, args: string[], _options: unknown, callback: (e: Error | null, stdout: string, stderr: string) => void) => {
      const gitArgs = args.filter((a: string, idx: number) => a !== '--no-optional-locks' && a !== '-C' && args[idx - 1] !== '-C');
      if (gitArgs[0] === 'status') {
        callback(null, '## main\0M  src/a.ts\0', '');
        return;
      }
      if (gitArgs[0] === 'log') {
        callback(null, 'feat: previous commit\n', '');
        return;
      }
      callback(null, 'M\tsrc/a.ts\n', '');
    });
    const fetchFn = vi.fn((async (url: RequestInfo | URL, init?: RequestInit) => {
      calls.push({
        url: String(url),
        body: JSON.parse(String(init?.body ?? '{}')) as Record<string, unknown>,
      });
      return new Response(JSON.stringify({
        output: [
          { type: 'reasoning', summary: [] },
          { type: 'message', content: [{ type: 'output_text', text: 'feat: responses api support\n\n- use /responses endpoint' }] },
        ],
      }), { status: 200 });
    }) as typeof fetch);
    const service = new SourceControlService({ execFileFn: fakeExec, fetchFn });
    const message = await service.generateCommitMessage(
      'D:\\repo',
      { providerId: 'gateway', apiKey: 'test-key', baseUrl: 'https://example.test/v1', api: 'openai-responses' },
      'test-model',
    );
    expect(message).toContain('feat: responses api support');
    // Both the initial call and the retry path are only hit when the first
    // response lacks a usable message — one call is enough here.
    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe('https://example.test/v1/responses');
    expect(calls[0].body).toMatchObject({ model: 'test-model', max_output_tokens: 800 });
    expect(calls[0].body).not.toHaveProperty('messages');
    expect(calls[0].body).not.toHaveProperty('max_tokens');
  });

  it('appends /v1 before the responses endpoint when the credential baseUrl lacks it', async () => {
    const fakeExec = vi.fn((file: string, args: string[], _options: unknown, callback: (e: Error | null, stdout: string, stderr: string) => void) => {
      const gitArgs = args.filter((a: string, idx: number) => a !== '--no-optional-locks' && a !== '-C' && args[idx - 1] !== '-C');
      if (gitArgs[0] === 'status') {
        callback(null, '## main\0M  src/a.ts\0', '');
        return;
      }
      if (gitArgs[0] === 'log') {
        callback(null, '', '');
        return;
      }
      callback(null, 'M\tsrc/a.ts\n', '');
    });
    const urls: string[] = [];
    const fetchFn = vi.fn((async (url: RequestInfo | URL) => {
      urls.push(String(url));
      return new Response(JSON.stringify({
        output_text: 'feat: v1 prefix enforced\n\n- keep /v1 before /responses',
      }), { status: 200 });
    }) as typeof fetch);
    const service = new SourceControlService({ execFileFn: fakeExec, fetchFn });
    const message = await service.generateCommitMessage(
      'D:\\repo',
      { providerId: 'gateway', apiKey: 'test-key', baseUrl: 'https://example.test', api: 'openai-responses' },
      'test-model',
    );
    expect(message).toContain('feat: v1 prefix enforced');
    expect(urls[0]).toBe('https://example.test/v1/responses');
  });

  it('falls back to reasoning_content when content is null', async () => {
    const fetchFn = vi.fn((async () => {
      return new Response(JSON.stringify({
        choices: [{ message: { content: null, reasoning_content: 'fix: reasoning fallback' } }],
      }), { status: 200 });
    }) as typeof fetch);
    const service = new SourceControlService({ execFileFn: fakeExecFileFn, fetchFn });
    const message = await service.generateCommitMessage(
      'D:\\repo',
      { providerId: 'openai-compatible', apiKey: 'test-key', baseUrl: 'https://example.test/v1' },
      'test-model',
    );
    expect(message).toBe('fix: reasoning fallback');
  });

  it('handles delta-style response', async () => {
    const fetchFn = vi.fn((async () => {
      return new Response(JSON.stringify({
        choices: [{ delta: { content: 'feat: delta format' } }],
      }), { status: 200 });
    }) as typeof fetch);
    const service = new SourceControlService({ execFileFn: fakeExecFileFn, fetchFn });
    const message = await service.generateCommitMessage(
      'D:\\repo',
      { providerId: 'openai-compatible', apiKey: 'test-key', baseUrl: 'https://example.test/v1' },
      'test-model',
    );
    expect(message).toBe('feat: delta format');
  });

  it('strips conversational filler and code fences from AI response', async () => {
    const fetchFn = vi.fn((async () => {
      return new Response(JSON.stringify({
        choices: [{ message: { content: '以下是提交信息：\n```text\nfeat: cleaned message\n```' } }],
      }), { status: 200 });
    }) as typeof fetch);
    const service = new SourceControlService({ execFileFn: fakeExecFileFn, fetchFn });
    const message = await service.generateCommitMessage(
      'D:\\repo',
      { providerId: 'openai-compatible', apiKey: 'test-key', baseUrl: 'https://example.test/v1' },
      'test-model',
    );
    expect(message).toBe('feat: cleaned message');
  });

  it('retries with stricter prompt when first response is empty', async () => {
    let callCount = 0;
    const fetchFn = vi.fn((async () => {
      callCount += 1;
      if (callCount === 1) {
        return new Response(JSON.stringify({
          choices: [{ message: { content: null } }],
        }), { status: 200 });
      }
      return new Response(JSON.stringify({
        choices: [{ message: { content: 'feat: recovered on retry' } }],
      }), { status: 200 });
    }) as typeof fetch);
    const service = new SourceControlService({ execFileFn: fakeExecFileFn, fetchFn });
    const message = await service.generateCommitMessage(
      'D:\\repo',
      { providerId: 'openai-compatible', apiKey: 'test-key', baseUrl: 'https://example.test/v1' },
      'test-model',
    );
    expect(message).toBe('feat: recovered on retry');
    expect(callCount).toBe(2);
  });

  it('retries when the response only contains reasoning text', async () => {
    let callCount = 0;
    const fetchFn = vi.fn((async () => {
      callCount += 1;
      const content = callCount === 1
        ? '我们需要分析 diff，然后选择合适的 type 和 scope。'
        : '<commit-message>fix: recovered after reasoning</commit-message>';
      return new Response(JSON.stringify({ choices: [{ message: { content } }] }), { status: 200 });
    }) as typeof fetch);
    const service = new SourceControlService({ execFileFn: fakeExecFileFn, fetchFn });
    await expect(
      service.generateCommitMessage(
        'D:\\repo',
        { providerId: 'openai-compatible', apiKey: 'test-key', baseUrl: 'https://example.test/v1' },
        'test-model',
      ),
    ).resolves.toBe('fix: recovered after reasoning');
    expect(callCount).toBe(2);
  });

  it('retries when the first response has only a title', async () => {
    let callCount = 0;
    const fetchFn = vi.fn((async () => {
      callCount += 1;
      const content = callCount === 1
        ? 'feat: title without body'
        : 'feat: title with body\n\n- 说明变更目的';
      return new Response(JSON.stringify({ choices: [{ message: { content } }] }), { status: 200 });
    }) as typeof fetch);
    const service = new SourceControlService({ execFileFn: fakeExecFileFn, fetchFn });
    await expect(
      service.generateCommitMessage(
        'D:\\repo',
        { providerId: 'openai-compatible', apiKey: 'test-key', baseUrl: 'https://example.test/v1' },
        'test-model',
      ),
    ).resolves.toBe('feat: title with body\n\n- 说明变更目的');
    expect(callCount).toBe(2);
  });

  it('throws when both first and retry responses are empty', async () => {
    const fetchFn = vi.fn((async () => {
      return new Response(JSON.stringify({
        choices: [{ message: { content: null } }],
      }), { status: 200 });
    }) as typeof fetch);
    const service = new SourceControlService({ execFileFn: fakeExecFileFn, fetchFn });
    await expect(
      service.generateCommitMessage(
        'D:\\repo',
        { providerId: 'openai-compatible', apiKey: 'test-key', baseUrl: 'https://example.test/v1' },
        'test-model',
      ),
    ).rejects.toThrow('AI response did not include a commit message');
  });

  it('classifies 401 error as authentication failure', async () => {
    const fetchFn = vi.fn((async () => {
      return new Response('Unauthorized', { status: 401 });
    }) as typeof fetch);
    const service = new SourceControlService({ execFileFn: fakeExecFileFn, fetchFn });
    await expect(
      service.generateCommitMessage(
        'D:\\repo',
        { providerId: 'openai-compatible', apiKey: 'bad-key', baseUrl: 'https://example.test/v1' },
        'test-model',
      ),
    ).rejects.toThrow('AI 认证失败');
  });

  it('classifies 429 error as rate limit', async () => {
    const fetchFn = vi.fn((async () => {
      return new Response('Too Many Requests', { status: 429 });
    }) as typeof fetch);
    const service = new SourceControlService({ execFileFn: fakeExecFileFn, fetchFn });
    await expect(
      service.generateCommitMessage(
        'D:\\repo',
        { providerId: 'openai-compatible', apiKey: 'test-key', baseUrl: 'https://example.test/v1' },
        'test-model',
      ),
    ).rejects.toThrow('AI 请求频率超限');
  });

  it('handles new repo with no commit history', async () => {
    // git log fails on a new repo — should not block generation
    const execFileFn = vi.fn((file, args, _options, callback) => {
      const gitArgs = args.filter((a: string, idx: number) => a !== '--no-optional-locks' && a !== '-C' && args[idx - 1] !== '-C');
      if (file !== 'git') {
        callback(new Error('unexpected binary'), '', '');
        return;
      }
      if (gitArgs[0] === 'status') {
        callback(null, '## main\0M  src/a.ts\0', '');
        return;
      }
      if (gitArgs[0] === 'log') {
        // New repo — git log exits with non-zero
        callback(new Error('no commits yet'), '', 'fatal: your current branch does not have any commits yet');
        return;
      }
      callback(null, 'M\tsrc/a.ts\n', '');
    });
    const fetchFn = vi.fn((async () => {
      return new Response(JSON.stringify({
        choices: [{ message: { content: 'feat: initial commit' } }],
      }), { status: 200 });
    }) as typeof fetch);
    const service = new SourceControlService({ execFileFn, fetchFn });
    const message = await service.generateCommitMessage(
      'D:\\repo',
      { providerId: 'openai-compatible', apiKey: 'test-key', baseUrl: 'https://example.test/v1' },
      'test-model',
    );
    expect(message).toBe('feat: initial commit');
  });

  it('commits all changes in a Git repository', { timeout: 15000 }, async () => {
    const repo = await mkdtemp(join(tmpdir(), 'socverify-scm-'));
    try {
      await execFileAsync('git', ['init'], { cwd: repo });
      await execFileAsync('git', ['config', 'user.email', 'test@example.com'], { cwd: repo });
      await execFileAsync('git', ['config', 'user.name', 'Test User'], { cwd: repo });
      await writeFile(join(repo, 'readme.md'), 'hello\n', 'utf-8');
      await mkdir(join(repo, '.socverify'), { recursive: true });
      await writeFile(join(repo, '.socverify', 'config.json'), '{}\n', 'utf-8');

      const service = new SourceControlService();
      const result = await service.commitAll(repo, 'test: initial commit');
      const status = await service.getStatus(repo);
      const tree = await execFileAsync('git', ['ls-tree', '--name-only', 'HEAD'], { cwd: repo });

      expect(result.commitHash).toMatch(/^[a-f0-9]+$/);
      expect(status.files).toEqual([]);
      expect(tree.stdout).not.toContain('.socverify');
    } finally {
      await rm(repo, { recursive: true, force: true });
    }
  });

  it('stages and commits individual files', { timeout: 15000 }, async () => {
    const repo = await mkdtemp(join(tmpdir(), 'socverify-scm-'));
    try {
      await execFileAsync('git', ['init'], { cwd: repo });
      await execFileAsync('git', ['config', 'user.email', 'test@example.com'], { cwd: repo });
      await execFileAsync('git', ['config', 'user.name', 'Test User'], { cwd: repo });

      // Create and commit an initial file
      await writeFile(join(repo, 'a.txt'), 'initial\n', 'utf-8');
      await execFileAsync('git', ['add', 'a.txt'], { cwd: repo });
      await execFileAsync('git', ['commit', '-m', 'init'], { cwd: repo });

      // Modify two files
      await writeFile(join(repo, 'a.txt'), 'modified\n', 'utf-8');
      await writeFile(join(repo, 'b.txt'), 'new file\n', 'utf-8');

      const service = new SourceControlService();

      // Stage only a.txt
      await service.stageFiles(repo, ['a.txt']);

      // Verify status shows a.txt as staged
      const statusAfterStage = await service.getStatus(repo);
      const aFile = statusAfterStage.files.find((f) => f.path === 'a.txt');
      expect(aFile?.staged).toBe(true);

      // Commit only staged changes
      const result = await service.commit(repo, 'fix: modify a.txt');
      expect(result.commitHash).toMatch(/^[a-f0-9]+$/);

      // b.txt should still be untracked after commit
      const statusAfterCommit = await service.getStatus(repo);
      const bFile = statusAfterCommit.files.find((f) => f.path === 'b.txt');
      expect(bFile).toBeDefined();
      expect(bFile?.staged).toBe(false);

      // Unstage b.txt is not applicable (untracked), but test unstage on a tracked file
      // Stage b.txt then unstage it
      await service.stageFiles(repo, ['b.txt']);
      const statusAfterStageB = await service.getStatus(repo);
      const bFileStaged = statusAfterStageB.files.find((f) => f.path === 'b.txt');
      expect(bFileStaged?.staged).toBe(true);

      await service.unstageFiles(repo, ['b.txt']);
      const statusAfterUnstage = await service.getStatus(repo);
      const bFileUnstaged = statusAfterUnstage.files.find((f) => f.path === 'b.txt');
      expect(bFileUnstaged?.staged).toBe(false);
    } finally {
      await rm(repo, { recursive: true, force: true });
    }
  });

  it('lists untracked files inside subdirectories individually', { timeout: 15000 }, async () => {
    const repo = await mkdtemp(join(tmpdir(), 'socverify-scm-'));
    try {
      await execFileAsync('git', ['init'], { cwd: repo });
      await execFileAsync('git', ['config', 'user.email', 'test@example.com'], { cwd: repo });
      await execFileAsync('git', ['config', 'user.name', 'Test User'], { cwd: repo });

      // Create and commit an initial file so the repo is not empty
      await writeFile(join(repo, 'readme.md'), 'hello\n', 'utf-8');
      await execFileAsync('git', ['add', 'readme.md'], { cwd: repo });
      await execFileAsync('git', ['commit', '-m', 'init'], { cwd: repo });

      // Create multiple untracked files inside a subdirectory
      await mkdir(join(repo, 'src', 'tools'), { recursive: true });
      await writeFile(join(repo, 'src', 'tools', 'a.ts'), 'a\n', 'utf-8');
      await writeFile(join(repo, 'src', 'tools', 'b.ts'), 'b\n', 'utf-8');
      await writeFile(join(repo, 'src', 'tools', 'c.ts'), 'c\n', 'utf-8');

      const service = new SourceControlService();
      const status = await service.getStatus(repo);

      // Each file should be listed individually, not collapsed into "src/tools/"
      const toolFiles = status.files.filter((f) => f.path.startsWith('src/tools/'));
      expect(toolFiles).toHaveLength(3);
      expect(toolFiles.map((f) => f.path).sort()).toEqual([
        'src/tools/a.ts',
        'src/tools/b.ts',
        'src/tools/c.ts',
      ]);
    } finally {
      await rm(repo, { recursive: true, force: true });
    }
  });

  it('discards changes for tracked and untracked files', { timeout: 15000 }, async () => {
    const repo = await mkdtemp(join(tmpdir(), 'socverify-scm-'));
    try {
      await execFileAsync('git', ['init'], { cwd: repo });
      await execFileAsync('git', ['config', 'user.email', 'test@example.com'], { cwd: repo });
      await execFileAsync('git', ['config', 'user.name', 'Test User'], { cwd: repo });

      // Create and commit initial file
      await writeFile(join(repo, 'tracked.txt'), 'original\n', 'utf-8');
      await execFileAsync('git', ['add', 'tracked.txt'], { cwd: repo });
      await execFileAsync('git', ['commit', '-m', 'init'], { cwd: repo });

      // Modify tracked file and create untracked file
      await writeFile(join(repo, 'tracked.txt'), 'modified\n', 'utf-8');
      await writeFile(join(repo, 'untracked.txt'), 'new\n', 'utf-8');

      const service = new SourceControlService();

      // Discard both
      await service.discardChanges(repo, ['tracked.txt', 'untracked.txt']);

      const status = await service.getStatus(repo);
      expect(status.files).toEqual([]);
    } finally {
      await rm(repo, { recursive: true, force: true });
    }
  });
});

  // ── file diff for manual review ───────────────────────────────

  it('returns the unstaged diff for a modified file', { timeout: 15000 }, async () => {
    const repo = await mkdtemp(join(tmpdir(), 'socverify-scm-'));
    try {
      await execFileAsync('git', ['init'], { cwd: repo });
      await execFileAsync('git', ['config', 'user.email', 'test@example.com'], { cwd: repo });
      await execFileAsync('git', ['config', 'user.name', 'Test User'], { cwd: repo });
      await writeFile(join(repo, 'a.ts'), 'line1\nline2\nline3\n', 'utf-8');
      await execFileAsync('git', ['add', 'a.ts'], { cwd: repo });
      await execFileAsync('git', ['commit', '-m', 'init'], { cwd: repo });
      await writeFile(join(repo, 'a.ts'), 'line1\nchanged\nline3\nadded\n', 'utf-8');

      const service = new SourceControlService();
      const diff = await service.getFileDiff(repo, 'a.ts', { staged: false });

      expect(diff.path).toBe('a.ts');
      expect(diff.staged).toBe(false);
      expect(diff.totalDel).toBe(1);
      expect(diff.totalAdd).toBe(2);
      const contents = diff.hunks.flatMap((h) => h.lines);
      expect(contents).toContainEqual({ type: 'del', content: 'line2', oldLine: 2 });
      expect(contents).toContainEqual({ type: 'add', content: 'changed', newLine: 2 });
      expect(contents).toContainEqual({ type: 'add', content: 'added', newLine: 4 });
    } finally {
      await rm(repo, { recursive: true, force: true });
    }
  });

  it('returns the staged diff and an empty unstaged diff after staging', { timeout: 15000 }, async () => {
    const repo = await mkdtemp(join(tmpdir(), 'socverify-scm-'));
    try {
      await execFileAsync('git', ['init'], { cwd: repo });
      await execFileAsync('git', ['config', 'user.email', 'test@example.com'], { cwd: repo });
      await execFileAsync('git', ['config', 'user.name', 'Test User'], { cwd: repo });
      await writeFile(join(repo, 'a.ts'), 'original\n', 'utf-8');
      await execFileAsync('git', ['add', 'a.ts'], { cwd: repo });
      await execFileAsync('git', ['commit', '-m', 'init'], { cwd: repo });
      await writeFile(join(repo, 'a.ts'), 'modified\n', 'utf-8');
      await execFileAsync('git', ['add', 'a.ts'], { cwd: repo });

      const service = new SourceControlService();
      const stagedDiff = await service.getFileDiff(repo, 'a.ts', { staged: true });
      expect(stagedDiff.staged).toBe(true);
      expect(stagedDiff.totalAdd).toBe(1);
      expect(stagedDiff.totalDel).toBe(1);

      // No unstaged changes remain after staging
      const unstagedDiff = await service.getFileDiff(repo, 'a.ts', { staged: false });
      expect(unstagedDiff.hunks).toEqual([]);
    } finally {
      await rm(repo, { recursive: true, force: true });
    }
  });

  it('shows all lines as additions for an untracked file', { timeout: 15000 }, async () => {
    const repo = await mkdtemp(join(tmpdir(), 'socverify-scm-'));
    try {
      await execFileAsync('git', ['init'], { cwd: repo });
      await execFileAsync('git', ['config', 'user.email', 'test@example.com'], { cwd: repo });
      await execFileAsync('git', ['config', 'user.name', 'Test User'], { cwd: repo });
      await writeFile(join(repo, 'fresh.ts'), 'alpha\nbeta\n', 'utf-8');

      const service = new SourceControlService();
      const diff = await service.getFileDiff(repo, 'fresh.ts', { staged: false });

      expect(diff.isNewFile).toBe(true);
      expect(diff.totalAdd).toBe(2);
      expect(diff.hunks[0].lines.map((l) => l.content)).toEqual(['alpha', 'beta']);
    } finally {
      await rm(repo, { recursive: true, force: true });
    }
  });

  it('returns an empty diff for a clean committed file', { timeout: 15000 }, async () => {
    const repo = await mkdtemp(join(tmpdir(), 'socverify-scm-'));
    try {
      await execFileAsync('git', ['init'], { cwd: repo });
      await execFileAsync('git', ['config', 'user.email', 'test@example.com'], { cwd: repo });
      await execFileAsync('git', ['config', 'user.name', 'Test User'], { cwd: repo });
      await writeFile(join(repo, 'a.ts'), 'stable\n', 'utf-8');
      await execFileAsync('git', ['add', 'a.ts'], { cwd: repo });
      await execFileAsync('git', ['commit', '-m', 'init'], { cwd: repo });

      const service = new SourceControlService();
      const diff = await service.getFileDiff(repo, 'a.ts', { staged: false });
      expect(diff.hunks).toEqual([]);
      expect(diff.isBinary).toBe(false);
    } finally {
      await rm(repo, { recursive: true, force: true });
    }
  });

// ═══ Linux 端 git status 失败模式的恢复策略与性能加固（追加于顶层）═══
//
// EDA 验证工程在 Linux 上常见的四类失败（此前全部被静默吞掉，导致文件树
// 无 M/U 徽标、版本控制面板无差异）：stdout 超 maxBuffer、老 git 不支持
// :(exclude) pathspec、dubious ownership、git 不在 PATH。
// 另：git status 在大工程树上可能耗时数秒~十几秒，补充缓存与范围化查询测试。

type MockResult = { stdout?: string; error?: Error & { code?: string | number } };
type RecordedCall = { file: string; args: string[]; options: { cwd?: string; maxBuffer?: number } };

function createMockExec(handlers: Array<(call: { file: string; args: string[] }) => MockResult>) {
  const calls: RecordedCall[] = [];
  const execFn: ExecFileFn = (file, args, options, callback) => {
    calls.push({ file, args, options });
    const handler = handlers[Math.min(calls.length - 1, handlers.length - 1)];
    const result = handler({ file, args });
    if (result.error) {
      callback(result.error, '', '');
      return;
    }
    callback(null, result.stdout ?? '', '');
  };
  return { execFn, calls };
}

const PORCELAIN_OUTPUT = '## main\0 M src/a.ts\0?? src/new.ts\0';

describe('git status failure recovery (linux)', () => {
  let warnSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
  });

  afterEach(() => {
    warnSpy.mockRestore();
  });

  it('passes an enlarged maxBuffer so huge untracked file lists are not truncated', async () => {
    const { execFn, calls } = createMockExec([() => ({ stdout: PORCELAIN_OUTPUT })]);
    const service = new SourceControlService({ execFileFn: execFn });

    const status = await service.getStatus('/repo');

    expect(status.isRepository).toBe(true);
    expect(calls[0].options.maxBuffer).toBeGreaterThanOrEqual(64 * 1024 * 1024);
  });

  it('retries without :(exclude) pathspec on legacy git versions', async () => {
    const { execFn, calls } = createMockExec([
      () => ({ error: Object.assign(new Error("fatal: Invalid pathspec magic 'exclude' in ':(exclude).socverify'"), { code: 128 }) }),
      () => ({ stdout: PORCELAIN_OUTPUT }),
    ]);
    const service = new SourceControlService({ execFileFn: execFn });

    const status = await service.getStatus('/repo');

    expect(status.isRepository).toBe(true);
    expect(status.files.map((f) => f.path)).toEqual(['src/a.ts', 'src/new.ts']);
    expect(calls[1].args).not.toContain(':(exclude).socverify');
  });

  it('adds safe.directory and retries when git reports dubious ownership', async () => {
    const dubious = () => ({
      error: Object.assign(new Error("fatal: detected dubious ownership in repository at '/repo'"), { code: 128 }),
    });
    const { execFn, calls } = createMockExec([
      dubious, // status → 失败
      () => ({ stdout: '' }), // safe.directory get-all → 无记录
      () => ({ stdout: '' }), // safe.directory add
      () => ({ stdout: PORCELAIN_OUTPUT }), // status 重试 → 成功
    ]);
    const service = new SourceControlService({ execFileFn: execFn });

    const status = await service.getStatus('/repo');

    expect(status.isRepository).toBe(true);
    expect(status.files).toHaveLength(2);
    const addCall = calls.find((c) => c.args[0] === 'config' && c.args[2] === '--add');
    expect(addCall?.args).toEqual(['config', '--global', '--add', 'safe.directory', '/repo']);
  });

  it('skips the add when the repo path is already whitelisted but still retries', async () => {
    const dubious = () => ({
      error: Object.assign(new Error("fatal: detected dubious ownership in repository at '/repo'"), { code: 128 }),
    });
    const { execFn, calls } = createMockExec([
      dubious, // status → 失败
      () => ({ stdout: '/repo\n' }), // safe.directory get-all → 已存在
      () => ({ stdout: PORCELAIN_OUTPUT }), // status 重试 → 成功
    ]);
    const service = new SourceControlService({ execFileFn: execFn });

    const status = await service.getStatus('/repo');

    expect(status.isRepository).toBe(true);
    expect(calls.filter((c) => c.args[0] === 'config' && c.args[2] === '--add')).toHaveLength(0);
  });

  it('reports a notice when git is entirely unavailable', async () => {
    const { execFn } = createMockExec([
      () => ({ error: Object.assign(new Error('spawn git ENOENT'), { code: 'ENOENT' }) }),
    ]);
    const service = new SourceControlService({ execFileFn: execFn });

    const status = await service.getStatus('/repo');

    expect(status.isRepository).toBe(false);
    expect(status.notice).toContain('ENOENT');
  });

  it('does not report a notice when status succeeds', async () => {
    const { execFn } = createMockExec([() => ({ stdout: PORCELAIN_OUTPUT })]);
    const service = new SourceControlService({ execFileFn: execFn });

    const status = await service.getStatus('/repo');

    expect(status.isRepository).toBe(true);
    expect(status.notice).toBeUndefined();
  });
});

describe('status caching and scoped queries (slow git status on linux)', () => {
  let warnSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
  });

  afterEach(() => {
    warnSpy.mockRestore();
  });

  it('reuses the cached status within maxAgeMs and re-runs afterwards', async () => {
    const { execFn, calls } = createMockExec([() => ({ stdout: PORCELAIN_OUTPUT })]);
    const service = new SourceControlService({ execFileFn: execFn });

    await service.getStatus('/repo', { maxAgeMs: 5000 });
    await service.getStatus('/repo', { maxAgeMs: 5000 });
    expect(calls).toHaveLength(1); // TTL 内复用缓存

    await service.getStatus('/repo'); // 默认 0 = 总是实时
    expect(calls).toHaveLength(2);

    await new Promise((resolve) => setTimeout(resolve, 20));
    await service.getStatus('/repo', { maxAgeMs: 1 }); // 超过 TTL 后重新执行
    expect(calls).toHaveLength(3);
  });

  it('checks untracked via a path-scoped status instead of a full-tree scan in getFileDiff', async () => {
    const repo = await mkdtemp(join(tmpdir(), 'socverify-scm-'));
    try {
      await writeFile(join(repo, 'fresh.ts'), 'alpha\n', 'utf-8');
      const { execFn, calls } = createMockExec([
        () => ({ stdout: '?? fresh.ts\0' }), // 范围化 status → untracked
      ]);
      const service = new SourceControlService({ execFileFn: execFn });

      const diff = await service.getFileDiff(repo, 'fresh.ts', { staged: false });

      expect(diff.isNewFile).toBe(true);
      expect(calls).toHaveLength(1); // untracked 直接读盘，无需再跑 diff
      const statusArgs = calls[0].args;
      expect(statusArgs).toContain('--no-optional-locks');
      expect(statusArgs).not.toContain('--branch'); // 范围化查询不带全树参数
      expect(statusArgs.slice(statusArgs.indexOf('--') + 1)).toEqual(['fresh.ts']);
    } finally {
      await rm(repo, { recursive: true, force: true });
    }
  });

  it('falls back to git diff when the scoped status reports no untracked entry', async () => {
    const repo = await mkdtemp(join(tmpdir(), 'socverify-scm-'));
    try {
      await writeFile(join(repo, 'a.ts'), 'new\n', 'utf-8');
      const { execFn, calls } = createMockExec([
        () => ({ stdout: '' }), // 范围化 status → 无记录（已跟踪的修改）
        () => ({
          stdout: '--- a/a.ts\n+++ b/a.ts\n@@ -1 +1 @@\n-old\n+new\n',
        }),
      ]);
      const service = new SourceControlService({ execFileFn: execFn });

      const diff = await service.getFileDiff(repo, 'a.ts', { staged: false });

      expect(diff.isNewFile).toBe(false);
      expect(diff.totalAdd).toBe(1);
      expect(calls[1].args[2]).toBe('diff'); // args[0..1] = -C <path>
    } finally {
      await rm(repo, { recursive: true, force: true });
    }
  });

  it('runs status with --no-optional-locks to avoid index.lock contention', async () => {
    const { execFn, calls } = createMockExec([() => ({ stdout: PORCELAIN_OUTPUT })]);
    const service = new SourceControlService({ execFileFn: execFn });

    await service.getStatus('/repo');

    expect(calls[0].args).toContain('--no-optional-locks');
  });
});
