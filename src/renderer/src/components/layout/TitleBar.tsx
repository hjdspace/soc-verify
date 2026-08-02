import { useState, useEffect, useCallback } from 'react';
import { Minus, Square, X, Copy, PanelLeft, PanelRight, PanelBottom, Settings, Search, ChevronRight, GitCommitHorizontal } from 'lucide-react';
import { useUiStore } from '@renderer/stores/ui';
import { useProjectStore } from '@renderer/stores/project';
import { useSimulationStore } from '@renderer/stores/simulation';
import { useTerminalStore } from '@renderer/stores/terminal';
import { cn } from '@renderer/lib/utils';

/**
 * 自定义无边框窗口 TitleBar。
 *
 * 布局：
 *  [Logo]  [左栏折叠] [面包屑: 项目 › 子系统]      [运行徽章] [右栏折叠] [命令面板] [设置]  [窗口控制]
 *
 * 整个 TitleBar 可拖拽（-webkit-app-region: drag），
 * 按钮区域设置 no-drag 以保证可点击。
 *
 * 设计：以间距分组替代分隔线，避免视觉噪声；面包屑提供上下文，运行徽章提供状态。
 */
export function TitleBar() {
  const leftCollapsed = useUiStore((s) => s.leftRailCollapsed);
  const rightCollapsed = useUiStore((s) => s.rightPanelCollapsed);
  const bottomPanelCollapsed = useUiStore((s) => s.bottomPanelCollapsed);
  const toggleLeftRail = useUiStore((s) => s.toggleLeftRail);
  const toggleRightPanel = useUiStore((s) => s.toggleRightPanel);
  const setBottomPanelCollapsed = useUiStore((s) => s.setBottomPanelCollapsed);
  const settingsOpen = useUiStore((s) => s.settingsOpen);
  const setSettingsOpen = useUiStore((s) => s.setSettingsOpen);
  const setCommandPaletteOpen = useUiStore((s) => s.setCommandPaletteOpen);
  const sourceControlOpen = useUiStore((s) => s.sourceControlOpen);
  const setSourceControlOpen = useUiStore((s) => s.setSourceControlOpen);

  const terminalTabs = useTerminalStore((s) => s.tabs);
  const createTerminal = useTerminalStore((s) => s.createTerminal);
  const bottomTabs = terminalTabs.filter((t) => t.location === 'bottom');

  const currentProjectId = useProjectStore((s) => s.currentProjectId);
  const projects = useProjectStore((s) => s.projects);
  const selectedSubsys = useProjectStore((s) => s.selectedSubsys);
  const activeRuns = useSimulationStore((s) => s.activeRuns);
  const simOptions = useSimulationStore((s) => s.simOptions);

  const projectName = projects.find((p) => p.id === currentProjectId)?.name;
  const selectedCase = typeof simOptions.case === 'string' ? simOptions.case : null;
  const runningCount = activeRuns.filter((r) => r.status === 'running' || r.status === 'pending').length;

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

  // ── 底部面板切换（VSCode 风格） ──────────────────────
  // 点击时：如果面板已折叠且无底部终端，创建一个；否则仅切换折叠状态。
  // 折叠不销毁终端会话，再次展开后历史输出保留。
  const handleToggleBottomPanel = useCallback(() => {
    if (bottomPanelCollapsed && bottomTabs.length === 0) {
      // No bottom terminals yet — create one and expand the panel
      void createTerminal(currentProjectId ?? undefined, undefined, 'bottom');
    } else {
      setBottomPanelCollapsed(!bottomPanelCollapsed);
    }
  }, [bottomPanelCollapsed, bottomTabs.length, createTerminal, currentProjectId, setBottomPanelCollapsed]);

  return (
    <header
      className={cn(
        'titlebar-drag',
        'flex h-9 shrink-0 items-center justify-between border-b border-titlebar-border bg-titlebar text-titlebar-foreground select-none',
      )}
    >
      {/* ── 左侧：Logo + 左栏折叠 ─────────────────────────────── */}
      <div className="flex items-center gap-3 pl-3">
        {/* Logo */}
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

        {/* 左栏折叠按钮 */}
        <TitleBarButton
          onClick={toggleLeftRail}
          title={leftCollapsed ? '展开左栏' : '收起左栏'}
          active={!leftCollapsed}
        >
          <PanelLeft className="h-3.5 w-3.5" />
        </TitleBarButton>

      </div>

      {/* ── 中间：项目 › 子系统 › 用例 ───────────────────────── */}
      <nav className="flex min-w-0 flex-1 items-center gap-1 px-4 text-xs text-muted-foreground">
        {projectName && (
          <>
            <span className="max-w-[160px] truncate text-titlebar-foreground/80">{projectName}</span>
            {selectedSubsys && (
              <>
                <ChevronRight className="h-3 w-3 shrink-0 opacity-50" />
                <span className="max-w-[160px] truncate text-titlebar-foreground/80">{selectedSubsys}</span>
              </>
            )}
            {selectedCase && (
              <>
                <ChevronRight className="h-3 w-3 shrink-0 opacity-50" />
                <span className="max-w-[200px] truncate text-titlebar-foreground">{selectedCase}</span>
              </>
            )}
          </>
        )}
      </nav>

      {/* ── 右侧：运行徽章 + 右栏折叠 + 命令面板 + 设置 + 窗口控制 ── */}
      <div className="flex items-center gap-3 pr-1">
        {/* 运行中徽章 */}
        {runningCount > 0 && (
          <div className="titlebar-no-drag flex items-center gap-1.5 rounded-full bg-status-running px-2 py-0.5 text-[11px] font-medium text-background">
            <span className="relative flex h-1.5 w-1.5">
              <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-background opacity-60" />
              <span className="relative inline-flex h-1.5 w-1.5 rounded-full bg-background" />
            </span>
            <span>REG · {runningCount} RUNNING</span>
          </div>
        )}

        {/* 右栏折叠按钮 */}
        <TitleBarButton
          onClick={toggleRightPanel}
          title={rightCollapsed ? '展开右栏' : '收起右栏'}
          active={!rightCollapsed}
        >
          <PanelRight className="h-3.5 w-3.5" />
        </TitleBarButton>

        {/* 底部面板切换按钮（终端） */}
        <TitleBarButton
          onClick={handleToggleBottomPanel}
          title={bottomPanelCollapsed ? '展开底部终端' : '折叠底部终端'}
          active={!bottomPanelCollapsed}
        >
          <PanelBottom className="h-3.5 w-3.5" />
        </TitleBarButton>

        {/* 命令面板按钮 */}
        <TitleBarButton
          onClick={() => setCommandPaletteOpen(true)}
          title="命令面板 (Ctrl+P)"
        >
          <Search className="h-3.5 w-3.5" />
        </TitleBarButton>

        {/* 源代码管理按钮 */}
        <TitleBarButton
          onClick={() => setSourceControlOpen(!sourceControlOpen)}
          title="源代码管理"
          active={sourceControlOpen}
        >
          <GitCommitHorizontal className="h-3.5 w-3.5" />
        </TitleBarButton>

        {/* 设置按钮 */}
        <TitleBarButton
          onClick={() => setSettingsOpen(!settingsOpen)}
          title="设置"
          active={settingsOpen}
        >
          <Settings className="h-3.5 w-3.5" />
        </TitleBarButton>

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
