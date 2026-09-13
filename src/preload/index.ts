import { contextBridge, ipcRenderer } from 'electron';
import { exposeElectronTRPC } from 'electron-trpc/main';
import type { SurfaceDeclaration } from '@shared/surface-types';
import { GLOBAL_ERROR_CHANNEL } from '@shared/ipc-channels';

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
    // cwd:changed — notify renderer to rebuild active AI session with new cwd
    onCwdChanged: (callback: (data: { projectId: string; cwd: string; dirId: string }) => void) => {
      const handler = (_event: Electron.IpcRendererEvent, data: { projectId: string; cwd: string; dirId: string }) => callback(data);
      ipcRenderer.on('cwd:changed', handler);
      return () => ipcRenderer.removeListener('cwd:changed', handler);
    },
    onSessionEvent: (callback: (data: { sessionId: string; event: unknown }) => void) => {
      const handler = (_event: Electron.IpcRendererEvent, data: { sessionId: string; event: unknown }) => callback(data);
      ipcRenderer.on('session:event', handler);
      return () => ipcRenderer.removeListener('session:event', handler);
    },
    onApprovalRequest: (callback: (data: { sessionId: string; requestId: string; toolName: string; args: unknown }) => void) => {
      const handler = (_event: Electron.IpcRendererEvent, data: { sessionId: string; requestId: string; toolName: string; args: unknown }) => callback(data);
      ipcRenderer.on('session:approval-request', handler);
      return () => ipcRenderer.removeListener('session:approval-request', handler);
    },
    onTrustRequest: (callback: (data: { sessionId: string; requestId: string; kind: 'project-extension' | 'mcp-server'; name: string; path?: string }) => void) => {
      const handler = (_event: Electron.IpcRendererEvent, data: { sessionId: string; requestId: string; kind: 'project-extension' | 'mcp-server'; name: string; path?: string }) => callback(data);
      ipcRenderer.on('session:trust-request', handler);
      return () => ipcRenderer.removeListener('session:trust-request', handler);
    },
    onAskRequest: (callback: (data: { sessionId: string; requestId: string; questions: unknown[] }) => void) => {
      const handler = (_event: Electron.IpcRendererEvent, data: { sessionId: string; requestId: string; questions: unknown[] }) => callback(data);
      ipcRenderer.on('session:ask-request', handler);
      return () => ipcRenderer.removeListener('session:ask-request', handler);
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

    // ── Issue #8: TitleBar 回归徽章 + 通知中心 ──────────────────
    // regression:event —— 运行中回归的 started / progress / finished 推送
    onRegressionEvent: (callback: (event: unknown) => void) => {
      const handler = (_event: Electron.IpcRendererEvent, data: unknown) => callback(data);
      ipcRenderer.on('regression:event', handler);
      return () => ipcRenderer.removeListener('regression:event', handler);
    },
    // notification:event —— 通知列表任意变更后的全量同步
    onNotificationEvent: (callback: (event: unknown) => void) => {
      const handler = (_event: Electron.IpcRendererEvent, data: unknown) => callback(data);
      ipcRenderer.on('notification:event', handler);
      return () => ipcRenderer.removeListener('notification:event', handler);
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

    // ── 覆盖率详细解析进度 ──────────────────────────────────────
    // coverage:detail-progress —— 主进程推送按需详细解析各步骤进度到前端
    onCoverageDetailProgress: (
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
      ipcRenderer.on('coverage:detail-progress', handler);
      return () => ipcRenderer.removeListener('coverage:detail-progress', handler);
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

    // ── Coverage Merger 实时日志事件 ────────────────────────────
    // coverage-merger:log —— 主进程推送覆盖率合并的实时日志
    onCoverageMergerLog: (
      callback: (data: {
        type: 'start' | 'output' | 'end';
        command?: string;
        line?: string;
        lines?: string[];
        success?: boolean;
      }) => void,
    ) => {
      const handler = (
        _event: Electron.IpcRendererEvent,
        data: {
          type: 'start' | 'output' | 'end';
          command?: string;
          line?: string;
          lines?: string[];
          success?: boolean;
        },
      ) => callback(data);
      ipcRenderer.on('coverage-merger:log', handler);
      return () => ipcRenderer.removeListener('coverage-merger:log', handler);
    },

    // ── Git Quick Pull 实时日志事件 ────────────────────────────
    // git-quick-pull:log —— 主进程推送批量 git pull 的实时日志
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
    ) => {
      const handler = (
        _event: Electron.IpcRendererEvent,
        data: {
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
        },
      ) => callback(data);
      ipcRenderer.on('git-quick-pull:log', handler);
      return () => ipcRenderer.removeListener('git-quick-pull:log', handler);
    },

    // ── Git Manager 事件（缓存加载 + 后台刷新进度）─────────────
    // git-manager:event —— 主进程推送扫描进度 / 单仓库刷新完成 / 扫描完成
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
    ) => {
      const handler = (
        _event: Electron.IpcRendererEvent,
        data: {
          type: 'progress' | 'repoRefreshed' | 'scanComplete' | 'error';
          completed?: number;
          total?: number;
          repoName?: string;
          repo?: unknown;
          fromCache?: boolean;
          message?: string;
        },
      ) => callback(data);
      ipcRenderer.on('git-manager:event', handler);
      return () => ipcRenderer.removeListener('git-manager:event', handler);
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

    // ── Sysbase Gen Module IO 生成实时日志事件 ──────────────────
    // sysbase-gen:mod-io-log —— 主进程推送 Module IO 生成的实时日志
    onSysbaseGenModIoLog: (
      callback: (data: {
        type: 'start' | 'output' | 'end';
        command?: string;
        line?: string;
        lines?: string[];
        success?: boolean;
        outputFilePath?: string;
      }) => void,
    ) => {
      const handler = (
        _event: Electron.IpcRendererEvent,
        data: {
          type: 'start' | 'output' | 'end';
          command?: string;
          line?: string;
          lines?: string[];
          success?: boolean;
          outputFilePath?: string;
        },
      ) => callback(data);
      ipcRenderer.on('sysbase-gen:mod-io-log', handler);
      return () => ipcRenderer.removeListener('sysbase-gen:mod-io-log', handler);
    },

    // ── Sysbase Gen 执行 sysbase_gen.py 实时日志事件 ─────────────
    // sysbase-gen:run-log —— 主进程推送 sysbase_gen.py 执行的实时日志
    onSysbaseGenRunLog: (
      callback: (data: {
        type: 'start' | 'output' | 'end';
        command?: string;
        line?: string;
        lines?: string[];
        success?: boolean;
      }) => void,
    ) => {
      const handler = (
        _event: Electron.IpcRendererEvent,
        data: {
          type: 'start' | 'output' | 'end';
          command?: string;
          line?: string;
          lines?: string[];
          success?: boolean;
        },
      ) => callback(data);
      ipcRenderer.on('sysbase-gen:run-log', handler);
      return () => ipcRenderer.removeListener('sysbase-gen:run-log', handler);
    },

    // ── 知识库文档状态事件（Issue #3）────────────────────────
    // kb:docStatus —— 主进程推送文档状态变化（queued/converting/classifying/done/failed）
    onKbDocStatus: (
      callback: (data: {
        name: string;
        status: 'queued' | 'converting' | 'classifying' | 'done' | 'failed';
        errorCode?: string;
        errorMessage?: string;
        category?: string;
        aiDegraded?: boolean;
        aiError?: string;
      }) => void,
    ) => {
      const handler = (
        _event: Electron.IpcRendererEvent,
        data: {
          name: string;
          status: 'queued' | 'converting' | 'classifying' | 'done' | 'failed';
          errorCode?: string;
          errorMessage?: string;
          category?: string;
          aiDegraded?: boolean;
          aiError?: string;
        },
      ) => callback(data);
      ipcRenderer.on('kb:docStatus', handler);
      return () => ipcRenderer.removeListener('kb:docStatus', handler);
    },

    // ── 知识库深度重建进度事件（Issue #7）────────────────────────
    // kb:deepReindex —— 主进程推送深度重建进度（processing/completed/failed）
    onKbDeepReindex: (
      callback: (data: {
        phase: 'processing' | 'completed' | 'failed';
        current?: number;
        total?: number;
        message: string;
        error?: string;
      }) => void,
    ) => {
      const handler = (
        _event: Electron.IpcRendererEvent,
        data: {
          phase: 'processing' | 'completed' | 'failed';
          current?: number;
          total?: number;
          message: string;
          error?: string;
        },
      ) => callback(data);
      ipcRenderer.on('kb:deepReindex', handler);
      return () => ipcRenderer.removeListener('kb:deepReindex', handler);
    },

    // ── 知识库导入队列事件（issue 03）────────────────────────
    // kb:task —— 主进程推送队列任务/队列状态事件（带 kbId 与单调 seq；
    // 渲染端重订阅先拉 kb.queueSnapshot 快照再按 seq 应用事件）
    onKbTask: (
      callback: (data: {
        type: 'task' | 'queue';
        kbId: string;
        seq: number;
        taskId?: string;
        attemptId?: string;
        phase?: string;
        lastError?: { code: string; message: string; at: string } | null;
        paused?: boolean;
        restoredWaiting?: boolean;
      }) => void,
    ) => {
      const handler = (_event: Electron.IpcRendererEvent, data: unknown) =>
        callback(data as Parameters<typeof callback>[0]);
      ipcRenderer.on('kb:task', handler);
      return () => ipcRenderer.removeListener('kb:task', handler);
    },

    // ── 全局错误事件（主进程 uncaughtException / unhandledRejection）──
    // global:error —— 主进程推送全局未捕获异常
    onGlobalError: (
      callback: (data: {
        type: 'uncaughtException' | 'unhandledRejection';
        message: string;
        stack?: string;
        timestamp: string;
      }) => void,
    ) => {
      const handler = (
        _event: Electron.IpcRendererEvent,
        data: {
          type: 'uncaughtException' | 'unhandledRejection';
          message: string;
          stack?: string;
          timestamp: string;
        },
      ) => callback(data);
      ipcRenderer.on(GLOBAL_ERROR_CHANNEL, handler);
      return () => ipcRenderer.removeListener(GLOBAL_ERROR_CHANNEL, handler);
    },

    // ── slang-server LSP 诊断推送（issue 06）──────────────────
    // lsp:diagnostics —— 主进程推送 publishDiagnostics 到渲染端
    onLspDiagnostics: (
      callback: (data: {
        projectId: string;
        uri: string;
        diagnostics: Array<{
          range: { start: { line: number; character: number }; end: { line: number; character: number } };
          severity: 'error' | 'warning' | 'info' | 'hint';
          message: string;
          source?: string;
          code?: number | string;
        }>;
      }) => void,
    ) => {
      const handler = (
        _event: Electron.IpcRendererEvent,
        data: {
          projectId: string;
          uri: string;
          diagnostics: Array<{
            range: { start: { line: number; character: number }; end: { line: number; character: number } };
            severity: 'error' | 'warning' | 'info' | 'hint';
            message: string;
            source?: string;
            code?: number | string;
          }>;
        },
      ) => callback(data);
      ipcRenderer.on('lsp:diagnostics', handler);
      return () => ipcRenderer.removeListener('lsp:diagnostics', handler);
    },
  });
});
