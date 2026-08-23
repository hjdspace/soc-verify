/**
 * 回归视图（Mission Control）— 回归测试管理的工作视图。
 *
 * 套件卡片网格（discovery 按子系统映射，原型 repeat(4,1fr) 窄窗降级 2 列）+
 * 历史趋势表（RegressionHistoryEntry 真实字段，缺失列占位「—」）+
 * 失败聚类占位面板（数据源暂缺，见 FailureClusterPanel TODO）。
 * 数据只读复用 regression store（discover / loadHistory），不重写数据层。
 */

import { useEffect, useMemo } from 'react';
import { RefreshCw } from 'lucide-react';
import type { RegressionHistoryEntry } from '@shared/types';
import { ViewHeader } from '@renderer/components/layout/ViewHeader';
import {
  SuiteCardGrid,
  SuiteCardGridSkeleton,
  SuiteCardGridEmpty,
  type SuiteCardData,
} from './regression/SuiteCardGrid';
import { HistoryTable } from './regression/HistoryTable';
import { FailureClusterPanel } from './regression/FailureClusterPanel';
import { useRegressionStore } from '@renderer/stores/regression';
import { useProjectStore } from '@renderer/stores/project';
import { useWorkbenchStore } from '@renderer/stores/workbench';
import { cn } from '@renderer/lib/utils';

export function RegressionView() {
  const currentProjectId = useProjectStore((s) => s.currentProjectId);
  const discovery = useRegressionStore((s) => s.discovery);
  const discoveryLoading = useRegressionStore((s) => s.discoveryLoading);
  const discoveryError = useRegressionStore((s) => s.discoveryError);
  const discover = useRegressionStore((s) => s.discover);
  const history = useRegressionStore((s) => s.history);
  const historyLoading = useRegressionStore((s) => s.historyLoading);
  const loadHistory = useRegressionStore((s) => s.loadHistory);
  const open = useWorkbenchStore((s) => s.open);

  // 数据加载：项目切换时扫描回归目录并拉取运行历史（SimulationView 模式）
  useEffect(() => {
    if (!currentProjectId) return;
    void discover(currentProjectId);
    void loadHistory(currentProjectId);
  }, [currentProjectId, discover, loadHistory]);

  /** 套件卡 = discovery 子系统分组；latest = 该子系统最近一次运行（状态色/时间来源） */
  const suites = useMemo<SuiteCardData[]>(() => {
    const latestBySubsys = new Map<string, RegressionHistoryEntry>();
    for (const entry of history) {
      const prev = latestBySubsys.get(entry.subsys);
      if (!prev || entry.submittedAt > prev.submittedAt) latestBySubsys.set(entry.subsys, entry);
    }
    return discovery.map(({ subsys, items }) => {
      const lists = items.filter((item) => item.type === 'list');
      return {
        subsys,
        listCount: lists.length,
        groupCount: items.length - lists.length,
        onCount: lists.reduce((acc, list) => acc + list.onCount, 0),
        latest: latestBySubsys.get(subsys) ?? null,
      };
    });
  }, [discovery, history]);

  /** 历史按提交时间降序（最近在前，对照原型 # 最新在最上） */
  const sortedHistory = useMemo(
    () => [...history].sort((a, b) => b.submittedAt - a.submittedAt),
    [history],
  );

  const handleRefresh = () => {
    if (!currentProjectId) return;
    void discover(currentProjectId, true);
    void loadHistory(currentProjectId);
  };

  return (
    <div className="flex-1 overflow-y-auto p-5" data-testid="regression-view">
      <ViewHeader title="回归" subtitle={`${discovery.length} 子系统 · ${history.length} 次运行`}>
        <button
          className="inline-flex cursor-pointer items-center gap-1.5 rounded-lg border border-border px-3.5 py-1.5 text-xs font-medium text-muted-foreground transition-colors hover:border-border/80 hover:bg-card hover:text-foreground disabled:cursor-not-allowed disabled:opacity-40"
          onClick={handleRefresh}
          disabled={discoveryLoading}
          data-testid="reg-refresh-btn"
        >
          <RefreshCw className={cn('size-3', discoveryLoading && 'animate-spin')} />
          刷新
        </button>
      </ViewHeader>

      {discoveryError ? (
        <div
          className="mb-3 rounded-xl border border-border bg-card px-4 py-3 text-xs"
          data-testid="reg-discovery-error"
        >
          <div className="font-medium text-destructive">扫描失败</div>
          <div className="mt-0.5 break-words text-[10px] text-muted-foreground">{discoveryError}</div>
          <button
            className="mt-2 flex cursor-pointer items-center gap-1 rounded px-1.5 py-1 text-[10px] text-primary transition-colors hover:bg-accent"
            onClick={() => currentProjectId && discover(currentProjectId, true)}
            data-testid="reg-retry-btn"
          >
            <RefreshCw className="size-3" />
            重新扫描
          </button>
        </div>
      ) : discoveryLoading && discovery.length === 0 ? (
        <SuiteCardGridSkeleton />
      ) : suites.length === 0 ? (
        <SuiteCardGridEmpty />
      ) : (
        <SuiteCardGrid suites={suites} />
      )}

      <div className="grid grid-cols-[1.6fr_1fr] items-start gap-3">
        <HistoryTable
          entries={sortedHistory}
          loading={historyLoading}
          onOpen={() => open({ type: 'regression-detail' })}
        />
        <FailureClusterPanel />
      </div>
    </div>
  );
}
