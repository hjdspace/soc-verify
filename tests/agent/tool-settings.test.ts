import { describe, it, expect, vi, beforeEach } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// 每个用例独立的 userData 目录，避免持久化文件在用例/运行之间泄漏
let dataDir: string;
vi.mock('electron', () => ({
  app: { getPath: vi.fn(() => dataDir) },
}));

// tool-settings 带内存缓存，每个用例重新加载模块
async function freshSettings() {
  vi.resetModules();
  const mod = await import('../../src/main/agent/tool-settings');
  return mod.toolSettings;
}

describe('tool-settings 持久化', () => {
  beforeEach(() => {
    dataDir = mkdtempSync(join(tmpdir(), 'tool-settings-'));
  });

  it('默认不禁用任何工具', async () => {
    const settings = await freshSettings();
    expect(await settings.getDisabledTools()).toEqual([]);
  });

  it('setDisabledTools 去重并持久化', async () => {
    const settings = await freshSettings();
    await settings.setDisabledTools(['run_simulation', 'run_simulation', 'gh']);
    expect(await settings.getDisabledTools()).toEqual(['run_simulation', 'gh']);
  });

  it('saveBuiltinCatalog 保存后可读回且幂等', async () => {
    const settings = await freshSettings();
    const tools = [{ name: 'bash', description: 'run shell' }];
    await settings.saveBuiltinCatalog(tools);
    expect(await settings.getBuiltinCatalog()).toEqual(tools);
    await settings.saveBuiltinCatalog(tools);
    expect(await settings.getBuiltinCatalog()).toEqual(tools);
  });

  it('同一目录下 disabledTools 与 builtinCatalog 独立更新', async () => {
    const settings = await freshSettings();
    await settings.setDisabledTools(['kb_search']);
    await settings.saveBuiltinCatalog([{ name: 'bash', description: '' }]);
    expect(await settings.getDisabledTools()).toEqual(['kb_search']);
    expect(await settings.getBuiltinCatalog()).toEqual([{ name: 'bash', description: '' }]);
  });
});
