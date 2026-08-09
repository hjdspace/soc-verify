import { app } from 'electron';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import {
  DEFAULT_CONTEXT_WINDOW,
  MAX_CONTEXT_WINDOW,
  MIN_CONTEXT_WINDOW,
} from '@shared/context-management';

const SETTINGS_FILE = 'agent-context.json';

type StoredContextSettings = {
  contextWindow: number;
};

class ContextSettingsImpl {
  private cachedContextWindow: number | null = null;

  private get dataDir(): string {
    return join(app.getPath('userData'), 'socverify-data');
  }

  private get settingsPath(): string {
    return join(this.dataDir, SETTINGS_FILE);
  }

  async getContextWindow(): Promise<number> {
    if (this.cachedContextWindow !== null) return this.cachedContextWindow;

    try {
      const parsed = JSON.parse(await readFile(this.settingsPath, 'utf-8')) as Partial<StoredContextSettings>;
      if (isValidContextWindow(parsed.contextWindow)) {
        this.cachedContextWindow = parsed.contextWindow;
        return parsed.contextWindow;
      }
    } catch {
      // Missing or invalid settings fall back to the product default.
    }

    this.cachedContextWindow = DEFAULT_CONTEXT_WINDOW;
    return DEFAULT_CONTEXT_WINDOW;
  }

  async setContextWindow(contextWindow: number): Promise<void> {
    if (!isValidContextWindow(contextWindow)) {
      throw new Error(`Context window must be an integer between ${MIN_CONTEXT_WINDOW} and ${MAX_CONTEXT_WINDOW}`);
    }

    await mkdir(this.dataDir, { recursive: true });
    await writeFile(this.settingsPath, JSON.stringify({ contextWindow }, null, 2), 'utf-8');
    this.cachedContextWindow = contextWindow;
  }
}

function isValidContextWindow(value: unknown): value is number {
  return Number.isInteger(value) &&
    (value as number) >= MIN_CONTEXT_WINDOW &&
    (value as number) <= MAX_CONTEXT_WINDOW;
}

export const contextSettings = new ContextSettingsImpl();

