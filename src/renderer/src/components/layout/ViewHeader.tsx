import type { ReactNode } from 'react';

/**
 * 通用视图头：标题 + 副标题 + 动作区。
 * 四大主视图（总览/仿真/覆盖率/回归）共用，样式对照原型 `.view-header`。
 */
export function ViewHeader({ title, subtitle, children }: {
  title: string;
  subtitle?: string;
  /** 动作区（自动重跑 pill / 导出 / 启动回归等） */
  children?: ReactNode;
}) {
  return (
    <div className="mb-4 flex flex-wrap items-center gap-3">
      <h1 className="text-[17px] font-semibold tracking-tight text-foreground">{title}</h1>
      {subtitle && <span className="text-xs text-muted-foreground">{subtitle}</span>}
      {children && <div className="ml-auto flex items-center gap-2">{children}</div>}
    </div>
  );
}
