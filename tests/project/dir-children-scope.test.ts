/**
 * 验证/设计分组目录（extraDirs）的懒加载作用域契约。
 *
 * 背景：FileDrawer 中验证/设计分组下的目录可能位于项目根之外。懒加载展开
 * （getDirChildren）必须携带 dirId 按目录作用域校验；不携带时后端按项目根
 * 校验，项目根外的路径会被拒绝（曾导致 UI 展开后无子项）。
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
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

describe('getDirChildren extra-dir scope', () => {
  let projectRoot: string;
  let extraRoot: string;

  beforeEach(async () => {
    projectRoot = await mkdtemp(join(tmpdir(), 'socverify-proj-'));
    // 独立的临时目录，模拟「设计」分组下位于项目根之外的目录
    extraRoot = await mkdtemp(join(tmpdir(), 'socverify-extra-'));
  });

  afterEach(async () => {
    await projectManager.closeAllProjects();
    await rm(projectRoot, { recursive: true, force: true });
    await rm(extraRoot, { recursive: true, force: true });
  });

  it('returns children for an out-of-root extra dir when dirId is provided', async () => {
    await mkdir(join(extraRoot, 'rtl'), { recursive: true });
    await writeFile(join(extraRoot, 'rtl', 'a.sv'), '// a\n');

    const info = await projectManager.openProject(projectRoot);
    const entry = await projectManager.addDir(info.id, extraRoot, 'design');

    // 第一级由 getDirFileTree 加载，子目录标记 lazy
    const tree = await projectManager.getDirFileTree(info.id, entry.id);
    const rtl = tree.children?.find((c) => c.name === 'rtl');
    expect(rtl?.type).toBe('directory');
    expect(rtl?.lazy).toBe(true);

    // 展开（携带 dirId）→ 正常返回子项
    const children = await projectManager.getDirChildren(info.id, rtl!.path, entry.id);
    expect(children.map((c) => c.name)).toEqual(['a.sv']);
  });

  it('auto-resolves extra-dir scope when dirId is omitted (breadcrumb path)', async () => {
    await mkdir(join(extraRoot, 'rtl'), { recursive: true });
    await writeFile(join(extraRoot, 'rtl', 'c.sv'), '// c\n');
    const info = await projectManager.openProject(projectRoot);
    await projectManager.addDir(info.id, extraRoot, 'design');

    // 不带 dirId：路径位于已添加的额外目录内 → 自动解析作用域并返回子项
    const children = await projectManager.getDirChildren(info.id, join(extraRoot, 'rtl'));
    expect(children.map((c) => c.name)).toEqual(['c.sv']);

    // 额外目录根本身也可列出（面包屑导航到目录段）
    const rootLevel = await projectManager.getDirChildren(info.id, extraRoot);
    expect(rootLevel.some((c) => c.name === 'rtl')).toBe(true);

    // 完全不在任何已添加目录内的路径仍然拒绝
    const stranger = await mkdtemp(join(tmpdir(), 'socverify-stranger-'));
    try {
      await expect(
        projectManager.getDirChildren(info.id, stranger),
      ).rejects.toThrow(/outside/i);
    } finally {
      await rm(stranger, { recursive: true, force: true });
    }
  });

  it('rejects paths outside the extra dir even with its dirId', async () => {
    const info = await projectManager.openProject(projectRoot);
    const entry = await projectManager.addDir(info.id, extraRoot, 'design');

    // 项目根不在额外目录作用域内
    await expect(
      projectManager.getDirChildren(info.id, join(projectRoot, 'anything'), entry.id),
    ).rejects.toThrow(/outside directory scope/i);
  });
});
