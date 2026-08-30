import { useLayoutEffect, useRef, useState, type CSSProperties, type ReactNode, type RefObject } from 'react';
import { cn } from '@renderer/lib/utils';
import { GlideMenu } from '@renderer/components/ui/GlideMenu';

type ComposerMenuProps = {
  /** 定位与宽度类（如 `left-0 right-0` 全宽、`left-0 w-56` 锚定按钮） */
  className?: string;
  /** 高亮行索引；null 表示隐藏高亮（未 hover / 未用键盘时保持素净，同 beautiful-ui） */
  activeIndex?: number | null;
  /** 底部提示行（分隔线 + 灰字），如 “输入以搜索文件” */
  footer?: ReactNode;
  /** 列表最大高度（px） */
  maxHeight?: number;
  /** pop-in 变换基点：全宽菜单居中，锚定按钮的窄菜单用左下角 */
  origin?: 'center' | 'left';
  /** 无滑动高亮的弹层（模型树等）开启行级 hover 背景 */
  plain?: boolean;
  /** 水平夹紧边界（传 composer 容器 ref）：锚定按钮的弹层在窄面板下
   *  右缘可能越过窗口边框，测量后将右缘夹紧到边界内（左移量为负） */
  clampTo?: RefObject<HTMLElement | null>;
  onMouseLeave?: () => void;
  children: ReactNode;
};

/**
 * Composer 弹层容器 —— 对齐 beautiful-ui PromptBar 的浮层卡片：
 * 白底 10px 圆角 + hairline 描边 + 浮起阴影，自底部 pop-in；
 * 行 hover/键盘选中由单一滑动色块呈现（滑动高亮已泛化为共享组件
 * GlideMenu，见 components/ui/GlideMenu.tsx），行本身保持透明。
 */
export function ComposerMenu({
  className,
  activeIndex = null,
  footer,
  maxHeight = 256,
  origin = 'center',
  plain = false,
  clampTo,
  onMouseLeave,
  children,
}: ComposerMenuProps) {
  const menuRef = useRef<HTMLDivElement>(null);
  // 夹紧后的水平偏移（相对锚定按钮的左缘），undefined 表示不夹紧
  const [clampLeft, setClampLeft] = useState<number | undefined>(undefined);

  useLayoutEffect(() => {
    const menu = menuRef.current;
    const boundary = clampTo?.current;
    if (!menu || !boundary) return;
    // 弹层的包含块是最近的定位祖先（按钮包裹层），以其坐标系计算夹紧量
    const wrapper = menu.offsetParent as HTMLElement | null;
    if (!wrapper) return;
    const menuWidth = menu.getBoundingClientRect().width;
    const wrapperLeft = wrapper.getBoundingClientRect().left;
    const maxLeft = boundary.getBoundingClientRect().right - wrapperLeft - menuWidth;
    const next = Math.min(0, maxLeft);
    setClampLeft((prev) => (prev === next ? prev : next));
  }, [clampTo]);

  const style: CSSProperties = { transformOrigin: origin === 'left' ? 'bottom left' : 'bottom center' };
  if (clampLeft !== undefined) style.left = clampLeft;

  return (
    <div ref={menuRef} className={cn('ap-menu', plain && 'ap-menu-plain', className)} style={style} onMouseLeave={onMouseLeave}>
      <GlideMenu className="ap-menu-list" style={{ maxHeight }} activeIndex={activeIndex} scrollActiveIntoView>
        {children}
      </GlideMenu>
      {footer != null && <div className="ap-menu-note">{footer}</div>}
    </div>
  );
}

type ComposerMenuRowProps = {
  /** 左侧 22px 图标槽（lucide 图标建议 h-3.5 w-3.5） */
  icon?: ReactNode;
  title: ReactNode;
  /** 标题右侧的内联灰字说明，超长省略 */
  desc?: ReactNode;
  /** 右侧灰色小字（来源 / 数量 / 大小等） */
  tag?: ReactNode;
  /** 右侧自定义元素（当前项的 Check 等），不受 flex-1 挤压 */
  trailing?: ReactNode;
  /** 标题最大宽度（px），超长省略——无 desc 的行（模型名等）防撑破窄菜单 */
  titleMaxWidth?: number;
  /** 缩进到 22px 图标槽之后（模型树子行用） */
  indent?: boolean;
  active?: boolean;
  onSelect?: () => void;
  /** hover 进入行：上报索引给滑动高亮 */
  onHover?: () => void;
  className?: string;
};

/** 弹层行：图标 + 标题 + 内联说明 + 右侧标签/勾选，单行 36px */
export function ComposerMenuRow({
  icon,
  title,
  desc,
  tag,
  trailing,
  titleMaxWidth,
  indent = false,
  active = false,
  onSelect,
  onHover,
  className,
}: ComposerMenuRowProps) {
  return (
    <button
      type="button"
      data-menu-row
      data-active={active || undefined}
      // 不让编辑器失焦，保住 chip 插入锚点与草稿光标
      onMouseDown={(e) => e.preventDefault()}
      onMouseEnter={onHover}
      onClick={onSelect}
      className={cn('ap-menu-row', className)}
      style={indent ? { paddingLeft: 30 } : undefined}
    >
      {icon != null && <span className="ap-menu-row-icon">{icon}</span>}
      <span
        className="ap-menu-row-title"
        style={titleMaxWidth != null ? { maxWidth: titleMaxWidth, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' } : undefined}
      >
        {title}
      </span>
      {desc != null && <span className="ap-menu-row-desc">{desc}</span>}
      {tag != null && <span className="ap-menu-row-tag">{tag}</span>}
      {trailing}
    </button>
  );
}

/** 右侧当前项勾选列：未选中时占位不可见，避免行内容回流 */
export function ComposerMenuCheck({ visible }: { visible: boolean }) {
  return (
    <span
      aria-hidden
      className={`flex h-3.5 w-3.5 shrink-0 items-center justify-center text-primary ${visible ? '' : 'invisible'}`}
    >
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2.5} strokeLinecap="round" strokeLinejoin="round" className="h-3 w-3">
        <path d="M20 6L9 17l-5-5" />
      </svg>
    </span>
  );
}
