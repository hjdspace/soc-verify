import { app } from 'electron';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { isValidTerminalThemeMode, type TerminalThemeMode } from '@shared/terminal-theme-types';

/**
 * 终端主题设置持久化（Issue #3）——appData 下文件级存储。
 *
 * 与 theme-settings.ts 相同的模式：独立 JSON 文件
 * `<userData>/socverify-data/terminal-theme.json`，缓存读取结果。
 * themeId 仅做非空字符串校验（内置主题 ID 或将来 Issue #4 的自定义主题 ID）。
 */

const SETTINGS_FILE = 'terminal-theme.json';

type TerminalThemePersisted = {
  themeMode?: TerminalThemeMode;
  themeId?: string;
};

class TerminalThemeSettingsImpl {
  private cached: TerminalThemePersisted | null = null;

  private get dataDir(): string {
    return join(app.getPath('userData'), 'socverify-data');
  }

  private get settingsPath(): string {
    return join(this.dataDir, SETTINGS_FILE);
  }

  private async load(): Promise<TerminalThemePersisted> {
    if (this.cached) return this.cached;
    try {
      const parsed = JSON.parse(await readFile(this.settingsPath, 'utf-8')) as TerminalThemePersisted;
      this.cached = {
        themeMode: isValidTerminalThemeMode(parsed.themeMode) ? parsed.themeMode : undefined,
        themeId: typeof parsed.themeId === 'string' && parsed.themeId.length > 0 ? parsed.themeId : undefined,
      };
      return this.cached;
    } catch {
      // 文件缺失或内容非法 —— 返回空（使用默认值）
      return {};
    }
  }

  async getMode(): Promise<TerminalThemeMode | null> {
    return (await this.load()).themeMode ?? null;
  }

  async setMode(mode: TerminalThemeMode): Promise<void> {
    const current = await this.load();
    const next = { ...current, themeMode: mode };
    await this.save(next);
  }

  async getThemeId(): Promise<string | null> {
    return (await this.load()).themeId ?? null;
  }

  async setThemeId(themeId: string): Promise<void> {
    if (themeId.length === 0) return;
    const current = await this.load();
    const next = { ...current, themeId };
    await this.save(next);
  }

  private async save(data: TerminalThemePersisted): Promise<void> {
    await mkdir(this.dataDir, { recursive: true });
    await writeFile(this.settingsPath, JSON.stringify(data, null, 2), 'utf-8');
    this.cached = data;
  }
}

export const terminalThemeSettings = new TerminalThemeSettingsImpl();
