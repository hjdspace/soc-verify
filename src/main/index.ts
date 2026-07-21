import { app, BrowserWindow, shell, ipcMain, Tray, Menu, nativeImage, dialog } from 'electron';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { existsSync, readFileSync, writeFileSync, unlinkSync } from 'node:fs';
import { execSync } from 'node:child_process';
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

// ── Linux D-Bus 会话总线处理 ───────────────────────────────────────
// 在 HPC 服务器 / SSH + X11 转发 / 最小化窗口管理器等环境中，D-Bus
// 会话总线可能未启动，导致 Chromium 打印大量 dbus/bus.cc ERROR 日志。
// 这些错误不影响应用核心功能（Chromium 会优雅降级），但会造成日志噪音。
//
// 策略：
//   1. 若 DBUS_SESSION_BUS_ADDRESS 已设置且有效 → 正常使用
//   2. 若未设置 → 尝试通过 `dbus-launch` 启动一个会话总线
//   3. 若 dbus-launch 不可用 → 提升 Chromium 日志级别至 FATAL，抑制 ERROR 级噪音
function setupLinuxDbus(): void {
  if (process.platform !== 'linux') return;

  const currentAddr = process.env['DBUS_SESSION_BUS_ADDRESS'];
  if (currentAddr && currentAddr.startsWith('unix:')) {
    // D-Bus session bus already configured — nothing to do
    return;
  }

  // Try to start a D-Bus session bus via dbus-launch
  try {
    const output = execSync('dbus-launch --sh-syntax', {
      encoding: 'utf-8',
      timeout: 5000,
      stdio: ['pipe', 'pipe', 'pipe']
    });
    // Parse lines like: DBUS_SESSION_BUS_ADDRESS=unix:abstract=/tmp/dbus-XXX,guid=...
    //                  DBUS_SESSION_BUS_PID=12345
    //                  DBUS_SESSION_BUS_WINDOWID=1
    for (const line of output.split('\n')) {
      const match = line.match(/^(DBUS_SESSION_BUS_\w+)=(.+?);?\s*$/);
      if (match) {
        process.env[match[1]] = match[2].replace(/;$/, '');
      }
    }
    console.log('[dbus] started session bus via dbus-launch');
    return;
  } catch {
    // dbus-launch not available or failed — fall through to log suppression
  }

  // No D-Bus available: suppress Chromium's non-fatal D-Bus error logs.
  // --log-level=3 means only FATAL messages are printed (0=INFO,1=WARN,2=ERROR,3=FATAL).
  // This silences the harmless "Failed to connect to the bus" noise while
  // preserving genuine crash-level messages.
  app.commandLine.appendSwitch('log-level', '3');
  console.log('[dbus] no session bus available; suppressing Chromium D-Bus error logs');
}

setupLinuxDbus();

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

/** Resolve window icon path: prefers icon.ico (native Windows multi-resolution), falls back to large PNG */
function resolveWindowIcon(): string {
  const ico = join(__dirname, '../../build/icon.ico');
  const png256 = join(__dirname, '../../build/icons/256x256.png');
  const png128 = join(__dirname, '../../build/icons/128x128.png');
  if (existsSync(ico)) return ico;
  if (existsSync(png256)) return png256;
  if (existsSync(png128)) return png128;
  return resolveTrayIcon();
}

// ── 关闭方式偏好持久化 ───────────────────────────────────────────
// 用户可选择「完全关闭」或「最小化到托盘」，并记住选择以免每次询问。

type CloseAction = 'close' | 'tray';

function getClosePrefPath(): string {
  return join(app.getPath('userData'), 'close-pref.json');
}

function loadClosePref(): CloseAction | null {
  try {
    const data = readFileSync(getClosePrefPath(), 'utf-8');
    const parsed = JSON.parse(data) as { action?: string };
    if (parsed.action === 'close' || parsed.action === 'tray') return parsed.action;
    return null;
  } catch {
    return null;
  }
}

function saveClosePref(action: CloseAction): void {
  try {
    writeFileSync(getClosePrefPath(), JSON.stringify({ action }, null, 2), 'utf-8');
  } catch (e) {
    console.error('[close-pref] failed to save:', e);
  }
}

function clearClosePref(): void {
  try {
    const prefPath = getClosePrefPath();
    if (existsSync(prefPath)) unlinkSync(prefPath);
  } catch {
    // ignore errors
  }
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
      label: '重置关闭偏好',
      click: () => {
        clearClosePref();
      }
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
    icon: resolveWindowIcon(),
    backgroundColor: '#1e1e2e',
    webPreferences: {
      preload: join(__dirname, '../preload/index.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false
    }
  });

  win.on('ready-to-show', () => win.show());

  // Close behavior: ask user to fully close or minimize to tray.
  // If a saved preference exists (via "不再询问" checkbox), use it directly.
  win.on('close', async (e) => {
    if (isQuitting) return; // allow close (tray "退出" or explicit app.quit)

    e.preventDefault();

    // If user previously saved a preference, use it directly
    const savedPref = loadClosePref();
    if (savedPref === 'close') {
      isQuitting = true;
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
      isQuitting = true;
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
