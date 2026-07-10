import { useUiStore } from '@renderer/stores/ui';

export function CenterArea() {
  const activeTab = useUiStore((s) => s.activeCenterTab);
  return (
    <main className="flex flex-1 flex-col overflow-hidden">
      <div className="border-b px-3 py-2 text-xs text-muted-foreground">
        多功能多页面区：终端 / AI 产物汇总 / 文件显示
      </div>
      <div className="flex flex-1 items-center justify-center text-sm text-muted-foreground">
        {activeTab ? `活动页签：${activeTab}` : '（M0 占位）中央工作区'}
      </div>
    </main>
  );
}
