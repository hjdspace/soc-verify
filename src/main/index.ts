import { app, BrowserWindow, shell, ipcMain, Tray, Menu, nativeImage } from 'electron';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { existsSync } from 'node:fs';
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
let tray: Tray | null = null;
let isQuitting = false;

/** Resolve tray icon path: prefers build/icons PNG, falls back to icon.ico */
function resolveTrayIcon(): string {
  const png32 = join(__dirname, '../../build/icons/32x32.png');
  const png16 = join(__dirname, '../../build/icons/16x16.png');
  const ico = join(__dirname, '../../build/icon.ico');
  if (existsSync(png32)) return png32;
  if (existsSync(png16)) return png16;
  return ico;
}

/** Create system tray with context menu */
function createTray(win: BrowserWindow): Tray {
  const iconPath = resolveTrayIcon();
  const image = nativeImage.createFromPath(iconPath);
  const t = new Tray(image);
  t.setToolTip('SoC Verify');

  const contextMenu = Menu.buildFromTemplate([
    {
      label: '显示窗口',
      click: () => {
        win.show();
        win.focus();
      }
    },
    {
      label: '隐藏窗口',
      click: () => win.hide()
    },
    { type: 'separator' },
    {
      label: '退出',
      click: () => {
        isQuitting = true;
        app.quit();
      }
    }
  ]);

  t.setContextMenu(contextMenu);

  // Click toggles window visibility
  t.on('click', () => {
    if (win.isVisible() && win.isFocused()) {
      win.hide();
    } else {
      win.show();
      win.focus();
    }
  });

  return t;
}

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

  // Minimize to tray instead of quitting (unless explicit quit)
  win.on('close', (e) => {
    if (!isQuitting) {
      e.preventDefault();
      win.hide();
    }
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

  // Create system tray
  tray = createTray(mainWindow);

  // Register error analysis coordinator to listen for simulation completions
  errorAnalysisCoordinator.registerListeners();

  const agentRuntime = resolveAgentRuntime();
  if (agentRuntime) {
    if (agentRuntime.mode === 'binary') {
      console.log(`[agent] resolved: binary mode, runner=${agentRuntime.runnerPath}`);
    } else {
      console.log(`[agent] resolved: script mode, bun=${agentRuntime.bunVersion}, runner=${agentRuntime.runnerPath}`);
      if (!agentRuntime.bunVersionOk) {
        console.warn(`[agent] Bun version ${agentRuntime.bunVersion} is below required 1.3.14. Run: bun upgrade`);
      }
    }
  } else {
    console.warn('[agent] runtime not found. Run `npm run setup:agent` to download the agent binary.');
  }
});

app.on('window-all-closed', () => {
  // With tray: keep app running (window is hidden, not closed)
  // On macOS this is the default behavior
});

app.on('activate', () => {
  if (BrowserWindow.getAllWindows().length === 0) {
    mainWindow = createWindow();
    registerWindowControls(mainWindow);
    registerEventForwarding(mainWindow);
  } else {
    mainWindow?.show();
    mainWindow?.focus();
  }
});

app.on('before-quit', async () => {
  // Destroy tray before quitting
  tray?.destroy();
  tray = null;
  // Save project state before quitting
  await projectManager.saveProjectsDb();
  projectManager.destroy();
  pluginLoader.clearAll();
  await sessionManager.destroyAll();
  terminalManager.destroyAll();
});
