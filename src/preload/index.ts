import { contextBridge, ipcRenderer } from 'electron';
import { exposeElectronTRPC } from 'electron-trpc/main';
import type { SurfaceDeclaration } from '@shared/surface-types';

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

  contextBridge.exposeInMainWorld('surfaceBridge', {
    sync: (declaration: SurfaceDeclaration) => ipcRenderer.invoke('surface:sync', declaration),
    show: (id: string) => ipcRenderer.invoke('surface:show', id),
    hide: (id: string) => ipcRenderer.invoke('surface:hide', id),
    destroy: (id: string) => ipcRenderer.invoke('surface:destroy', id),
    setOverlayHidden: (hidden: boolean) => ipcRenderer.invoke('surface:set-overlay-hidden', hidden),
    goBack: (id: string) => ipcRenderer.invoke('surface:go-back', id),
    goForward: (id: string) => ipcRenderer.invoke('surface:go-forward', id),
    reload: (id: string) => ipcRenderer.invoke('surface:reload', id),
    // Issue #11: Find-in-page
    findInPage: (id: string, searchText: string, options?: { forward?: boolean }) =>
      ipcRenderer.invoke('surface:find-in-page', id, searchText, options),
    stopFindInPage: (id: string, action?: 'clearSelection' | 'keepSelection' | 'activateSelection') =>
      ipcRenderer.invoke('surface:stop-find-in-page', id, action),
  });

  // ── 事件监听 API（文件树更新、项目事件、会话事件）──────────────
  contextBridge.exposeInMainWorld('eventBridge', {
    onSurfaceEvent: (callback: (event: unknown) => void) => {
      const handler = (_event: Electron.IpcRendererEvent, data: unknown) => callback(data);
      ipcRenderer.on('surface:event', handler);
      return () => ipcRenderer.removeListener('surface:event', handler);
    },
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
    onErrorAnalysisEvent: (callback: (data: { type: string; [key: string]: unknown }) => void) => {
      const handler = (_event: Electron.IpcRendererEvent, data: { type: string; [key: string]: unknown }) => callback(data);
      ipcRenderer.on('errorAnalysis:event', handler);
      return () => ipcRenderer.removeListener('errorAnalysis:event', handler);
    },
    onClosureEvent: (callback: (data: { type: string; [key: string]: unknown }) => void) => {
      const handler = (_event: Electron.IpcRendererEvent, data: { type: string; [key: string]: unknown }) => callback(data);
      ipcRenderer.on('closure:event', handler);
      return () => ipcRenderer.removeListener('closure:event', handler);
    },
    onTerminalData: (callback: (data: { id: string; data: string }) => void) => {
      const handler = (_event: Electron.IpcRendererEvent, data: { id: string; data: string }) => callback(data);
      ipcRenderer.on('terminal:data', handler);
      return () => ipcRenderer.removeListener('terminal:data', handler);
    },
    onTerminalExit: (callback: (data: { id: string; exitCode: number }) => void) => {
      const handler = (_event: Electron.IpcRendererEvent, data: { id: string; exitCode: number }) => callback(data);
      ipcRenderer.on('terminal:exit', handler);
      return () => ipcRenderer.removeListener('terminal:exit', handler);
    },

    // ── officecli 文档事件（Issue #7 / #8）──────────────────────
    // document:flush-request —— 主进程通知前端立即 flush XlsxEditor 未保存的修改
    onDocumentFlushRequest: (callback: (filePath: string) => void) => {
      const handler = (_event: Electron.IpcRendererEvent, filePath: string) => callback(filePath);
      ipcRenderer.on('document:flush-request', handler);
      return () => ipcRenderer.removeListener('document:flush-request', handler);
    },
    // document:file-changed —— AI 修改文件后通知前端重载
    onDocumentFileChanged: (callback: (filePath: string) => void) => {
      const handler = (_event: Electron.IpcRendererEvent, filePath: string) => callback(filePath);
      ipcRenderer.on('document:file-changed', handler);
      return () => ipcRenderer.removeListener('document:file-changed', handler);
    },
    // officecli:download-progress —— 开发模式下载 officecli 二进制的进度推送
    onOfficecliDownloadProgress: (
      callback: (data: { stage: string; message: string; percent?: number }) => void,
    ) => {
      const handler = (
        _event: Electron.IpcRendererEvent,
        data: { stage: string; message: string; percent?: number },
      ) => callback(data);
      ipcRenderer.on('officecli:download-progress', handler);
      return () => ipcRenderer.removeListener('officecli:download-progress', handler);
    },

    // ── 时序违例解析进度 ──────────────────────────────────────
    // violation:parseProgress —— 主进程推送解析进度到前端
    onViolationParseProgress: (
      callback: (data: { filePath: string; processedLines: number; foundViolations: number }) => void,
    ) => {
      const handler = (
        _event: Electron.IpcRendererEvent,
        data: { filePath: string; processedLines: number; foundViolations: number },
      ) => callback(data);
      ipcRenderer.on('violation:parseProgress', handler);
      return () => ipcRenderer.removeListener('violation:parseProgress', handler);
    },

    // ── 覆盖率导入进度 ──────────────────────────────────────
    // coverage:import-progress —— 主进程推送覆盖率导入各步骤进度到前端
    onCoverageImportProgress: (
      callback: (data: {
        step: string;
        message: string;
        percent?: number;
        durationMs?: number;
        details?: Record<string, unknown>;
      }) => void,
    ) => {
      const handler = (
        _event: Electron.IpcRendererEvent,
        data: {
          step: string;
          message: string;
          percent?: number;
          durationMs?: number;
          details?: Record<string, unknown>;
        },
      ) => callback(data);
      ipcRenderer.on('coverage:import-progress', handler);
      return () => ipcRenderer.removeListener('coverage:import-progress', handler);
    },

    // ── Issue #9: Browser window-open events ────────────────────
    // browser:open-new-tab —— 主进程通知前端打开新的浏览器标签页
    onBrowserOpenNewTab: (callback: (data: { url: string }) => void) => {
      const handler = (_event: Electron.IpcRendererEvent, data: { url: string }) => callback(data);
      ipcRenderer.on('browser:open-new-tab', handler);
      return () => ipcRenderer.removeListener('browser:open-new-tab', handler);
    },
    // browser:auth-popup —— 认证浮层打开/关闭事件
    onAuthPopup: (
      callback: (data: { type: 'opened' | 'closed'; url: string }) => void,
    ) => {
      const handler = (
        _event: Electron.IpcRendererEvent,
        data: { type: 'opened' | 'closed'; url: string },
      ) => callback(data);
      ipcRenderer.on('browser:auth-popup', handler);
      return () => ipcRenderer.removeListener('browser:auth-popup', handler);
    },

    // ── Issue #10: Download events ───────────────────────────────
    // browser:download-event —— 下载生命周期事件（开始/进度/完成/失败/取消）
    onDownloadEvent: (
      callback: (data: {
        type: 'started' | 'progress' | 'completed' | 'failed' | 'cancelled';
        filename: string;
        percent?: number;
        savedPath?: string;
        error?: string;
        url?: string;
      }) => void,
    ) => {
      const handler = (
        _event: Electron.IpcRendererEvent,
        data: {
          type: 'started' | 'progress' | 'completed' | 'failed' | 'cancelled';
          filename: string;
          percent?: number;
          savedPath?: string;
          error?: string;
          url?: string;
        },
      ) => callback(data);
      ipcRenderer.on('browser:download-event', handler);
      return () => ipcRenderer.removeListener('browser:download-event', handler);
    },
  });
});
