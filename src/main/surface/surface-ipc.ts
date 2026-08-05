import { BrowserWindow, WebContentsView, ipcMain, session, app, type IpcMainInvokeEvent } from 'electron';
import { join } from 'node:path';
import type { SurfaceDeclaration, SurfaceEvent } from '@shared/surface-types';
import { ViewManager, type SurfaceView } from './view-manager';
import { classifyWindowOpen } from '../browser/window-open-handler';
import { CertificateErrorTracker } from '../browser/certificate-handler';
import { DownloadTracker } from '../browser/download-handler';
import { getDefaultPermissionResponse } from '../browser/permission-handler';
import type { DownloadEvent } from '@shared/browser-types';

const managers = new Map<number, ViewManager>();
let registered = false;

// ── Issue #9: Certificate error tracker (shared across all windows) ──
const certTracker = new CertificateErrorTracker();

// ── Issue #10: Download tracker (shared across all windows) ──
const downloadTracker = new DownloadTracker();

// ── Issue #10: Auth popup windows (tracked for cleanup) ──
const authPopups = new Set<BrowserWindow>();

function managerForEvent(event: IpcMainInvokeEvent): ViewManager {
  const window = BrowserWindow.fromWebContents(event.sender);
  if (!window) throw new Error('Surface IPC sender is not a BrowserWindow');
  let manager = managers.get(window.id);
  if (!manager) {
    manager = createViewManager(window);
    managers.set(window.id, manager);
    window.once('closed', () => {
      managers.get(window.id)?.destroyAll();
      managers.delete(window.id);
    });
  }
  return manager;
}

/** Issue #10: Set up permission handlers on a browser session (default-deny policy). */
function setupBrowserPermissions(sess: Electron.Session): void {
  // Permission request handler: deny all by default
  sess.setPermissionRequestHandler((_webContents, permission, callback) => {
    callback(getDefaultPermissionResponse(permission) === 'granted');
  });

  // Permission check handler: deny all by default (for synchronous checks)
  sess.setPermissionCheckHandler((_webContents, permission) => {
    return getDefaultPermissionResponse(permission) === 'granted';
  });
}

/** Issue #10: Set up download handler on a browser session. */
function setupDownloadHandler(sess: Electron.Session, window: BrowserWindow): void {
  sess.on('will-download', (_event, item) => {
    const filename = item.getFilename();
    const url = item.getURL();
    const downloadId = downloadTracker.startDownload(filename, url);

    // Show save dialog to let user choose where to save
    const defaultPath = join(app.getPath('downloads'), filename);

    // Set the save path via dialog
    item.setSaveDialogOptions({
      defaultPath,
      buttonLabel: '保存',
    });

    // Notify renderer: download started
    sendDownloadEvent(window, { type: 'started', filename, url });

    // Track progress
    item.on('updated', (_e, state) => {
      if (state === 'progressing') {
        const received = item.getReceivedBytes();
        const total = item.getTotalBytes();
        const percent = total > 0 ? Math.round((received / total) * 100) : 0;
        downloadTracker.progressDownload(downloadId, percent, received, total);
        sendDownloadEvent(window, { type: 'progress', filename, percent });
      }
    });

    item.once('done', (_e, state) => {
      if (state === 'completed') {
        const savedPath = item.getSavePath();
        downloadTracker.completeDownload(downloadId, savedPath);
        sendDownloadEvent(window, { type: 'completed', filename, savedPath });
      } else if (state === 'cancelled') {
        downloadTracker.cancelDownload(downloadId);
        sendDownloadEvent(window, { type: 'cancelled', filename });
      } else {
        downloadTracker.failDownload(downloadId, `Download state: ${state}`);
        sendDownloadEvent(window, { type: 'failed', filename, error: `下载失败 (${state})` });
      }
    });
  });
}

/** Send a download event to the renderer. */
function sendDownloadEvent(window: BrowserWindow, event: DownloadEvent): void {
  if (!window.isDestroyed()) {
    window.webContents.send('browser:download-event', event);
  }
}

