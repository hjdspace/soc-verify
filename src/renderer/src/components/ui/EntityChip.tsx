import type { ReactNode } from 'react';
import { cn } from '@renderer/lib/utils';

/**
 * 实体 chip：彩色首字母圆盘（Monogram）+ 名称的行内 soft pill。
 * 在行文中标注一个实体（文件/人员/记录），比状态徽章轻、比代码 chip 软。
 *
 * 视觉/交互参考 beautiful-ui: D:\AI\beautiful-ui\components\atoms\EntityChip.tsx
 * （bg-field→--muted、text-ink→--foreground、阴影取映射层 --shadow-hairline。）
 */

/** 默认装饰色（同 .ap-src-icon 先例的固定色板，不随语义令牌） */
export const MONOGRAM_DEFAULT_COLOR = 'rgb(224 138 60)';

/** 彩色圆盘标识 */
export function Monogram({
  children,
  color = MONOGRAM_DEFAULT_COLOR,
  className,
}: {
  children: ReactNode;
  color?: string;
  className?: string;
}) {
  return (
    <span
      className={cn(
        'flex size-4 shrink-0 items-center justify-center rounded-full text-[9px] font-semibold leading-none text-white',
        className,
      )}
      style={{ background: color }}
    >
      {children}
    </span>
  );
}

export function EntityChip({
  name,
  color,
  monogram,
  className,
}: {
  name: string;
  color?: string;
  monogram?: ReactNode;
  className?: string;
}) {
  return (
    <span
      className={cn(
        'mx-0.5 inline-flex items-center gap-1 rounded-full bg-muted py-px pl-[3px] pr-1.5 align-middle',
        className,
      )}
      style={{ boxShadow: 'var(--shadow-hairline)' }}
    >
      <Monogram color={color}>{monogram ?? name.charAt(0)}</Monogram>
      <span className="text-[12px] font-medium text-foreground">{name}</span>
    </span>
  );
}
