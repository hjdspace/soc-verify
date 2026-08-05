import { BrowserWindow, WebContentsView, ipcMain, session, type IpcMainInvokeEvent } from 'electron';
import type { SurfaceDeclaration, SurfaceEvent } from '@shared/surface-types';
import { ViewManager, type SurfaceView } from './view-manager';

const managers = new Map<number, ViewManager>();
let registered = false;

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

function createViewManager(window: BrowserWindow): ViewManager {
  return new ViewManager(window as unknown as import('./view-manager').SurfaceHost, {
    createView: (declaration) => {
      const partition = declaration.kind === 'browser'
        ? 'persist:soc-verify-browser'
        : `soc-verify-document-${window.id}-${declaration.id}`;
      return new WebContentsView({
        webPreferences: {
          session: session.fromPartition(partition),
          contextIsolation: true,
          nodeIntegration: false,
          sandbox: true,
        },
      }) as unknown as SurfaceView;
    },
    emit: (surfaceEvent: SurfaceEvent) => {
      if (!window.isDestroyed()) window.webContents.send('surface:event', surfaceEvent);
    },
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
}

export function destroyAllSurfaceManagers(): void {
  for (const manager of managers.values()) manager.destroyAll();
  managers.clear();
}
