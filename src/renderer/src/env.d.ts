/// <reference types="vite/client" />

import type { SurfaceDeclaration, SurfaceEvent } from '@shared/surface-types';

export interface SurfaceBridgeAPI {
  sync: (declaration: SurfaceDeclaration) => Promise<void>;
  show: (id: string) => Promise<void>;
  hide: (id: string) => Promise<void>;
  destroy: (id: string) => Promise<void>;
  setOverlayHidden: (hidden: boolean) => Promise<void>;
  goBack: (id: string) => Promise<void>;
  goForward: (id: string) => Promise<void>;
  reload: (id: string) => Promise<void>;
}

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
  // officecli 文档事件（Issue #7 / #8）
  onDocumentFlushRequest: (callback: (filePath: string) => void) => () => void;
  onDocumentFileChanged: (callback: (filePath: string) => void) => () => void;
  onOfficecliDownloadProgress: (
    callback: (data: { stage: string; message: string; percent?: number }) => void,
  ) => () => void;
  // 时序违例解析进度
  onViolationParseProgress: (
    callback: (data: { filePath: string; processedLines: number; foundViolations: number }) => void,
  ) => () => void;
  // 覆盖率导入进度
  onSurfaceEvent: (callback: (event: SurfaceEvent) => void) => () => void;
  onCoverageImportProgress: (
    callback: (data: {
      step: string;
      message: string;
      percent?: number;
      durationMs?: number;
      details?: Record<string, unknown>;
    }) => void,
  ) => () => void;
}

declare global {
  interface Window {
    windowControls?: WindowControlsAPI;
    surfaceBridge?: SurfaceBridgeAPI;
    eventBridge?: EventBridgeAPI;
  }
}
