import { useEffect } from 'react';
import { Check, GitCommitHorizontal, GitBranch, Loader2, RefreshCw, Sparkles } from 'lucide-react';
import { useProjectStore } from '@renderer/stores/project';
import { useSessionStore } from '@renderer/stores/session';
import { useSourceControlStore } from '@renderer/stores/source-control';
import { cn } from '@renderer/lib/utils';
import type { SourceControlFileStatus } from '@shared/types';

function statusLabel(file: SourceControlFileStatus): string {
  if (file.indexStatus === '?' && file.workTreeStatus === '?') return '新增';
  if (file.indexStatus === 'D' || file.workTreeStatus === 'D') return '删除';
  if (file.indexStatus === 'R' || file.workTreeStatus === 'R') return '重命名';
  if (file.indexStatus === 'A') return '新增';
  if (file.indexStatus === 'M' || file.workTreeStatus === 'M') return '修改';
  return `${file.indexStatus}${file.workTreeStatus}`.trim() || '变更';
}

function statusTone(file: SourceControlFileStatus): string {
  if (file.indexStatus === '?' && file.workTreeStatus === '?') return 'bg-info/10 text-info-foreground';
  if (file.indexStatus === 'D' || file.workTreeStatus === 'D') return 'bg-status-fail/10 text-status-fail-foreground';
  if (file.indexStatus === 'R' || file.workTreeStatus === 'R') return 'bg-violet/10 text-violet-foreground';
  return 'bg-warning/10 text-warning-foreground';
}

export function SourceControlPanel() {
  const currentProjectId = useProjectStore((s) => s.currentProjectId);
  const currentProject = useProjectStore((s) => s.projects.find((p) => p.id === s.currentProjectId));
  const lastModel = useSessionStore((s) => s.lastModel);
  const status = useSourceControlStore((s) => s.status);
  const commitMessage = useSourceControlStore((s) => s.commitMessage);
  const loading = useSourceControlStore((s) => s.loading);
  const generating = useSourceControlStore((s) => s.generating);
  const committing = useSourceControlStore((s) => s.committing);
  const loadStatus = useSourceControlStore((s) => s.loadStatus);
  const setCommitMessage = useSourceControlStore((s) => s.setCommitMessage);
  const generateCommitMessage = useSourceControlStore((s) => s.generateCommitMessage);
  const commitAll = useSourceControlStore((s) => s.commitAll);

  useEffect(() => {
    if (currentProjectId) {
      void loadStatus(currentProjectId);
    }
  }, [currentProjectId, loadStatus]);

  if (!currentProjectId || !currentProject) {
    return (
      <div className="flex flex-1 items-center justify-center text-xs text-muted-foreground">
        请先打开项目
      </div>
    );
  }

  if (loading && !status) {
    return (
      <div className="flex flex-1 items-center justify-center gap-2 text-xs text-muted-foreground">
        <Loader2 className="h-4 w-4 animate-spin" />
        加载 Git 状态...
      </div>
    );
  }

  if (status && !status.isRepository) {
    return (
      <div className="flex flex-1 flex-col items-center justify-center gap-2 text-xs text-muted-foreground">
        <GitBranch className="h-8 w-8 opacity-50" />
        <div>{currentProject.name} 不是 Git 仓库</div>
      </div>
    );
  }

  const files = status?.files ?? [];
  const hasChanges = files.length > 0;
  const canCommit = hasChanges && commitMessage.trim().length > 0 && !committing;

  return (
    <div className="flex flex-1 flex-col overflow-hidden">
      <div className="flex items-center justify-between border-b bg-secondary/20 px-3 py-2">
        <div className="min-w-0">
          <div className="flex items-center gap-2 text-xs font-semibold text-foreground">
            <GitBranch className="h-3.5 w-3.5 text-muted-foreground" />
            <span>{status?.branch ?? 'HEAD'}</span>
            {status && (status.ahead > 0 || status.behind > 0) && (
              <span className="text-[10px] font-normal text-muted-foreground">
                ahead {status.ahead} / behind {status.behind}
              </span>
            )}
          </div>
          <div className="mt-0.5 truncate text-[10px] text-muted-foreground">{currentProject.rootPath}</div>
        </div>
        <button
          onClick={() => void loadStatus(currentProjectId)}
          title="刷新"
          className="rounded p-1 text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
        >
          <RefreshCw className={cn('h-3.5 w-3.5', loading && 'animate-spin')} />
        </button>
      </div>

      <div className="flex flex-1 overflow-hidden">
        <div className="flex min-w-0 flex-1 flex-col overflow-hidden border-r border-border/50">
          <div className="flex items-center justify-between border-b border-border/50 px-3 py-1.5">
            <span className="text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">
              变更文件
            </span>
            <span className="rounded bg-secondary px-1.5 py-0.5 text-[10px] text-muted-foreground">
              {files.length}
            </span>
          </div>
          {hasChanges ? (
            <div className="flex-1 overflow-auto p-2">
              {files.map((file) => (
                <div
                  key={`${file.path}:${file.indexStatus}:${file.workTreeStatus}`}
                  className="mb-1 flex items-center gap-2 rounded border border-border/50 bg-background/50 px-2 py-1.5 text-xs"
                >
                  <span className={cn('w-12 shrink-0 rounded px-1 py-0.5 text-center text-[10px]', statusTone(file))}>
                    {statusLabel(file)}
                  </span>
                  <div className="min-w-0 flex-1">
                    <div className="truncate font-mono text-foreground">{file.path}</div>
                    {file.originalPath && (
                      <div className="truncate font-mono text-[10px] text-muted-foreground">
                        from {file.originalPath}
                      </div>
                    )}
                  </div>
                  <span className="font-mono text-[10px] text-muted-foreground">
                    {file.indexStatus}{file.workTreeStatus}
                  </span>
                </div>
              ))}
            </div>
          ) : (
            <div className="flex flex-1 items-center justify-center gap-2 text-xs text-muted-foreground">
              <Check className="h-4 w-4 text-status-pass-foreground" />
              工作区干净
            </div>
          )}
        </div>

        <div className="flex w-80 shrink-0 flex-col p-3">
          <div className="mb-2 text-xs font-semibold">提交全部变更</div>
          <textarea
            value={commitMessage}
            onChange={(event) => setCommitMessage(event.target.value)}
            placeholder="提交信息"
            className="min-h-28 resize-none rounded-md border border-border bg-background px-2 py-2 text-xs outline-none focus:ring-1 focus:ring-primary"
          />
          <div className="mt-2 flex gap-2">
            <button
              onClick={() => void generateCommitMessage(currentProjectId, lastModel?.id)}
              disabled={!hasChanges || generating || committing}
              className="flex flex-1 items-center justify-center gap-1 rounded-md border border-border px-2 py-1.5 text-xs transition-colors hover:bg-accent disabled:opacity-40"
            >
              {generating ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Sparkles className="h-3.5 w-3.5" />}
              AI 生成
            </button>
            <button
              onClick={() => void commitAll(currentProjectId)}
              disabled={!canCommit}
              className="flex flex-1 items-center justify-center gap-1 rounded-md bg-primary px-2 py-1.5 text-xs text-primary-foreground transition-colors hover:bg-primary/90 disabled:opacity-40"
            >
              {committing ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <GitCommitHorizontal className="h-3.5 w-3.5" />}
              提交全部变更
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
