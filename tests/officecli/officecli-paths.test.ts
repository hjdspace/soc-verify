/**
 * officecli-paths PATH 注入测试（Issue #6）。
 *
 * 测试缝：mock node:fs/promises 和 node:fs，避免真实文件系统操作。
 * 验证 ensureOfficecliOnPath 的行为：
 *  - 注入 ~/.officecli/bin 到 env.PATH 前面
 *  - 同步内置二进制到用户安装目录
 *  - 避免重复注入
 *  - 源不存在时仍注入 PATH
 *  - 复制失败时仍注入 PATH
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { homedir } from 'node:os';
import { join } from 'node:path';

// Mock node:fs/promises（避免真实文件系统操作）
vi.mock('node:fs/promises', () => ({
  mkdir: vi.fn().mockResolvedValue(undefined),
  copyFile: vi.fn().mockResolvedValue(undefined),
  stat: vi.fn(),
  chmod: vi.fn().mockResolvedValue(undefined),
}));

// Mock node:fs（existsSync 用于 findInDir）
vi.mock('node:fs', () => ({
  existsSync: vi.fn(),
}));

import { mkdir, copyFile, stat, chmod } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { ensureOfficecliOnPath } from '../../src/main/agent/officecli-paths';

const mockMkdir = vi.mocked(mkdir);
const mockCopyFile = vi.mocked(copyFile);
const mockStat = vi.mocked(stat);
const mockChmod = vi.mocked(chmod);
const mockExistsSync = vi.mocked(existsSync);

/** 用户级安装目录（~/.officecli/bin） */
function officecliInstallDir(): string {
  return join(homedir(), '.officecli', 'bin');
}

/** 当前平台预期的内置二进制文件名（带平台后缀） */
function expectedBundledName(): string {
  const platform = process.platform;
  const arch = process.arch;
  const platformName = platform === 'win32' ? 'win' : platform === 'darwin' ? 'mac' : 'linux';
  return `officecli-${platformName}-${arch}${platform === 'win32' ? '.exe' : ''}`;
}

/** 当前平台预期的用户级安装文件名（无平台后缀） */
function expectedInstalledName(): string {
  return `officecli${process.platform === 'win32' ? '.exe' : ''}`;
}

