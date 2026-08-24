import { useState, useEffect } from 'react';
import { ChevronUp, ChevronDown, GitCompare } from 'lucide-react';
import { useSimulationStore } from '@renderer/stores/simulation';
import { useWorkbenchStore } from '@renderer/stores/workbench';
import { useProjectStore } from '@renderer/stores/project';
import { cn } from '@renderer/lib/utils';
import type { SimulationHistoryEntry } from '@shared/types';
import { StatusBadge } from './StatusBadge';

export function SimulationHistoryView() {
  const history = useSimulationStore((s) => s.history);
  const loadHistory = useSimulationStore((s) => s.loadHistory);
  const compareRuns = useSimulationStore((s) => s.compareRuns);
  const currentProjectId = useProjectStore((s) => s.currentProjectId);
  const openDestination = useWorkbenchStore((s) => s.open);

  const [sortBy, setSortBy] = useState<'time' | 'case' | 'status' | 'duration'>('time');
  const [sortDir, setSortDir] = useState<'asc' | 'desc'>('desc');
  const [compareSelect, setCompareSelect] = useState<string[]>([]);

  // 懒加载：组件挂载或项目切换时加载历史
  useEffect(() => {
    if (currentProjectId) {
      void loadHistory(currentProjectId);
    }
  }, [currentProjectId, loadHistory]);

  if (history.length === 0) {
    return (
      <div className="flex flex-1 items-center justify-center text-xs text-muted-foreground">
        无仿真历史记录
      </div>
    );
  }

  const sorted = [...history].sort((a, b) => {
    let cmp = 0;
    switch (sortBy) {
      case 'time': cmp = a.startTime - b.startTime; break;
      case 'case': cmp = a.caseName.localeCompare(b.caseName); break;
      case 'status': cmp = a.status.localeCompare(b.status); break;
      case 'duration': cmp = a.duration - b.duration; break;
    }
    return sortDir === 'asc' ? cmp : -cmp;
  });

  const toggleSort = (col: typeof sortBy) => {
    if (sortBy === col) {
      setSortDir(sortDir === 'asc' ? 'desc' : 'asc');
    } else {
      setSortBy(col);
      setSortDir('desc');
    }
  };

  const sortIcon = (col: typeof sortBy) => {
    if (sortBy !== col) return null;
    return sortDir === 'asc'
      ? <ChevronUp className="inline h-2.5 w-2.5" />
      : <ChevronDown className="inline h-2.5 w-2.5" />;
  };

  const toggleCompare = (runId: string) => {
    setCompareSelect((prev) => {
      if (prev.includes(runId)) return prev.filter((r) => r !== runId);
      if (prev.length >= 2) return [prev[1], runId];
      return [...prev, runId];
    });
  };

  const openSimErrors = (runId: string) => {
    openDestination({ type: 'simulation-errors', runId });
  };

  const openRunDetail = (runId: string) => {
    openDestination({ type: 'simulation-detail', runId });
  };

  const openCompare = async (runIdA: string, runIdB: string) => {
    if (currentProjectId) {
      await compareRuns(currentProjectId, runIdA, runIdB);
    }
    openDestination({ type: 'simulation-comparison' });
  };

  return (
    <div className="flex flex-1 flex-col overflow-auto">
      <div className="flex items-center justify-between border-b bg-secondary/20 px-3 py-1.5">
        <div>
          <span className="text-xs font-semibold text-foreground">仿真历史</span>
          <span className="ml-2 text-[11px] text-muted-foreground">{history.length} 条记录</span>
        </div>
        {compareSelect.length === 2 && (
          <button
            onClick={() => openCompare(compareSelect[0], compareSelect[1])}
            className="flex items-center gap-1 rounded bg-primary/10 px-2 py-0.5 text-[11px] text-primary hover:bg-primary/20"
          >
            <GitCompare className="h-3 w-3" />
            对比选中
          </button>
        )}
      </div>
      <div className="flex-1 overflow-auto p-2">
        <table className="w-full text-xs">
          <thead>
            <tr className="border-b text-left text-[11px] uppercase text-muted-foreground">
              <th className="px-2 py-1 w-6">
                <input
                  type="checkbox"
                  checked={compareSelect.length === history.length}
                  onChange={(e) => setCompareSelect(e.target.checked ? history.slice(0, 2).map((h) => h.runId) : [])}
                  className="h-2.5 w-2.5"
                  title="选择前两条用于对比"
                />
              </th>
              <th className="cursor-pointer px-2 py-1 hover:text-foreground" onClick={() => toggleSort('case')}>
                用例 {sortIcon('case')}
              </th>
              <th className="px-2 py-1">子系统</th>
              <th className="cursor-pointer px-2 py-1 hover:text-foreground" onClick={() => toggleSort('status')}>
                状态 {sortIcon('status')}
              </th>
              <th className="cursor-pointer px-2 py-1 hover:text-foreground" onClick={() => toggleSort('duration')}>
                耗时 {sortIcon('duration')}
              </th>
              <th className="cursor-pointer px-2 py-1 hover:text-foreground" onClick={() => toggleSort('time')}>
                时间 {sortIcon('time')}
              </th>
              <th className="px-2 py-1">操作</th>
            </tr>
          </thead>
          <tbody>
            {sorted.map((entry: SimulationHistoryEntry) => (
              <tr
                key={entry.runId}
                className={cn(
                  'border-b border-border/30 hover:bg-accent/30 cursor-pointer',
                  compareSelect.includes(entry.runId) && 'bg-primary/5',
                )}
                onClick={() => openRunDetail(entry.runId)}
              >
                <td className="px-2 py-1" onClick={(e) => e.stopPropagation()}>
                  <input
                    type="checkbox"
                    checked={compareSelect.includes(entry.runId)}
                    onChange={() => toggleCompare(entry.runId)}
                    className="h-2.5 w-2.5"
                  />
                </td>
                <td className="px-2 py-1 text-foreground">{entry.caseName}</td>
                <td className="px-2 py-1 text-muted-foreground">{entry.subsys}</td>
                <td className="px-2 py-1">
                  <StatusBadge status={entry.status} />
                </td>
                <td className="px-2 py-1 text-muted-foreground">
                  {entry.duration > 1000
                    ? `${(entry.duration / 1000).toFixed(1)}s`
                    : `${entry.duration}ms`}
                </td>
                <td className="px-2 py-1 text-muted-foreground">
                  {new Date(entry.startTime).toLocaleString()}
                </td>
                <td className="px-2 py-1" onClick={(e) => e.stopPropagation()}>
                  {entry.compileErrors && entry.compileErrors.length > 0 && (
                    <button
                      onClick={() => openSimErrors(entry.runId)}
                      className="rounded bg-status-fail/10 px-1.5 py-0.5 text-[11px] text-status-fail-foreground hover:bg-status-fail/20"
                    >
                      查看错误
                    </button>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
