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
      <div className="flex flex-1 overflow-hidden">
        {!leftCollapsed && <LeftRail />}
        <CenterArea />
        {!rightCollapsed && <RightPanel />}
      </div>
      <OptionDock />
    </div>
  );
}
