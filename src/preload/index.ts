import { contextBridge, ipcRenderer } from 'electron';
import { exposeElectronTRPC } from 'electron-trpc/main';

// electron-trpc 要求在 'loaded' 事件后暴露桥接
process.once('loaded', async () => {
  exposeElectronTRPC();

  // ── 窗口控制 API（无边框窗口自定义 TitleBar 使用）──────────────
  contextBridge.exposeInMainWorld('windowControls', {
    minimize: () => ipcRenderer.send('window:minimize'),
    toggleMaximize: () => ipcRenderer.send('window:maximize'),
    close: () => ipcRenderer.send('window:close'),
    isMaximized: () => ipcRenderer.invoke('window:is-maximized'),
    onMaximizeChange: (callback: (isMaximized: boolean) => void) => {
      const handler = (_event: Electron.IpcRendererEvent, isMaximized: boolean) =>
        callback(isMaximized);
      ipcRenderer.on('window:maximize-changed', handler);
      return () => ipcRenderer.removeListener('window:maximize-changed', handler);
    },
  });

  // ── 事件监听 API（文件树更新、项目事件、会话事件）──────────────
  contextBridge.exposeInMainWorld('eventBridge', {
    onFileTreeUpdate: (callback: (update: unknown) => void) => {
      const handler = (_event: Electron.IpcRendererEvent, update: unknown) => callback(update);
      ipcRenderer.on('filetree:update', handler);
      return () => ipcRenderer.removeListener('filetree:update', handler);
    },
    onProjectOpened: (callback: (info: unknown) => void) => {
      const handler = (_event: Electron.IpcRendererEvent, info: unknown) => callback(info);
      ipcRenderer.on('project:opened', handler);
      return () => ipcRenderer.removeListener('project:opened', handler);
    },
    onProjectClosed: (callback: (projectId: string) => void) => {
      const handler = (_event: Electron.IpcRendererEvent, projectId: string) => callback(projectId);
      ipcRenderer.on('project:closed', handler);
      return () => ipcRenderer.removeListener('project:closed', handler);
    },
    onSessionEvent: (callback: (data: { sessionId: string; event: unknown }) => void) => {
      const handler = (_event: Electron.IpcRendererEvent, data: { sessionId: string; event: unknown }) => callback(data);
      ipcRenderer.on('session:event', handler);
      return () => ipcRenderer.removeListener('session:event', handler);
    },
    onSimulationEvent: (callback: (data: { type: string; record: unknown }) => void) => {
      const handler = (_event: Electron.IpcRendererEvent, data: { type: string; record: unknown }) => callback(data);
      ipcRenderer.on('simulation:event', handler);
      return () => ipcRenderer.removeListener('simulation:event', handler);
    },
  });
});
