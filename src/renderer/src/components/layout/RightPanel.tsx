import { useUiStore } from '@renderer/stores/ui';
import { Button } from '../ui/button';

export function RightPanel() {
  const toggle = useUiStore((s) => s.toggleRightPanel);
  return (
    <aside className="flex w-80 flex-col border-l bg-secondary/30">
      <div className="flex items-center justify-between px-3 py-2 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
        AI Agent
        <Button variant="ghost" size="icon" onClick={toggle} title="收起右栏">
          ›
        </Button>
      </div>
      <div className="flex-1 overflow-y-auto px-2 text-sm text-muted-foreground">
        <p className="px-2 py-1">（M0 占位）AI 多会话 + 后台任务</p>
      </div>
    </aside>
  );
}
