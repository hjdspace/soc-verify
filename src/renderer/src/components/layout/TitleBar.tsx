import { useState, useEffect, useCallback } from 'react';
import { Minus, Square, X, Copy, Search, SlidersHorizontal } from 'lucide-react';
import { useUiStore } from '@renderer/stores/ui';
import { useEnvStore } from '@renderer/stores/env';
import { useRegressionStore } from '@renderer/stores/regression';
import { cn } from '@renderer/lib/utils';
import { ToolsDropdown } from './ToolsDropdown';
import { ProjectSelector } from './ProjectSelector';
import { NotificationCenter } from './NotificationCenter';

/**
 * 自定义无边框窗口 TitleBar（mission-control 重构，Issue #8）。
 *
 * 布局（原型 .titlebar）：
 *  [Logo] [项目选择器] [全局搜索触发框]  ···spacer···  [回归徽章] [通知铃铛] [环境变量] [工具] [窗口控制]
 *
 * 迁移说明（Plan §3.3 功能保全）：
 *   - 旧面包屑 → 项目选择器（下拉切换已打开项目）
 *   - 旧运行徽章 → 回归运行徽章（x/y 进度，点击跳回归视图）
 *   - 设置 / 源代码管理 → 导航栏图标（Issue #2）
 *   - 底部面板开关 → 状态栏（Issue #8）
 *   - ToolsDropdown 保留；环境变量管理无新归宿，保留为右侧图标按钮
 *
 * 整个 TitleBar 可拖拽（-webkit-app-region: drag），
 * 按钮区域设置 no-drag 以保证可点击。
 */
