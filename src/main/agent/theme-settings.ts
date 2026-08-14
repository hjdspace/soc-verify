import { app } from 'electron';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

const SETTINGS_FILE = 'theme.json';
const VALID_THEME_IDS = new Set(['drafting', 'bench', 'slate', 'daylight']);

class ThemeSettingsImpl {
  private cachedTheme: string | null = null;

  private get dataDir(): string {
    return join(app.getPath('userData'), 'socverify-data');
  }

  private get settingsPath(): string {
    return join(this.dataDir, SETTINGS_FILE);
  }

  async getTheme(): Promise<string | null> {
    if (this.cachedTheme !== null) return this.cachedTheme;

    try {
      const parsed = JSON.parse(await readFile(this.settingsPath, 'utf-8')) as { theme?: string };
      if (typeof parsed.theme === 'string' && VALID_THEME_IDS.has(parsed.theme)) {
        this.cachedTheme = parsed.theme;
        return parsed.theme;
      }
    } catch {
      // Missing or invalid settings file — return null (use default)
    }
    return null;
  }

  async setTheme(theme: string): Promise<void> {
    if (!VALID_THEME_IDS.has(theme)) return;
    await mkdir(this.dataDir, { recursive: true });
    await writeFile(this.settingsPath, JSON.stringify({ theme }, null, 2), 'utf-8');
    this.cachedTheme = theme;
  }
}

export const themeSettings = new ThemeSettingsImpl();
