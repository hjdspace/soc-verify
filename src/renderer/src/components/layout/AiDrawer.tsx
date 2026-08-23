import { PanelRight } from 'lucide-react';
import { useUiStore } from '@renderer/stores/ui';
import { Drawer } from './Drawer';
import { RightPanelContent } from './RightPanel';

/** 原型：AI 抽屉宽 360px */
const AI_DRAWER_WIDTH = 360;

/**
 * 右侧 AI 会话抽屉（Issue #7，aiPanelMode === 'drawer' 时挂载）。
 * 内容复用 RightPanelContent（消息流 / 审批卡 / 子代理展示 / composer），
 * 仅外壳换抽屉；底部提供切换回固定侧栏（docked）模式的入口。
 */
export function AiDrawer() {
  const open = useUiStore((s) => s.rightDrawerOpen);
  const closeDrawers = useUiStore((s) => s.closeDrawers);
  const setAiPanelMode = useUiStore((s) => s.setAiPanelMode);
  const setActiveView = useUiStore((s) => s.setActiveView);

  /** 切换回固定侧栏模式：偏好写入布局持久化，并切到 workspace 让用户看到面板。 */
  const handleSwitchToDocked = () => {
    setAiPanelMode('docked');
    setActiveView('workspace');
  };

  return (
    <Drawer
      side="right"
      open={open}
      onClose={closeDrawers}
      title="AI 验证助手"
      width={AI_DRAWER_WIDTH}
      flush
    >
      <div className="flex min-h-0 flex-1 flex-col">
        <RightPanelContent />
        <button
          type="button"
          onClick={handleSwitchToDocked}
          data-testid="ai-drawer-dock-switch"
          className="flex shrink-0 items-center justify-center gap-1.5 border-t border-border/50 px-3 py-2 text-[11px] text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
        >
          <PanelRight className="size-3" />
          切换为固定侧栏模式
        </button>
      </div>
    </Drawer>
  );
}
