/**
 * Browser tab persistence and bookmark types.
 *
 * Used by both main process (persistence layer, tRPC router) and renderer
 * (Zustand stores, components).
 */

// ── Issue #7: Browser tab persistence ──────────────────────────

/** A single persisted browser tab — minimal state needed for restore. */
export type PersistedBrowserTab = {
  surfaceId: string;
  url: string;
  title: string;
};

/** On-disk format for browser-tabs.json — versioned for forward compatibility. */
export type PersistedBrowserTabs = {
  version: 1;
  tabs: PersistedBrowserTab[];
  activeTabId: string | null;
};

/** Soft limit: warn the user when exceeding this many browser tabs. */
export const BROWSER_TAB_SOFT_LIMIT = 12;

// ── Issue #8: Bookmarks ────────────────────────────────────────

/** A single bookmark entry. */
export type Bookmark = {
  id: string;
  url: string;
  title: string;
  /** Group ID; null means "ungrouped". */
  groupId: string | null;
  /** Whether this bookmark is marked as frequently used (shown on new-tab homepage). */
  frequent: boolean;
  /** Sort order within the group (0-based). */
  order: number;
};

/** A bookmark group for single-layer categorization. */
export type BookmarkGroup = {
  id: string;
  name: string;
  /** Sort order (0-based). */
  order: number;
};

/** On-disk format for browser-bookmarks.json — versioned. */
export type PersistedBookmarks = {
  version: 1;
  bookmarks: Bookmark[];
  groups: BookmarkGroup[];
};

/** Input for creating a bookmark. */
export type CreateBookmarkInput = {
  url: string;
  title: string;
  groupId?: string | null;
  frequent?: boolean;
};

/** Input for updating a bookmark. All fields optional except id. */
export type UpdateBookmarkInput = {
  id: string;
  url?: string;
  title?: string;
  groupId?: string | null;
  frequent?: boolean;
  order?: number;
};

/** Input for creating a group. */
export type CreateGroupInput = {
  name: string;
};

/** Input for updating a group. */
export type UpdateGroupInput = {
  id: string;
  name?: string;
  order?: number;
};

/** Input for reordering a bookmark within its group. */
export type ReorderBookmarkInput = {
  id: string;
  newOrder: number;
};

/** Result of a bookmark import operation. */
export type BookmarkImportResult = {
  imported: number;
  skipped: number;
  errors: string[];
};

// ── Issue #9: Window open and auth events ─────────────────────

/** Main→Renderer event: ask the workbench to open a new browser tab. */
export type OpenNewTabEvent = {
  url: string;
};

/** Main→Renderer event: an auth popup window was closed. */
export type AuthPopupEvent = {
  type: 'opened' | 'closed';
  url: string;
};

// ── Issue #10: Download events ─────────────────────────────────

/** Download lifecycle state. */
export type DownloadState = 'starting' | 'progressing' | 'completed' | 'failed' | 'cancelled';

/** Main→Renderer event: download lifecycle notification. */
export type DownloadEvent =
  | { type: 'started'; filename: string; url: string }
  | { type: 'progress'; filename: string; percent: number }
  | { type: 'completed'; filename: string; savedPath: string }
  | { type: 'failed'; filename: string; error: string }
  | { type: 'cancelled'; filename: string };

/** Download entry returned by the getDownloads procedure. */
export type DownloadInfo = {
  id: string;
  filename: string;
  url: string;
  state: DownloadState;
  percent?: number;
  savedPath?: string;
  error?: string;
};
