import { useEffect, useRef } from 'react';
import { TitleBar } from './TitleBar';
import { LeftRail } from './LeftRail';
import { CenterArea } from './CenterArea';
import { RightPanel } from './RightPanel';
import { OptionDock } from './OptionDock';
import { ResizeHandle } from './ResizeHandle';
import { TaskPanel } from './TaskPanel';
import { BottomPanel } from './BottomPanel';
import { CommandPalette } from './CommandPalette';
import { EnvWizard } from '@renderer/components/env/EnvWizard';
import { SettingsPanel } from '@renderer/components/settings/SettingsPanel';
import { SourceControlDialog } from '@renderer/components/scm/SourceControlDialog';
import { useUiStore } from '@renderer/stores/ui';
import { useProjectStore } from '@renderer/stores/project';
import { useSessionStore } from '@renderer/stores/session';

export function AppShell() {
  const leftCollapsed = useUiStore((s) => s.leftRailCollapsed);
  const rightCollapsed = useUiStore((s) => s.rightPanelCollapsed);
  const leftRailWidth = useUiStore((s) => s.leftRailWidth);
  const rightPanelWidth = useUiStore((s) => s.rightPanelWidth);
  const setLeftRailWidth = useUiStore((s) => s.setLeftRailWidth);
  const setRightPanelWidth = useUiStore((s) => s.setRightPanelWidth);
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

  // Debounced save when UI layout or session tabs change.
  useEffect(() => {
    if (!currentProjectId || !uiStateReady) return;
    const timer = window.setTimeout(() => {
      void saveProjectState();
    }, 250);
    return () => window.clearTimeout(timer);
  }, [currentProjectId, uiStateReady, leftCollapsed, rightCollapsed, optionDockExpanded, pluginViewLayouts, sessionIds, saveProjectState]);

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

      {/* ── 三栏主工作区 ─────────────────────────────────── */}
      <div className="relative flex flex-1 overflow-hidden">
        {!leftCollapsed && (
          <>
            <LeftRail width={leftRailWidth} />
            <ResizeHandle
              side="left"
              width={leftRailWidth}
              onResize={setLeftRailWidth}
            />
          </>
        )}
        {/* 中栏 + 底部终端面板（垂直排列） */}
        <div className="flex flex-1 flex-col overflow-hidden">
          <CenterArea />
          <BottomPanel />
        </div>
        {!rightCollapsed && (
          <>
            <ResizeHandle
              side="right"
              width={rightPanelWidth}
              onResize={setRightPanelWidth}
            />
            <RightPanel width={rightPanelWidth} />
          </>
        )}

        {/* ── 后台任务面板（浮动在右下角） ──────────────────── */}
        <TaskPanel />
      </div>

      {/* ── 底部仿真选项浮窗 ─────────────────────────────── */}
      <OptionDock />

      {/* ── 环境搭建向导 ─────────────────────────────────── */}
      <EnvWizard />

      {/* ── 设置面板 ─────────────────────────────────────── */}
      <SettingsPanel />

      {/* ── 源代码管理弹窗 ───────────────────────────────── */}
      <SourceControlDialog />

      {/* ── 命令面板（Ctrl+P 触发） ──────────────────────── */}
      <CommandPalette />
    </div>
  );
}