describe('ensureOfficecliOnPath', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // 默认：所有文件不存在（无内置二进制、无用户安装）
    mockExistsSync.mockReturnValue(false);
    mockMkdir.mockResolvedValue(undefined);
    mockCopyFile.mockResolvedValue(undefined);
    mockChmod.mockResolvedValue(undefined);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('注入 ~/.officecli/bin 到 env.PATH 前面', async () => {
    const env: Record<string, string> = { PATH: '/usr/bin:/bin' };
    await ensureOfficecliOnPath(env);

    const installDir = officecliInstallDir();
    const pathSep = process.platform === 'win32' ? ';' : ':';
    expect(env.PATH).toBe(`${installDir}${pathSep}/usr/bin:/bin`);
  });

  it('源二进制不存在时仍注入 PATH（用户可能已手动安装）', async () => {
    mockExistsSync.mockReturnValue(false);
    const env: Record<string, string> = { PATH: '/usr/bin' };
    await ensureOfficecliOnPath(env);

    const installDir = officecliInstallDir();
    expect(env.PATH).toContain(installDir);
    // 不应调用 copyFile（无源文件）
    expect(mockCopyFile).not.toHaveBeenCalled();
  });

  it('源二进制存在时复制到用户安装目录', async () => {
    // 模拟内置二进制存在（dev 目录下）
    mockExistsSync.mockImplementation((path: unknown) => {
      const p = String(path);
      // dev binaries 目录及其下的内置二进制都存在
      return p.includes('resources') && p.includes('binaries');
    });
    // stat 返回源文件比目标新
    mockStat.mockImplementation((path: unknown) => {
      const p = String(path);
      if (p.includes(expectedBundledName())) {
        return Promise.resolve({ mtimeMs: 2000, size: 1000 } as never);
      }
      // 目标文件不存在
      return Promise.reject(new Error('not found'));
    });

    const env: Record<string, string> = { PATH: '/usr/bin' };
    await ensureOfficecliOnPath(env);

    // 应调用 copyFile 复制二进制
    expect(mockCopyFile).toHaveBeenCalledTimes(1);
    const copyArgs = mockCopyFile.mock.calls[0];
    const destPath = String(copyArgs[1]);
    expect(destPath).toContain(expectedInstalledName());
    expect(destPath).toContain('.officecli');
  });

  it('目标已是最新时跳过复制', async () => {
    mockExistsSync.mockImplementation((path: unknown) => {
      const p = String(path);
      return p.includes('resources') && p.includes('binaries');
    });
    // stat 返回目标比源新（mtimeMs 更大、size 相同）
    mockStat.mockImplementation((path: unknown) => {
      const p = String(path);
      if (p.includes(expectedBundledName())) {
        return Promise.resolve({ mtimeMs: 1000, size: 1000 } as never);
      }
      // 目标文件存在且更新
      return Promise.resolve({ mtimeMs: 2000, size: 1000 } as never);
    });

    const env: Record<string, string> = { PATH: '/usr/bin' };
    await ensureOfficecliOnPath(env);

    // 不应调用 copyFile（目标已是最新）
    expect(mockCopyFile).not.toHaveBeenCalled();
  });

  it('复制失败时仍注入 PATH', async () => {
    mockExistsSync.mockImplementation((path: unknown) => {
      const p = String(path);
      return p.includes('resources') && p.includes('binaries');
    });
    mockStat.mockImplementation(() => Promise.resolve({ mtimeMs: 1000, size: 1000 } as never));
    mockCopyFile.mockRejectedValue(new Error('permission denied'));

    const env: Record<string, string> = { PATH: '/usr/bin' };
    await ensureOfficecliOnPath(env);

    // 即使复制失败，PATH 仍应被注入
    const installDir = officecliInstallDir();
    expect(env.PATH).toContain(installDir);
  });

  it('避免重复注入（installDir 已在 PATH 最前面）', async () => {
    const installDir = officecliInstallDir();
    const pathSep = process.platform === 'win32' ? ';' : ':';
    const env: Record<string, string> = { PATH: `${installDir}${pathSep}/usr/bin` };
    const originalPath = env.PATH;
    await ensureOfficecliOnPath(env);

    // PATH 不应变（已注入）
    expect(env.PATH).toBe(originalPath);
  });

  it('env 无 PATH 键时使用 process.env.PATH 作为基础', async () => {
    const env: Record<string, string> = {};
    await ensureOfficecliOnPath(env);

    const installDir = officecliInstallDir();
    expect(env.PATH).toContain(installDir);
    // PATH 应以 installDir 开头
    expect(env.PATH!.startsWith(installDir)).toBe(true);
  });

  it('Unix 下复制后设置可执行权限', async () => {
    if (process.platform === 'win32') {
      // Windows 跳过此测试
      return;
    }
    mockExistsSync.mockImplementation((path: unknown) => {
      const p = String(path);
      return p.includes('resources') && p.includes('binaries');
    });
    mockStat.mockImplementation((path: unknown) => {
      const p = String(path);
      if (p.includes(expectedBundledName())) {
        return Promise.resolve({ mtimeMs: 2000, size: 1000 } as never);
      }
      return Promise.reject(new Error('not found'));
    });

    const env: Record<string, string> = { PATH: '/usr/bin' };
    await ensureOfficecliOnPath(env);

    // Unix 下应调用 chmod 设置 0o755
    expect(mockChmod).toHaveBeenCalledTimes(1);
    const chmodArgs = mockChmod.mock.calls[0];
    expect(chmodArgs[1]).toBe(0o755);
  });

  it('保留原有 PATH 条目', async () => {
    const env: Record<string, string> = { PATH: '/usr/bin:/bin:/usr/local/bin' };
    await ensureOfficecliOnPath(env);

    // 原 PATH 条目应保留
    expect(env.PATH).toContain('/usr/bin');
    expect(env.PATH).toContain('/bin');
    expect(env.PATH).toContain('/usr/local/bin');
  });

  it('调用 mkdir 确保用户安装目录存在', async () => {
    const env: Record<string, string> = { PATH: '/usr/bin' };
    await ensureOfficecliOnPath(env);

    const installDir = officecliInstallDir();
    expect(mockMkdir).toHaveBeenCalledWith(installDir, { recursive: true });
  });
});
