import { useEffect, useState } from 'react';
import { CheckCircle2, Clock, XCircle, FileDown, RefreshCw } from 'lucide-react';
import { useTOChecklistStore } from '@renderer/stores/to-checklist';
import { useProjectStore } from '@renderer/stores/project';
import { cn } from '@renderer/lib/utils';
import type { TOChecklistItem } from '@shared/types';

const CATEGORY_LABELS: Record<string, string> = {
  coverage: '覆盖率',
  regression: '回归测试',
  signoff: '签核',
};

export function TOChecklistPanel() {
  const items = useTOChecklistStore((s) => s.items);
  const loading = useTOChecklistStore((s) => s.loading);
  const loadChecklist = useTOChecklistStore((s) => s.loadChecklist);
  const updateItem = useTOChecklistStore((s) => s.updateItem);
  const exportReport = useTOChecklistStore((s) => s.exportReport);

  const currentProjectId = useProjectStore((s) => s.currentProjectId);
  const currentProject = useProjectStore((s) =>
    s.projects.find((p) => p.id === s.currentProjectId),
  );
  const [exportPath, setExportPath] = useState('');

  useEffect(() => {
    if (currentProjectId) {
      loadChecklist(currentProjectId);
    }
  }, [currentProjectId, loadChecklist]);

  const handleToggleStatus = (item: TOChecklistItem) => {
    if (!currentProjectId) return;
    const next: TOChecklistItem['status'] = item.status === 'pass' ? 'pending' : item.status === 'pending' ? 'blocked' : 'pass';
    updateItem(currentProjectId, item.id, { status: next });
  };

  const handleExport = () => {
    if (!currentProjectId || !exportPath.trim()) return;
    const path = exportPath.trim().includes('.') ? exportPath.trim() : `${exportPath.trim()}/to-report.html`;
    exportReport(currentProjectId, path);
    setExportPath('');
  };

  // Group items by category
  const grouped = items.reduce<Record<string, TOChecklistItem[]>>((acc, item) => {
    if (!acc[item.category]) acc[item.category] = [];
    acc[item.category].push(item);
    return acc;
  }, {});

  // Overall readiness
  const passed = items.filter((i) => i.status === 'pass').length;
  const readiness = items.length > 0 ? (passed / items.length) * 100 : 0;

  if (loading && items.length === 0) {
    return (
      <div className="flex flex-1 items-center justify-center text-xs text-muted-foreground">
        加载 TO 检查清单...
      </div>
    );
  }

  return (
    <div className="flex-1 overflow-auto p-3">
      {/* Header */}
      <div className="mb-3 flex items-center justify-between">
        <div>
          <span className="text-xs font-semibold">TO 检查清单</span>
          <span className="ml-2 text-[10px] text-muted-foreground">{passed}/{items.length} 通过</span>
        </div>
        <div className="flex items-center gap-1">
          <button
            onClick={() => currentProjectId && loadChecklist(currentProjectId)}
            className="rounded p-1 text-muted-foreground hover:bg-accent hover:text-foreground"
          >
            <RefreshCw className={cn('h-3.5 w-3.5', loading && 'animate-spin')} />
          </button>
        </div>
      </div>

      {/* Readiness bar */}
      <div className="mb-4">
        <div className="mb-1 flex justify-between text-[10px] text-muted-foreground">
          <span>TO 就绪度</span>
          <span className={cn('font-mono font-semibold', readiness >= 80 ? 'text-status-pass-foreground' : readiness >= 50 ? 'text-warning-foreground' : 'text-status-fail-foreground')}>
            {readiness.toFixed(0)}%
          </span>
        </div>
        <div className="h-3 overflow-hidden rounded-full bg-muted">
          <div
            className={cn('h-full rounded-full transition-all', readiness >= 80 ? 'bg-status-pass-foreground' : readiness >= 50 ? 'bg-warning-foreground' : 'bg-status-fail-foreground')}
            style={{ width: `${readiness}%` }}
          />
        </div>
      </div>

      {/* Checklist items grouped by category */}
      <div className="space-y-3">
        {Object.entries(grouped).map(([category, catItems]) => (
          <div key={category}>
            <div className="mb-1.5 text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">
              {CATEGORY_LABELS[category] ?? category}
            </div>
            <div className="space-y-1">
              {catItems.map((item) => (
                <ChecklistRow key={item.id} item={item} onToggle={() => handleToggleStatus(item)} />
              ))}
            </div>
          </div>
        ))}
      </div>

      {/* Export */}
      <div className="mt-4 rounded-md border border-border/50 bg-secondary/20 p-2">
        <div className="mb-1 text-[10px] font-semibold text-muted-foreground">导出报告</div>
        <div className="flex gap-1">
          <input
            type="text"
            value={exportPath}
            onChange={(e) => setExportPath(e.target.value)}
            placeholder={currentProject ? `${currentProject.rootPath}/to-report.html` : '输出路径'}
            className="flex-1 rounded border border-border bg-background px-2 py-1 text-xs outline-none focus:ring-1 focus:ring-primary"
          />
          <button
            onClick={handleExport}
            disabled={!currentProjectId || !exportPath.trim()}
            className="flex items-center gap-1 rounded bg-primary/10 px-2 py-1 text-[10px] text-primary hover:bg-primary/20 disabled:opacity-30"
          >
            <FileDown className="h-3 w-3" />
            导出
          </button>
        </div>
      </div>
    </div>
  );
}

function ChecklistRow({ item, onToggle }: { item: TOChecklistItem; onToggle: () => void }) {
  const statusIcon = {
    pass: <CheckCircle2 className="h-4 w-4 text-status-pass-foreground" />,
    pending: <Clock className="h-4 w-4 text-warning-foreground" />,
    blocked: <XCircle className="h-4 w-4 text-status-fail-foreground" />,
  };

  return (
    <div className="flex items-start gap-2 rounded-md border border-border/40 bg-background/50 px-2 py-1.5">
      <button onClick={onToggle} className="mt-0.5 shrink-0">
        {statusIcon[item.status]}
      </button>
      <div className="flex-1 min-w-0">
        <div className="text-xs font-medium text-foreground">{item.name}</div>
        <div className="text-[10px] text-muted-foreground">{item.description}</div>
        {item.autoEvaluated && item.threshold != null && (
          <div className="mt-0.5 flex items-center gap-2 text-[9px] text-muted-foreground">
            <span>阈值: {item.threshold}%</span>
            {item.actualValue != null && (
              <span className={cn('font-mono', item.actualValue >= item.threshold ? 'text-status-pass-foreground' : 'text-status-fail-foreground')}>
                实际: {item.actualValue.toFixed(1)}%
              </span>
            )}
          </div>
        )}
        {item.details && (
          <div className="mt-0.5 text-[9px] text-muted-foreground/70">{item.details}</div>
        )}
      </div>
      {item.autoEvaluated && (
        <span className="rounded bg-primary/10 px-1 py-0.5 text-[8px] text-primary">自动</span>
      )}
    </div>
  );
}
