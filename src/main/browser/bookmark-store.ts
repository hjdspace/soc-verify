/**
 * BookmarkStore — persistent storage for browser bookmarks and groups.
 *
 * Bookmarks support:
 *   - CRUD operations (add, update, delete)
 *   - Single-layer grouping (each bookmark belongs to at most one group)
 *   - In-group ordering
 *   - Frequent marking (shown on new-tab homepage)
 *   - JSON import/export with validation
 *
 * File format: versioned JSON (`browser-bookmarks.json`) in the app's
 * userData directory. Writes are atomic (temp file + rename).
 *
 * Corruption handling: if the file is missing, corrupted, or has an
 * unsupported version, `load()` returns an empty state.
 */
import { join } from 'node:path';
import { readFile, writeFile, rename, mkdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import type {
  Bookmark,
  BookmarkGroup,
  BookmarkImportResult,
  CreateBookmarkInput,
  CreateGroupInput,
  PersistedBookmarks,
  ReorderBookmarkInput,
  UpdateBookmarkInput,
  UpdateGroupInput,
} from '@shared/browser-types';

const FILE_NAME = 'browser-bookmarks.json';
const TMP_SUFFIX = '.tmp';
const CURRENT_VERSION = 1;

function emptyState(): PersistedBookmarks {
  return { version: CURRENT_VERSION, bookmarks: [], groups: [] };
}

function generateId(prefix: string): string {
  return `${prefix}_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
}

/** Check if a URL string has a valid http/https protocol. */
function isValidUrl(url: string): boolean {
  try {
    const parsed = new URL(url);
    return parsed.protocol === 'http:' || parsed.protocol === 'https:';
  } catch {
    return false;
  }
}

export class BookmarkStore {
  private readonly filePath: string;
  private readonly tmpPath: string;
  private readonly dirPath: string;
  private cache: PersistedBookmarks | null = null;

  constructor(dirPath: string) {
    this.dirPath = dirPath;
    this.filePath = join(dirPath, FILE_NAME);
    this.tmpPath = `${this.filePath}${TMP_SUFFIX}`;
  }

  /** Load bookmarks from disk (with in-memory cache). */
  async load(): Promise<PersistedBookmarks> {
    if (this.cache) return this.cache;

    try {
      const content = await readFile(this.filePath, 'utf-8');
      const parsed = JSON.parse(content) as PersistedBookmarks;

      if (parsed.version !== CURRENT_VERSION) {
        this.cache = emptyState();
        return this.cache;
      }

      if (!Array.isArray(parsed.bookmarks) || !Array.isArray(parsed.groups)) {
        this.cache = emptyState();
        return this.cache;
      }

      this.cache = {
        version: CURRENT_VERSION,
        bookmarks: parsed.bookmarks.filter(
          (b): b is Bookmark =>
            b != null &&
            typeof b.id === 'string' &&
            typeof b.url === 'string' &&
            typeof b.title === 'string' &&
            (b.groupId === null || typeof b.groupId === 'string') &&
            typeof b.frequent === 'boolean' &&
            typeof b.order === 'number',
        ),
        groups: parsed.groups.filter(
          (g): g is BookmarkGroup =>
            g != null &&
            typeof g.id === 'string' &&
            typeof g.name === 'string' &&
            typeof g.order === 'number',
        ),
      };
      return this.cache;
    } catch {
      this.cache = emptyState();
      return this.cache;
    }
  }

  /** Persist current state to disk atomically. */
  private async save(): Promise<void> {
    if (!this.cache) return;
    const json = JSON.stringify(this.cache, null, 2);
    if (!existsSync(this.dirPath)) {
      await mkdir(this.dirPath, { recursive: true });
    }
    await writeFile(this.tmpPath, json, 'utf-8');
    await rename(this.tmpPath, this.filePath);
  }

  // ── Bookmark CRUD ────────────────────────────────────────────

  async addBookmark(input: CreateBookmarkInput): Promise<Bookmark> {
    const data = await this.load();
    const order = data.bookmarks.filter((b) => b.groupId === (input.groupId ?? null)).length;
    const bookmark: Bookmark = {
      id: generateId('bm'),
      url: input.url,
      title: input.title,
      groupId: input.groupId ?? null,
      frequent: input.frequent ?? false,
      order,
    };
    data.bookmarks.push(bookmark);
    await this.save();
    return bookmark;
  }

  async updateBookmark(input: UpdateBookmarkInput): Promise<Bookmark> {
    const data = await this.load();
    const idx = data.bookmarks.findIndex((b) => b.id === input.id);
    if (idx === -1) throw new Error(`Bookmark not found: ${input.id}`);

    const updated: Bookmark = {
      ...data.bookmarks[idx],
      ...(input.url !== undefined ? { url: input.url } : {}),
      ...(input.title !== undefined ? { title: input.title } : {}),
      ...(input.groupId !== undefined ? { groupId: input.groupId } : {}),
      ...(input.frequent !== undefined ? { frequent: input.frequent } : {}),
      ...(input.order !== undefined ? { order: input.order } : {}),
    };
    data.bookmarks[idx] = updated;
    await this.save();
    return updated;
  }

  async deleteBookmark(id: string): Promise<void> {
    const data = await this.load();
    data.bookmarks = data.bookmarks.filter((b) => b.id !== id);
    await this.save();
  }

  async reorderBookmark(input: ReorderBookmarkInput): Promise<void> {
    const data = await this.load();
    const bookmark = data.bookmarks.find((b) => b.id === input.id);
    if (!bookmark) throw new Error(`Bookmark not found: ${input.id}`);

    const groupId = bookmark.groupId;
    // Get all bookmarks in the same group, sorted by order
    const groupBookmarks = data.bookmarks
      .filter((b) => b.groupId === groupId)
      .sort((a, b) => a.order - b.order);

    // Remove the target bookmark from the list
    const withoutTarget = groupBookmarks.filter((b) => b.id !== input.id);
    // Insert at new position
    const clampedOrder = Math.max(0, Math.min(input.newOrder, withoutTarget.length));
    withoutTarget.splice(clampedOrder, 0, bookmark);

    // Reassign order
    withoutTarget.forEach((b, i) => {
      const idx = data.bookmarks.findIndex((bm) => bm.id === b.id);
      if (idx !== -1) data.bookmarks[idx] = { ...data.bookmarks[idx], order: i };
    });

    await this.save();
  }

  async toggleFrequent(id: string): Promise<Bookmark> {
    const data = await this.load();
    const idx = data.bookmarks.findIndex((b) => b.id === id);
    if (idx === -1) throw new Error(`Bookmark not found: ${id}`);

    data.bookmarks[idx] = { ...data.bookmarks[idx], frequent: !data.bookmarks[idx].frequent };
    await this.save();
    return data.bookmarks[idx];
  }

  // ── Group CRUD ───────────────────────────────────────────────

  async addGroup(input: CreateGroupInput): Promise<BookmarkGroup> {
    const data = await this.load();
    const order = data.groups.length;
    const group: BookmarkGroup = {
      id: generateId('grp'),
      name: input.name,
      order,
    };
    data.groups.push(group);
    await this.save();
    return group;
  }

  async updateGroup(input: UpdateGroupInput): Promise<BookmarkGroup> {
    const data = await this.load();
    const idx = data.groups.findIndex((g) => g.id === input.id);
    if (idx === -1) throw new Error(`Group not found: ${input.id}`);

    const updated: BookmarkGroup = {
      ...data.groups[idx],
      ...(input.name !== undefined ? { name: input.name } : {}),
      ...(input.order !== undefined ? { order: input.order } : {}),
    };
    data.groups[idx] = updated;
    await this.save();
    return updated;
  }

  async deleteGroup(id: string): Promise<void> {
    const data = await this.load();
    data.groups = data.groups.filter((g) => g.id !== id);
    // Unassign bookmarks from the deleted group
    data.bookmarks = data.bookmarks.map((b) =>
      b.groupId === id ? { ...b, groupId: null } : b,
    );
    await this.save();
  }

  // ── Import / Export ──────────────────────────────────────────

  async exportData(): Promise<PersistedBookmarks> {
    return this.load();
  }

  async importData(data: PersistedBookmarks): Promise<BookmarkImportResult> {
    const errors: string[] = [];
    let imported = 0;
    let skipped = 0;

    // Version check
    if (data.version !== CURRENT_VERSION) {
      errors.push(`Unsupported version: ${data.version}. Expected ${CURRENT_VERSION}.`);
      return { imported, skipped, errors };
    }

    if (!Array.isArray(data.bookmarks) || !Array.isArray(data.groups)) {
      errors.push('Invalid data structure: bookmarks and groups must be arrays.');
      return { imported, skipped, errors };
    }

    const current = await this.load();
    const existingUrls = new Set(current.bookmarks.map((b) => b.url));

    // Import groups first (so bookmarks can reference them)
    const validGroupIds = new Set<string>();
    for (const grp of data.groups) {
      if (!grp || typeof grp.id !== 'string' || typeof grp.name !== 'string' || typeof grp.order !== 'number') {
        skipped++;
        errors.push(`Skipped invalid group: missing required fields.`);
        continue;
      }
      // Don't duplicate groups with the same id
      if (!current.groups.some((g) => g.id === grp.id)) {
        current.groups.push({ ...grp });
        validGroupIds.add(grp.id);
      } else {
        validGroupIds.add(grp.id);
      }
    }

    // Import bookmarks
    for (const bm of data.bookmarks) {
      // Validate required fields (id, url, title must be non-empty strings)
      if (!bm || typeof bm.id !== 'string' || !bm.id ||
          typeof bm.url !== 'string' || !bm.url ||
          typeof bm.title !== 'string' || !bm.title) {
        skipped++;
        errors.push(`Skipped bookmark: missing or empty required fields (id, url, title).`);
        continue;
      }

      // Validate URL protocol
      if (!isValidUrl(bm.url)) {
        skipped++;
        errors.push(`Skipped bookmark "${bm.title}": URL must be http/https.`);
        continue;
      }

      // Skip duplicates (same URL already exists)
      if (existingUrls.has(bm.url)) {
        skipped++;
        errors.push(`Skipped bookmark "${bm.title}": URL already exists.`);
        continue;
      }

      existingUrls.add(bm.url);
      current.bookmarks.push({
        id: bm.id,
        url: bm.url,
        title: bm.title,
        groupId: bm.groupId ?? null,
        frequent: typeof bm.frequent === 'boolean' ? bm.frequent : false,
        order: typeof bm.order === 'number' ? bm.order : current.bookmarks.length,
      });
      imported++;
    }

    await this.save();
    return { imported, skipped, errors };
  }
}
