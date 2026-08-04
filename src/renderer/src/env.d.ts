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
    eventBridge?: EventBridgeAPI;
  }

  // ── Electron <webview> 标签类型声明 ──────────────────────────
  // webview 是 Electron 提供的自定义元素，独立于渲染进程运行，
  // 不在 @types/react 的 JSX.IntrinsicElements 中。此处补齐常用属性。
  namespace JSX {
    interface IntrinsicElements {
      webview: WebviewAttributes;
    }
  }
}

// webview 标签支持的常用属性（仅声明本期使用的子集）
export interface WebviewAttributes {
  src?: string;
  partition?: string;
  // 关闭 http/https 时的安全策略限制（用于加载 localhost watch 服务）
  allowpopups?: boolean;
  // 启用 Node 集成（默认 false，保持隔离）
  nodeintegration?: boolean;
  // 禁用 websecurity（仅用于本地 file:// 加载，跨平台兼容）
  disablewebsecurity?: boolean;
  // 事件回调
  onLoad?: React.EventHandler<React.SyntheticEvent<HTMLElement>>;
  onDomReady?: React.EventHandler<React.SyntheticEvent<HTMLElement>>;
  onError?: React.EventHandler<React.SyntheticEvent<HTMLElement>>;
  [key: string]: unknown;
}
