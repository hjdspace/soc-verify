/**
 * 仿真视图（三栏布局整合 — Issue #5）。
 *
 * 从单一运行列表表格重构为 IDE 三栏布局容器：
 *   左栏 CaseTreePanel（子系统/用例树，宽度 simLeftPanelWidth，可拖拽）
 *   中上 SimOptionPanel（Option 面板，max-h-280px 可滚动）
 *   中中 RunListPanel（运行列表，flex-1 可滚动）
 *   中底 SimCommandBar（命令预览 + 复制 + 运行按钮，shrink-0）
 *
 * 切换到仿真视图时自动加载子系统列表（由 CaseTreePanel 内部 effect 驱动）
 * 和活跃运行列表。保留 ViewHeader（标题 + 副标题 + 停止全部/新建仿真）。
 * 左栏与中栏之间使用 ResizeHandle 拖拽调整宽度，持久化到 simLeftPanelWidth。
 */

import { useEffect, useMemo } from 'react';
import { Play, Square } from 'lucide-react';
import { ViewHeader } from '@renderer/components/layout/ViewHeader';
import { ResizeHandle } from '@renderer/components/layout/ResizeHandle';
import { CaseTreePanel } from '@renderer/components/simulation/CaseTreePanel';
import { SimOptionPanel } from '@renderer/components/simulation/SimOptionPanel';
import { RunListPanel } from '@renderer/components/simulation/RunListPanel';
import { SimCommandBar } from '@renderer/components/simulation/SimCommandBar';
import { useSimulationStore } from '@renderer/stores/simulation';
import { useProjectStore } from '@renderer/stores/project';
import { useUiStore } from '@renderer/stores/ui';

export function SimulationView() {
  const currentProjectId = useProjectStore((s) => s.currentProjectId);
  const activeRuns = useSimulationStore((s) => s.activeRuns);
  const loadActiveRuns = useSimulationStore((s) => s.loadActiveRuns);
  const stopAllRuns = useSimulationStore((s) => s.stopAllRuns);
  const setActiveView = useUiStore((s) => s.setActiveView);
  const simLeftPanelWidth = useUiStore((s) => s.simLeftPanelWidth);
  const setSimLeftPanelWidth = useUiStore((s) => s.setSimLeftPanelWidth);

  // 拉取插件运行（agent/回归启动）合并进 activeRuns；终端运行由 IPC 事件驱动
  useEffect(() => {
    if (!currentProjectId) return;
    void loadActiveRuns(currentProjectId);
  }, [currentProjectId, loadActiveRuns]);

  // 运行中 + 队列中计数（副标题）
  const liveCount = useMemo(
    () => activeRuns.filter((r) => r.status === 'running' || r.status === 'pending').length,
    [activeRuns],
  );
  const doneCount = activeRuns.length - liveCount;
  const hasLive = liveCount > 0;

  return (
    <div className="flex flex-1 flex-col overflow-hidden" data-testid="simulation-view">
      {/* ── ViewHeader: 标题 + 副标题 + 动作按钮 ────────── */}
      <div className="px-4 pt-4">
        <ViewHeader
          title="仿真"
          subtitle={`${liveCount} 运行中 · ${doneCount} 已完成`}
        >
          <button
            className="inline-flex cursor-pointer items-center gap-1.5 rounded-lg border border-border px-3.5 py-1.5 text-xs font-medium text-muted-foreground transition-colors hover:border-border/80 hover:bg-card hover:text-foreground disabled:cursor-not-allowed disabled:opacity-40"
            onClick={() => void stopAllRuns()}
            disabled={!hasLive}
            data-testid="sim-stop-all"
          >
            <Square className="size-2.5" fill="currentColor" />
            停止全部
          </button>
          <button
            className="inline-flex cursor-pointer items-center gap-1.5 rounded-lg bg-primary px-3.5 py-1.5 text-xs font-semibold text-primary-foreground transition-colors hover:opacity-90"
            title="前往工作区用例列表启动仿真"
            onClick={() => setActiveView('workspace')}
            data-testid="sim-new-btn"
          >
            <Play className="size-2.5" fill="currentColor" />
            新建仿真
          </button>
        </ViewHeader>
      </div>

      {/* ── 三栏布局：CaseTreePanel | ResizeHandle | CenterArea ── */}
      <div className="flex flex-1 overflow-hidden px-4 pb-4">
        {/* 左栏：用例树 */}
        <div
          className="shrink-0 overflow-hidden rounded-xl border border-border bg-card"
          style={{ width: `${simLeftPanelWidth}px` }}
        >
          <CaseTreePanel />
        </div>

        {/* 拖拽分隔线 */}
        <ResizeHandle
          side="left"
          width={simLeftPanelWidth}
          onResize={setSimLeftPanelWidth}
        />

        {/* 中栏：Option 面板（上） + 运行列表（中） + 命令栏（底） */}
        <div className="flex min-w-0 flex-1 flex-col gap-3">
          {/* 中上：Option 面板 */}
          <div className="max-h-80 shrink-0 overflow-y-auto">
            <SimOptionPanel />
          </div>

          {/* 中中：运行列表 */}
          <div className="flex min-h-0 flex-1 flex-col">
            <RunListPanel />
          </div>

          {/* 中底：命令预览 + 运行按钮 */}
          <SimCommandBar />
        </div>
      </div>
    </div>
  );
}
