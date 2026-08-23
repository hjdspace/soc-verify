import { useEffect, useRef } from 'react';
import { TitleBar } from './TitleBar';
import { NavRail } from './NavRail';
import { ViewContainer } from './ViewContainer';
import { BottomPanel } from './BottomPanel';
import { StatusBar } from './StatusBar';
import { OptionDock } from './OptionDock';
import { TaskPanel } from './TaskPanel';
import { CommandPalette } from './CommandPalette';
import { Backdrop } from './Backdrop';
import { FileDrawer } from './FileDrawer';
import { AiDrawer } from './AiDrawer';
import { EnvWizard } from '@renderer/components/env/EnvWizard';
import { EnvManagerDialog } from '@renderer/components/env/EnvManagerDialog';
import { SettingsPanel } from '@renderer/components/settings/SettingsPanel';
import { SourceControlDialog } from '@renderer/components/scm/SourceControlDialog';
import { ExportDialog } from '@renderer/components/coverage/ExportDialog';
import { useUiStore } from '@renderer/stores/ui';
import { useProjectStore } from '@renderer/stores/project';
import { useSessionStore } from '@renderer/stores/session';
import { useEnvStore } from '@renderer/stores/env';

export function AppShell() {
  // 布局持久化触发器（抽屉为瞬态不持久化；RightPanel 几何随 workspace 视图在 ViewContainer）
  const activeView = useUiStore((s) => s.activeView);
  const aiPanelMode = useUiStore((s) => s.aiPanelMode);
  const leftDrawerOpen = useUiStore((s) => s.leftDrawerOpen);
  const rightDrawerOpen = useUiStore((s) => s.rightDrawerOpen);
  const closeDrawers = useUiStore((s) => s.closeDrawers);
  const rightCollapsed = useUiStore((s) => s.rightPanelCollapsed);
  const optionDockExpanded = useUiStore((s) => s.optionDockExpanded);
  const pluginViewLayouts = useUiStore((s) => s.pluginViewLayouts);
  const currentProjectId = useProjectStore((s) => s.currentProjectId);
  const uiStateReady = useProjectStore((s) => s.uiStateReady);
  const saveProjectState = useProjectStore((s) => s.saveState);
  // Track session tab changes so that lastSessionIds is persisted.
  const sessionIds = useSessionStore((s) =>
    s.sessions.map((sess) => sess.persistedSessionId ?? sess.id).join(','),
  );
  const saveProjectStateRef = useRef(saveProjectState);
  saveProjectStateRef.current = saveProjectState;
  const settingsOpen = useUiStore((s) => s.settingsOpen);
  const commandPaletteOpen = useUiStore((s) => s.commandPaletteOpen);
  const sourceControlOpen = useUiStore((s) => s.sourceControlOpen);
  const centerMenuOpen = useUiStore((s) => s.centerMenuOpen);
  const wizardOpen = useEnvStore((s) => s.wizardOpen);
  const managerOpen = useEnvStore((s) => s.managerOpen);

  useEffect(() => {
    void window.surfaceBridge?.setOverlayHidden(
      settingsOpen || commandPaletteOpen || sourceControlOpen || centerMenuOpen || wizardOpen || managerOpen,
    );
  }, [settingsOpen, commandPaletteOpen, sourceControlOpen, centerMenuOpen, wizardOpen, managerOpen]);

  // Debounced save when UI layout or session tabs change.
  useEffect(() => {
    if (!currentProjectId || !uiStateReady) return;
    const timer = window.setTimeout(() => {
      void saveProjectState();
    }, 250);
    return () => window.clearTimeout(timer);
  }, [currentProjectId, uiStateReady, activeView, aiPanelMode, rightCollapsed, optionDockExpanded, pluginViewLayouts, sessionIds, saveProjectState]);

  // Save state before the window unloads so lastSessionIds is up-to-date.
  useEffect(() => {
    const handler = () => {
      void saveProjectStateRef.current();
    };
    window.addEventListener('beforeunload', handler);
    return () => window.removeEventListener('beforeunload', handler);
  }, []);

  return (
    <div className="flex h-screen w-screen flex-col bg-background text-foreground">
      {/* ── 自定义无边框 TitleBar ─────────────────────────── */}
      <TitleBar />

      {/* ── 主区域：NavRail | (ViewContainer + BottomPanel) ── */}
      <div className="relative flex flex-1 overflow-hidden">
        <NavRail />
        <div className="flex flex-1 flex-col overflow-hidden">
          <ViewContainer />
          <BottomPanel />
        </div>

        {/* ── 后台任务面板（浮动在右下角） ──────────────────── */}
        <TaskPanel />

        {/* ── 内容区遮罩 + 文件 / AI 抽屉（Issue #7） ───────── */}
        <Backdrop open={leftDrawerOpen || rightDrawerOpen} onClose={closeDrawers} />
        <FileDrawer />
        {aiPanelMode === 'drawer' && <AiDrawer />}
      </div>

      {/* ── 全局状态栏 ───────────────────────────────────── */}
      <StatusBar />

      {/* ── 底部仿真选项浮窗 ─────────────────────────────── */}
      <OptionDock />

      {/* ── 环境搭建向导 ─────────────────────────────────── */}
      <EnvWizard />

      <EnvManagerDialog />

      {/* ── 设置面板 ─────────────────────────────────────── */}
      <SettingsPanel />

      {/* ── 源代码管理弹窗 ───────────────────────────────── */}
      <SourceControlDialog />

      {/* ── 覆盖率报告导出对话框（store 驱动，Issue #9 全局化） ── */}
      <ExportDialog />

      {/* ── 命令面板（Ctrl+K / Ctrl+P 触发） ─────────────── */}
      <CommandPalette />
    </div>
  );
}
