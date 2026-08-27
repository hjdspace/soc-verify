import { cn } from '@renderer/lib/utils';
import { NAV_RAIL_WIDTH, STATUS_BAR_HEIGHT, TITLE_BAR_HEIGHT } from './layout-constants';

type BackdropProps = {
  /** 抽屉（或其它浮层）打开时显示遮罩 */
  open: boolean;
  /** 点击遮罩回调（通常为关闭抽屉） */
  onClose?: () => void;
};

/**
 * 内容区遮罩：只遮 TitleBar 以下、状态栏以上、导航栏以右的内容区，
 * TitleBar / NavRail / StatusBar 保持可见可交互（原型 §2.1 第 2 条）。
 * z-index 40，低于抽屉（50）。
 */
export function Backdrop({ open, onClose }: BackdropProps) {
  return (
    <div
      data-testid="app-backdrop"
      aria-hidden="true"
      onClick={onClose}
      className={cn(
        'fixed right-0 z-40 bg-black/50 transition-opacity duration-[var(--duration-drawer)] ease-[var(--ease-out)]',
        open ? 'pointer-events-auto opacity-100' : 'pointer-events-none opacity-0',
      )}
      style={{ top: TITLE_BAR_HEIGHT, bottom: STATUS_BAR_HEIGHT, left: NAV_RAIL_WIDTH }}
    />
  );
}
