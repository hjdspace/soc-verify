import { useUiStore } from '@renderer/stores/ui';
import { Button } from '../ui/button';

export function OptionDock() {
  const expanded = useUiStore((s) => s.optionDockExpanded);
  const toggle = useUiStore((s) => s.toggleOptionDock);
  return (
    <div className="border-t bg-secondary/40">
      <div className="flex items-center justify-between px-3 py-1.5">
        <span className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
          仿真 Option
        </span>
        <Button variant="ghost" size="sm" onClick={toggle}>
          {expanded ? '收起' : '展开'}
        </Button>
      </div>
      {expanded && (
        <div className="px-3 pb-3 text-sm text-muted-foreground">
          （M0 占位）动态 schema 驱动的仿真选项浮窗
        </div>
      )}
    </div>
  );
}
