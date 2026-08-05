/**
 * Tool Window Manager — manages independent BrowserWindow instances for tools.
 *
 * Design decisions (from grilling session):
 * - Single instance per tool (focus existing window if already open)
 * - Frameless window with simplified TitleBar (consistent with main window)
 * - Same SPA + hash routing (`#tool=<tool-id>`)
 * - Auto-inject project path via URL query parameter
 *
 * Tool windows share the same preload script and tRPC IPC bridge as the main
 * window. The electron-trpc bridge uses `event.reply()` which sends back to
 * the sender's WebContents, so tRPC calls from tool windows work automatically.
 */

import { BrowserWindow } from 'electron';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { existsSync } from 'node:fs';
import type { ToolMeta } from '../../shared/tool-types.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

/** Resolve window icon path (same logic as main window). */
function resolveWindowIcon(): string {
  const ico = join(__dirname, '../../build/icon.ico');
  const png256 = join(__dirname, '../../build/icons/256x256.png');
  const png128 = join(__dirname, '../../build/icons/128x128.png');
  if (existsSync(ico)) return ico;
  if (existsSync(png256)) return png256;
  if (existsSync(png128)) return png128;
  return ico;
}

/** Open tool windows, keyed by tool id for single-instance behavior. */
const openWindows = new Map<string, BrowserWindow>();

/**
 * Open (or focus) a tool window.
 *
 * @param tool  Tool metadata (id, name, width, height, …)
 * @param projectRoot  Current project root path (auto-injected, overridable in UI)
 */
export function openToolWindow(tool: ToolMeta, projectRoot: string | null): void {
  // Single instance: focus existing window if already open
  const existing = openWindows.get(tool.id);
  if (existing && !existing.isDestroyed()) {
    if (existing.isMinimized()) {
      existing.restore();
    }
    existing.focus();
    return;
  }

  const win = new BrowserWindow({
    width: tool.width,
    height: tool.height,
    minWidth: 600,
    minHeight: 400,
    show: false,
    frame: false,
    title: tool.name,
    icon: resolveWindowIcon(),
    backgroundColor: '#1e1e2e',
    webPreferences: {
      preload: join(__dirname, '../preload/index.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
    },
  });

  // Track the window
  openWindows.set(tool.id, win);

  // Clean up on close
  win.on('closed', () => {
    openWindows.delete(tool.id);
  });

  // Forward maximize/unmaximize events to this window's webContents
  win.on('maximize', () => {
    if (!win.isDestroyed()) {
      win.webContents.send('window:maximize-changed', true);
    }
  });
  win.on('unmaximize', () => {
    if (!win.isDestroyed()) {
      win.webContents.send('window:maximize-changed', false);
    }
  });

  // Build URL: same renderer, with hash routing + project path query param
  const params = new URLSearchParams();
  if (projectRoot) {
    params.set('project', projectRoot);
  }
  const query = params.toString();
  const hash = `#tool=${tool.id}`;

  if (process.env['ELECTRON_RENDERER_URL']) {
    // Dev mode: load from dev server
    const devUrl = new URL(process.env['ELECTRON_RENDERER_URL']);
    devUrl.hash = hash;
    if (query) {
      devUrl.search = query;
    }
    win.loadURL(devUrl.toString());
  } else {
    // Production: load from built HTML file
    const filePath = join(__dirname, '../renderer/index.html');
    let url = `file://${filePath}?${query}${hash}`;
    if (!query) {
      url = `file://${filePath}${hash}`;
    }
    win.loadURL(url);
  }

  win.on('ready-to-show', () => win.show());
}

/**
 * Close all open tool windows.
 * Called during app quit to clean up resources.
 */
export function closeAllToolWindows(): void {
  for (const [, win] of openWindows) {
    if (!win.isDestroyed()) {
      win.destroy();
    }
  }
  openWindows.clear();
}


