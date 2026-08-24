/**
 * CoverageImportDialog — 覆盖率导入对话框。
 *
 * 从 CoveragePanel 中提取，供 CoverageView 使用。
 * 提供 cov_merge 目录选择、EDA 工具配置、导入进度展示。
 */
import { useEffect, useState } from 'react';
import { Upload, FolderOpen, Loader2, X, CheckCircle2, Clock } from 'lucide-react';
import { useCoverageCoreStore } from '@renderer/stores/coverage';
import { useProjectStore } from '@renderer/stores/project';
import { cn } from '@renderer/lib/utils';
import type { EdaTool } from '@shared/types';

const EDA_TOOL_OPTIONS: Array<{ value: EdaTool; label: string }> = [
  { value: 'imc', label: 'Cadence IMC' },
  { value: 'vcs-urg', label: 'Synopsys VCS urg' },
  { value: 'vcover', label: 'Mentor Questa vcover' },
  { value: 'unknown', label: '未知/其他' },
];

type CoverageImportDialogProps = {
  /** 对话框是否打开 */
  open: boolean;
  /** 关闭回调 */
  onClose: () => void;
};

export function CoverageImportDialog({ open, onClose }: CoverageImportDialogProps) {
  const currentProjectId = useProjectStore((s) => s.currentProjectId);
const importCoverage = useCoverageCoreStore((s) => s.importCoverage);
const browseDirectory = useCoverageCoreStore((s) => s.browseDirectory);
const importing = useCoverageCoreStore((s) => s.importing);

  // 导入进度
const importProgress = useCoverageCoreStore((s) => s.importProgress);
const importStep = useCoverageCoreStore((s) => s.importStep);
const importStepLog = useCoverageCoreStore((s) => s.importStepLog);
const showImportProgress = useCoverageCoreStore((s) => s.showImportProgress);
const registerImportProgressListener = useCoverageCoreStore((s) => s.registerImportProgressListener);
const clearImportProgress = useCoverageCoreStore((s) => s.clearImportProgress);

  const [covMergeDir, setCovMergeDir] = useState('');
  const [edaTool, setEdaTool] = useState<EdaTool>('imc');
  const [browsing, setBrowsing] = useState(false);

  // 注册 coverage:import-progress IPC 监听器（幂等，全局一次）
  useEffect(() => {
    registerImportProgressListener();
  }, [registerImportProgressListener]);

  // 对话框关闭时清理进度面板
  useEffect(() => {
    if (!open && !importing) {
      clearImportProgress();
    }
  }, [open, importing, clearImportProgress]);

  if (!open) return null;

  const handleImport = async () => {
    if (!currentProjectId || !covMergeDir.trim()) return;
    const sid = await importCoverage(currentProjectId, covMergeDir.trim(), {
      tool: edaTool,
      covMergeDir: covMergeDir.trim(),
    });
    if (sid) {
      onClose();
      setCovMergeDir('');
    }
  };

  const handleBrowse = async () => {
    setBrowsing(true);
    const path = await browseDirectory(covMergeDir.trim() || undefined);
    setBrowsing(false);
    if (path) setCovMergeDir(path);
  };

  return (
    <div className="fixed inset-0 z-[80] flex items-center justify-center bg-black/50" data-testid="cov-import-dialog-overlay">
      <div
        className="w-full max-w-lg rounded-xl border border-border bg-card shadow-2xl"
        data-testid="cov-import-dialog"
      >
        {/* 头部 */}
        <div className="flex items-center gap-2 border-b border-border px-4 py-3">
          <Upload className="size-4 text-primary" />
          <span className="text-sm font-semibold text-foreground">导入覆盖率数据</span>
          <button
            type="button"
            onClick={onClose}
            disabled={importing}
            className="ml-auto grid size-6 place-items-center rounded-md text-muted-foreground transition-colors hover:bg-foreground/10 hover:text-foreground disabled:opacity-50"
            aria-label="关闭"
          >
            <X className="size-3.5" />
          </button>
        </div>

        {/* 内容 */}
        <div className="flex flex-col gap-4 p-4">
          {/* cov_merge 目录 */}
          <div>
            <label className="mb-1.5 block text-xs font-medium text-muted-foreground">
              cov_merge 目录路径
            </label>
            <div className="flex gap-2">
              <input
                type="text"
                value={covMergeDir}
                onChange={(e) => setCovMergeDir(e.target.value)}
                placeholder="例如 cov_merge 或 /abs/path/to/covdb"
                disabled={importing}
                className="min-w-0 flex-1 rounded-md border border-border bg-background px-3 py-1.5 text-xs text-foreground disabled:opacity-50"
              />
              <button
                type="button"
                onClick={handleBrowse}
                disabled={browsing || importing}
                className="flex shrink-0 items-center gap-1.5 rounded-md border border-border bg-card px-3 py-1.5 text-xs transition-colors hover:bg-accent disabled:opacity-50"
                title="浏览选择目录"
              >
                <FolderOpen className="size-3" />
                {browsing ? '...' : '浏览'}
              </button>
            </div>
          </div>

          {/* EDA 工具选择 */}
          <div>
            <label className="mb-1.5 block text-xs font-medium text-muted-foreground">
              EDA 工具
            </label>
            <select
              value={edaTool}
              onChange={(e) => setEdaTool(e.target.value as EdaTool)}
              disabled={importing}
              className="w-full rounded-md border border-border bg-background px-3 py-1.5 text-xs text-foreground disabled:opacity-50"
            >
              {EDA_TOOL_OPTIONS.map((o) => (
                <option key={o.value} value={o.value}>{o.label}</option>
              ))}
            </select>
          </div>

          {/* 导入进度 */}
          {showImportProgress && importing && (
            <div className="rounded-lg border border-primary/40 bg-primary/5 p-3">
              <div className="mb-2 flex items-center justify-between">
                <span className="flex items-center gap-1.5 text-xs font-medium text-primary">
                  <Loader2 className="size-3.5 animate-spin" />
                  {importStep || '正在导入...'}
                </span>
                <span className="font-mono text-xs text-primary">{importProgress}%</span>
              </div>
              {/* 进度条 */}
              <div className="h-2 w-full overflow-hidden rounded-full bg-secondary">
                <div
                  className="h-full rounded-full bg-primary transition-all duration-300 ease-out"
                  style={{ width: `${importProgress}%` }}
                />
              </div>
              {/* 步骤日志 */}
              {importStepLog.length > 0 && (
                <div className="mt-2 max-h-32 overflow-auto rounded bg-muted/50 p-2">
                  {importStepLog.map((entry, i) => (
                    <div key={i} className="flex items-start gap-1.5 py-0.5 text-[10px]">
                      {entry.step === 'done' ? (
                        <CheckCircle2 className="mt-0.5 size-3 shrink-0 text-primary" />
                      ) : (
                        <Clock className="mt-0.5 size-3 shrink-0 text-muted-foreground" />
                      )}
                      <span className="text-muted-foreground">
                        {new Date(entry.timestamp).toLocaleTimeString()}
                      </span>
                      <span className="flex-1 break-all">{entry.message}</span>
                      {entry.durationMs !== undefined && (
                        <span className="font-mono text-muted-foreground">{entry.durationMs}ms</span>
                      )}
                    </div>
                  ))}
                </div>
              )}
            </div>
          )}

          {/* 操作按钮 */}
          <div className="flex justify-end gap-2">
            <button
              type="button"
              onClick={onClose}
              disabled={importing}
              className="rounded-md border border-border px-3 py-1.5 text-xs transition-colors hover:bg-accent disabled:opacity-50"
            >
              取消
            </button>
            <button
              type="button"
              onClick={handleImport}
              disabled={!covMergeDir.trim() || importing}
              className={cn(
                'rounded-md bg-primary px-3 py-1.5 text-xs font-medium text-primary-foreground transition-colors',
                'hover:opacity-90 disabled:opacity-50',
              )}
            >
              {importing ? '导入中...' : '导入'}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
