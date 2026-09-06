import { useEffect } from 'react';
import {
  LayoutDashboard,
  Play,
  Target,
  Repeat,
  Layers,
  Folder,
  GitFork,
  Sparkles,
  Settings,
  Coins,
  Network,
} from 'lucide-react';
import { useUiStore, type ActiveView } from '@renderer/stores/ui';
import { useSimulationStore } from '@renderer/stores/simulation';
import { cn } from '@renderer/lib/utils';

type NavItem = {
  view: ActiveView;
  label: string;
  icon: typeof Play;
};

/** 六个视图按钮：总览 / 仿真 / 回归 / 覆盖率 / 设计 / 工作区（tooltip 含 Ctrl+N 快捷键） */
const VIEW_ITEMS: NavItem[] = [
  { view: 'dashboard', label: '总览 · Ctrl 1', icon: LayoutDashboard },
  { view: 'simulation', label: '仿真 · Ctrl 2', icon: Play },
  { view: 'regression', label: '回归 · Ctrl 3', icon: Repeat },
  { view: 'coverage', label: '覆盖率 · Ctrl 4', icon: Target },
  { view: 'design', label: '设计', icon: Network },
  { view: 'workspace', label: '工作区', icon: Layers },
];

/** Ctrl+1..4 快捷键覆盖的四大主视图（工作区不占数字键位） */
const SHORTCUT_VIEWS: readonly ActiveView[] = ['dashboard', 'simulation', 'regression', 'coverage'];

/** 按钮结构样式（结构 / 颜色分离，激活态按需组合） */
const NAV_BUTTON_BASE =
  'group relative grid size-[42px] place-items-center rounded-[10px] transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/50';
const NAV_BUTTON_IDLE = 'text-muted-foreground hover:bg-accent hover:text-foreground';

/** 纯 CSS tooltip：hover 父级 .group 时淡入（原型 .nav-btn .tooltip） */
function NavTooltip({ label }: { label: string }) {
  return (
    <span className="pointer-events-none absolute left-[52px] top-1/2 z-10 -translate-y-1/2 whitespace-nowrap rounded-md border border-border bg-popover px-2.5 py-1 text-[11px] text-popover-foreground opacity-0 transition-opacity duration-100 group-hover:opacity-100">
      {label}
    </span>
  );
}

/**
 * 60px 窄图标导航栏（mission-control 布局）：
 * 上部六个视图按钮（仿真带运行数 badge），分隔线后文件/版本控制/AI，
 * 底部设置。每个按钮 hover 显示纯 CSS tooltip。
 */
