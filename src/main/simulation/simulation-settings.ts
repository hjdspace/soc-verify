import { app } from 'electron';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

const SETTINGS_FILE = 'simulation-settings.json';

type StoredSimulationSettings = {
  preferLogMode: boolean;
};

/**
 * SimulationSettings — 用户级仿真执行设置持久化。
 *
 * 存储位置：<userData>/socverify-data/simulation-settings.json
 * （与 agent-context.json 相同的数据目录，先例：context-settings.ts）
 */
class SimulationSettingsImpl {
  private cachedPreferLogMode: boolean | null = null;

  private get dataDir(): string {
    return join(app.getPath('userData'), 'socverify-data');
  }

  private get settingsPath(): string {
    return join(this.dataDir, SETTINGS_FILE);
  }

  /**
   * 是否默认以 log-mode 执行仿真（终端仿真 / rerun）。
   *
   * 默认 false：仿真在交互式 PTY 终端中执行，node-pty 不可用时自动回退到
   * log-mode。用户在设置中启用后，仿真直接以 log-mode（`shell -c` 只读
   * 日志模式）执行，不再探测/依赖 node-pty。
   */
  async getPreferLogMode(): Promise<boolean> {
    if (this.cachedPreferLogMode !== null) return this.cachedPreferLogMode;

    try {
      const parsed = JSON.parse(await readFile(this.settingsPath, 'utf-8')) as Partial<StoredSimulationSettings>;
      if (typeof parsed.preferLogMode === 'boolean') {
        this.cachedPreferLogMode = parsed.preferLogMode;
        return parsed.preferLogMode;
      }
    } catch {
      // Missing or invalid settings fall back to the product default.
    }

    this.cachedPreferLogMode = false;
    return false;
  }

  async setPreferLogMode(preferLogMode: boolean): Promise<void> {
    if (typeof preferLogMode !== 'boolean') {
      throw new Error('preferLogMode must be a boolean');
    }

    await mkdir(this.dataDir, { recursive: true });
    await writeFile(this.settingsPath, JSON.stringify({ preferLogMode }, null, 2), 'utf-8');
    this.cachedPreferLogMode = preferLogMode;
  }
}

export const simulationSettings = new SimulationSettingsImpl();
