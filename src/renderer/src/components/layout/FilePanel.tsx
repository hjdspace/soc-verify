import { PanelLeftClose } from 'lucide-react';
import { useUiStore } from '@renderer/stores/ui';
import { FileDrawerContent } from './FileDrawer';

interface FilePanelProps {
  width: number;
}

/**
 * 固定左侧栏文件面板（filePanelMode === 'docked' 时挂载）。
 * 内容复用 FileDrawerContent（项目切换 + 文件树 + 最近打开）。
 * 顶部提供「解除固定」按钮，切换回抽屉浮窗模式。
 */
export function FilePanel({ width }: FilePanelProps) {
  const setFilePanelMode = useUiStore((s) => s.setFilePanelMode);
  const toggleLeftDrawer = useUiStore((s) => s.toggleLeftDrawer);

  /** 解除固定：切回抽屉模式并自动打开左抽屉，保持文件面板内容不中断。 */
  const handleUnpin = () => {
    setFilePanelMode('drawer');
    // 延迟一帧打开抽屉，确保 mode 切换后 FileDrawer 已挂载
    requestAnimationFrame(() => toggleLeftDrawer());
  };

  return (
    <aside
      className="flex shrink-0 flex-col border-r bg-sidebar"
      style={{ width: `${width}px` }}
      data-testid="file-docked-panel"
    >
      {/* 解除固定栏 */}
      <div className="flex items-center justify-between border-b border-border/50 px-3 py-1.5">
        <span className="text-[10px] font-medium uppercase tracking-[0.06em] text-muted-foreground">文件</span>
        <button
          type="button"
          onClick={handleUnpin}
          className="flex items-center gap-1 rounded-md px-2 py-0.5 text-[10px] text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
          title="解除固定，切换为侧滑浮窗模式"
          data-testid="file-docked-unpin"
        >
          <PanelLeftClose className="size-3" />
          解除固定
        </button>
      </div>
      <FileDrawerContent />
    </aside>
  );
}
