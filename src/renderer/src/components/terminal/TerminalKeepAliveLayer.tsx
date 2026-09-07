/**
 * TerminalKeepAliveLayer — 终端视图的常驻层。
 *
 * 终端 tab 切换 / 视图切换时不再卸载 TerminalPanel（xterm 实例 +
 * 10 万行 scrollback 一起销毁），而是把最近激活的终端保留在 DOM 中
 * （display:none），切回时零挂载成本、瞬时可见。超出上限的终端按
 * LRU（lastActivatedAt 最小者）退回“卸载 → 重挂载时从 outputBuffer
 * 尾部恢复”的路径，防止几十个 tab 常驻导致 WebGL 上下文 / xterm
 * 内存无限增长。
 *
 * 挂载集合 = 最近 KEEP_ALIVE_MAX 个终端（以 lastActivatedAt 排序），
 * 其中活动的那个可见，其余 hidden。CenterArea 只在当前 tab 是终端
 * 时把此层渲染出来；非终端 tab 时整层隐藏。
 */

import { useMemo } from 'react';
import { useTerminalStore } from '@renderer/stores/terminal';
import { TerminalPanel } from './TerminalPanel';
import { cn } from '@renderer/lib/utils';

/** 常驻终端上限：每个实例 = 1 个 xterm + WebGL 上下文 + 最多 10 万行缓冲 */
const KEEP_ALIVE_MAX = 6;

/**
 * 计算需要 keep-alive 的终端 tab（含 active 在内的最近 KEEP_ALIVE_MAX 个）。
 * 导出供测试使用。
 */
export function selectKeepAliveTerminalTabIds(
  tabs: { id: string; terminalId: string | null; lastActivatedAt: number }[],
  activeTabId: string | null,
): string[] {
  const withSession = tabs.filter((t) => t.terminalId !== null);
  const sorted = [...withSession].sort((a, b) => b.lastActivatedAt - a.lastActivatedAt);
  const kept = new Set<string>();
  // 活动终端即使是最久未用的也必须保留（否则可见的终端反而被卸载）
  const activeTab = tabs.find((t) => t.id === activeTabId);
  if (activeTab?.terminalId) kept.add(activeTab.id);
  for (const tab of sorted) {
    if (kept.size >= KEEP_ALIVE_MAX) break;
    kept.add(tab.id);
  }
  return [...kept];
}

export function TerminalKeepAliveLayer({ activeTerminalTabId }: { activeTerminalTabId: string | null }) {
  const tabs = useTerminalStore((s) => s.tabs);

  const keepAliveTabIds = useMemo(
    () => selectKeepAliveTerminalTabIds(tabs, activeTerminalTabId),
    [tabs, activeTerminalTabId],
  );

  return (
    <>
      {keepAliveTabIds.map((tabId) => {
        const tab = tabs.find((t) => t.id === tabId);
        if (!tab?.terminalId) return null;
        const visible = tab.id === activeTerminalTabId;
        return (
          <div
            key={tab.terminalId}
            className={cn('absolute inset-0 flex flex-col', visible ? 'flex' : 'hidden')}
            aria-hidden={!visible}
          >
            <TerminalPanel
              terminalId={tab.terminalId}
              tabTitle={tab.title}
              hidden={!visible}
            />
          </div>
        );
      })}
    </>
  );
}
