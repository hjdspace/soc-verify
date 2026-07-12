import { TitleBar } from './TitleBar';
import { LeftRail } from './LeftRail';
import { CenterArea } from './CenterArea';
import { RightPanel } from './RightPanel';
import { OptionDock } from './OptionDock';
import { ResizeHandle } from './ResizeHandle';
import { TaskPanel } from './TaskPanel';
import { CommandPalette } from './CommandPalette';
import { EnvWizard } from '@renderer/components/env/EnvWizard';
import { SettingsPanel } from '@renderer/components/settings/SettingsPanel';
import { useUiStore } from '@renderer/stores/ui';

export function AppShell() {
  const leftCollapsed = useUiStore((s) => s.leftRailCollapsed);
  const rightCollapsed = useUiStore((s) => s.rightPanelCollapsed);
  const leftRailWidth = useUiStore((s) => s.leftRailWidth);
  const rightPanelWidth = useUiStore((s) => s.rightPanelWidth);
  const setLeftRailWidth = useUiStore((s) => s.setLeftRailWidth);
  const setRightPanelWidth = useUiStore((s) => s.setRightPanelWidth);

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
        <CenterArea />
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

      {/* ── 命令面板（Ctrl+P 触发） ──────────────────────── */}
      <CommandPalette />
    </div>
  );
}
