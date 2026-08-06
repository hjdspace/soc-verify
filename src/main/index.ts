import { app, BrowserWindow, Tray } from 'electron';
import { createIPCHandler } from './ipc/electron-trpc-bridge';
import { router } from './ipc/router';
import { resolveAgentRuntime } from './agent/paths';
import { projectManager } from './project/project-manager';
import { sessionManager } from './agent/session-manager';
import { pluginLoader } from './plugins/loader';
import { errorAnalysisCoordinator } from './simulation/error-analysis-coordinator';
import { terminalManager } from './terminal/terminal-manager';
import { registerDocumentIpcHandlers, cleanupEditorRegistry } from './document/editor-registry';
import { cleanupOfficeCli } from './officecli/service';
import { closeAllToolWindows } from './tools/tool-window-manager';
import { destroyAllSurfaceManagers, registerSurfaceIpcHandlers } from './surface/surface-ipc';
import { createEventRelay, type EventRelay } from './ipc/event-relay';
import { setupLinuxPlatform } from './platform-setup';
import { createTray } from './tray-manager';
import { createWindow, registerWindowControls } from './window-factory';

// ── Linux 平台环境设置（IME + D-Bus）─────────────────────────────
setupLinuxPlatform();

let mainWindow: BrowserWindow | null = null;
let tray: Tray | null = null;
let eventRelay: EventRelay | null = null;

/** Set up declarative event relay: forwards backend EventEmitter events to the renderer. */
function setupEventRelay(win: BrowserWindow): EventRelay {
  // Destroy previous relay to clean up listeners (prevents leak on window recreation)
  eventRelay?.destroy();
  eventRelay = createEventRelay(win);
  return eventRelay;
}

app.whenReady().then(async () => {
  await projectManager.ensureDataDir();
  const restoredCount = await projectManager.restorePersistedProjects();
  if (restoredCount > 0) {
    console.log(`[project] restored ${restoredCount} project(s) from disk`);
  }

  mainWindow = createWindow();
  createIPCHandler({ router, windows: [mainWindow] });
  registerWindowControls();
  registerSurfaceIpcHandlers();
  setupEventRelay(mainWindow);

  // 注册 officecli 文档相关 IPC handlers（flush-done 由前端发送）
  registerDocumentIpcHandlers();

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
    setupEventRelay(mainWindow);
  } else {
    mainWindow?.show();
    mainWindow?.focus();
  }
});

app.on('before-quit', async () => {
  // Destroy tray before quitting
  tray?.destroy();
  tray = null;
  // Clean up event relay listeners
  eventRelay?.destroy();
  eventRelay = null;
  // Save project state before quitting
  await projectManager.saveProjectsDb();
  projectManager.destroy();
  await pluginLoader.deactivateAll();
  pluginLoader.clearAll();
  await sessionManager.destroyAll();
  terminalManager.destroyAll();
  // 清理 officecli watch 进程和文档编辑器注册表
  cleanupOfficeCli();
  cleanupEditorRegistry();
  // 关闭所有工具窗口
  closeAllToolWindows();
  destroyAllSurfaceManagers();
});
