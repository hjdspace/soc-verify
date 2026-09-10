/**
 * TerminalKeepAliveLayer — 终端视图的常驻层。
 *
 * 终端 tab 切换 / 视图切换 / workbench 目的地切换时不再卸载
 * TerminalPanel（xterm 实例 + 10 万行 scrollback 一起销毁），而是把最近
 * 激活的终端保留在 DOM 中（display:none），切回时零挂载成本、瞬时可见。
 * 超出上限的终端按 LRU（lastActivatedAt 最小者）退回“卸载 → 重挂载时从
 * outputBuffer 尾部恢复”的路径，防止几十个 tab 常驻导致 WebGL 上下文 /
 * xterm 内存无限增长。
 *
 * 挂载集合 = 本层 location 下最近 KEEP_ALIVE_MAX 个终端（含 active 在
 * 内，以 lastActivatedAt 排序），其中活动的那个可见，其余 hidden。
 * 中栏层（CenterArea）常驻渲染、仅终端 tab 激活时可见 —— 文件 tab（如
 * irun_sim.log）与终端 tab 互切不会卸载本层，切回无需跨 IPC 重放
 * outputBuffer（大日志下空白数秒）。按 location 隔离还保证同一 session
 * 只在其所属层挂载一份，不会出现双 xterm 实例 / 双 WebGL 上下文 /
 * 双份数据监听。
 */

import { useMemo } from 'react';
import { useTerminalStore, type TerminalTab, type TerminalLocation } from '@renderer/stores/terminal';
import { TerminalPanel } from './TerminalPanel';
import { cn } from '@renderer/lib/utils';

/** 常驻终端上限（每层）：每个实例 = 1 个 xterm + WebGL 上下文 + 最多 10 万行缓冲 */
const KEEP_ALIVE_MAX = 6;

/** keep-alive 选择实际依赖的字段（TerminalTab 的结构子集，便于测试构造） */
type KeepAliveCandidate = Pick<TerminalTab, 'id' | 'terminalId' | 'lastActivatedAt' | 'location'>;

/**
 * 计算需要 keep-alive 的终端 tab（本 location 下含 active 在内的最近
 * KEEP_ALIVE_MAX 个）。导出供测试使用。
 */
export function selectKeepAliveTerminalTabIds(
  tabs: readonly KeepAliveCandidate[],
  activeTabId: string | null,
  location: TerminalLocation,
): string[] {
  const localTabs = tabs.filter((t) => t.location === location);
  const withSession = localTabs.filter((t) => t.terminalId !== null);
  const sorted = [...withSession].sort((a, b) => b.lastActivatedAt - a.lastActivatedAt);
  const kept = new Set<string>();
  // 活动终端即使是最久未用的也必须保留（否则可见的终端反而被卸载）
  const activeTab = localTabs.find((t) => t.id === activeTabId);
  if (activeTab?.terminalId) kept.add(activeTab.id);
  for (const tab of sorted) {
    if (kept.size >= KEEP_ALIVE_MAX) break;
    kept.add(tab.id);
  }
  return [...kept];
}

export function TerminalKeepAliveLayer({
  activeTerminalTabId,
  location,
}: {
  /** 当前可见的终端 tab；null = 全部隐藏（层常驻保温） */
  activeTerminalTabId: string | null;
  /** 本层承载的终端位置：中栏（center）或底部面板（bottom） */
  location: TerminalLocation;
}) {
  const tabs = useTerminalStore((s) => s.tabs);

  const keepAliveTabIds = useMemo(
    () => selectKeepAliveTerminalTabIds(tabs, activeTerminalTabId, location),
    [tabs, activeTerminalTabId, location],
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
