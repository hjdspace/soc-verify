import { useState, useEffect, useCallback } from 'react';
import { Minus, Square, X, Copy, PanelLeft, PanelRight, Settings, Search } from 'lucide-react';
import { useUiStore } from '@renderer/stores/ui';
import { cn } from '@renderer/lib/utils';

/**
 * 自定义无边框窗口 TitleBar。
 *
 * 布局：
 *  [Logo] [左栏折叠] | SoC Verify | [右栏折叠] [设置] [最小化] [最大化] [关闭]
 *
 * 整个 TitleBar 可拖拽（-webkit-app-region: drag），
 * 按钮区域设置 no-drag 以保证可点击。
 */
export function TitleBar() {
  const leftCollapsed = useUiStore((s) => s.leftRailCollapsed);
  const rightCollapsed = useUiStore((s) => s.rightPanelCollapsed);
  const toggleLeftRail = useUiStore((s) => s.toggleLeftRail);
  const toggleRightPanel = useUiStore((s) => s.toggleRightPanel);
  const settingsOpen = useUiStore((s) => s.settingsOpen);
  const setSettingsOpen = useUiStore((s) => s.setSettingsOpen);

  const setCommandPaletteOpen = useUiStore((s) => s.setCommandPaletteOpen);

  const [isMaximized, setIsMaximized] = useState(false);

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

  return (
    <header
      className={cn(
        'titlebar-drag',
        'flex h-9 shrink-0 items-center justify-between border-b border-titlebar-border bg-titlebar text-titlebar-foreground select-none',
      )}
    >
      {/* ── 左侧：Logo + 左栏折叠 ─────────────────────────────── */}
      <div className="flex items-center gap-1 pl-3">
        {/* Logo */}
        <div className="flex items-center gap-2 pr-2">
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

        <div className="h-4 w-px bg-titlebar-border" />

        {/* 左栏折叠按钮 */}
        <TitleBarButton
          onClick={toggleLeftRail}
          title={leftCollapsed ? '展开左栏' : '收起左栏'}
          active={!leftCollapsed}
        >
          <PanelLeft className="h-3.5 w-3.5" />
        </TitleBarButton>
      </div>

      {/* ── 中间：可拖拽空白区域 ─────────────────────────────── */}
      <div className="flex-1" />

      {/* ── 右侧：右栏折叠 + 主题 + 窗口控制 ─────────────────── */}
      <div className="flex items-center gap-1 pr-1">
        {/* 右栏折叠按钮 */}
        <TitleBarButton
          onClick={toggleRightPanel}
          title={rightCollapsed ? '展开右栏' : '收起右栏'}
          active={!rightCollapsed}
        >
          <PanelRight className="h-3.5 w-3.5" />
        </TitleBarButton>

        {/* 命令面板按钮 */}
        <TitleBarButton
          onClick={() => setCommandPaletteOpen(true)}
          title="命令面板 (Ctrl+P)"
        >
          <Search className="h-3.5 w-3.5" />
        </TitleBarButton>

        <div className="h-4 w-px bg-titlebar-border mr-1" />

        {/* 设置按钮 — 点击直接打开设置弹窗 */}
        <TitleBarButton
          onClick={() => setSettingsOpen(!settingsOpen)}
          title="设置"
          active={settingsOpen}
        >
          <Settings className="h-3.5 w-3.5" />
        </TitleBarButton>

        <div className="h-4 w-px bg-titlebar-border mr-1" />

        {/* 窗口控制按钮 */}
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


