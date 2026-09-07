import { useEffect, useRef } from 'react';
import { TitleBar } from './TitleBar';
import { NavRail } from './NavRail';
import { ViewContainer } from './ViewContainer';
import { BottomPanel } from './BottomPanel';
import { StatusBar } from './StatusBar';
import { TaskPanel } from './TaskPanel';
import { CommandPalette } from './CommandPalette';
import { Backdrop } from './Backdrop';
import { FileDrawer } from './FileDrawer';
import { FilePanel } from './FilePanel';
import { AiDrawer } from './AiDrawer';
import { RightPanel } from './RightPanel';
import { ResizeHandle } from './ResizeHandle';
import { EnvWizard } from '@renderer/components/env/EnvWizard';
import { EnvManagerDialog } from '@renderer/components/env/EnvManagerDialog';
import { SettingsPanel } from '@renderer/components/settings/SettingsPanel';
import { SourceControlDialog } from '@renderer/components/scm/SourceControlDialog';
import { ExportDialog } from '@renderer/components/coverage/ExportDialog';
import { useUiStore } from '@renderer/stores/ui';
import { useProjectStore } from '@renderer/stores/project';
import { useSessionCoreStore } from '@renderer/stores/session-core';
import { useEnvStore } from '@renderer/stores/env';
import { ensureSimulationEventListener } from '@renderer/stores/simulation';

export function AppShell() {
  // 布局持久化触发器（抽屉为瞬态不持久化；RightPanel 几何随 workspace 视图在 ViewContainer）
  const activeView = useUiStore((s) => s.activeView);
  const aiPanelMode = useUiStore((s) => s.aiPanelMode);
  const filePanelMode = useUiStore((s) => s.filePanelMode);
  const filePanelCollapsed = useUiStore((s) => s.filePanelCollapsed);
  const filePanelWidth = useUiStore((s) => s.filePanelWidth);
  const setFilePanelWidth = useUiStore((s) => s.setFilePanelWidth);
  const leftDrawerOpen = useUiStore((s) => s.leftDrawerOpen);
  const rightDrawerOpen = useUiStore((s) => s.rightDrawerOpen);
  const closeDrawers = useUiStore((s) => s.closeDrawers);
  const rightCollapsed = useUiStore((s) => s.rightPanelCollapsed);
  const rightPanelWidth = useUiStore((s) => s.rightPanelWidth);
  const setRightPanelWidth = useUiStore((s) => s.setRightPanelWidth);
  const simLeftPanelWidth = useUiStore((s) => s.simLeftPanelWidth);
  const designTreeWidth = useUiStore((s) => s.designTreeWidth);
  const pluginViewLayouts = useUiStore((s) => s.pluginViewLayouts);
  const currentProjectId = useProjectStore((s) => s.currentProjectId);
  const uiStateReady = useProjectStore((s) => s.uiStateReady);
  const saveProjectState = useProjectStore((s) => s.saveState);
  // Track session tab changes so that lastSessionIds is persisted.
  const sessionIds = useSessionCoreStore((s) =>
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
  }, [currentProjectId, uiStateReady, activeView, aiPanelMode, filePanelMode, filePanelCollapsed, filePanelWidth, rightCollapsed, rightPanelWidth, simLeftPanelWidth, designTreeWidth, pluginViewLayouts, sessionIds, saveProjectState]);

  // Save state before the window unloads so lastSessionIds is up-to-date.
  useEffect(() => {
    const handler = () => {
      void saveProjectStateRef.current();
    };
    window.addEventListener('beforeunload', handler);
    return () => window.removeEventListener('beforeunload', handler);
  }, []);

  // 应用挂载即注册 simulation:event 监听（幂等）——仿真启动入口不止
  // startCaseRun 一个（AI 工具卡 / 终端工具栏重跑等直接调 tRPC），
  // 不注册会导致运行列表仿真状态不实时更新（卡在「进行中」直到重挂载）
  useEffect(() => {
    ensureSimulationEventListener();
  }, []);

  return (
    <div className="flex h-screen w-screen flex-col bg-background text-foreground">
      {/* ── 自定义无边框 TitleBar ─────────────────────────── */}
      <TitleBar />

      {/* ── 主区域：NavRail | (ViewContainer + BottomPanel) ── */}
      <div className="relative flex flex-1 overflow-hidden">
        <NavRail />
        {/* relative：为 popLayout 退场元素（视图切换）提供定位上下文 */}
        <div className="relative flex flex-1 overflow-hidden">
          {/* ── 固定左栏文件面板（docked 模式，所有视图全局可见） ── */}
          {filePanelMode === 'docked' && !filePanelCollapsed && (
            <>
              <FilePanel width={filePanelWidth} />
              <ResizeHandle side="left" width={filePanelWidth} onResize={setFilePanelWidth} />
            </>
          )}
          <div className="flex flex-1 flex-col overflow-hidden">
            <ViewContainer />
            <BottomPanel />
          </div>

          {/* ── 固定侧栏 AI 面板（docked 模式，折叠时保留挂载状态） ── */}
          {aiPanelMode === 'docked' && (
            <>
              {!rightCollapsed && (
                <ResizeHandle side="right" width={rightPanelWidth} onResize={setRightPanelWidth} />
              )}
              <RightPanel width={rightPanelWidth} collapsed={rightCollapsed} />
            </>
          )}
        </div>

        {/* ── 后台任务面板（浮动在右下角） ──────────────────── */}
        <TaskPanel />

        {/* ── 内容区遮罩 + 文件 / AI 抽屉（Issue #7） ───────── */}
        <Backdrop open={leftDrawerOpen || rightDrawerOpen} onClose={closeDrawers} />
        {filePanelMode === 'drawer' && <FileDrawer />}
        {aiPanelMode === 'drawer' && <AiDrawer />}
      </div>

      {/* ── 全局状态栏 ───────────────────────────────────── */}
      <StatusBar />

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
