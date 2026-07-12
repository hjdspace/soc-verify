import { useEffect, useRef } from 'react';
import { AppShell } from './components/layout/AppShell';
import { ToastContainer } from './components/ToastContainer';
import { useThemeStore } from './stores/theme';
import { useToastStore } from './stores/toast';
import { trpc } from './lib/trpc';

export default function App() {
  const initTheme = useThemeStore((s) => s.initTheme);
  const errorToast = useToastStore((s) => s.error);
  const healthCheckDone = useRef(false);

  useEffect(() => {
    initTheme();
  }, [initTheme]);

  // Startup health check: verify tRPC IPC bridge is working
  // Guarded against StrictMode double-execution
  useEffect(() => {
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
  }, [errorToast]);

  return (
    <div className="theme-transition h-screen w-screen">
      <AppShell />
      <ToastContainer />
    </div>
  );
}