export function NavRail() {
  const activeView = useUiStore((s) => s.activeView);
  const setActiveView = useUiStore((s) => s.setActiveView);
  const setSourceControlOpen = useUiStore((s) => s.setSourceControlOpen);
  const setSettingsOpen = useUiStore((s) => s.setSettingsOpen);
  const leftDrawerOpen = useUiStore((s) => s.leftDrawerOpen);
  const toggleLeftDrawer = useUiStore((s) => s.toggleLeftDrawer);
  const filePanelMode = useUiStore((s) => s.filePanelMode);
  const filePanelCollapsed = useUiStore((s) => s.filePanelCollapsed);
  const toggleFilePanel = useUiStore((s) => s.toggleFilePanel);
  const rightDrawerOpen = useUiStore((s) => s.rightDrawerOpen);
  const toggleRightDrawer = useUiStore((s) => s.toggleRightDrawer);
  const aiPanelMode = useUiStore((s) => s.aiPanelMode);
  const rightPanelCollapsed = useUiStore((s) => s.rightPanelCollapsed);
  const toggleRightPanel = useUiStore((s) => s.toggleRightPanel);
  const activeRuns = useSimulationStore((s) => s.activeRuns);
  const runningCount = activeRuns.filter((r) => r.status === 'running' || r.status === 'pending').length;

  /** 文件按钮：drawer 模式 toggle 左抽屉；docked 模式 toggle 折叠状态。 */
  const handleFileClick = () => {
    if (filePanelMode === 'drawer') {
      toggleLeftDrawer();
      return;
    }
    toggleFilePanel();
  };

  const fileButtonActive =
    filePanelMode === 'drawer'
      ? leftDrawerOpen
      : !filePanelCollapsed;

  /** AI 按钮：drawer 模式 toggle 右抽屉；docked 模式 toggle 固定右栏折叠状态（不切换视图）。 */
  const handleAiClick = () => {
    if (aiPanelMode === 'drawer') {
      toggleRightDrawer();
      return;
    }
    toggleRightPanel();
  };

  const aiButtonActive =
    aiPanelMode === 'drawer'
      ? rightDrawerOpen
      : !rightPanelCollapsed;

  // Ctrl+1..4 切换四大视图；仅 ctrl/meta 按下时拦截，普通数字键（含输入框）不受影响
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (!(e.ctrlKey || e.metaKey)) return;
      const index = Number(e.key) - 1;
      if (!Number.isInteger(index) || index < 0 || index >= SHORTCUT_VIEWS.length) return;
      e.preventDefault();
      setActiveView(SHORTCUT_VIEWS[index]);
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [setActiveView]);

  return (
    <nav
      aria-label="视图导航"
      className="flex w-[60px] shrink-0 flex-col items-center gap-1 border-r border-border bg-sidebar py-3"
    >
      {VIEW_ITEMS.map(({ view, label, icon: Icon }) => (
        <button
          key={view}
          type="button"
          aria-current={activeView === view ? 'page' : undefined}
          onClick={() => setActiveView(view)}
          className={cn(
            NAV_BUTTON_BASE,
            activeView === view ? 'bg-primary/10 text-primary' : NAV_BUTTON_IDLE,
          )}
        >
          <Icon className="size-[18px]" strokeWidth={1.8} />
          {activeView === view && (
            <span
              aria-hidden="true"
              data-testid="nav-active-indicator"
              className="absolute bottom-1 h-0.5 w-4 rounded-full bg-primary"
            />
          )}
          {view === 'simulation' && runningCount > 0 && (
            <span
              data-testid="nav-simulation-badge"
              className="absolute right-[5px] top-[5px] grid h-3.5 min-w-3.5 place-items-center rounded-full bg-status-fail px-[3px] text-[9px] font-semibold text-background"
            >
              {runningCount}
            </span>
          )}
          <NavTooltip label={label} />
        </button>
      ))}

      <div className="my-2 h-px w-7 bg-border" />

      {/* 文件抽屉：drawer 模式 toggle 左抽屉；docked 模式 toggle 折叠 */}
      <button
        type="button"
        aria-label="文件"
        aria-pressed={fileButtonActive}
        onClick={handleFileClick}
        className={cn(
          NAV_BUTTON_BASE,
          fileButtonActive ? 'bg-primary/10 text-primary' : NAV_BUTTON_IDLE,
        )}
      >
        <Folder className="size-[18px]" strokeWidth={1.8} />
        <NavTooltip label="文件" />
      </button>

      {/* 版本控制：接现有 SourceControlDialog */}
      <button
        type="button"
        aria-label="版本控制"
        onClick={() => setSourceControlOpen(true)}
        className={cn(NAV_BUTTON_BASE, NAV_BUTTON_IDLE)}
      >
        <GitFork className="size-[18px]" strokeWidth={1.8} />
        <NavTooltip label="版本控制" />
      </button>

      {/* AI 助手：drawer 模式 toggle 右抽屉；docked 模式切换固定右栏 */}
      <button
        type="button"
        aria-label="AI 助手"
        aria-pressed={aiButtonActive}
        onClick={handleAiClick}
        className={cn(
          NAV_BUTTON_BASE,
          aiButtonActive ? 'bg-primary/10 text-primary' : NAV_BUTTON_IDLE,
        )}
      >
        <Sparkles className="size-[18px]" strokeWidth={1.8} />
        <NavTooltip label="AI 助手" />
      </button>

      {/* Token 用量：独立工具按钮（非仿真相关），点击切换到 Token 视图 */}
      <button
        type="button"
        aria-label="Token 用量"
        aria-current={activeView === 'token' ? 'page' : undefined}
        onClick={() => setActiveView('token')}
        className={cn(
          NAV_BUTTON_BASE,
          activeView === 'token' ? 'bg-primary/10 text-primary' : NAV_BUTTON_IDLE,
        )}
      >
        <Coins className="size-[18px]" strokeWidth={1.8} />
        {activeView === 'token' && (
          <span
            aria-hidden="true"
            data-testid="nav-active-indicator"
            className="absolute bottom-1 h-0.5 w-4 rounded-full bg-primary"
          />
        )}
        <NavTooltip label="Token 用量" />
      </button>

      <div className="mt-auto">
        <button
          type="button"
          aria-label="设置"
          onClick={() => setSettingsOpen(true)}
          className={cn(NAV_BUTTON_BASE, NAV_BUTTON_IDLE)}
        >
          <Settings className="size-[18px]" strokeWidth={1.8} />
          <NavTooltip label="设置" />
        </button>
      </div>
    </nav>
  );
}
