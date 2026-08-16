import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

// Mock node:fs 与 node:child_process，避免真实文件系统和进程调用
vi.mock('node:fs', () => ({
  existsSync: vi.fn(),
}));

vi.mock('node:child_process', () => ({
  execFileSync: vi.fn(),
}));

import { existsSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { resolveDrawioPath, isDrawioInstalled } from '../../src/main/drawio/binary';

const mockExistsSync = vi.mocked(existsSync);
const mockExecFileSync = vi.mocked(execFileSync);

describe('drawio/binary - resolveDrawioPath', () => {
  let originalResourcesPath: string | undefined;
  let originalLocalAppData: string | undefined;

  beforeEach(() => {
    vi.clearAllMocks();
    mockExistsSync.mockReturnValue(false);
    mockExecFileSync.mockImplementation(() => {
      throw new Error('not found');
    });
    originalResourcesPath = (process as NodeJS.Process & { resourcesPath?: string }).resourcesPath;
    originalLocalAppData = process.env.LOCALAPPDATA;
  });

  afterEach(() => {
    (process as unknown as { resourcesPath?: string }).resourcesPath = originalResourcesPath;
    if (originalLocalAppData === undefined) delete process.env.LOCALAPPDATA;
    else process.env.LOCALAPPDATA = originalLocalAppData;
  });

  it('Linux 上优先返回内置二进制（packaged）', () => {
    const fakeResources = '/fake/electron/resources';
    (process as NodeJS.Process & { resourcesPath?: string }).resourcesPath = fakeResources;

    // 原测试运行在任意平台：内置路径仅 Linux 生成，这里直接验证目录拼接规则
    // 通过让 packaged 目录下的 drawio-linux-*/drawio "存在" 来覆盖 Linux 行为
    mockExistsSync.mockImplementation((p) => {
      const s = String(p).replace(/\\/g, '/');
      return process.platform === 'linux' && s.includes(fakeResources);
    });

    const result = resolveDrawioPath();
    if (process.platform === 'linux') {
      expect(result).toBeTruthy();
      expect(String(result).replace(/\\/g, '/')).toContain(fakeResources);
      expect(String(result)).toContain('drawio');
    } else {
      // 非 Linux 平台内置路径不参与，直接回退标准安装 / PATH
      expect(result).toBeNull();
    }
  });

  it('Windows 标准安装路径存在时返回该路径', () => {
    if (process.platform !== 'win32') return; // 平台相关用例
    const fakeLocalAppData = 'C:\\Users\\fake\\AppData\\Local';
    process.env.LOCALAPPDATA = fakeLocalAppData;

    mockExistsSync.mockImplementation((p) => {
      return String(p) === fakeLocalAppData + '\\Programs\\draw.io\\draw.io.exe';
    });

    const result = resolveDrawioPath();
    expect(result).toBe(fakeLocalAppData + '\\Programs\\draw.io\\draw.io.exe');
  });

  it('标准安装与内置都缺失时回退到系统 PATH（drawio）', () => {
    mockExistsSync.mockReturnValue(false);
    mockExecFileSync.mockReturnValue('/usr/local/bin/drawio\n');

    expect(resolveDrawioPath()).toBe('/usr/local/bin/drawio');
  });

  it('PATH 中无 drawio 时尝试 draw.io 候选名', () => {
    mockExistsSync.mockReturnValue(false);
    let calls = 0;
    // findInPath 用 execFileSync(cmd, [executable])：可执行名在第二参数
    mockExecFileSync.mockImplementation((_cmd: string, args?: readonly string[]) => {
      calls += 1;
      if ((args ?? [])[0] === 'drawio') throw new Error('not found');
      return '/usr/bin/draw.io\n';
    });

    expect(resolveDrawioPath()).toBe('/usr/bin/draw.io');
    expect(calls).toBe(2);
  });

  it('全部不可用时返回 null', () => {
    (process as NodeJS.Process & { resourcesPath?: string }).resourcesPath = '/fake/electron/resources';
    mockExistsSync.mockReturnValue(false);
    mockExecFileSync.mockImplementation(() => {
      throw new Error('not found');
    });

    expect(resolveDrawioPath()).toBeNull();
    expect(isDrawioInstalled()).toBe(false);
  });
});
