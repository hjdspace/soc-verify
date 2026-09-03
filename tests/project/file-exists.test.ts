/**
 * projectManager.fileExists — 引用点击前的存在性校验。
 *
 * 覆盖场景：
 * - 项目内存在的常规文件 → true
 * - 项目内不存在的路径（如 AI 文本误识别出的 "Tavily/Exa/Firecrawl/Z.AI"）→ false
 * - 目录（存在但非常规文件）→ false
 * - 项目目录外的路径 → false（沙箱规则与 readFile 一致）
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtemp, writeFile, mkdir, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

vi.mock('electron', () => {
  let _userDataDir: string | null = null;
  return {
    app: {
      getPath: (name: string) => {
        if (name === 'userData') {
          if (!_userDataDir) {
            const fs = require('node:fs');
            _userDataDir = fs.mkdtempSync(join(tmpdir(), 'socverify-userdata-'));
          }
          return _userDataDir;
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

describe('projectManager.fileExists', () => {
  let projectRoot: string;
  let projectId: string;

  beforeEach(async () => {
    projectRoot = await mkdtemp(join(tmpdir(), 'socverify-fileexists-'));
    const info = await projectManager.openProject(projectRoot, 'test-file-exists');
    projectId = info.id;
  });

  afterEach(async () => {
    await projectManager.closeAllProjects();
    await rm(projectRoot, { recursive: true, force: true });
  });

  it('returns true for an existing regular file inside the project', async () => {
    const filePath = join(projectRoot, 'rtl', 'core.sv');
    await mkdir(join(projectRoot, 'rtl'), { recursive: true });
    await writeFile(filePath, 'module core();\nendmodule\n', 'utf-8');

    await expect(projectManager.fileExists(projectId, filePath)).resolves.toBe(true);
  });

  it('returns false for a non-existent path inside the project', async () => {
    await expect(
      projectManager.fileExists(projectId, join(projectRoot, 'Tavily', 'Exa', 'Firecrawl', 'Z.AI')),
    ).resolves.toBe(false);
  });

  it('returns false for a directory', async () => {
    const dirPath = join(projectRoot, 'rtl');
    await mkdir(dirPath, { recursive: true });

    await expect(projectManager.fileExists(projectId, dirPath)).resolves.toBe(false);
  });

  it('returns true for an existing file outside the project directories', async () => {
    const outside = await mkdtemp(join(tmpdir(), 'socverify-outside-'));
    try {
      const filePath = join(outside, 'external.txt');
      await writeFile(filePath, 'external', 'utf-8');

      // fileExists 不再限制路径，允许检查项目目录外的文件
      await expect(projectManager.fileExists(projectId, filePath)).resolves.toBe(true);
    } finally {
      await rm(outside, { recursive: true, force: true });
    }
  });
});
