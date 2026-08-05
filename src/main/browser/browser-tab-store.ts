/**
 * BrowserTabStore — persistent storage for global browser tabs.
 *
 * Browser tabs are saved independently of project state to a user-level
 * data file. This enables restart recovery: URLs, titles, order, and the
 * last active tab are restored when the app launches.
 *
 * File format: versioned JSON (`browser-tabs.json`) in the app's userData directory.
 * Writes are atomic: data is written to a `.tmp` file first, then renamed.
 *
 * Corruption handling: if the file is missing, corrupted, or has an
 * unsupported version, `load()` returns an empty state (no tabs).
 */
import { join } from 'node:path';
import { readFile, writeFile, rename, mkdir } from 'node:fs/promises';
import { writeFileSync, renameSync, mkdirSync, existsSync } from 'node:fs';
import type { PersistedBrowserTab, PersistedBrowserTabs } from '@shared/browser-types';

const FILE_NAME = 'browser-tabs.json';
const TMP_SUFFIX = '.tmp';
const CURRENT_VERSION = 1;

function emptyState(): PersistedBrowserTabs {
  return { version: CURRENT_VERSION, tabs: [], activeTabId: null };
}

export class BrowserTabStore {
  private readonly filePath: string;
  private readonly tmpPath: string;
  private readonly dirPath: string;

  constructor(dirPath: string) {
    this.dirPath = dirPath;
    this.filePath = join(dirPath, FILE_NAME);
    this.tmpPath = `${this.filePath}${TMP_SUFFIX}`;
  }

  /** Load persisted tabs from disk. Returns empty state if missing, corrupted, or unsupported version. */
  async load(): Promise<PersistedBrowserTabs> {
    try {
      const content = await readFile(this.filePath, 'utf-8');
      const parsed = JSON.parse(content) as PersistedBrowserTabs;

      // Version check — reject unsupported versions
      if (parsed.version !== CURRENT_VERSION) {
        return emptyState();
      }

      // Basic shape validation
      if (!Array.isArray(parsed.tabs)) {
        return emptyState();
      }

      // Filter out invalid entries
      const validTabs = parsed.tabs.filter(
        (t): t is PersistedBrowserTab =>
          t != null &&
          typeof t.surfaceId === 'string' &&
          typeof t.url === 'string' &&
          typeof t.title === 'string',
      );

      return {
        version: CURRENT_VERSION,
        tabs: validTabs,
        activeTabId: typeof parsed.activeTabId === 'string' ? parsed.activeTabId : null,
      };
    } catch {
      // File missing, unreadable, or invalid JSON → empty state
      return emptyState();
    }
  }

  /** Save tabs to disk atomically (async). */
  async save(tabs: PersistedBrowserTab[], activeTabId: string | null): Promise<void> {
    const data: PersistedBrowserTabs = {
      version: CURRENT_VERSION,
      tabs,
      activeTabId,
    };
    const json = JSON.stringify(data, null, 2);

    await this.ensureDir();
    // Atomic write: write to temp file, then rename
    await writeFile(this.tmpPath, json, 'utf-8');
    await rename(this.tmpPath, this.filePath);
  }

  /** Save tabs synchronously — used during app shutdown (before-quit). */
  saveSync(tabs: PersistedBrowserTab[], activeTabId: string | null): void {
    const data: PersistedBrowserTabs = {
      version: CURRENT_VERSION,
      tabs,
      activeTabId,
    };
    const json = JSON.stringify(data, null, 2);

    this.ensureDirSync();
    writeFileSync(this.tmpPath, json, 'utf-8');
    // Atomic-ish: write to tmp then rename. On most platforms rename is atomic.
    renameSync(this.tmpPath, this.filePath);
  }

  private async ensureDir(): Promise<void> {
    if (!existsSync(this.dirPath)) {
      await mkdir(this.dirPath, { recursive: true });
    }
  }

  private ensureDirSync(): void {
    if (!existsSync(this.dirPath)) {
      mkdirSync(this.dirPath, { recursive: true });
    }
  }
}
