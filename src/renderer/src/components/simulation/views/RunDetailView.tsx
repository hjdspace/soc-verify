import { useEffect } from 'react';
import { useSimulationStore } from '@renderer/stores/simulation';
import { useWorkbenchStore } from '@renderer/stores/workbench';
import { useProjectStore } from '@renderer/stores/project';
import { cn } from '@renderer/lib/utils';
import { StatusBadge } from './StatusBadge';

export function RunDetailView() {
  const detailRun = useSimulationStore((s) => s.detailRun);
  const loading = useSimulationStore((s) => s.loadingDetail);
  const loadRunDetail = useSimulationStore((s) => s.loadRunDetail);
  const currentProjectId = useProjectStore((s) => s.currentProjectId);
  const openDestination = useWorkbenchStore((s) => s.open);

  // 获取当前 active tab 的 destination 来提取 runId
  const activeTabId = useWorkbenchStore((s) => s.activeTabId);
  const tabs = useWorkbenchStore((s) => s.tabs);
  const activeTab = tabs.find((t) => t.id === activeTabId) ?? null;
  const runId = activeTab?.destination?.type === 'simulation-detail' ? activeTab.destination.runId : null;

  useEffect(() => {
    if (currentProjectId && runId) {
      void loadRunDetail(currentProjectId, runId);
    }
  }, [currentProjectId, runId, loadRunDetail]);

  if (loading) {
    return (
      <div className="flex flex-1 items-center justify-center text-xs text-muted-foreground">
        加载中...
      </div>
    );
  }

  if (!detailRun) {
    return (
      <div className="flex flex-1 items-center justify-center text-xs text-muted-foreground">
        无运行详情
      </div>
    );
  }

  const openSimErrors = (runId: string) => {
    openDestination({ type: 'simulation-errors', runId });
  };

  return (
    <div className="flex flex-1 flex-col overflow-auto">
      <div className="border-b bg-secondary/20 px-3 py-1.5">
        <span className="text-xs font-semibold text-foreground">运行详情 — {detailRun.runId.slice(-6)}</span>
      </div>
      <div className="flex-1 overflow-auto p-3">
        {/* Basic info */}
        <div className="mb-4 grid grid-cols-2 gap-2 text-xs">
          <div className="rounded border border-border/50 bg-secondary/20 px-3 py-2">
            <span className="text-[11px] uppercase text-muted-foreground">用例</span>
            <div className="mt-0.5 font-medium text-foreground">{detailRun.caseName}</div>
          </div>
          <div className="rounded border border-border/50 bg-secondary/20 px-3 py-2">
            <span className="text-[11px] uppercase text-muted-foreground">子系统</span>
            <div className="mt-0.5 font-medium text-foreground">{detailRun.subsys}</div>
          </div>
          <div className="rounded border border-border/50 bg-secondary/20 px-3 py-2">
            <span className="text-[11px] uppercase text-muted-foreground">状态</span>
            <div className="mt-0.5">
              <StatusBadge status={detailRun.status} />
            </div>
          </div>
          <div className="rounded border border-border/50 bg-secondary/20 px-3 py-2">
            <span className="text-[11px] uppercase text-muted-foreground">耗时</span>
            <div className="mt-0.5 font-medium text-foreground">
              {detailRun.duration > 1000
                ? `${(detailRun.duration / 1000).toFixed(1)}s`
                : `${detailRun.duration}ms`}
            </div>
          </div>
          <div className="rounded border border-border/50 bg-secondary/20 px-3 py-2">
            <span className="text-[11px] uppercase text-muted-foreground">开始时间</span>
            <div className="mt-0.5 text-foreground">{new Date(detailRun.startTime).toLocaleString()}</div>
          </div>
          <div className="rounded border border-border/50 bg-secondary/20 px-3 py-2">
            <span className="text-[11px] uppercase text-muted-foreground">结束时间</span>
            <div className="mt-0.5 text-foreground">{new Date(detailRun.endTime).toLocaleString()}</div>
          </div>
        </div>

        {/* Options */}
        <div className="mb-4">
          <div className="mb-1 text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">仿真选项</div>
          <div className="rounded border border-border/50 bg-secondary/20 p-2">
            {Object.keys(detailRun.options).length === 0 ? (
              <span className="text-[11px] text-muted-foreground">无选项</span>
            ) : (
              <div className="grid grid-cols-2 gap-1 text-xs">
                {Object.entries(detailRun.options).map(([key, value]) => (
                  <div key={key} className="flex justify-between">
                    <span className="text-muted-foreground">{key}:</span>
                    <span className="font-mono text-foreground">{String(value)}</span>
                  </div>
                ))}
              </div>
            )}
          </div>
        </div>

        {/* Compile errors */}
        {detailRun.compileErrors && detailRun.compileErrors.length > 0 && (
          <div className="mb-4">
            <div className="mb-1 flex items-center justify-between">
              <span className="text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">
                编译错误 ({detailRun.compileErrors.length})
              </span>
              <button
                onClick={() => openSimErrors(detailRun.runId)}
                className="rounded bg-status-fail/10 px-1.5 py-0.5 text-[11px] text-status-fail-foreground hover:bg-status-fail/20"
              >
                查看全部
              </button>
            </div>
            <div className="space-y-1">
              {detailRun.compileErrors.slice(0, 5).map((err, i) => (
                <div
                  key={i}
                  className={cn(
                    'rounded border p-2 text-xs',
                    err.severity === 'error'
                      ? 'border-status-fail/30 bg-status-fail/5'
                      : 'border-status-pending/30 bg-status-pending/5',
                  )}
                >
                  <span className="font-medium text-foreground">{err.file}:{err.line}</span>
                  <span className="ml-2 text-muted-foreground">{err.message}</span>
                </div>
              ))}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
