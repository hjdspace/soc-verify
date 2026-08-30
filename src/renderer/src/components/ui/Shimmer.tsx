import type { ReactNode } from 'react';
import { cn } from '@renderer/lib/utils';

/**
 * 扫光文字——agent 处理中的中性信号（faint↔ink 渐变往复扫过）。
 *
 * 视觉/交互参考 beautiful-ui: D:\AI\beautiful-ui\components\atoms\Shimmer.tsx
 * 渐变取映射层 ink 色阶（--ink-3→--fg-faint、--ink→--foreground），keyframes
 * 用 globals.css 映射层 canonical shimmer-text；AI 面板内的品牌渐变变体
 * 见 ai-panel.css 的 .ap-shimmer，两者并存。
 */
export function Shimmer({
  children,
  className,
}: {
  children: ReactNode;
  className?: string;
}) {
  return (
    <span
      className={cn('inline-block bg-clip-text text-transparent', className)}
      style={{
        backgroundImage:
          'linear-gradient(90deg, var(--fg-faint) 35%, var(--foreground) 50%, var(--fg-faint) 65%)',
        backgroundSize: '200% 100%',
        animation: 'shimmer-text 1.8s linear infinite',
      }}
    >
      {children}
    </span>
  );
}
