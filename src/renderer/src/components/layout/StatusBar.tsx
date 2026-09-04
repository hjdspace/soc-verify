import { useCallback, useEffect, useState } from 'react';
import { Check, PanelBottom } from 'lucide-react';
import { useUiStore } from '@renderer/stores/ui';
import { useProjectStore } from '@renderer/stores/project';
import { useTerminalStore } from '@renderer/stores/terminal';
import { cn } from '@renderer/lib/utils';

/** 引擎版本（静态数据先行，后续切片接真实数据） */
const ENGINE_VERSION = 'v4.1.2';

const pad2 = (n: number) => String(n).padStart(2, '0');

function formatClock(d: Date): string {
  return `${pad2(d.getHours())}:${pad2(d.getMinutes())}:${pad2(d.getSeconds())}`;
}

/**
 * 全局状态栏：omp 连接状态 / 引擎版本 / 秒级时钟 + 底部终端面板开关。
 * 底部面板开关自 TitleBar 迁入（Plan §3.3 功能保全：「底部面板开关移至状态栏」）。
 */
export function StatusBar() {
  const [now, setNow] = useState(() => new Date());

  const bottomPanelCollapsed = useUiStore((s) => s.bottomPanelCollapsed);
  const setBottomPanelCollapsed = useUiStore((s) => s.setBottomPanelCollapsed);
  const currentProjectId = useProjectStore((s) => s.currentProjectId);
  const terminalTabs = useTerminalStore((s) => s.tabs);
  const createTerminal = useTerminalStore((s) => s.createTerminal);
  const bottomTabs = terminalTabs.filter((t) => t.location === 'bottom');

  useEffect(() => {
    const timer = window.setInterval(() => setNow(new Date()), 1000);
    return () => window.clearInterval(timer);
  }, []);

  // 与旧 TitleBar 行为一致：面板折叠且无底部终端时先创建一个再展开；
  // 折叠不销毁会话，再次展开后历史输出保留。
  const handleToggleBottomPanel = useCallback(() => {
    if (bottomPanelCollapsed && bottomTabs.length === 0) {
      void createTerminal(currentProjectId ?? undefined, undefined, 'bottom');
    } else {
      setBottomPanelCollapsed(!bottomPanelCollapsed);
    }
  }, [bottomPanelCollapsed, bottomTabs.length, createTerminal, currentProjectId, setBottomPanelCollapsed]);

  return (
    <footer className="flex h-6 shrink-0 items-center gap-3.5 border-t border-titlebar-border bg-titlebar px-3 text-[10.5px] text-muted-foreground glass">
      <span className="flex items-center gap-1.5 text-status-pass">
        <Check className="size-2.5" strokeWidth={3} />
        omp 已连接
      </span>
      <span className="flex items-center gap-1.5">引擎 {ENGINE_VERSION}</span>
      <button
        type="button"
        title={bottomPanelCollapsed ? '展开底部终端' : '折叠底部终端'}
        onClick={handleToggleBottomPanel}
        className={cn(
          'flex items-center gap-1 rounded px-1 transition-colors hover:bg-foreground/10 hover:text-foreground',
          !bottomPanelCollapsed && 'text-foreground',
        )}
      >
        <PanelBottom className="size-3" />
        终端
      </button>
      <span className="ml-auto tabular-nums" data-testid="statusbar-clock">
        {formatClock(now)}
      </span>
    </footer>
  );
}
