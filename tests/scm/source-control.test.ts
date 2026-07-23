import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { describe, expect, it, vi } from 'vitest';
import { parseGitStatus, sanitizeCommitMessage, SourceControlService } from '../../src/main/scm/source-control';

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

  it('generates commit messages through an OpenAI-compatible endpoint', async () => {
    let requestBody = '';
    const execFileFn = vi.fn((file, args, _options, callback) => {
      const gitArgs = args.slice(2);
      if (file !== 'git') {
        callback(new Error('unexpected binary'), '', '');
        return;
      }
      if (gitArgs[0] === 'status') {
        callback(null, '## main\0 M src/a.ts\0', '');
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
  });

  it('generates commit messages using staged diff when files are staged', async () => {
    let requestBody = '';
    const execFileFn = vi.fn((file, args, _options, callback) => {
      const gitArgs = args.slice(2);
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

  it('commits all changes in a Git repository', async () => {
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

  it('stages and commits individual files', async () => {
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

  it('discards changes for tracked and untracked files', async () => {
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
