/**
 * 验证项目打开时自动将 `.socverify` 写入项目根目录的 `.gitignore`。
 *
 * 覆盖场景：
 * - `.gitignore` 不存在 → 新建
 * - `.gitignore` 存在但未忽略 → 追加
 * - 已忽略（含 `.socverify/` 变体、行内注释变体）→ 幂等不修改
 * - 末尾无换行的 `.gitignore` 也能正确追加
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

vi.mock('electron', () => {
  let userDataDir: string | null = null;
  return {
    app: {
      getPath: (name: string) => {
        if (name === 'userData') {
          if (!userDataDir) {
            const fs = require('node:fs');
            userDataDir = fs.mkdtempSync(join(tmpdir(), 'socverify-userdata-'));
          }
          return userDataDir;
        }
        return '/tmp/socverify-mock';
      },
      isReady: () => true,
    },
    dialog: { showOpenDialog: vi.fn() },
    ipcMain: { on: vi.fn(), handle: vi.fn() },
    BrowserWindow: class {},
  };
});

import { projectManager } from '../../src/main/project/project-manager';

async function readGitignore(root: string): Promise<string | null> {
  const path = join(root, '.gitignore');
  if (!existsSync(path)) return null;
  return readFile(path, 'utf-8');
}

describe('project .gitignore auto-entry for .socverify', () => {
  let projectRoot: string;

  beforeEach(async () => {
    projectRoot = await mkdtemp(join(tmpdir(), 'socverify-gi-'));
  });

  afterEach(async () => {
    await projectManager.closeAllProjects();
    await rm(projectRoot, { recursive: true, force: true });
  });

  it('creates .gitignore when it does not exist', async () => {
    await projectManager.openProject(projectRoot, 'no-gitignore');

    const content = await readGitignore(projectRoot);
    expect(content).not.toBeNull();
    expect(content).toContain('.socverify');
    // 应该有头部注释标识来源
    expect(content).toContain('SoC Verify workspace');
  });

  it('appends .socverify when .gitignore exists but does not ignore it', async () => {
    const pre = 'node_modules\n*.log\nbuild/\n';
    await writeFile(join(projectRoot, '.gitignore'), pre, 'utf-8');

    await projectManager.openProject(projectRoot, 'append-gitignore');

    const content = await readGitignore(projectRoot);
    expect(content).not.toBeNull();
    // 原有内容保留
    expect(content).toContain('node_modules');
    expect(content).toContain('*.log');
    expect(content).toContain('build/');
    // 新增条目
    expect(content).toContain('.socverify');
  });

  it('does not modify .gitignore when .socverify already ignored', async () => {
    const pre = `node_modules
.socverify
*.log
`;
    await writeFile(join(projectRoot, '.gitignore'), pre, 'utf-8');

    await projectManager.openProject(projectRoot, 'already-ignored');

    const content = await readGitignore(projectRoot);
    expect(content).toBe(pre);
  });

  it('recognises .socverify/ variant as already ignored', async () => {
    const pre = `node_modules
.socverify/
`;
    await writeFile(join(projectRoot, '.gitignore'), pre, 'utf-8');

    await projectManager.openProject(projectRoot, 'slash-variant');

    const content = await readGitignore(projectRoot);
    expect(content).toBe(pre);
  });

  it('recognises inline-comment variant as already ignored', async () => {
    const pre = `node_modules
.socverify # SoC Verify workspace
`;
    await writeFile(join(projectRoot, '.gitignore'), pre, 'utf-8');

    await projectManager.openProject(projectRoot, 'inline-comment');

    const content = await readGitignore(projectRoot);
    expect(content).toBe(pre);
  });

  it('does not match substrings like foo.socverify', async () => {
    const pre = `node_modules
foo.socverify
`;
    await writeFile(join(projectRoot, '.gitignore'), pre, 'utf-8');

    await projectManager.openProject(projectRoot, 'substring-no-match');

    const content = await readGitignore(projectRoot);
    expect(content).not.toBe(pre);
    expect(content).toContain('.socverify');
    expect(content).toContain('foo.socverify');
  });

  it('appends correctly when .gitignore has no trailing newline', async () => {
    const pre = 'node_modules\n*.log'; // 末尾无换行
    await writeFile(join(projectRoot, '.gitignore'), pre, 'utf-8');

    await projectManager.openProject(projectRoot, 'no-trailing-newline');

    const content = await readGitignore(projectRoot);
    expect(content).not.toBeNull();
    // 应该在原内容和新增条目之间插入换行
    expect(content).toContain('*.log\n\n# SoC Verify workspace\n.socverify');
  });

  it('is idempotent across multiple project opens', async () => {
    await projectManager.openProject(projectRoot, 'idempotent-1');
    await projectManager.closeAllProjects();

    await projectManager.openProject(projectRoot, 'idempotent-2');
    await projectManager.closeAllProjects();

    await projectManager.openProject(projectRoot, 'idempotent-3');

    const content = await readGitignore(projectRoot);
    expect(content).not.toBeNull();
    // `.socverify` 应该只出现一次（不考虑注释行）
    const socverifyLines = content!
      .split(/\r?\n/)
      .filter((l) => {
        const hashIdx = l.indexOf('#');
        const pattern = (hashIdx >= 0 ? l.slice(0, hashIdx) : l).trim();
        return pattern === '.socverify' || pattern === '.socverify/';
      });
    expect(socverifyLines.length).toBe(1);
  });
});
