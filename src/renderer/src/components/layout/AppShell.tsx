import { TitleBar } from './TitleBar';
import { LeftRail } from './LeftRail';
import { CenterArea } from './CenterArea';
import { RightPanel } from './RightPanel';
import { OptionDock } from './OptionDock';
import { useUiStore } from '@renderer/stores/ui';

export function AppShell() {
  const leftCollapsed = useUiStore((s) => s.leftRailCollapsed);
  const rightCollapsed = useUiStore((s) => s.rightPanelCollapsed);

  return (
    <div className="flex h-screen w-screen flex-col bg-background text-foreground">
      {/* ── 自定义无边框 TitleBar ─────────────────────────── */}
      <TitleBar />

      {/* ── 三栏主工作区 ─────────────────────────────────── */}
      <div className="flex flex-1 overflow-hidden">
        {!leftCollapsed && <LeftRail />}
        <CenterArea />
        {!rightCollapsed && <RightPanel />}
      </div>

      {/* ── 底部仿真选项浮窗 ─────────────────────────────── */}
      <OptionDock />
    </div>
  );
}
