import type { ButtonHTMLAttributes, CSSProperties } from 'react';
import { cn } from '@renderer/lib/utils';

export type PillButtonVariant = 'primary' | 'secondary' | 'ghost' | 'accent' | 'success';
type PillButtonSize = 'sm' | 'md';

/**
 * 胶囊按钮（Pill-shaped，5 变体 × 2 尺寸）——后续 AI 组件（建议卡、
 * 批量采纳表等）的核心按钮形态。
 *
 * 视觉/交互参考 beautiful-ui: D:\AI\beautiful-ui\components\atoms\Button.tsx
 * 命名 PillButton 避开既有 shadcn ui/button.tsx（Windows 文件系统大小写
 * 不敏感，Button.tsx 会与其冲突）；active 按压反馈由 globals.css 的全局
 * button:active 规则承担，不重复声明 scale。
 */

/* filled 变体顶部内高光（装饰，同参考实现） */
const filledGloss: CSSProperties = { boxShadow: 'inset 0 1px 0 rgb(255 255 255 / 0.14)' };

/* 变体色映射（bu→项目语义变量，见 globals.css 公共映射层）：
   bg-ink→foreground、bg-surface→card、bg-inset→muted、bg-hover→accent、
   bg-hover-2→secondary、bg-accent→primary、bg-green→status-pass；
   secondary 的语义阴影经内联样式取映射层 --shadow-btn，随亮暗/面板作用域切换 */
const variants: Record<PillButtonVariant, { className: string; style?: CSSProperties }> = {
  primary: { className: 'bg-foreground text-background hover:opacity-90', style: filledGloss },
  secondary: {
    className: 'bg-card text-foreground hover:bg-muted aria-expanded:bg-accent',
    style: { boxShadow: 'var(--shadow-btn)' },
  },
  ghost: { className: 'bg-secondary text-foreground hover:bg-input' },
  accent: { className: 'bg-primary text-primary-foreground hover:brightness-95', style: filledGloss },
  /* 文字取 background 而非固定白：暗色主题的 status-pass 明度高，白字对比不足 */
  success: { className: 'bg-status-pass text-background hover:brightness-95', style: filledGloss },
};

/* 显式对称内边距（非固定高度），保证上下留白恒等（同参考实现） */
const sizes: Record<PillButtonSize, string> = {
  sm: 'px-3 py-[7px] text-[13px] leading-none rounded-full gap-1.5',
  md: 'px-4 py-[9px] text-sm leading-none rounded-full gap-2',
};

export function PillButton({
  variant = 'secondary',
  size = 'md',
  className = '',
  style,
  ...props
}: ButtonHTMLAttributes<HTMLButtonElement> & {
  variant?: PillButtonVariant;
  size?: PillButtonSize;
}) {
  const v = variants[variant];
  return (
    <button
      className={cn(
        'inline-flex select-none items-center justify-center font-medium',
        'transition-[transform,background-color,opacity] duration-150 ease-out',
        'disabled:pointer-events-none disabled:opacity-50',
        v.className,
        sizes[size],
        className,
      )}
      style={{ ...v.style, ...style }}
      {...props}
    />
  );
}
