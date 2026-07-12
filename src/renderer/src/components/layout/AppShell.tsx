import { TitleBar } from './TitleBar';
import { LeftRail } from './LeftRail';
import { CenterArea } from './CenterArea';
import { RightPanel } from './RightPanel';
import { OptionDock } from './OptionDock';
import { ResizeHandle } from './ResizeHandle';
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
      <div className="flex flex-1 overflow-hidden">
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
      </div>

      {/* ── 底部仿真选项浮窗 ─────────────────────────────── */}
      <OptionDock />
    </div>
  );
}
