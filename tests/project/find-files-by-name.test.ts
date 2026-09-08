/**
 * projectManager.findFilesByName — 引用点击回退的按名模糊查找。
 *
 * 覆盖场景：
 * - 裸文件名（AI 只写文件名的引用）→ 找到项目内嵌套的真实文件
 * - 带目录的相对路径后缀 → 按路径后缀匹配
 * - `../` 基准目录前缀被剥离后再匹配
 * - 绝对路径引用 → 退化为按裸文件名匹配
 * - 多个同名文件 → 按（深度, 路径长度）升序，最浅匹配在前
 * - node_modules / .git 等重目录被跳过
 * - 额外目录（extraDirs）也参与查找
 * - extraDir 嵌套在项目根内时结果去重
 * - 项目不存在 / 无匹配 → 空数组
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

describe('projectManager.findFilesByName', () => {
  let projectRoot: string;
  let projectId: string;
  let extraDir: string;

  beforeEach(async () => {
    projectRoot = await mkdtemp(join(tmpdir(), 'socverify-findfile-'));
    extraDir = await mkdtemp(join(tmpdir(), 'socverify-findfile-extra-'));
    const info = await projectManager.openProject(projectRoot, 'test-find-file');
    projectId = info.id;
    await projectManager.addDir(projectId, extraDir, 'verify');
  });

  afterEach(async () => {
    await projectManager.closeAllProjects();
    await rm(projectRoot, { recursive: true, force: true });
    await rm(extraDir, { recursive: true, force: true });
  });

  it('finds a nested file by bare filename (AI only writes the name)', async () => {
    const nested = join(projectRoot, 'src', 'renderer', 'styles');
    await mkdir(nested, { recursive: true });
    await writeFile(join(nested, 'globals.css'), 'body {}', 'utf-8');

    await expect(projectManager.findFilesByName(projectId, 'globals.css')).resolves.toEqual([
      join(nested, 'globals.css'),
    ]);
  });

  it('matches by relative path suffix when the reference carries directories', async () => {
    const dir = join(projectRoot, 'src', 'config');
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, 'settings.ts'), 'export {}', 'utf-8');
    // 同名文件在别的目录也存在——只有带目录后缀的那个应命中
    await mkdir(join(projectRoot, 'other'), { recursive: true });
    await writeFile(join(projectRoot, 'other', 'settings.ts'), 'export {}', 'utf-8');

    const matches = await projectManager.findFilesByName(projectId, 'src/config/settings.ts');
    expect(matches).toHaveLength(1);
    expect(matches[0]).toBe(join(dir, 'settings.ts'));
  });

  it('orders multiple matches shallowest first', async () => {
    await mkdir(join(projectRoot, 'deep', 'a', 'b'), { recursive: true });
    await writeFile(join(projectRoot, 'core.sv'), 'module top();', 'utf-8');
    await writeFile(join(projectRoot, 'deep', 'a', 'b', 'core.sv'), 'module sub();', 'utf-8');

    const matches = await projectManager.findFilesByName(projectId, 'core.sv');
    expect(matches).toHaveLength(2);
    expect(matches[0]).toBe(join(projectRoot, 'core.sv'));
  });

  it('skips node_modules and .git while searching', async () => {
    await mkdir(join(projectRoot, 'node_modules', 'pkg'), { recursive: true });
    await mkdir(join(projectRoot, '.git', 'hooks'), { recursive: true });
    await mkdir(join(projectRoot, 'src'), { recursive: true });
    await writeFile(join(projectRoot, 'node_modules', 'pkg', 'index.js'), 'x', 'utf-8');
    await writeFile(join(projectRoot, '.git', 'hooks', 'pre-commit'), 'x', 'utf-8');
    await writeFile(join(projectRoot, 'src', 'index.js'), 'x', 'utf-8');

    await expect(projectManager.findFilesByName(projectId, 'index.js')).resolves.toEqual([
      join(projectRoot, 'src', 'index.js'),
    ]);
  });

  it('searches extra directories as well as the project root', async () => {
    await mkdir(join(extraDir, 'sub'), { recursive: true });
    await writeFile(join(extraDir, 'sub', 'notes.md'), 'note', 'utf-8');

    await expect(projectManager.findFilesByName(projectId, 'notes.md')).resolves.toEqual([
      join(extraDir, 'sub', 'notes.md'),
    ]);
  });

  it('is case-insensitive when matching names', async () => {
    await mkdir(join(projectRoot, 'src'), { recursive: true });
    await writeFile(join(projectRoot, 'src', 'Global.CSS'), 'body {}', 'utf-8');

    await expect(projectManager.findFilesByName(projectId, 'global.css')).resolves.toEqual([
      join(projectRoot, 'src', 'Global.CSS'),
    ]);
  });

  it('strips ../ base-directory prefixes before matching', async () => {
    // AI 以子目录为基准写 ../rtl/core.sv，真实路径不含 .. 段
    const rtl = join(projectRoot, 'rtl');
    await mkdir(rtl, { recursive: true });
    await writeFile(join(rtl, 'core.sv'), 'module core();', 'utf-8');

    await expect(projectManager.findFilesByName(projectId, '../rtl/core.sv')).resolves.toEqual([
      join(rtl, 'core.sv'),
    ]);
  });

  it('falls back to bare filename for absolute-path references', async () => {
    const dir = join(projectRoot, 'tb');
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, 'top.sv'), 'module top();', 'utf-8');

    // 绝对路径在项目外（如 /proj/xxx/view/tb/top.sv），全路径后缀匹配不到，
    // 退化为按裸文件名匹配项目内文件
    await expect(projectManager.findFilesByName(projectId, '/proj/other/user/view/tb/top.sv')).resolves.toEqual([
      join(dir, 'top.sv'),
    ]);
  });

  it('deduplicates matches when an extraDir is nested inside the project root', async () => {
    // extraDir 允许嵌套在 rootPath 内——同一文件被两个根扫到，结果仍只出现一次
    const nested = join(projectRoot, 'dv');
    await mkdir(join(nested, 'tb'), { recursive: true });
    await writeFile(join(nested, 'tb', 'top.sv'), 'module top();', 'utf-8');
    await projectManager.addDir(projectId, nested, 'verify');

    await expect(projectManager.findFilesByName(projectId, 'tb/top.sv')).resolves.toEqual([
      join(nested, 'tb', 'top.sv'),
    ]);
  });

  it('returns empty for a name that matches nothing', async () => {
    await expect(projectManager.findFilesByName(projectId, 'Tavily.md')).resolves.toEqual([]);
  });

  it('returns empty for an unknown project', async () => {
    await expect(projectManager.findFilesByName('proj_missing', 'globals.css')).resolves.toEqual([]);
  });
});
