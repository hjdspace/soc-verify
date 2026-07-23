import { X } from 'lucide-react';
import { useUiStore } from '@renderer/stores/ui';
import { SourceControlPanel } from './SourceControlPanel';

/**
 * 源代码管理弹窗。
 *
 * 从 TitleBar 图标触发，以模态弹窗形式展示 SourceControlPanel。
 * 遵循与 SettingsPanel 相同的弹窗模式：fixed 全屏遮罩 + 居中卡片。
 */
export function SourceControlDialog() {
  const sourceControlOpen = useUiStore((s) => s.sourceControlOpen);
  const setSourceControlOpen = useUiStore((s) => s.setSourceControlOpen);

  if (!sourceControlOpen) return null;

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/50"
      onClick={() => setSourceControlOpen(false)}
    >
      <div
        className="flex h-[520px] w-[760px] flex-col overflow-hidden rounded-lg border border-border bg-popover shadow-2xl"
        onClick={(e) => e.stopPropagation()}
      >
        {/* Header */}
        <div className="flex items-center justify-between border-b px-4 py-2.5">
          <h2 className="text-sm font-semibold">源代码管理</h2>
          <button
            onClick={() => setSourceControlOpen(false)}
            className="rounded p-1 text-muted-foreground hover:bg-accent hover:text-foreground"
          >
            <X className="h-4 w-4" />
          </button>
        </div>

        {/* Content */}
        <div className="flex flex-1 overflow-hidden">
          <SourceControlPanel />
        </div>
      </div>
    </div>
  );
}
