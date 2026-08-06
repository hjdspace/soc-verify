import { BrowserWindow, shell, ipcMain, dialog, nativeImage, app } from 'electron';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { resolveWindowIcon, resolveTrayIcon } from './platform-setup';
import { loadClosePref, saveClosePref } from './close-prefs';
import { getIsQuitting, setIsQuitting } from './tray-manager';

const __dirname = dirname(fileURLToPath(import.meta.url));

// ── 窗口工厂 + 窗口控制 IPC ───────────────────────────────────────
// 深模块：封装窗口创建（尺寸/图标/preload）、close 行为（托盘/关闭对话）、
// 窗口控制 IPC（minimize/maximize/close/isMaximized）。
// 外部只需 `createWindow()` + `registerWindowControls()`。

/**
 * Create the main application window.
 *
 * Includes:
 * - Frameless window with custom preload
 * - Maximize/unmaximize event forwarding
 * - Close behavior: tray vs. full close with persisted preference
 * - External link handling
 */
export function createWindow(): BrowserWindow {
  const win = new BrowserWindow({
    width: 1440,
    height: 900,
    minWidth: 1024,
    minHeight: 640,
    show: false,
    frame: false,
    title: 'SoC Verify',
    icon: resolveWindowIcon(),
    backgroundColor: '#1e1e2e',
    webPreferences: {
      preload: join(__dirname, '../preload/index.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
    }
  });

  win.on('ready-to-show', () => win.show());

  // Forward maximize/unmaximize events to this window's webContents
  win.on('maximize', () => {
    if (!win.isDestroyed()) win.webContents.send('window:maximize-changed', true);
  });
  win.on('unmaximize', () => {
    if (!win.isDestroyed()) win.webContents.send('window:maximize-changed', false);
  });

  // Close behavior: ask user to fully close or minimize to tray.
  // If a saved preference exists (via "不再询问" checkbox), use it directly.
  win.on('close', async (e) => {
    if (getIsQuitting()) return; // allow close (tray "退出" or explicit app.quit)

    e.preventDefault();

    // If user previously saved a preference, use it directly
    const savedPref = loadClosePref();
    if (savedPref === 'close') {
      setIsQuitting(true);
      app.quit();
      return;
    }
    if (savedPref === 'tray') {
      win.hide();
      return;
    }

    // No saved preference — show confirmation dialog
    const result = await dialog.showMessageBox(win, {
      type: 'question',
      title: '关闭窗口',
      message: '您希望完全关闭 SoC Verify，还是最小化到系统托盘？',
      detail: '最小化到托盘后，应用将继续在后台运行，可随时从托盘图标恢复。',
      buttons: ['完全关闭', '最小化到托盘', '取消'],
      defaultId: 1,
      cancelId: 2,
      checkboxLabel: '不再询问，记住我的选择',
      checkboxChecked: false,
      icon: nativeImage.createFromPath(resolveTrayIcon()),
      noLink: true
    });

    if (result.response === 0) {
      // Fully close
      if (result.checkboxChecked) saveClosePref('close');
      setIsQuitting(true);
      app.quit();
    } else if (result.response === 1) {
      // Minimize to tray
      if (result.checkboxChecked) saveClosePref('tray');
      win.hide();
    }
    // response === 2 (取消): do nothing, window stays visible
  });

  win.webContents.setWindowOpenHandler(({ url }) => {
    shell.openExternal(url);
    return { action: 'deny' };
  });

  if (process.env['ELECTRON_RENDERER_URL']) {
    win.loadURL(process.env['ELECTRON_RENDERER_URL']);
  } else {
    win.loadFile(join(__dirname, '../renderer/index.html'));
  }

  return win;
}

/**
 * Register global window-control IPC handlers.
 *
 * Uses `event.sender` to identify which BrowserWindow sent the request,
 * so the same handlers work for both the main window and tool windows.
 * Must be called exactly once (in app.whenReady).
 */
export function registerWindowControls(): void {
  ipcMain.on('window:minimize', (event) => {
    BrowserWindow.fromWebContents(event.sender)?.minimize();
  });

  ipcMain.on('window:maximize', (event) => {
    const win = BrowserWindow.fromWebContents(event.sender);
    if (!win) return;
    if (win.isMaximized()) win.unmaximize();
    else win.maximize();
  });

  ipcMain.on('window:close', (event) => {
    BrowserWindow.fromWebContents(event.sender)?.close();
  });

  ipcMain.handle('window:is-maximized', (event) => {
    return BrowserWindow.fromWebContents(event.sender)?.isMaximized() ?? false;
  });
}
