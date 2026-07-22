/**
 * ExportDialog — 覆盖率报告导出对话框（Slice 7 / Issue #9）。
 *
 * 提供：
 *   - 格式选择：HTML（独立可打开文件）/ JSON（结构化数据）
 *   - 范围选择：当前 session / 两个 session 对比（Before 固定为当前 session）
 *   - 保存路径：原生保存对话框选择 + 手动输入
 *   - 异步导出：执行期间禁用按钮，完成后 toast 通知
 *
 * 布局与 TriageDialog 一致：fixed 全屏遮罩 + 居中卡片。
 * 使用语义色 class（bg-card / text-foreground / border-border / bg-primary 等）。
 */
import { Download, FileCode, FileJson, FolderOpen, Loader2 } from 'lucide-react';
import { useCoverageStore } from '@renderer/stores/coverage';
import { useProjectStore } from '@renderer/stores/project';
import { cn } from '@renderer/lib/utils';

export function ExportDialog() {
  const open = useCoverageStore((s) => s.exportDialogOpen);
  const format = useCoverageStore((s) => s.exportFormat);
  const scope = useCoverageStore((s) => s.exportScope);
  const compareSessionId = useCoverageStore((s) => s.exportCompareSessionId);
  const outputPath = useCoverageStore((s) => s.exportOutputPath);
  const exporting = useCoverageStore((s) => s.exporting);
  const sessions = useCoverageStore((s) => s.sessions);
  const currentSessionId = useCoverageStore((s) => s.currentSessionId);

  const closeExportDialog = useCoverageStore((s) => s.closeExportDialog);
  const setExportFormat = useCoverageStore((s) => s.setExportFormat);
  const setExportScope = useCoverageStore((s) => s.setExportScope);
  const setExportCompareSessionId = useCoverageStore((s) => s.setExportCompareSessionId);
  const setExportOutputPath = useCoverageStore((s) => s.setExportOutputPath);
  const pickExportPath = useCoverageStore((s) => s.pickExportPath);
  const runExport = useCoverageStore((s) => s.runExport);

  const currentProjectId = useProjectStore((s) => s.currentProjectId);

  if (!open) return null;

  // 对比范围可选的 After session（排除当前 session）
  const compareOptions = sessions.filter((s) => s.sessionId !== currentSessionId);

  // 导出按钮可用条件
  const canExport = outputPath.trim() !== '' && !exporting && (
    scope === 'current'
      ? !!currentSessionId
      : !!currentSessionId && !!compareSessionId && currentSessionId !== compareSessionId
  );

  const handleExport = async () => {
    if (!currentProjectId) return;
    await runExport(currentProjectId);
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40">
      <div className="w-[440px] rounded border border-border bg-card p-4 shadow-lg">
        <div className="mb-3 flex items-center gap-2 text-sm font-medium">
          <Download className="h-4 w-4 text-primary" />
          导出覆盖率报告
        </div>

        {/* 格式选择 */}
        <div className="mb-3">
          <div className="mb-1.5 text-[10px] text-muted-foreground">导出格式</div>
          <div className="flex gap-2">
            <button
              onClick={() => setExportFormat('html')}
              data-testid="export-format-html"
              className={cn(
                'flex flex-1 items-center gap-2 rounded border px-3 py-2 text-xs',
                format === 'html'
                  ? 'border-primary bg-primary/10 text-primary'
                  : 'border-border bg-background text-muted-foreground hover:bg-secondary',
              )}
            >
              <FileCode className="h-4 w-4" />
              <span className="flex flex-col items-start">
                <span className="font-medium">HTML</span>
                <span className="text-[9px] text-muted-foreground">独立可打开，内联样式</span>
              </span>
            </button>
            <button
              onClick={() => setExportFormat('json')}
              data-testid="export-format-json"
              className={cn(
                'flex flex-1 items-center gap-2 rounded border px-3 py-2 text-xs',
                format === 'json'
                  ? 'border-primary bg-primary/10 text-primary'
                  : 'border-border bg-background text-muted-foreground hover:bg-secondary',
              )}
            >
              <FileJson className="h-4 w-4" />
              <span className="flex flex-col items-start">
                <span className="font-medium">JSON</span>
                <span className="text-[9px] text-muted-foreground">结构化数据，含 Gap/Delta</span>
              </span>
            </button>
          </div>
        </div>

        {/* 范围选择 */}
        <div className="mb-3">
          <div className="mb-1.5 text-[10px] text-muted-foreground">导出范围</div>
          <div className="flex gap-2">
            <button
              onClick={() => setExportScope('current')}
              data-testid="export-scope-current"
              className={cn(
                'flex-1 rounded border px-3 py-1.5 text-xs',
                scope === 'current'
                  ? 'border-primary bg-primary/10 text-primary'
                  : 'border-border bg-background text-muted-foreground hover:bg-secondary',
              )}
            >
              当前 Session
            </button>
            <button
              onClick={() => setExportScope('compare')}
              data-testid="export-scope-compare"
              className={cn(
                'flex-1 rounded border px-3 py-1.5 text-xs',
                scope === 'compare'
                  ? 'border-primary bg-primary/10 text-primary'
                  : 'border-border bg-background text-muted-foreground hover:bg-secondary',
              )}
            >
              对比（Before → After）
            </button>
          </div>
        </div>

        {/* 对比范围：After session 选择 */}
        {scope === 'compare' && (
          <div className="mb-3">
            <div className="mb-1.5 text-[10px] text-muted-foreground">
              Before（当前 Session）: <span className="font-mono text-foreground">{currentSessionId ?? '未选择'}</span>
            </div>
            <label className="block text-[10px] text-muted-foreground">
              After Session
              <select
                value={compareSessionId ?? ''}
                onChange={(e) => setExportCompareSessionId(e.target.value || null)}
                className="mt-1 w-full rounded border border-border bg-background px-2 py-1 text-xs"
                data-testid="export-compare-session"
              >
                <option value="">— 选择 —</option>
                {compareOptions.map((s) => (
                  <option key={s.sessionId} value={s.sessionId}>
                    {s.sessionId} ({s.edaTool})
                  </option>
                ))}
              </select>
            </label>
            {compareOptions.length === 0 && (
              <div className="mt-1 text-[10px] text-muted-foreground">
                当前只有一个 session，无法进行对比导出。请先导入第二个 session。
              </div>
            )}
          </div>
        )}

        {/* 保存路径 */}
        <div className="mb-4">
          <div className="mb-1.5 text-[10px] text-muted-foreground">保存路径</div>
          <div className="flex gap-2">
            <input
              type="text"
              value={outputPath}
              onChange={(e) => setExportOutputPath(e.target.value)}
              placeholder="选择或输入导出文件路径"
              className="flex-1 rounded border border-border bg-background px-2 py-1 text-xs font-mono"
              data-testid="export-output-path"
            />
            <button
              onClick={() => void pickExportPath()}
              className="flex items-center gap-1 rounded border border-border bg-secondary px-2 py-1 text-xs hover:bg-secondary/80"
              data-testid="export-pick-path"
            >
              <FolderOpen className="h-3 w-3" />
              浏览
            </button>
          </div>
        </div>

        {/* 操作按钮 */}
        <div className="flex justify-end gap-2">
          <button
            onClick={closeExportDialog}
            disabled={exporting}
            className="rounded border border-border px-3 py-1.5 text-xs hover:bg-secondary disabled:opacity-50"
          >
            取消
          </button>
          <button
            onClick={() => void handleExport()}
            disabled={!canExport}
            className="flex items-center gap-1.5 rounded bg-primary px-3 py-1.5 text-xs text-primary-foreground disabled:opacity-50"
            data-testid="export-run"
          >
            {exporting ? (
              <>
                <Loader2 className="h-3 w-3 animate-spin" />
                导出中...
              </>
            ) : (
              <>
                <Download className="h-3 w-3" />
                导出
              </>
            )}
          </button>
        </div>
      </div>
    </div>
  );
}
