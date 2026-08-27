import { useEffect, type ReactNode } from 'react';
import { X } from 'lucide-react';
import { cn } from '@renderer/lib/utils';
import { DRAWER_LEFT_OFFSET, STATUS_BAR_HEIGHT, TITLE_BAR_HEIGHT } from './layout-constants';

/** 默认抽屉宽度（原型：文件抽屉 330px，AI 抽屉 360px 由调用方传入） */
const DEFAULT_WIDTH = 330;

/** 关闭态额外离屏余量（px）：抗子像素/边框圆角，保证完全离屏（原型取 400 > 398） */
const CLOSE_MARGIN_PX = 2;

type DrawerProps = {
  /** 抽屉停靠侧 */
  side: 'left' | 'right';
  /** 打开状态（组件常驻挂载以保证开合动画） */
  open: boolean;
  /** 关闭回调：Esc / 头部关闭按钮触发 */
  onClose: () => void;
  /** 头部标题 */
  title: string;
  /** 抽屉宽度（px） */
  width?: number;
  /**
   * 贴合内容模式：内容区不加分隔内边距与滚动，由子组件自管滚动与布局
   * （如 AI 会话：消息流滚动、composer 固定底部）。
   */
  flush?: boolean;
  children: ReactNode;
};

/**
 * 通用抽屉原语。
 * 关闭位移 ≥ left + width，保证关闭态完全离屏、不遮挡导航栏（原型 §2.1 第 1 条）。
 * z-index 50（刻度：backdrop 40 / drawer 50 / dropdown 70 / palette 80 / toast 100）。
 *
 * 动画：260ms transform 过渡，强 ease-out 曲线 cubic-bezier(0.25,1,0.5,1)，
 * 面板快速从屏幕左边缘外滑入、丝滑减速到位；
 * 组件常驻挂载以保证关闭态也能播放离场动画。
 */
export function Drawer({ side, open, onClose, title, width = DEFAULT_WIDTH, flush = false, children }: DrawerProps) {
  // Esc 关闭（仅打开时挂载监听）
  useEffect(() => {
    if (!open) return;
    const handler = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [open, onClose]);

  // 关闭位移：左抽屉须 ≥ DRAWER_LEFT_OFFSET + width 才完全离屏（原型 §2.1-1：68+330 → 400）
  const closedTransform =
    side === 'left'
      ? `translateX(-${DRAWER_LEFT_OFFSET + width + CLOSE_MARGIN_PX}px)`
      : `translateX(${width + CLOSE_MARGIN_PX}px)`;

  return (
    <aside
      role="dialog"
      aria-label={title}
      aria-hidden={!open}
      inert={!open}
      data-testid={`drawer-${side}`}
      className={cn(
        'fixed z-50 flex flex-col border border-border bg-glass shadow-2xl glass',
        'transition-transform duration-[var(--duration-drawer)] ease-[var(--ease-out)] will-change-transform',
        side === 'left' ? 'rounded-r-[14px]' : 'rounded-tl-[14px]',
      )}
      style={{
        top: TITLE_BAR_HEIGHT,
        bottom: STATUS_BAR_HEIGHT,
        width,
        ...(side === 'left' ? { left: DRAWER_LEFT_OFFSET } : { right: 0 }),
        transform: open ? 'translateX(0)' : closedTransform,
        pointerEvents: open ? 'auto' : 'none',
      }}
    >
      <div className="flex items-center gap-2 border-b border-border px-4 py-3 text-[12.5px] font-semibold">
        {title}
        <button
          type="button"
          onClick={onClose}
          aria-label="关闭"
          className="ml-auto grid size-6 shrink-0 place-items-center rounded-md text-muted-foreground transition-colors hover:bg-foreground/10 hover:text-foreground"
        >
          <X className="size-3" />
        </button>
      </div>
      <div
        className={cn(
          'min-h-0 flex-1',
          flush ? 'flex flex-col overflow-hidden' : 'overflow-y-auto p-2',
        )}
      >
        {children}
      </div>
    </aside>
  );
}
