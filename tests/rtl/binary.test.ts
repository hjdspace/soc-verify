/**
 * rtl/binary 路径解析与降级逻辑测试（对齐 tests/officecli/binary.test.ts 的 mock 模式）。
 *
 * mock node:fs existsSync + node:child_process execFileSync，
 * 验证：内置 packaged → dev 回退 → PATH 回退；yosys DLL 完整性检查；
 * getRtlToolsStatus 三工具可用性汇总。
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

vi.mock('node:fs', () => ({
  existsSync: vi.fn(),
}));

vi.mock('node:child_process', () => ({
  execFileSync: vi.fn(),
}));

import { existsSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import {
  resolveYosysPath,
  resolveSlangServerPath,
  resolveVeribleLintPath,
  yosysMissingDlls,
  getRtlToolsStatus,
  YOSYS_DLLS,
} from '../../src/main/rtl/binary';

const mockExistsSync = vi.mocked(existsSync);
const mockExecFileSync = vi.mocked(execFileSync);

/** 路径统一为正斜杠便于断言 */
function norm(p: unknown): string {
  return String(p).replace(/\\/g, '/');
}

const FAKE_RESOURCES = '/fake/electron/resources';

/** 让指定 binaries 子目录及其中的文件"存在"（同时匹配 .exe 与无扩展名候选） */
function makeDirExist(dirSuffix: string, files: string[]): void {
  mockExistsSync.mockImplementation((p) => {
    const s = norm(p);
    if (!s.includes(FAKE_RESOURCES)) return false;
    const dir = `${FAKE_RESOURCES}/binaries/${dirSuffix}`;
    if (s === dir) return true;
    return files.some((f) => {
      const base = f.replace(/\.exe$/, '');
      return s === `${dir}/${base}` || s === `${dir}/${base}.exe`;
    });
  });
}

describe('rtl/binary - resolveYosysPath', () => {
  let originalResourcesPath: string | undefined;

  beforeEach(() => {
    vi.clearAllMocks();
    mockExistsSync.mockReturnValue(false);
    mockExecFileSync.mockImplementation(() => {
      throw new Error('not found');
    });
    originalResourcesPath = (process as NodeJS.Process & { resourcesPath?: string }).resourcesPath;
    (process as unknown as { resourcesPath?: string }).resourcesPath = FAKE_RESOURCES;
  });

  afterEach(() => {
    (process as unknown as { resourcesPath?: string }).resourcesPath = originalResourcesPath;
  });

  it('优先返回 packaged 内置 yosys', () => {
    makeDirExist('yosys', ['yosys.exe']);
    const result = resolveYosysPath();
    expect(result).toBeTruthy();
    expect(norm(result)).toContain(FAKE_RESOURCES);
    expect(norm(result)).toContain('yosys/yosys');
  });

  it('packaged 不存在时回退到 dev resources/binaries', () => {
    mockExistsSync.mockImplementation((p) => {
      const s = norm(p);
      if (s.includes(FAKE_RESOURCES)) return false;
      return s.includes('resources/binaries/yosys');
    });
    const result = resolveYosysPath();
    expect(result).toBeTruthy();
    expect(norm(result)).not.toContain(FAKE_RESOURCES);
    expect(norm(result)).toContain('yosys/yosys');
  });

  it('内置不存在时回退到系统 PATH（开发模式）', () => {
    mockExecFileSync.mockReturnValue('C:\\tools\\yosys.exe\n');
    const result = resolveYosysPath();
    expect(norm(result)).toBe('C:/tools/yosys.exe');
  });

  it('全部不可用时返回 null', () => {
    expect(resolveYosysPath()).toBeNull();
  });
});

describe('rtl/binary - resolveSlangServerPath / resolveVeribleLintPath', () => {
  let originalResourcesPath: string | undefined;

  beforeEach(() => {
    vi.clearAllMocks();
    mockExistsSync.mockReturnValue(false);
    mockExecFileSync.mockImplementation(() => {
      throw new Error('not found');
    });
    originalResourcesPath = (process as NodeJS.Process & { resourcesPath?: string }).resourcesPath;
    (process as unknown as { resourcesPath?: string }).resourcesPath = FAKE_RESOURCES;
  });

  afterEach(() => {
    (process as unknown as { resourcesPath?: string }).resourcesPath = originalResourcesPath;
  });

  it('slang-server 从内置 slang-server 子目录解析', () => {
    makeDirExist('slang-server', ['slang-server.exe']);
    const result = resolveSlangServerPath();
    expect(result).toBeTruthy();
    expect(norm(result)).toContain('slang-server/slang-server');
  });

  it('verible lint 从内置 verible 子目录解析', () => {
    makeDirExist('verible', ['verible-verilog-lint.exe']);
    const result = resolveVeribleLintPath();
    expect(result).toBeTruthy();
    expect(norm(result)).toContain('verible/verible-verilog-lint');
  });

  it('缺失时回退 PATH', () => {
    mockExecFileSync.mockReturnValue('/usr/bin/verible-verilog-lint\n');
    expect(resolveVeribleLintPath()).toBe('/usr/bin/verible-verilog-lint');
  });
});

