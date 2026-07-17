import { useEffect, useState } from 'react';
import { Play, Plus, Trash2, Edit3, History, GitCompare, Loader2, ChevronDown, ChevronUp } from 'lucide-react';
import { useRegressionStore } from '@renderer/stores/regression';
import { useProjectStore } from '@renderer/stores/project';
import { cn } from '@renderer/lib/utils';
import type { RegressionSuite, RegressionResult } from '@shared/types';

export function RegressionPanel() {
  const suites = useRegressionStore((s) => s.suites);
  const loading = useRegressionStore((s) => s.loading);
  const loadSuites = useRegressionStore((s) => s.loadSuites);
  const createSuite = useRegressionStore((s) => s.createSuite);
  const deleteSuite = useRegressionStore((s) => s.deleteSuite);
  const runSuite = useRegressionStore((s) => s.runSuite);
  const history = useRegressionStore((s) => s.history);
  const loadHistory = useRegressionStore((s) => s.loadHistory);
  const compareResult = useRegressionStore((s) => s.compareResult);
  const compareRuns = useRegressionStore((s) => s.compareRuns);

  const currentProjectId = useProjectStore((s) => s.currentProjectId);
  const [showCreate, setShowCreate] = useState(false);
  const [newName, setNewName] = useState('');
  const [newCaseIds, setNewCaseIds] = useState('');
  const [expandedSuite, setExpandedSuite] = useState<string | null>(null);
  const [compareSelect, setCompareSelect] = useState<string[]>([]);

  useEffect(() => {
    if (currentProjectId) {
      loadSuites(currentProjectId);
      loadHistory(currentProjectId);
    }
  }, [currentProjectId, loadSuites, loadHistory]);

  const handleCreate = async () => {
    if (!currentProjectId || !newName.trim()) return;
    const caseIds = newCaseIds.split('\n').map((s) => s.trim()).filter(Boolean);
    await createSuite(currentProjectId, newName.trim(), caseIds, {});
    setNewName('');
    setNewCaseIds('');
    setShowCreate(false);
  };

  const handleCompare = async () => {
    if (compareSelect.length !== 2 || !currentProjectId) return;
    await compareRuns(currentProjectId, compareSelect[0], compareSelect[1]);
  };

  return (
    <div className="flex flex-1 flex-col overflow-auto p-3">
      {/* Header */}
      <div className="mb-3 flex items-center justify-between">
        <div>
          <span className="text-xs font-semibold text-foreground">回归套件管理</span>
          <span className="ml-2 text-[10px] text-muted-foreground">{suites.length} 个套件</span>
        </div>
        <button
          onClick={() => setShowCreate(!showCreate)}
          className="flex items-center gap-1 rounded bg-primary/10 px-2 py-1 text-[10px] text-primary hover:bg-primary/20"
        >
          <Plus className="h-3 w-3" />
          新建套件
        </button>
      </div>

      {/* Create form */}
      {showCreate && (
        <div className="mb-3 rounded-md border border-border bg-secondary/20 p-2">
          <input
            type="text"
            value={newName}
            onChange={(e) => setNewName(e.target.value)}
            placeholder="套件名称"
            className="mb-1.5 w-full rounded border border-border bg-background px-2 py-1 text-xs outline-none focus:ring-1 focus:ring-primary"
          />
          <textarea
            value={newCaseIds}
            onChange={(e) => setNewCaseIds(e.target.value)}
            placeholder="用例 ID（每行一个）"
            rows={4}
            className="mb-1.5 w-full rounded border border-border bg-background px-2 py-1 text-xs outline-none focus:ring-1 focus:ring-primary"
          />
          <div className="flex justify-end gap-1">
            <button onClick={() => setShowCreate(false)} className="rounded px-2 py-0.5 text-[10px] text-muted-foreground hover:bg-accent">
              取消
            </button>
            <button onClick={handleCreate} disabled={!newName.trim()} className="rounded bg-primary/10 px-2 py-0.5 text-[10px] text-primary hover:bg-primary/20 disabled:opacity-30">
              创建
            </button>
          </div>
        </div>
      )}

      {/* Suites list */}
      <div className="mb-4 space-y-1.5">
        {suites.length === 0 ? (
          <div className="py-4 text-center text-xs text-muted-foreground">
            暂无回归套件，点击 "新建套件" 创建
          </div>
        ) : (
          suites.map((suite) => (
            <SuiteCard
              key={suite.name}
              suite={suite}
              expanded={expandedSuite === suite.name}
              onToggle={() => setExpandedSuite(expandedSuite === suite.name ? null : suite.name)}
              onRun={() => currentProjectId && runSuite(currentProjectId, suite.name)}
              onDelete={() => currentProjectId && deleteSuite(currentProjectId, suite.name)}
              loading={loading}
            />
          ))
        )}
      </div>

      {/* History */}
      {history.length > 0 && (
        <div>
          <div className="mb-2 flex items-center justify-between">
            <div className="flex items-center gap-1.5">
              <History className="h-3.5 w-3.5 text-muted-foreground" />
              <span className="text-xs font-semibold">运行历史</span>
              <span className="text-[10px] text-muted-foreground">{history.length} 条</span>
            </div>
            {compareSelect.length === 2 && (
              <button
                onClick={handleCompare}
                className="flex items-center gap-1 rounded bg-primary/10 px-2 py-0.5 text-[10px] text-primary hover:bg-primary/20"
              >
                <GitCompare className="h-3 w-3" />
                对比选中
              </button>
            )}
          </div>
          <div className="overflow-hidden rounded-md border border-border/50">
            <table className="w-full text-xs">
              <thead>
                <tr className="border-b bg-secondary/20 text-left text-[10px] uppercase text-muted-foreground">
                  <th className="px-2 py-1 w-6"></th>
                  <th className="px-2 py-1">套件</th>
                  <th className="px-2 py-1">通过/失败</th>
                  <th className="px-2 py-1">通过率</th>
                  <th className="px-2 py-1">时间</th>
                </tr>
              </thead>
              <tbody>
                {history.slice(0, 20).map((h) => {
                  const rate = h.totalCases > 0 ? (h.passed / h.totalCases) * 100 : 0;
                  return (
                    <tr key={h.runId} className="border-b border-border/30 hover:bg-accent/20">
                      <td className="px-2 py-1">
                        <input
                          type="checkbox"
                          checked={compareSelect.includes(h.runId)}
                          onChange={() => {
                            setCompareSelect((prev) => {
                              if (prev.includes(h.runId)) return prev.filter((r) => r !== h.runId);
                              if (prev.length >= 2) return [prev[1], h.runId];
                              return [...prev, h.runId];
                            });
                          }}
                          className="h-2.5 w-2.5"
                        />
                      </td>
                      <td className="px-2 py-1 text-foreground">{h.suiteName}</td>
                      <td className="px-2 py-1">
                        <span className="text-status-pass-foreground">{h.passed}</span>
                        <span className="text-muted-foreground"> / </span>
                        <span className="text-status-fail-foreground">{h.failed}</span>
                        <span className="text-muted-foreground"> / {h.totalCases}</span>
                      </td>
                      <td className="px-2 py-1">
                        <span className={cn('font-mono', rate >= 80 ? 'text-status-pass-foreground' : rate >= 50 ? 'text-warning-foreground' : 'text-status-fail-foreground')}>
                          {rate.toFixed(1)}%
                        </span>
                      </td>
                      <td className="px-2 py-1 text-muted-foreground">{new Date(h.timestamp).toLocaleString()}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {/* Comparison result */}
      {compareResult && (
        <div className="mt-3">
          <div className="mb-1 text-[10px] font-semibold uppercase text-muted-foreground">对比结果</div>
          {compareResult.newFailures.length > 0 && (
            <div className="mb-2">
              <div className="text-[10px] text-status-fail-foreground">新增失败 ({compareResult.newFailures.length})</div>
              <div className="flex flex-wrap gap-1">
                {compareResult.newFailures.map((f) => (
                  <span key={f.caseId} className="rounded bg-status-fail/10 px-1.5 py-0.5 text-[10px] text-status-fail-foreground">{f.caseName}</span>
                ))}
              </div>
            </div>
          )}
          {compareResult.fixed.length > 0 && (
            <div className="mb-2">
              <div className="text-[10px] text-status-pass-foreground">已修复 ({compareResult.fixed.length})</div>
              <div className="flex flex-wrap gap-1">
                {compareResult.fixed.map((f) => (
                  <span key={f.caseId} className="rounded bg-status-pass/10 px-1.5 py-0.5 text-[10px] text-status-pass-foreground">{f.caseName}</span>
                ))}
              </div>
            </div>
          )}
          {compareResult.newFailures.length === 0 && compareResult.fixed.length === 0 && (
            <p className="text-[10px] text-muted-foreground">无差异</p>
          )}
        </div>
      )}
    </div>
  );
}

function SuiteCard({
  suite,
  expanded,
  onToggle,
  onRun,
  onDelete,
  loading,
}: {
  suite: RegressionSuite;
  expanded: boolean;
  onToggle: () => void;
  onRun: () => void;
  onDelete: () => void;
  loading: boolean;
}) {
  return (
    <div className="rounded-md border border-border/50 bg-secondary/20">
      <div className="flex items-center justify-between px-2 py-1.5">
        <button onClick={onToggle} className="flex flex-1 items-center gap-1.5 text-left">
          {expanded ? <ChevronUp className="h-3 w-3 text-muted-foreground" /> : <ChevronDown className="h-3 w-3 text-muted-foreground" />}
          <span className="text-xs font-medium text-foreground">{suite.name}</span>
          <span className="rounded-full bg-muted px-1.5 py-0.5 text-[9px] text-muted-foreground">{suite.caseIds.length} 用例</span>
        </button>
        <div className="flex items-center gap-0.5">
          <button
            onClick={onRun}
            disabled={loading}
            title="运行"
            className="rounded p-1 text-primary hover:bg-primary/10 disabled:opacity-30"
          >
            {loading ? <Loader2 className="h-3 w-3 animate-spin" /> : <Play className="h-3 w-3" />}
          </button>
          <button
            onClick={onDelete}
            title="删除"
            className="rounded p-1 text-destructive hover:bg-destructive/10"
          >
            <Trash2 className="h-3 w-3" />
          </button>
        </div>
      </div>
      {expanded && (
        <div className="border-t border-border/30 px-2 py-1.5">
          <div className="text-[10px] text-muted-foreground mb-1">用例列表</div>
          <div className="flex flex-wrap gap-1">
            {suite.caseIds.map((id) => (
              <span key={id} className="rounded bg-background px-1.5 py-0.5 text-[10px] font-mono text-muted-foreground">
                {id}
              </span>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
