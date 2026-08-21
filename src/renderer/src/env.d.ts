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
  // Issue #11: Find-in-page
  findInPage: (id: string, searchText: string, options?: { forward?: boolean }) => Promise<void>;
  stopFindInPage: (id: string, action?: 'clearSelection' | 'keepSelection' | 'activateSelection') => Promise<void>;
  // Issue #9: Single-continue a certificate error for a specific surface+URL
  proceedCertificate: (surfaceId: string, url: string) => Promise<boolean>;
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
  // cwd 切换通知 — 渲染端需重建活跃 AI 会话
  onCwdChanged: (callback: (data: { projectId: string; cwd: string; dirId: string }) => void) => () => void;
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
  onApprovalRequest: (callback: (data: { sessionId: string; requestId: string; toolName: string; args: unknown }) => void) => () => void;
  onAskRequest: (callback: (data: { sessionId: string; requestId: string; questions: unknown[] }) => void) => () => void;
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
  // 覆盖率详细解析进度（按需触发详细解析时推送）
  onCoverageDetailProgress: (
    callback: (data: {
      step: string;
      message: string;
      percent?: number;
      durationMs?: number;
      details?: Record<string, unknown>;
    }) => void,
  ) => () => void;
  // Issue #9: Browser window-open events
  onBrowserOpenNewTab: (callback: (data: { url: string }) => void) => () => void;
  onAuthPopup: (callback: (data: { type: 'opened' | 'closed'; url: string }) => void) => () => void;
  // Coverage Merger 实时日志
  onCoverageMergerLog: (
    callback: (data: {
      type: 'start' | 'output' | 'end';
      command?: string;
      line?: string;
      lines?: string[];
      success?: boolean;
    }) => void,
  ) => () => void;
  // Git Quick Pull 实时日志
  onGitQuickPullLog: (
    callback: (data: {
      type: 'start' | 'repo' | 'end';
      lines: string[];
      repoName?: string;
      success?: boolean;
      reason?: string | null;
      isSkipped?: boolean;
      stats?: {
        total: number;
        success: number;
        skipped: Array<{ name: string; reason: string }>;
        failed: Array<{ name: string; reason: string }>;
      };
    }) => void,
  ) => () => void;
  // Issue #10: Download events
  onDownloadEvent: (
    callback: (data: {
      type: 'started' | 'progress' | 'completed' | 'failed' | 'cancelled';
      filename: string;
      percent?: number;
      savedPath?: string;
      error?: string;
      url?: string;
    }) => void,
  ) => () => void;
  // Git Manager 事件（缓存加载 + 后台刷新进度）
  onGitManagerEvent: (
    callback: (data: {
      type: 'progress' | 'repoRefreshed' | 'scanComplete' | 'error';
      completed?: number;
      total?: number;
      repoName?: string;
      repo?: unknown;
      fromCache?: boolean;
      message?: string;
    }) => void,
  ) => () => void;
  // Sysbase Gen Module IO 生成实时日志
  onSysbaseGenModIoLog: (
    callback: (data: {
      type: 'start' | 'output' | 'end';
      command?: string;
      line?: string;
      lines?: string[];
      success?: boolean;
      outputFilePath?: string;
    }) => void,
  ) => () => void;
  // Sysbase Gen 执行 sysbase_gen.py 实时日志
  onSysbaseGenRunLog: (
    callback: (data: {
      type: 'start' | 'output' | 'end';
      command?: string;
      line?: string;
      lines?: string[];
      success?: boolean;
    }) => void,
  ) => () => void;
  // 知识库文档状态事件（Issue #3 / #5）
  onKbDocStatus: (
    callback: (data: {
      name: string;
      status: 'queued' | 'converting' | 'classifying' | 'done' | 'failed';
      errorCode?: string;
      errorMessage?: string;
      category?: string;
    }) => void,
  ) => () => void;
  // 知识库深度重建进度事件（Issue #7）
  onKbDeepReindex: (
    callback: (data: {
      phase: 'processing' | 'completed' | 'failed';
      current?: number;
      total?: number;
      message: string;
      error?: string;
    }) => void,
  ) => () => void;
  // 全局错误事件（主进程 uncaughtException / unhandledRejection）
  onGlobalError: (
    callback: (data: {
      type: 'uncaughtException' | 'unhandledRejection';
      message: string;
      stack?: string;
      timestamp: string;
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
