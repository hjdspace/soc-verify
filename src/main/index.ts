import { app, BrowserWindow, shell, ipcMain } from 'electron';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { createIPCHandler } from './ipc/electron-trpc-bridge';
import { router } from './ipc/router';
import { resolveAgentRuntime } from './agent/paths';
import { projectManager } from './project/project-manager';
import { sessionManager } from './agent/session-manager';
import { pluginLoader } from './plugins/loader';
import { simulationRegistry } from './simulation/simulation-registry';
import { simTerminalLinker } from './simulation/sim-terminal-linker';
import { errorAnalysisCoordinator } from './simulation/error-analysis-coordinator';
import { terminalManager } from './terminal/terminal-manager';

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

  // Session events from agent
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

  // Terminal-based simulation events (from simTerminalLinker)
  simTerminalLinker.on('run:started', (run) => {
    if (!win.isDestroyed()) {
      win.webContents.send('simulation:event', { type: 'started', record: run });
    }
  });

  simTerminalLinker.on('run:completed', (run) => {
    if (!win.isDestroyed()) {
      win.webContents.send('simulation:event', { type: 'completed', record: run });
    }
  });

  simTerminalLinker.on('run:aborted', (run) => {
    if (!win.isDestroyed()) {
      win.webContents.send('simulation:event', { type: 'aborted', record: run });
    }
  });

  // Terminal data events
  terminalManager.on('data', ({ id, data }) => {
    if (!win.isDestroyed()) {
      win.webContents.send('terminal:data', { id, data });
    }
  });

  terminalManager.on('exit', ({ id, exitCode }) => {
    if (!win.isDestroyed()) {
      win.webContents.send('terminal:exit', { id, exitCode });
    }
  });

  // Error analysis events (from ErrorAnalysisCoordinator)
  errorAnalysisCoordinator.on('errorAnalysis:started', (data) => {
    if (!win.isDestroyed()) {
      win.webContents.send('errorAnalysis:event', { type: 'started', ...data });
    }
  });

  errorAnalysisCoordinator.on('errorAnalysis:retrying', (data) => {
    if (!win.isDestroyed()) {
      win.webContents.send('errorAnalysis:event', { type: 'retrying', ...data });
    }
  });

  errorAnalysisCoordinator.on('errorAnalysis:stopped', (data) => {
    if (!win.isDestroyed()) {
      win.webContents.send('errorAnalysis:event', { type: 'stopped', ...data });
    }
  });

  errorAnalysisCoordinator.on('errorAnalysis:failed', (data) => {
    if (!win.isDestroyed()) {
      win.webContents.send('errorAnalysis:event', { type: 'failed', ...data });
    }
  });

  errorAnalysisCoordinator.on('errorAnalysis:statusChanged', (data) => {
    if (!win.isDestroyed()) {
      win.webContents.send('errorAnalysis:event', { type: 'statusChanged', ...data });
    }
  });
}

app.whenReady().then(async () => {
  await projectManager.ensureDataDir();
  const restoredCount = await projectManager.restorePersistedProjects();
  if (restoredCount > 0) {
    console.log(`[project] restored ${restoredCount} project(s) from disk`);
  }

  mainWindow = createWindow();
  createIPCHandler({ router, windows: [mainWindow] });
  registerWindowControls(mainWindow);
  registerEventForwarding(mainWindow);

  // Register error analysis coordinator to listen for simulation completions
  errorAnalysisCoordinator.registerListeners();

  const agentRuntime = resolveAgentRuntime();
  if (agentRuntime) {
    console.log(`[agent] resolved: bun=${agentRuntime.bunVersion}, runner=${agentRuntime.runnerPath}`);
    if (!agentRuntime.bunVersionOk) {
      console.warn(`[agent] Bun version ${agentRuntime.bunVersion} is below required 1.3.14. Run: bun upgrade`);
    }
  } else console.warn('[agent] runtime not found (need bun + engine/oh-my-pi runner script)');

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
  terminalManager.destroyAll();
});
