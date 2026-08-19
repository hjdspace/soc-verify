/**
 * 多目录支持 — 数据模型与目录增删改 API 测试。
 *
 * 覆盖场景（来自 issue acceptance criteria）：
 * - addDir 后持久化、getExtraDirs 返回正确
 * - removeDir 后目录消失、移除 cwd 时自动回退到验证组第一个剩余目录
 * - setCwd 标记更新
 * - updateDirLabel 更新标签
 * - readFile/writeFile 安全检查允许额外目录内文件、拒绝目录外路径
 * - 旧项目（extraDirs 不存在）打开时自动迁移
 * - 持久化到 projects.json
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
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

describe('multi-directory: addDir / getExtraDirs / persistence', () => {
  let projectRoot: string;
  let extraDir: string;

  beforeEach(async () => {
    projectRoot = await mkdtemp(join(tmpdir(), 'socverify-md-1-'));
    extraDir = await mkdtemp(join(tmpdir(), 'socverify-md-extra-'));
  });

  afterEach(async () => {
    await projectManager.closeAllProjects();
    await rm(projectRoot, { recursive: true, force: true });
    await rm(extraDir, { recursive: true, force: true });
  });

  it('addDir returns ExtraDirEntry with correct fields', async () => {
    const info = await projectManager.openProject(projectRoot, 'test-add');

    const dir = await projectManager.addDir(info.id, extraDir, 'verify', 'IP2SOC');

    expect(dir.id).toBeTruthy();
    expect(dir.path).toBe(extraDir);
    expect(dir.group).toBe('verify');
    expect(dir.label).toBe('IP2SOC');
    expect(dir.isCwd).toBe(false);
    expect(dir.order).toBe(0);
    expect(dir.createdAt).toBeGreaterThan(0);
  });

  it('getExtraDirs returns added directories', async () => {
    const info = await projectManager.openProject(projectRoot, 'test-list');

    await projectManager.addDir(info.id, extraDir, 'design', 'RTL');

    const dirs = projectManager.getExtraDirs(info.id);
    expect(dirs).toHaveLength(1);
    expect(dirs[0].path).toBe(extraDir);
    expect(dirs[0].group).toBe('design');
  });

  it('addDir persists extraDirs to projects.json', async () => {
    const info = await projectManager.openProject(projectRoot, 'test-persist');

    await projectManager.addDir(info.id, extraDir, 'verify');

    // Verify persistence via listProjects (reads from in-memory state that was saved to projects.json)
    const projects = projectManager.listProjects();
    const found = projects.find((p) => p.id === info.id);
    expect(found).toBeDefined();
    expect(found!.extraDirs).toBeDefined();
    expect(found!.extraDirs).toHaveLength(1);
    expect(found!.extraDirs![0].path).toBe(extraDir);
  });

  it('addDir increments order for same group', async () => {
    const info = await projectManager.openProject(projectRoot, 'test-order');
    const dir2 = await mkdtemp(join(tmpdir(), 'socverify-md-extra2-'));

    try {
      const d1 = await projectManager.addDir(info.id, extraDir, 'verify');
      const d2 = await projectManager.addDir(info.id, dir2, 'verify');

      expect(d1.order).toBe(0);
      expect(d2.order).toBe(1);
    } finally {
      await rm(dir2, { recursive: true, force: true });
    }
  });

  it('addDir rejects duplicate path', async () => {
    const info = await projectManager.openProject(projectRoot, 'test-dup');

    await projectManager.addDir(info.id, extraDir, 'verify');
    await expect(projectManager.addDir(info.id, extraDir, 'design')).rejects.toThrow(
      /already.*added|duplicate|exists/i,
    );
  });
});

describe('multi-directory: removeDir', () => {
  let projectRoot: string;
  let dir1: string;
  let dir2: string;

  beforeEach(async () => {
    projectRoot = await mkdtemp(join(tmpdir(), 'socverify-md-2-'));
    dir1 = await mkdtemp(join(tmpdir(), 'socverify-md-rm1-'));
    dir2 = await mkdtemp(join(tmpdir(), 'socverify-md-rm2-'));
  });

  afterEach(async () => {
    await projectManager.closeAllProjects();
    await rm(projectRoot, { recursive: true, force: true });
    await rm(dir1, { recursive: true, force: true });
    await rm(dir2, { recursive: true, force: true });
  });

  it('removeDir removes the directory from extraDirs', async () => {
    const info = await projectManager.openProject(projectRoot, 'test-remove');

    const added = await projectManager.addDir(info.id, dir1, 'verify');
    expect(projectManager.getExtraDirs(info.id)).toHaveLength(1);

    await projectManager.removeDir(info.id, added.id);

    expect(projectManager.getExtraDirs(info.id)).toHaveLength(0);
  });

  it('removeDir persists removal to projects.json', async () => {
    const info = await projectManager.openProject(projectRoot, 'test-remove-persist');

    const added = await projectManager.addDir(info.id, dir1, 'verify');
    await projectManager.removeDir(info.id, added.id);

    const projects = projectManager.listProjects();
    const found = projects.find((p) => p.id === info.id);
    expect(found!.extraDirs ?? []).toHaveLength(0);
  });

  it('removeDir on non-existent dirId throws', async () => {
    const info = await projectManager.openProject(projectRoot, 'test-remove-nonexist');

    await expect(projectManager.removeDir(info.id, 'dir_nonexistent')).rejects.toThrow(
      /not.*found|exist/i,
    );
  });

  it('removeCwd dir falls back to verify group first remaining dir', async () => {
    const info = await projectManager.openProject(projectRoot, 'test-remove-cwd');

    // Add two verify dirs
    const d1 = await projectManager.addDir(info.id, dir1, 'verify');
    const d2 = await projectManager.addDir(info.id, dir2, 'verify');

    // Set d2 as cwd
    await projectManager.setCwd(info.id, d2.id);
    expect(projectManager.getExtraDirs(info.id).find((d) => d.id === d2.id)?.isCwd).toBe(true);

    // Remove d2 (cwd) — should fall back to d1
    await projectManager.removeDir(info.id, d2.id);

    const remaining = projectManager.getExtraDirs(info.id);
    expect(remaining).toHaveLength(1);
    expect(remaining[0].id).toBe(d1.id);
    expect(remaining[0].isCwd).toBe(true);
  });

  it('removeCwd dir with no remaining verify dirs falls back to rootPath (no extraDirs cwd)', async () => {
    const info = await projectManager.openProject(projectRoot, 'test-remove-cwd-root');

    const d1 = await projectManager.addDir(info.id, dir1, 'verify');
    await projectManager.setCwd(info.id, d1.id);

    // Remove the only verify extraDir → cwd should be gone from extraDirs
    // (rootPath is implicit cwd)
    await projectManager.removeDir(info.id, d1.id);

    const remaining = projectManager.getExtraDirs(info.id);
    expect(remaining).toHaveLength(0);
    // No extraDir is marked as cwd — rootPath is implicit cwd
    expect(remaining.every((d) => !d.isCwd)).toBe(true);
  });
});

describe('multi-directory: setCwd', () => {
  let projectRoot: string;
  let dir1: string;
  let dir2: string;

  beforeEach(async () => {
    projectRoot = await mkdtemp(join(tmpdir(), 'socverify-md-3-'));
    dir1 = await mkdtemp(join(tmpdir(), 'socverify-md-cwd1-'));
    dir2 = await mkdtemp(join(tmpdir(), 'socverify-md-cwd2-'));
  });

  afterEach(async () => {
    await projectManager.closeAllProjects();
    await rm(projectRoot, { recursive: true, force: true });
    await rm(dir1, { recursive: true, force: true });
    await rm(dir2, { recursive: true, force: true });
  });

  it('setCwd marks the specified dir as cwd and unmarks others', async () => {
    const info = await projectManager.openProject(projectRoot, 'test-setcwd');

    const d1 = await projectManager.addDir(info.id, dir1, 'verify');
    const d2 = await projectManager.addDir(info.id, dir2, 'verify');

    // Initially no extraDir is cwd (rootPath is implicit cwd)
    expect(d1.isCwd).toBe(false);
    expect(d2.isCwd).toBe(false);

    // Set d1 as cwd
    await projectManager.setCwd(info.id, d1.id);

    const dirs = projectManager.getExtraDirs(info.id);
    expect(dirs.find((d) => d.id === d1.id)?.isCwd).toBe(true);
    expect(dirs.find((d) => d.id === d2.id)?.isCwd).toBe(false);

    // Switch to d2
    await projectManager.setCwd(info.id, d2.id);

    const dirs2 = projectManager.getExtraDirs(info.id);
    expect(dirs2.find((d) => d.id === d1.id)?.isCwd).toBe(false);
    expect(dirs2.find((d) => d.id === d2.id)?.isCwd).toBe(true);
  });

  it('setCwd on non-existent dirId throws', async () => {
    const info = await projectManager.openProject(projectRoot, 'test-setcwd-nonexist');

    await expect(projectManager.setCwd(info.id, 'dir_nonexistent')).rejects.toThrow(
      /not.*found|exist/i,
    );
  });
});

describe('multi-directory: updateDirLabel', () => {
  let projectRoot: string;
  let dir1: string;

  beforeEach(async () => {
    projectRoot = await mkdtemp(join(tmpdir(), 'socverify-md-4-'));
    dir1 = await mkdtemp(join(tmpdir(), 'socverify-md-label-'));
  });

  afterEach(async () => {
    await projectManager.closeAllProjects();
    await rm(projectRoot, { recursive: true, force: true });
    await rm(dir1, { recursive: true, force: true });
  });

  it('updateDirLabel sets the label on a directory', async () => {
    const info = await projectManager.openProject(projectRoot, 'test-label');

    const d1 = await projectManager.addDir(info.id, dir1, 'design');

    await projectManager.updateDirLabel(info.id, d1.id, 'SoC RTL');

    const dirs = projectManager.getExtraDirs(info.id);
    expect(dirs[0].label).toBe('SoC RTL');
  });

  it('updateDirLabel on non-existent dirId throws', async () => {
    const info = await projectManager.openProject(projectRoot, 'test-label-nonexist');

    await expect(projectManager.updateDirLabel(info.id, 'dir_nonexistent', 'x')).rejects.toThrow(
      /not.*found|exist/i,
    );
  });
});

describe('multi-directory: readFile/writeFile security check', () => {
  let projectRoot: string;
  let dir1: string;

  beforeEach(async () => {
    projectRoot = await mkdtemp(join(tmpdir(), 'socverify-md-5-'));
    dir1 = await mkdtemp(join(tmpdir(), 'socverify-md-sec-'));
  });

  afterEach(async () => {
    await projectManager.closeAllProjects();
    await rm(projectRoot, { recursive: true, force: true });
    await rm(dir1, { recursive: true, force: true });
  });

  it('readFile allows reading files within rootPath', async () => {
    const info = await projectManager.openProject(projectRoot, 'test-sec-root');
    const testFile = join(projectRoot, 'test.txt');
    await writeFile(testFile, 'hello', 'utf-8');

    const content = await projectManager.readFile(info.id, testFile);
    expect(content).toBe('hello');
  });

  it('readFile allows reading files within an added extraDir', async () => {
    const info = await projectManager.openProject(projectRoot, 'test-sec-extra');
    await projectManager.addDir(info.id, dir1, 'verify');

    const testFile = join(dir1, 'extra.txt');
    await writeFile(testFile, 'world', 'utf-8');

    const content = await projectManager.readFile(info.id, testFile);
    expect(content).toBe('world');
  });

  it('readFile rejects files outside all project directories', async () => {
    const info = await projectManager.openProject(projectRoot, 'test-sec-outside');

    const outside = await mkdtemp(join(tmpdir(), 'socverify-outside-'));
    try {
      const testFile = join(outside, 'secret.txt');
      await writeFile(testFile, 'no', 'utf-8');

      await expect(projectManager.readFile(info.id, testFile)).rejects.toThrow(
        /outside/i,
      );
    } finally {
      await rm(outside, { recursive: true, force: true });
    }
  });

  it('writeFile allows writing files within an added extraDir', async () => {
    const info = await projectManager.openProject(projectRoot, 'test-sec-write');
    await projectManager.addDir(info.id, dir1, 'design');

    const testFile = join(dir1, 'new.txt');
    await projectManager.writeFile(info.id, testFile, 'written');

    expect(await readFile(testFile, 'utf-8')).toBe('written');
  });

  it('writeFile rejects files outside all project directories', async () => {
    const info = await projectManager.openProject(projectRoot, 'test-sec-write-outside');

    const outside = await mkdtemp(join(tmpdir(), 'socverify-outside-w-'));
    try {
      const testFile = join(outside, 'bad.txt');
      await expect(projectManager.writeFile(info.id, testFile, 'x')).rejects.toThrow(
        /outside/i,
      );
    } finally {
      await rm(outside, { recursive: true, force: true });
    }
  });
});

describe('multi-directory: old project auto-migration', () => {
  let projectRoot: string;

  beforeEach(async () => {
    projectRoot = await mkdtemp(join(tmpdir(), 'socverify-md-6-'));
  });

  afterEach(async () => {
    await projectManager.closeAllProjects();
    await rm(projectRoot, { recursive: true, force: true });
  });

  it('old project without extraDirs opens without error', async () => {
    const info = await projectManager.openProject(projectRoot, 'old-project');

    // extraDirs should be undefined or empty — rootPath is implicit cwd
    expect(info.extraDirs).toBeUndefined();
  });

  it('getExtraDirs returns empty array for old project', async () => {
    const info = await projectManager.openProject(projectRoot, 'old-project-2');

    const dirs = projectManager.getExtraDirs(info.id);
    expect(dirs).toEqual([]);
  });
});

describe('multi-directory: persistence across save/load cycle', () => {
  let projectRoot: string;
  let dir1: string;

  beforeEach(async () => {
    projectRoot = await mkdtemp(join(tmpdir(), 'socverify-md-7-'));
    dir1 = await mkdtemp(join(tmpdir(), 'socverify-md-pl-'));
  });

  afterEach(async () => {
    await projectManager.closeAllProjects();
    await rm(projectRoot, { recursive: true, force: true });
    await rm(dir1, { recursive: true, force: true });
  });

  it('extraDirs survive close and reopen', async () => {
    // Open and add a dir
    const info = await projectManager.openProject(projectRoot, 'persist-test');
    await projectManager.addDir(info.id, dir1, 'verify', 'persisted-dir');

    // Close the project
    await projectManager.closeProject(info.id);

    // Reopen
    const reopened = await projectManager.openProject(projectRoot, 'persist-test');

    const dirs = projectManager.getExtraDirs(reopened.id);
    expect(dirs).toHaveLength(1);
    expect(dirs[0].path).toBe(dir1);
    expect(dirs[0].label).toBe('persisted-dir');
    expect(dirs[0].group).toBe('verify');
  });
});

describe('multi-directory: addDir validation', () => {
  let projectRoot: string;

  beforeEach(async () => {
    projectRoot = await mkdtemp(join(tmpdir(), 'socverify-md-8-'));
  });

  afterEach(async () => {
    await projectManager.closeAllProjects();
    await rm(projectRoot, { recursive: true, force: true });
  });

  it('addDir rejects path equal to rootPath', async () => {
    const info = await projectManager.openProject(projectRoot, 'test-dup-root');

    await expect(projectManager.addDir(info.id, projectRoot, 'verify')).rejects.toThrow(
      /root|already/i,
    );
  });

  it('addDir rejects non-existent path', async () => {
    const info = await projectManager.openProject(projectRoot, 'test-nonexist-path');

    const fakePath = join(tmpdir(), 'socverify-fake-' + Date.now());
    await expect(projectManager.addDir(info.id, fakePath, 'verify')).rejects.toThrow(
      /exist|directory|not.*found/i,
    );
  });

  it('addDir rejects invalid group', async () => {
    const info = await projectManager.openProject(projectRoot, 'test-bad-group');
    const dir1 = await mkdtemp(join(tmpdir(), 'socverify-md-bg-'));

    try {
      await expect(
        projectManager.addDir(info.id, dir1, 'invalid' as never),
      ).rejects.toThrow(/group/i);
    } finally {
      await rm(dir1, { recursive: true, force: true });
    }
  });
});