/** Issue #9: Set up window.open handler for a browser surface's webContents. */
function setupWindowOpenHandler(
  webContents: Electron.WebContents,
  window: BrowserWindow,
): void {
  webContents.setWindowOpenHandler(({ url, features }) => {
    const action = classifyWindowOpen(url, features);

    if (action === 'deny') {
      return { action: 'deny' as const };
    }

    if (action === 'new-tab') {
      // Notify renderer to create a new browser tab
      if (!window.isDestroyed()) {
        window.webContents.send('browser:open-new-tab', { url });
      }
      return { action: 'deny' as const };
    }

    // auth-popup: create a controlled temporary BrowserWindow
    // with the same browser session, preserving opener relationship
    const browserSession = session.fromPartition('persist:soc-verify-browser');
    const popup = new BrowserWindow({
      width: 500,
      height: 650,
      modal: false,
      parent: window,
      show: true,
      webPreferences: {
        session: browserSession,
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true,
      },
    });

    authPopups.add(popup);

    // Notify renderer
    if (!window.isDestroyed()) {
      window.webContents.send('browser:auth-popup', { type: 'opened', url });
    }

    // Load the URL
    void popup.loadURL(url);

    // Destroy on close — no residual workbench tabs
    popup.once('closed', () => {
      authPopups.delete(popup);
      if (!window.isDestroyed()) {
        window.webContents.send('browser:auth-popup', { type: 'closed', url });
      }
    });

    return { action: 'deny' as const };
  });
}

function createViewManager(window: BrowserWindow): ViewManager {
  // Set up browser session handlers once
  const browserSession = session.fromPartition('persist:soc-verify-browser');
  setupBrowserPermissions(browserSession);
  setupDownloadHandler(browserSession, window);

  return new ViewManager(window as unknown as import('./view-manager').SurfaceHost, {
    createView: (declaration) => {
      const partition = declaration.kind === 'browser'
        ? 'persist:soc-verify-browser'
        : `soc-verify-document-${window.id}-${declaration.id}`;
      const view = new WebContentsView({
        webPreferences: {
          session: session.fromPartition(partition),
          contextIsolation: true,
          nodeIntegration: false,
          sandbox: true,
        },
      });

      // Issue #9: Set up window.open handler for browser surfaces
      if (declaration.kind === 'browser') {
        setupWindowOpenHandler(view.webContents, window);
      }

      return view as unknown as SurfaceView;
    },
    emit: (surfaceEvent: SurfaceEvent) => {
      if (!window.isDestroyed()) window.webContents.send('surface:event', surfaceEvent);
    },
    shouldProceedCertificate: (surfaceId, url) => certTracker.shouldProceed(surfaceId, url),
    consumeProceedCertificate: (surfaceId, url) => certTracker.consumeProceed(surfaceId, url),
  });
}

export function registerSurfaceIpcHandlers(): void {
  if (registered) return;
  registered = true;

  ipcMain.handle('surface:sync', async (event, declaration: SurfaceDeclaration) => {
    await managerForEvent(event).sync(declaration);
  });
  ipcMain.handle('surface:show', (event, id: string) => managerForEvent(event).show(id));
  ipcMain.handle('surface:hide', (event, id: string) => managerForEvent(event).hide(id));
  ipcMain.handle('surface:destroy', (event, id: string) => managerForEvent(event).destroy(id));
  ipcMain.handle('surface:set-overlay-hidden', (event, hidden: boolean) => managerForEvent(event).setOverlayHidden(hidden));
  ipcMain.handle('surface:go-back', (event, id: string) => managerForEvent(event).goBack(id));
  ipcMain.handle('surface:go-forward', (event, id: string) => managerForEvent(event).goForward(id));
  ipcMain.handle('surface:reload', (event, id: string) => managerForEvent(event).reload(id));

  // Issue #9: Certificate proceed — renderer asks to single-continue a certificate error
  ipcMain.handle('browser:proceed-certificate', (event, surfaceId: string, url: string) => {
    certTracker.allowProceed(surfaceId, url);
    return true;
  });
}

/** Issue #10: Get the download tracker (for tRPC router use). */
export function getDownloadTracker(): DownloadTracker {
  return downloadTracker;
}

export function destroyAllSurfaceManagers(): void {
  for (const manager of managers.values()) manager.destroyAll();
  managers.clear();
  // Clean up auth popups
  for (const popup of authPopups) {
    if (!popup.isDestroyed()) popup.destroy();
  }
  authPopups.clear();
  // Clean up certificate tracker
  certTracker.clearAll();
}
