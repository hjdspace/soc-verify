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
});
