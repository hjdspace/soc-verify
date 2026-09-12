import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { existsSync, mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// 只包装 existsSync（默认真实实现），用于模拟"路径不存在"场景。
// paths.ts 以 `import { existsSync } from 'node:fs'` 引用，vitest 的
// 模块 mock 使该引用指向这里包装后的版本。
vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs')>();
  return { ...actual, existsSync: vi.fn(actual.existsSync) };
});

import * as paths from '../../src/main/agent/paths';
import { resolvePiRunnerScript, resolvePiSessionScanScript } from '../../src/main/agent/paths';

// ─── 旧 omp/Bun 构建链解析器必须已移除（issue 10）─────────────────
//
// omp 运行时（Bun compile 二进制 + native addon + engine submodule）在
// issue 10 移除后，仅为其服务的路径解析器不得再从 paths.ts 导出 ——
// 残留导出会让"回退旧 runner"的死代码路径在运行时复活。

describe('paths.ts 旧 omp/Bun 解析器移除（issue 10）', () => {
  const removedExports = [
    'resolveAgentRuntime',
    'resolveRunnerBinary',
    'resolveRunnerScript',
    'resolveRunnerPath',
    'resolveBunPath',
    'checkBunVersion',
  ] as const;

  for (const name of removedExports) {
    it(`不再导出 ${name}`, () => {
      expect((paths as unknown as Record<string, unknown>)[name]).toBeUndefined();
    });
  }

  it('不再导出 omp/Bun 运行时类型标记 AgentRuntime', () => {
    // 类型在运行时无值可查，但旧实现曾作为值导出 type 的同时被
    // session-manager 以值语义导入 —— 这里通过 TS 侧编译保证（tsc），
    // 运行时断言仅覆盖同名导出不存在。
    expect((paths as unknown as Record<string, unknown>).AgentRuntime).toBeUndefined();
  });
});

// ─── pi runner 解析（保留能力）───────────────────────────────────

describe('resolvePiRunnerScript', () => {
  it('开发模式解析到仓库内 runner-pi/index.ts 且文件存在', () => {
    const p = resolvePiRunnerScript();
    expect(p).not.toBeNull();
    expect(p!.replace(/\\/g, '/')).toMatch(/runner-pi\/index\.ts$/);
    expect(existsSync(p!)).toBe(true);
  });

  it('runner 脚本不存在时返回 null', async () => {
    const fs = await import('node:fs');
    const mocked = vi.mocked(fs.existsSync);
    const real = mocked.getMockImplementation()!;
    mocked.mockReturnValue(false);
    try {
      expect(resolvePiRunnerScript()).toBeNull();
    } finally {
      mocked.mockImplementation(real);
    }
  });

  it('打包模式：resourcesPath 下含空格与非 ASCII 字符的路径也能解析（issue 10）', () => {
    // 用真实文件系统构造"打包后"目录布局，目录名带空格与中文，
    // 验证打包分支的路径拼接不受特殊字符影响。
    const fakeResources = mkdtempSync(join(tmpdir(), 'pi 打包 资源-'));
    try {
      const runnerDir = join(fakeResources, 'runner-pi');
      mkdirSync(runnerDir, { recursive: true });
      writeFileSync(join(runnerDir, 'index.ts'), '// fake runner', 'utf-8');

      const owner = process as NodeJS.Process & { resourcesPath?: string };
      const original = owner.resourcesPath;
      Object.defineProperty(owner, 'resourcesPath', { value: fakeResources, configurable: true });
      try {
        const p = resolvePiRunnerScript();
        expect(p).not.toBeNull();
        expect(p).toBe(join(fakeResources, 'runner-pi', 'index.ts'));
        expect(existsSync(p!)).toBe(true);
      } finally {
        if (original === undefined) {
          delete (owner as { resourcesPath?: string }).resourcesPath;
        } else {
          Object.defineProperty(owner, 'resourcesPath', { value: original, configurable: true });
        }
      }
    } finally {
      rmSync(fakeResources, { recursive: true, force: true });
    }
  });
});

describe('resolvePiSessionScanScript', () => {
  it('开发模式解析到仓库内 runner-pi/session-scan.ts 且文件存在', () => {
    const p = resolvePiSessionScanScript();
    expect(p).not.toBeNull();
    expect(p!.replace(/\\/g, '/')).toMatch(/runner-pi\/session-scan\.ts$/);
    expect(existsSync(p!)).toBe(true);
  });
});

describe('resolveBuiltInExtensionDir', () => {
  it('开发模式解析到含 skills/ 的内置扩展目录', () => {
    const dir = paths.resolveBuiltInExtensionDir();
    expect(dir).not.toBeNull();
    expect(existsSync(join(dir!, 'skills'))).toBe(true);
  });
});

// ─── 通用二进制查找助手（officecli/traceweave/rtl 共用，必须保留）───

describe('通用二进制查找助手保留', () => {
  beforeEach(() => {
    vi.unstubAllEnvs();
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('candidateNames 在 Windows 追加 .exe/.cmd 变体', () => {
    const names = paths.candidateNames('tool');
    if (process.platform === 'win32') {
      expect(names).toEqual(['tool.exe', 'tool', 'tool.cmd']);
    } else {
      expect(names).toEqual(['tool']);
    }
  });

  it('findInDir 在目录缺失时返回 null 而不抛错', () => {
    expect(paths.findInDir(join(tmpdir(), `不存在的目录-${Date.now()}`), 'tool')).toBeNull();
  });
});
