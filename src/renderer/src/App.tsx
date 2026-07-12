import { useEffect } from 'react';
import { AppShell } from './components/layout/AppShell';
import { useThemeStore } from './stores/theme';

export default function App() {
  const initTheme = useThemeStore((s) => s.initTheme);

  useEffect(() => {
    initTheme();
  }, [initTheme]);

  return (
    <div className="theme-transition h-screen w-screen">
      <AppShell />
    </div>
  );
}
