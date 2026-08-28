/**
 * `~` 前缀 home 简写路径支持测试。
 *
 * Agent（omp）以用户身份运行，工具参数里可能出现 `~/.claude/skills/...` 这类
 * home 简写路径。Node fs 不识别 `~`，此前渲染层把 `~` 当字面目录名拼进项目根，
 * 点击工具卡路径后以 `<root>/~/.claude/...` 加载报 ENOENT。
 *
 * 覆盖场景：
 * - expandTildePath 仅展开 `~` / `~/` 前缀，`~user` 形式与普通路径不动
 * - readFile / writeFile 对 `~` 路径按 home 目录读写，不受项目目录沙箱限制
 * - 非 `~` 的项目外路径仍被拒绝（沙箱行为不变）
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtemp, rm, writeFile as fsWriteFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir, homedir } from 'node:os';
import { randomBytes } from 'node:crypto';

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

import { projectManager, expandTildePath, isTildePath } from '../../src/main/project/project-manager';
import type { ProjectInfo } from '@shared/types';

describe('expandTildePath / isTildePath', () => {
  it('detects tilde shorthand paths', () => {
    expect(isTildePath('~')).toBe(true);
    expect(isTildePath('~/.claude/skills/tdd/tests.md')).toBe(true);
    expect(isTildePath('~\\.claude\\tests.md')).toBe(true);
    expect(isTildePath('D:/proj/core.sv')).toBe(false);
    expect(isTildePath('~user/x')).toBe(false);
  });

  it('expands tilde paths to the home directory and leaves others untouched', () => {
    expect(expandTildePath('~')).toBe(join(homedir(), ''));
    expect(expandTildePath('~/.claude/tests.md')).toBe(join(homedir(), '.claude/tests.md'));
    expect(expandTildePath('~\\.claude\\tests.md')).toBe(join(homedir(), '.claude\\tests.md'));
    expect(expandTildePath('D:/proj/core.sv')).toBe('D:/proj/core.sv');
    expect(expandTildePath('~user/x')).toBe('~user/x');
  });
});

describe('projectManager readFile/writeFile with tilde paths', () => {
  let projectRoot: string;
  let project: ProjectInfo;
  let homeMarker: string;
  let tildeMarker: string;

  beforeEach(async () => {
    projectRoot = await mkdtemp(join(tmpdir(), 'socverify-tilde-'));
    project = await projectManager.openProject(projectRoot, 'tilde-test');
    // 在真实 home 下放置标记文件（测试后清理），验证 `~/` 读写走 home 目录
    homeMarker = join(homedir(), `.socverify-tilde-test-${randomBytes(4).toString('hex')}`);
    tildeMarker = `~/${homeMarker.replace(/\\/g, '/').split('/').pop()}`;
    await fsWriteFile(homeMarker, 'tilde content', 'utf-8');
  });

  afterEach(async () => {
    await projectManager.closeAllProjects();
    await rm(projectRoot, { recursive: true, force: true });
    await rm(homeMarker, { force: true });
  });

  it('reads a ~ path from the home directory even though it is outside the project', async () => {
    await expect(projectManager.readFile(project.id, tildeMarker)).resolves.toBe('tilde content');
  });

  it('writes a ~ path into the home directory', async () => {
    await projectManager.writeFile(project.id, tildeMarker, 'updated by tilde test');
    await expect(projectManager.readFile(project.id, tildeMarker)).resolves.toBe('updated by tilde test');
  });

  it('still rejects non-tilde paths outside project directories', async () => {
    await expect(projectManager.readFile(project.id, homeMarker)).rejects.toThrow(
      'File path is outside project directories',
    );
  });
});