export function TitleBar() {
  const setCommandPaletteOpen = useUiStore((s) => s.setCommandPaletteOpen);
  const setActiveView = useUiStore((s) => s.setActiveView);

  const managerOpen = useEnvStore((s) => s.managerOpen);
  const setManagerOpen = useEnvStore((s) => s.setManagerOpen);

  const activeRegressions = useRegressionStore((s) => s.activeRegressions);
  const initActiveRuns = useRegressionStore((s) => s.initActiveRuns);

  const [isMaximized, setIsMaximized] = useState(false);

  // ── 回归徽章数据源：拉取运行中回归 + 订阅 regression:event ────
  useEffect(() => {
    initActiveRuns();
  }, [initActiveRuns]);

  // ── 监听窗口最大化状态 ──────────────────────────────────────
  useEffect(() => {
    const api = window.windowControls;
    if (!api) return;

    api.isMaximized().then(setIsMaximized);
    const unlisten = api.onMaximizeChange(setIsMaximized);
    return unlisten;
  }, []);

  // ── 窗口控制 ─────────────────────────────────────────────────
  const handleMinimize = useCallback(() => window.windowControls?.minimize(), []);
  const handleMaximize = useCallback(() => window.windowControls?.toggleMaximize(), []);
  const handleClose = useCallback(() => window.windowControls?.close(), []);

  // ── 回归徽章：单条显示 x/y 进度，多条显示计数 ────────────────
  const latestRegression =
    activeRegressions.length > 0
      ? activeRegressions.reduce((a, b) => (a.submittedAt >= b.submittedAt ? a : b))
      : null;
  const hasProgress =
    latestRegression?.completed !== undefined && latestRegression?.total !== undefined;

  return (
    <header
      className={cn(
        'titlebar-drag',
        'flex h-9 shrink-0 items-center gap-2 border-b border-titlebar-border bg-titlebar pl-3 pr-1 text-titlebar-foreground select-none',
      )}
    >
      {/* ── Logo ─────────────────────────────────────────────────── */}
      <div className="flex items-center gap-2">
        <svg
          width="16"
          height="16"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="2"
          strokeLinecap="round"
          strokeLinejoin="round"
          className="opacity-70"
        >
          <rect x="4" y="4" width="16" height="16" rx="2" />
          <rect x="9" y="9" width="6" height="6" />
          <path d="M9 2v2M15 2v2M9 20v2M15 20v2M2 9h2M2 15h2M20 9h2M20 15h2" />
        </svg>
        <span className="text-xs font-semibold tracking-wide">SoC Verify</span>
      </div>

      {/* ── 项目选择器（下拉切换已打开项目） ─────────────────────── */}
      <ProjectSelector />

      {/* ── 全局搜索触发框（只读；Ctrl K / Ctrl P 呼出命令面板） ── */}
      <button
        type="button"
        onClick={() => setCommandPaletteOpen(true)}
        title="全局搜索（Ctrl+K / Ctrl+P）"
        className={cn(
          'titlebar-no-drag',
          'ml-1 flex h-7 min-w-0 max-w-[320px] flex-1 items-center gap-2 rounded-md border border-border/60 bg-background/40 px-2.5 text-xs text-muted-foreground transition-colors hover:border-border hover:text-foreground',
        )}
      >
        <Search className="size-3 shrink-0 opacity-70" />
        <span className="truncate">搜索用例、文件、命令…</span>
        <kbd className="ml-auto hidden shrink-0 rounded border border-border bg-accent/40 px-1.5 py-px font-mono text-[10px] text-muted-foreground sm:inline">
          Ctrl K
        </kbd>
      </button>

      {/* ── 右侧：回归徽章 + 通知 + 工具 + 窗口控制 ─────────────── */}
      <div className="ml-auto flex items-center gap-1.5">
        {/* 回归运行徽章：点击跳回归视图；无运行时隐藏 */}
        {latestRegression && (
          <button
            type="button"
            data-testid="regression-badge"
            onClick={() => setActiveView('regression')}
            title="查看回归视图"
            className={cn(
              'titlebar-no-drag',
              'flex h-6 items-center gap-1.5 rounded-full bg-status-running/15 px-2.5 text-[11px] font-medium text-status-running transition-colors hover:bg-status-running/25',
            )}
          >
            <span className="relative flex size-1.5">
              <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-status-running opacity-60" />
              <span className="relative inline-flex size-1.5 rounded-full bg-status-running" />
            </span>
            {activeRegressions.length > 1 ? (
              <span>回归 ×{activeRegressions.length} 运行中</span>
            ) : (
              <span className="tabular-nums">
                回归 #{latestRegression.runId.slice(-6)} 运行中
                {hasProgress && ` · ${latestRegression.completed}/${latestRegression.total}`}
              </span>
            )}
          </button>
        )}

        {/* 通知中心（铃铛 + 下拉面板） */}
        <NotificationCenter />

        {/* 环境变量管理 */}
        <TitleBarButton
          onClick={() => setManagerOpen(!managerOpen)}
          title="环境变量管理"
          active={managerOpen}
        >
          <SlidersHorizontal className="h-3.5 w-3.5" />
        </TitleBarButton>

        {/* 工具下拉菜单 */}
        <ToolsDropdown />

        {/* 窗口控制按钮组 */}
        <div className="flex items-center">
          <TitleBarButton onClick={handleMinimize} title="最小化">
            <Minus className="h-3.5 w-3.5" />
          </TitleBarButton>
          <TitleBarButton onClick={handleMaximize} title={isMaximized ? '还原' : '最大化'}>
            {isMaximized ? (
              <Copy className="h-3 w-3 -scale-x-100" />
            ) : (
              <Square className="h-3 w-3" />
            )}
          </TitleBarButton>
          <TitleBarButton onClick={handleClose} title="关闭" variant="close">
            <X className="h-3.5 w-3.5" />
          </TitleBarButton>
        </div>
      </div>
    </header>
  );
}

// ── TitleBar 按钮子组件 ─────────────────────────────────────────

interface TitleBarButtonProps {
  children: React.ReactNode;
  onClick: () => void;
  title: string;
  active?: boolean;
  variant?: 'default' | 'close';
}

function TitleBarButton({ children, onClick, title, active, variant = 'default' }: TitleBarButtonProps) {
  return (
    <button
      onClick={onClick}
      title={title}
      className={cn(
        'titlebar-no-drag',
        'flex h-7 w-7 items-center justify-center rounded transition-colors',
        'hover:bg-foreground/10',
        active && 'text-foreground',
        !active && 'text-muted-foreground',
        variant === 'close' && 'hover:bg-destructive hover:text-destructive-foreground',
      )}
    >
      {children}
    </button>
  );
}
