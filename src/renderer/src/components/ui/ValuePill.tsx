import type { ReactNode } from 'react';
import { cn } from '@renderer/lib/utils';

type ValuePillTone = 'neutral' | 'green' | 'orange' | 'red' | 'accent';

/**
 * 行内数值徽章——在行文中标出一个值（日期/名称/计数），无状态语义。
 *
 * 视觉/交互参考 beautiful-ui: D:\AI\beautiful-ui\components\atoms\ValuePill.tsx
 * tone 取项目语义变量派生（见 globals.css 公共映射层颜色映射表）：
 * green→--status-pass、orange→--status-aborted、red→--status-fail、
 * accent→--primary。tint 底（14% 混入卡面）与 1px 描边（28% 透明）在使用点
 * color-mix 就地计算，随主题与 .ai-panel 作用域自动取正确值。
 */
const TONES: Record<ValuePillTone, { text: string; bg: string; ring: string }> = {
  neutral: { text: 'text-muted-foreground', bg: 'var(--muted)', ring: 'var(--shadow-hairline)' },
  green: {
    text: 'text-[var(--status-pass)]',
    bg: 'color-mix(in srgb, var(--status-pass) 14%, var(--card))',
    ring: '0 0 0 1px color-mix(in srgb, var(--status-pass) 28%, transparent)',
  },
  orange: {
    text: 'text-[var(--status-aborted)]',
    bg: 'color-mix(in srgb, var(--status-aborted) 14%, var(--card))',
    ring: '0 0 0 1px color-mix(in srgb, var(--status-aborted) 28%, transparent)',
  },
  red: {
    text: 'text-[var(--status-fail)]',
    bg: 'color-mix(in srgb, var(--status-fail) 14%, var(--card))',
    ring: '0 0 0 1px color-mix(in srgb, var(--status-fail) 28%, transparent)',
  },
  accent: {
    text: 'text-primary',
    bg: 'color-mix(in srgb, var(--primary) 14%, var(--card))',
    ring: '0 0 0 1px color-mix(in srgb, var(--primary) 28%, transparent)',
  },
};

export function ValuePill({
  children,
  tone = 'neutral',
  className,
}: {
  children: ReactNode;
  tone?: ValuePillTone;
  className?: string;
}) {
  const t = TONES[tone];
  return (
    <span
      className={cn(
        'mx-0.5 inline-flex items-center rounded-full px-1.5 py-0 align-middle text-[12px] font-medium',
        t.text,
        className,
      )}
      style={{ backgroundColor: t.bg, boxShadow: t.ring }}
    >
      {children}
    </span>
  );
}
