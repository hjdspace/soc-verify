import { useUiStore } from '@renderer/stores/ui';
import { Button } from '../ui/button';

export function LeftRail() {
  const toggle = useUiStore((s) => s.toggleLeftRail);
  return (
    <aside className="flex w-60 flex-col border-r bg-secondary/30">
      <div className="flex items-center justify-between px-3 py-2 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
        项目 / 用例
        <Button variant="ghost" size="icon" onClick={toggle} title="收起左栏">
          ‹
        </Button>
      </div>
      <div className="flex-1 overflow-y-auto px-2 text-sm text-muted-foreground">
        <p className="px-2 py-1">（M0 占位）文件树 + 用例树 + dashboard</p>
      </div>
    </aside>
  );
}
