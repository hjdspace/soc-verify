import { app, BrowserWindow, shell, ipcMain } from 'electron';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { createIPCHandler } from './ipc/electron-trpc-bridge';
import { router } from './ipc/router';
import { resolveOmpRuntime } from './omp/paths';
import { projectManager } from './project/project-manager';
import { sessionManager } from './omp/session-manager';
import { pluginLoader } from './plugins/loader';
import { simulationRegistry } from './simulation/simulation-registry';

const __dirname = dirname(fileURLToPath(import.meta.url));

let mainWindow: BrowserWindow | null = null;

function createWindow(): BrowserWindow {
  const win = new BrowserWindow({
    width: 1440,
    height: 900,
    minWidth: 1024,
    minHeight: 640,
    show: false,
    frame: false,
    title: 'SoC Verify',
    backgroundColor: '#1e1e2e',
    webPreferences: {
      preload: join(__dirname, '../preload/index.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false
    }
  });

  win.on('ready-to-show', () => win.show());

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

/** Register window-control IPC handlers (single-window app). */
function registerWindowControls(win: BrowserWindow) {
  ipcMain.on('window:minimize', () => win.minimize());

  ipcMain.on('window:maximize', () => {
    if (win.isMaximized()) win.unmaximize();
    else win.maximize();
  });

  ipcMain.on('window:close', () => win.close());

  ipcMain.handle('window:is-maximized', () => win.isMaximized());

  win.on('maximize', () => win.webContents.send('window:maximize-changed', true));
  win.on('unmaximize', () => win.webContents.send('window:maximize-changed', false));
}

/** Forward backend events to the renderer via IPC. */
function registerEventForwarding(win: BrowserWindow) {
  // File tree updates from project watcher
  projectManager.on('filetree:update', (update) => {
    if (!win.isDestroyed()) {
      win.webContents.send('filetree:update', update);
    }
  });

  // Project opened/closed events
  projectManager.on('project:opened', (info) => {
    if (!win.isDestroyed()) {
      win.webContents.send('project:opened', info);
    }
  });

  projectManager.on('project:closed', (projectId) => {
    if (!win.isDestroyed()) {
      win.webContents.send('project:closed', projectId);
    }
  });

  // Session events from omp
  sessionManager.on('sessionEvent', ({ sessionId, event }) => {
    if (!win.isDestroyed()) {
      win.webContents.send('session:event', { sessionId, event });
    }
  });

  // Simulation events
  simulationRegistry.on('run:started', (record) => {
    if (!win.isDestroyed()) {
      win.webContents.send('simulation:event', { type: 'started', record });
    }
  });
  simulationRegistry.on('run:statusChanged', (record) => {
    if (!win.isDestroyed()) {
      win.webContents.send('simulation:event', { type: 'statusChanged', record });
    }
  });
  simulationRegistry.on('run:completed', (record) => {
    if (!win.isDestroyed()) {
      win.webContents.send('simulation:event', { type: 'completed', record });
    }
  });
  simulationRegistry.on('run:aborted', (record) => {
    if (!win.isDestroyed()) {
      win.webContents.send('simulation:event', { type: 'aborted', record });
    }
  });
}

app.whenReady().then(async () => {
  await projectManager.ensureDataDir();

  mainWindow = createWindow();
  createIPCHandler({ router, windows: [mainWindow] });
  registerWindowControls(mainWindow);
  registerEventForwarding(mainWindow);

  const ompRuntime = resolveOmpRuntime();
  if (ompRuntime) {
    console.log(`[omp] resolved: bun=${ompRuntime.bunVersion}, entry=${ompRuntime.ompEntryPath}`);
    if (!ompRuntime.bunVersionOk) {
      console.warn(`[omp] Bun version ${ompRuntime.bunVersion} is below required 1.3.14. Run: bun upgrade`);
    }
  } else console.warn('[omp] runtime not found (need bun + engine/oh-my-pi)');

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      mainWindow = createWindow();
      registerWindowControls(mainWindow);
      registerEventForwarding(mainWindow);
    }
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

app.on('before-quit', async () => {
  // Save project state before quitting
  await projectManager.saveProjectsDb();
  projectManager.destroy();
  pluginLoader.clearAll();
  await sessionManager.destroyAll();
});
