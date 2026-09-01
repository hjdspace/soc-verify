import { describe, it, expect, vi, beforeEach } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// 每个用例独立的 userData 目录，避免持久化文件在用例/运行之间泄漏
let dataDir: string;
vi.mock('electron', () => ({
  app: { getPath: vi.fn(() => dataDir) },
}));

// simulation-settings 带内存缓存，每个用例重新加载模块
async function freshSettings() {
  vi.resetModules();
  const mod = await import('../../src/main/simulation/simulation-settings');
  return mod.simulationSettings;
}

describe('simulation-settings 持久化', () => {
  beforeEach(() => {
    dataDir = mkdtempSync(join(tmpdir(), 'simulation-settings-'));
  });

  it('默认不启用 log-mode', async () => {
    const settings = await freshSettings();
    expect(await settings.getPreferLogMode()).toBe(false);
  });

  it('setPreferLogMode 持久化并可读回', async () => {
    const settings = await freshSettings();
    await settings.setPreferLogMode(true);
    expect(await settings.getPreferLogMode()).toBe(true);
  });

  it('重新加载模块后从磁盘读回已保存的值（含关闭）', async () => {
    const settings = await freshSettings();
    await settings.setPreferLogMode(true);

    const reloaded = await freshSettings();
    expect(await reloaded.getPreferLogMode()).toBe(true);

    await reloaded.setPreferLogMode(false);
    const again = await freshSettings();
    expect(await again.getPreferLogMode()).toBe(false);
  });

  it('setPreferLogMode 拒绝非布尔值', async () => {
    const settings = await freshSettings();
    await expect(
      settings.setPreferLogMode('yes' as unknown as boolean),
    ).rejects.toThrow('preferLogMode must be a boolean');
    // 拒绝后不应写入文件，仍保持默认值
    expect(await settings.getPreferLogMode()).toBe(false);
  });
});
