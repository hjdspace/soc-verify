import { useEffect, useRef } from 'react';
import { AppShell } from './components/layout/AppShell';
import { ToastContainer } from './components/ToastContainer';
import { useThemeStore } from './stores/theme';
import { useTerminalThemeStore } from './stores/terminal-theme';
import { useFontStore } from './stores/font';
import { useEditorStore } from './stores/editor';
import { useToastStore } from './stores/toast';
import { useSessionCoreStore } from './stores/session-core';
import { useSessionMessagesStore } from './stores/session-messages';
import { useSessionApprovalStore } from './stores/session-approval';
import { useSettingsStore } from './stores/settings';
import { useProjectStore } from './stores/project';
import { trpc } from './lib/trpc';
import { injectNerdFonts } from './styles/nerd-fonts';
import { ToolApp } from './tools/ToolApp';
import { useBrowserTabPersistence } from './hooks/use-browser-tab-persistence';
import { useBrowserEvents } from './hooks/use-browser-events';
import { useBrowserShortcuts } from './hooks/use-browser-shortcuts';

/** Check if this renderer instance is a tool window (has `#tool=` hash). */
function isToolWindow(): boolean {
  return window.location.hash.startsWith('#tool=');
}

export default function App() {
  const initTheme = useThemeStore((s) => s.initTheme);
  const initTerminalTheme = useTerminalThemeStore((s) => s.initTerminalTheme);
  const initFont = useFontStore((s) => s.initFont);
  const initEditor = useEditorStore((s) => s.initEditor);
  const initLastModel = useSessionCoreStore((s) => s.initLastModel);
  const registerCoreEventListeners = useSessionCoreStore((s) => s.registerCoreEventListeners);
  const registerMessagesEventListeners = useSessionMessagesStore((s) => s.registerMessagesEventListeners);
  const registerApprovalEventListeners = useSessionApprovalStore((s) => s.registerApprovalEventListeners);
  const loadContextWindow = useSettingsStore((s) => s.loadContextWindow);
  const errorToast = useToastStore((s) => s.error);
  const healthCheckDone = useRef(false);
  const restoreDone = useRef(false);

  // Tool window: skip main-window initialization (sessions, etc.)
  const toolMode = isToolWindow();

  useEffect(() => {
    initTheme();
    // 终端主题模式 / 独立主题恢复（Issue #3，跟随 UI 为默认值）
    initTerminalTheme();
    initFont();
    initEditor();
    // Nerd Font @font-face 注入（字体未下载时主进程返回空列表，自然降级）
    void injectNerdFonts();
    if (!toolMode) {
      void loadContextWindow();
      initLastModel();
      registerCoreEventListeners();
      registerMessagesEventListeners();
      registerApprovalEventListeners();
    }
  }, [initTheme, initTerminalTheme, initFont, initEditor, initLastModel, loadContextWindow, registerCoreEventListeners, registerMessagesEventListeners, registerApprovalEventListeners, toolMode]);

  // Restore the most recently opened project on startup (non-tool windows only).
  // This was previously in LeftRail, but LeftRail is conditionally mounted/unmounted
  // when the sidebar is toggled — each remount re-ran restoreState(), which read
  // stale persisted UI layout from the backend and overwrote the current layout,
  // causing the sidebar to collapse immediately after expanding.
  useEffect(() => {
    if (toolMode) return;
    if (restoreDone.current) return;
    restoreDone.current = true;
    void useProjectStore.getState().restoreState();
  }, [toolMode]);

  // Startup health check: verify tRPC IPC bridge is working
  // (only needed for the main window, not tool windows)
  useEffect(() => {
    if (toolMode) return;
    if (healthCheckDone.current) return;
    healthCheckDone.current = true;

    // Check if electronTRPC global is available
    if (typeof window !== 'undefined' && !(window as unknown as Record<string, unknown>).electronTRPC) {
      errorToast(
        'IPC 桥接未初始化',
        'window.electronTRPC 不可用。Preload 脚本可能未正确加载。请尝试重启应用。',
      );
      return;
    }

    // Ping the backend to verify tRPC is working
    trpc.ping
      .query()
      .then(() => {
        console.log('[tRPC] health check passed');
      })
      .catch((err) => {
        const detail = err instanceof Error ? err.message : String(err);
        errorToast('tRPC 连接失败', `后端服务不可达: ${detail}`);
      });
  }, [errorToast, toolMode]);

  // Browser tab persistence: restore on startup, debounced save on changes
  useBrowserTabPersistence();

  // Issue #9 + #10: Browser event listeners (window.open, downloads, auth popups)
  useBrowserEvents();

  // Issue #11: Browser keyboard shortcuts (Ctrl+F, Ctrl+L, Ctrl+R, Alt+Left/Right, Ctrl+D, Ctrl+W)
  useBrowserShortcuts();

  // Tool window: render ToolApp instead of AppShell
  if (toolMode) {
    return (
      <div className="theme-transition h-screen w-screen">
        <ToolApp />
      </div>
    );
  }

  return (
    <div className="theme-transition h-screen w-screen">
      <AppShell />
      <ToastContainer />
    </div>
  );
}
