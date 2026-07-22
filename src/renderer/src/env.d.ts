/// <reference types="vite/client" />

// ── windowControls 类型声明（由 preload 通过 contextBridge 暴露）────
export interface WindowControlsAPI {
  minimize: () => void;
  toggleMaximize: () => void;
  close: () => void;
  isMaximized: () => Promise<boolean>;
  onMaximizeChange: (callback: (isMaximized: boolean) => void) => () => void;
}

// ── eventBridge 类型声明（IPC 事件转发）──────────────────────────
export interface EventBridgeAPI {
  onFileTreeUpdate: (callback: (update: {
    projectId: string;
    type: 'add' | 'unlink' | 'change';
    path: string;
  }) => void) => () => void;
  onProjectOpened: (callback: (info: {
    id: string;
    name: string;
    rootPath: string;
    createdAt: number;
    lastOpenedAt: number;
  }) => void) => () => void;
  onProjectClosed: (callback: (projectId: string) => void) => () => void;
  onSessionEvent: (callback: (data: { sessionId: string; event: unknown }) => void) => () => void;
  onSimulationEvent: (callback: (data: { type: string; record: unknown }) => void) => () => void;
  onErrorAnalysisEvent: (callback: (data: { type: string; [key: string]: unknown }) => void) => () => void;
  onClosureEvent: (callback: (data: { type: string; [key: string]: unknown }) => void) => () => void;
  onTerminalData: (callback: (data: { id: string; data: string }) => void) => () => void;
  onTerminalExit: (callback: (data: { id: string; exitCode: number }) => void) => () => void;
}

declare global {
  interface Window {
    windowControls?: WindowControlsAPI;
    eventBridge?: EventBridgeAPI;
  }
}
