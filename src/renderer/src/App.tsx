import { useEffect, useRef } from 'react';
import { AppShell } from './components/layout/AppShell';
import { ToastContainer } from './components/ToastContainer';
import { useThemeStore } from './stores/theme';
import { useFontStore } from './stores/font';
import { useToastStore } from './stores/toast';
import { useSessionStore } from './stores/session';
import { trpc } from './lib/trpc';
import { ToolApp } from './tools/ToolApp';

/** Check if this renderer instance is a tool window (has `#tool=` hash). */
function isToolWindow(): boolean {
  return window.location.hash.startsWith('#tool=');
}

export default function App() {
  const initTheme = useThemeStore((s) => s.initTheme);
  const initFont = useFontStore((s) => s.initFont);
  const initLastModel = useSessionStore((s) => s.initLastModel);
  const registerSessionEventListeners = useSessionStore((s) => s.registerEventListeners);
  const errorToast = useToastStore((s) => s.error);
  const healthCheckDone = useRef(false);

  // Tool window: skip main-window initialization (sessions, etc.)
  const toolMode = isToolWindow();

  useEffect(() => {
    initTheme();
    initFont();
    if (!toolMode) {
      initLastModel();
      registerSessionEventListeners();
    }
  }, [initTheme, initFont, initLastModel, registerSessionEventListeners, toolMode]);

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
