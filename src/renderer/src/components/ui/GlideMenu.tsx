import {
  useLayoutEffect,
  useRef,
  useState,
  type CSSProperties,
  type FocusEvent,
  type MouseEvent,
  type ReactNode,
} from 'react';
import { cn } from '@renderer/lib/utils';

type GlideMenuProps = {
  children: ReactNode;
  /** 容器类（如 `ap-menu-list`：滚动 + relative 定位基准） */
  className?: string;
  /** 高亮层外观类（默认 .ap-menu-highlight：配色/圆角/220ms 过渡） */
  highlightClassName?: string;
  /** 行选择器：hover/focus 目标向上 closest 匹配，受控模式按索引取行 */
  rowSelector?: string;
  /** 受控行索引（键盘导航）：null 隐藏高亮；缺省时自驱动 hover/focus 测量 */
  activeIndex?: number | null;
  /** 受控模式下行定位后 scrollIntoView nearest（键盘导航跟随可视区） */
  scrollActiveIntoView?: boolean;
  style?: CSSProperties;
  onMouseLeave?: () => void;
};

/**
 * 滑动高亮菜单容器——单个绝对定位高亮层在行间滑动（top/height 220ms
 * var(--ease-out-strong) 过渡），行本身保持透明。
 *
 * 视觉/交互参考 beautiful-ui: D:\AI\beautiful-ui\components\primitives\GlideMenu.tsx
 * （从 ComposerMenu 的 .ap-menu-highlight 滑动高亮模式泛化为共享件。）
 *
 * 两种驱动方式：
 * - 受控：传 `activeIndex`，hover/键盘索引由外部统一上报（索引同时驱动
 *   选中行为等场景，如 ComposerMenu）；
 * - 自驱动（参考实现同款）：容器自行监听 mouseover/focusin 测量
 *   `[data-menu-row]` 行位置，mouseleave/focusout 隐藏。
 */
export function GlideMenu({
  children,
  className,
  highlightClassName = 'ap-menu-highlight',
  rowSelector = '[data-menu-row]',
  activeIndex,
  scrollActiveIntoView = false,
  style,
  onMouseLeave,
}: GlideMenuProps) {
  const ref = useRef<HTMLDivElement>(null);
  const [box, setBox] = useState<{ top: number; height: number } | null>(null);
  const [hovered, setHovered] = useState(false);
  const controlled = activeIndex !== undefined;
  const visible = controlled ? activeIndex != null : hovered;

  const moveTo = (target: EventTarget | null) => {
    const container = ref.current;
    if (!container || !(target instanceof Element)) return;
    const row = target.closest(rowSelector);
    if (!(row instanceof HTMLElement) || !container.contains(row)) return;
    // 参考实现的 gBR 测量：与容器视口相对，自驱动 hover 时即时正确
    const containerRect = container.getBoundingClientRect();
    const rowRect = row.getBoundingClientRect();
    const top = rowRect.top - containerRect.top;
    setBox((prev) => (prev?.top === top && prev?.height === rowRect.height ? prev : { top, height: rowRect.height }));
    setHovered(true);
  };

  useLayoutEffect(() => {
    if (!controlled) return;
    const container = ref.current;
    if (!container) return;
    const rows = container.querySelectorAll<HTMLElement>(rowSelector);
    const row = activeIndex == null ? undefined : rows[activeIndex];
    if (row) {
      // 受控路径用 offsetTop（内容系坐标）：高亮层在滚动容器内，
      // 滚动后仍与行对齐，不依赖测量时机（ComposerMenu 既有行为）
      const top = row.offsetTop;
      const height = row.offsetHeight;
      setBox((prev) => (prev?.top === top && prev?.height === height ? prev : { top, height }));
      if (scrollActiveIntoView) row.scrollIntoView({ block: 'nearest' });
    } else {
      setBox(null);
    }
  }, [controlled, activeIndex, rowSelector, scrollActiveIntoView, children]);

  return (
    <div
      ref={ref}
      className={cn('relative', className)}
      style={style}
      onMouseLeave={() => {
        setHovered(false);
        onMouseLeave?.();
      }}
      {...(controlled
        ? {}
        : {
            onMouseOver: (event: MouseEvent<HTMLDivElement>) => moveTo(event.target),
            onFocusCapture: (event: FocusEvent<HTMLDivElement>) => moveTo(event.target),
            onBlurCapture: (event: FocusEvent<HTMLDivElement>) => {
              if (!ref.current?.contains(event.relatedTarget as Node | null)) setHovered(false);
            },
          })}
    >
      <span
        aria-hidden
        className={cn('pointer-events-none absolute left-0 right-0', highlightClassName)}
        style={{
          top: box?.top ?? 0,
          height: box?.height ?? 0,
          opacity: box && visible ? 1 : 0,
        }}
      />
      {children}
    </div>
  );
}
