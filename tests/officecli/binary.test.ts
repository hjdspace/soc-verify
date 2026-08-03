import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

// Mock node:fs 和 node:child_process，避免真实文件系统和进程调用
vi.mock('node:fs', () => ({
  existsSync: vi.fn(),
}));

vi.mock('node:child_process', () => ({
  execFileSync: vi.fn(),
}));

import { existsSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { resolveOfficecliPath, isOfficecliInstalled } from '../../src/main/officecli/binary';

const mockExistsSync = vi.mocked(existsSync);
const mockExecFileSync = vi.mocked(execFileSync);

/** 当前平台预期的二进制文件名 */
function expectedBundledName(): string {
  const platform = process.platform;
  const arch = process.arch;
  const platformName = platform === 'win32' ? 'win' : platform === 'darwin' ? 'mac' : 'linux';
  return `officecli-${platformName}-${arch}${platform === 'win32' ? '.exe' : ''}`;
}

/** 当前平台预期的用户级安装文件名 */
function expectedInstalledName(): string {
  return `officecli${process.platform === 'win32' ? '.exe' : ''}`;
}

describe('officecli/binary - resolveOfficecliPath', () => {
  let originalResourcesPath: string | undefined;

  beforeEach(() => {
    vi.clearAllMocks();
    mockExistsSync.mockReturnValue(false);
    mockExecFileSync.mockImplementation(() => {
      throw new Error('not found');
    });
    // 保存原始 process.resourcesPath
    originalResourcesPath = (process as NodeJS.Process & { resourcesPath?: string }).resourcesPath;
  });

  afterEach(() => {
    // 恢复 process.resourcesPath
    (process as unknown as { resourcesPath?: string }).resourcesPath = originalResourcesPath;
  });

  it('优先返回 packaged 内置二进制（生产模式）', () => {
    const fakeResources = '/fake/electron/resources';
    (process as NodeJS.Process & { resourcesPath?: string }).resourcesPath = fakeResources;

    const bundledName = expectedBundledName();

    // packaged 目录和文件都"存在"（路径包含 fakeResources），dev 不存在
    mockExistsSync.mockImplementation((p) => {
      const s = String(p).replace(/\\/g, '/');
      return s.includes(fakeResources);
    });

    const result = resolveOfficecliPath();
    expect(result).toBeTruthy();
    // 规范化后比较
    expect(String(result).replace(/\\/g, '/')).toContain(fakeResources);
    expect(result).toContain(bundledName);
  });

  it('packaged 不存在时回退到 dev 二进制（开发模式）', () => {
    (process as NodeJS.Process & { resourcesPath?: string }).resourcesPath = '/fake/electron/resources';

    const bundledName = expectedBundledName();

    // 只有 dev "存在"（路径不含 /fake/electron 但含 resources/binaries）
    mockExistsSync.mockImplementation((p) => {
      const s = String(p).replace(/\\/g, '/');
      return !s.includes('/fake/electron') && s.includes('resources/binaries');
    });

    const result = resolveOfficecliPath();
    expect(result).toBeTruthy();
    expect(String(result).replace(/\\/g, '/')).not.toContain('/fake/electron');
    expect(result).toContain(bundledName);
  });

  it('内置二进制都不存在时回退到用户级安装', () => {
    (process as NodeJS.Process & { resourcesPath?: string }).resourcesPath = '/fake/electron/resources';

    const installedName = expectedInstalledName();

    // 只有用户级安装"存在"（路径包含 .officecli/bin）
    mockExistsSync.mockImplementation((p) => {
      return String(p).includes('.officecli');
    });

    const result = resolveOfficecliPath();
    expect(result).toBeTruthy();
    expect(result).toContain('.officecli');
    expect(result).toContain(installedName);
  });

  it('内置和用户级都不存在时回退到系统 PATH', () => {
    (process as NodeJS.Process & { resourcesPath?: string }).resourcesPath = '/fake/electron/resources';
    mockExistsSync.mockReturnValue(false);
    mockExecFileSync.mockReturnValue('/usr/local/bin/officecli\n');

    const result = resolveOfficecliPath();
    expect(result).toBe('/usr/local/bin/officecli');
  });

  it('PATH 查找返回多个路径时取第一个', () => {
    mockExistsSync.mockReturnValue(false);
    mockExecFileSync.mockReturnValue('/usr/local/bin/officecli\n/opt/homebrew/bin/officecli\n');

    const result = resolveOfficecliPath();
    expect(result).toBe('/usr/local/bin/officecli');
  });

  it('全部不可用时返回 null', () => {
    (process as NodeJS.Process & { resourcesPath?: string }).resourcesPath = '/fake/electron/resources';
    mockExistsSync.mockReturnValue(false);
    mockExecFileSync.mockImplementation(() => {
      throw new Error('not found');
    });

    expect(resolveOfficecliPath()).toBeNull();
  });

  it('PATH 查找命令失败时返回 null（which/where 抛错）', () => {
    mockExistsSync.mockReturnValue(false);
    mockExecFileSync.mockImplementation(() => {
      throw new Error('command not found');
    });

    expect(resolveOfficecliPath()).toBeNull();
  });
});

describe('officecli/binary - isOfficecliInstalled', () => {
  let originalResourcesPath: string | undefined;

  beforeEach(() => {
    vi.clearAllMocks();
    mockExistsSync.mockReturnValue(false);
    mockExecFileSync.mockImplementation(() => {
      throw new Error('not found');
    });
    originalResourcesPath = (process as NodeJS.Process & { resourcesPath?: string }).resourcesPath;
  });

  afterEach(() => {
    (process as unknown as { resourcesPath?: string }).resourcesPath = originalResourcesPath;
  });

  it('找到二进制时返回 true', () => {
    const fakeResources = '/fake/electron/resources';
    (process as NodeJS.Process & { resourcesPath?: string }).resourcesPath = fakeResources;

    mockExistsSync.mockImplementation((p) => {
      const s = String(p).replace(/\\/g, '/');
      return s.includes(fakeResources);
    });

    expect(isOfficecliInstalled()).toBe(true);
  });

  it('找不到二进制时返回 false', () => {
    mockExistsSync.mockReturnValue(false);
    mockExecFileSync.mockImplementation(() => {
      throw new Error('not found');
    });

    expect(isOfficecliInstalled()).toBe(false);
  });
});
