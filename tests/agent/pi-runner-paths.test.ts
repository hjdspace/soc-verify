import { describe, it, expect, vi } from 'vitest';
import { existsSync } from 'node:fs';

// 只包装 existsSync（默认真实实现），用于模拟"路径不存在"场景。
// paths.ts 以 `import { existsSync } from 'node:fs'` 引用，vitest 的
// 模块 mock 使该引用指向这里包装后的版本。
vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs')>();
  return { ...actual, existsSync: vi.fn(actual.existsSync) };
});

import { resolvePiRunnerScript } from '../../src/main/agent/paths';

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
});