describe('rtl/binary - yosysMissingDlls', () => {
  let originalResourcesPath: string | undefined;

  beforeEach(() => {
    vi.clearAllMocks();
    mockExistsSync.mockReturnValue(false);
    mockExecFileSync.mockImplementation(() => {
      throw new Error('not found');
    });
    originalResourcesPath = (process as NodeJS.Process & { resourcesPath?: string }).resourcesPath;
    (process as unknown as { resourcesPath?: string }).resourcesPath = FAKE_RESOURCES;
  });

  afterEach(() => {
    (process as unknown as { resourcesPath?: string }).resourcesPath = originalResourcesPath;
  });

  it('DLL 集完整时返回空数组', () => {
    makeDirExist('yosys', ['yosys.exe', ...YOSYS_DLLS]);
    expect(yosysMissingDlls()).toEqual([]);
  });

  it('缺失 DLL 时返回缺失清单（S0：Windows DLL 必须与 exe 同目录）', () => {
    const missing = ['libstdc++-6.dll', 'zlib1.dll'];
    makeDirExist('yosys', ['yosys.exe', ...YOSYS_DLLS.filter((d) => !missing.includes(d))]);
    expect(yosysMissingDlls()).toEqual(missing);
  });

  it('exe 不存在时返回 null（无法判定）', () => {
    expect(yosysMissingDlls()).toBeNull();
  });

  it('PATH 回退的 yosys 不做 DLL 检查', () => {
    mockExecFileSync.mockReturnValue('C:\\tools\\yosys.exe\n');
    expect(yosysMissingDlls()).toEqual([]);
  });

  it('非 Windows 平台恒不检查 DLL（Linux yosys 为 ELF 链接系统库）', () => {
    const spy = vi.spyOn(process, 'platform', 'get').mockReturnValue('linux');
    try {
      // 缺失 DLL 的布局在 Linux 下也应返回空（无 DLL 集概念）
      makeDirExist('yosys', ['yosys']);
      expect(yosysMissingDlls()).toEqual([]);
    } finally {
      spy.mockRestore();
    }
  });
});

describe('rtl/binary - getRtlToolsStatus', () => {
  let originalResourcesPath: string | undefined;

  beforeEach(() => {
    vi.clearAllMocks();
    mockExistsSync.mockReturnValue(false);
    mockExecFileSync.mockImplementation(() => {
      throw new Error('not found');
    });
    originalResourcesPath = (process as NodeJS.Process & { resourcesPath?: string }).resourcesPath;
    (process as unknown as { resourcesPath?: string }).resourcesPath = FAKE_RESOURCES;
  });

  afterEach(() => {
    (process as unknown as { resourcesPath?: string }).resourcesPath = originalResourcesPath;
  });

  it('三工具全缺失时全部不可用（UI 降级提示数据源）', () => {
    const status = getRtlToolsStatus();
    expect(status.yosys).toEqual({ available: false, path: null, missingDlls: [] });
    expect(status.slangServer).toEqual({ available: false, path: null });
    expect(status.verible).toEqual({ available: false, lintPath: null, formatPath: null });
  });

  it('yosys DLL 缺失时按不可用处理并报告清单', { skip: process.platform !== 'win32' }, () => {
    makeDirExist('yosys', ['yosys.exe', ...YOSYS_DLLS.slice(1)]);
    const status = getRtlToolsStatus();
    expect(status.yosys.available).toBe(false);
    expect(status.yosys.missingDlls).toEqual([YOSYS_DLLS[0]]);
  });

  it('三工具齐备时全部可用', () => {
    mockExistsSync.mockImplementation((p) => {
      const s = norm(p);
      return (
        s.includes('binaries/yosys') ||
        s.includes('binaries/slang-server') ||
        s.includes('binaries/verible')
      );
    });
    const status = getRtlToolsStatus();
    expect(status.yosys.available).toBe(true);
    expect(status.slangServer.available).toBe(true);
    expect(status.verible.available).toBe(true);
    expect(status.verible.lintPath).toBeTruthy();
    expect(status.verible.formatPath).toBeTruthy();
  });

  it('verible 仅有 lint 缺 format 时按不可用处理', () => {
    makeDirExist('verible', ['verible-verilog-lint.exe']);
    const status = getRtlToolsStatus();
    expect(status.verible.available).toBe(false);
    expect(status.verible.lintPath).toBeTruthy();
    expect(status.verible.formatPath).toBeNull();
  });
});
