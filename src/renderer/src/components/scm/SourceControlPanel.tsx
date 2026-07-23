import { useEffect, useState } from 'react';
import {
  Check,
  GitCommitHorizontal,
  GitBranch,
  Loader2,
  RefreshCw,
  Sparkles,
  Plus,
  Minus,
  Undo2,
  ChevronDown,
  ChevronRight,
} from 'lucide-react';
import { useProjectStore } from '@renderer/stores/project';
import { useSessionStore } from '@renderer/stores/session';
import { useSourceControlStore } from '@renderer/stores/source-control';
import { cn } from '@renderer/lib/utils';
import type { SourceControlFileStatus } from '@shared/types';

// ── helpers ──────────────────────────────────────────────────────

function statusLabel(file: SourceControlFileStatus): string {
  if (file.indexStatus === '?' && file.workTreeStatus === '?') return 'U';
  if (file.indexStatus === 'D' || file.workTreeStatus === 'D') return 'D';
  if (file.indexStatus === 'R' || file.workTreeStatus === 'R') return 'R';
  if (file.indexStatus === 'A') return 'A';
  if (file.indexStatus === 'M' || file.workTreeStatus === 'M') return 'M';
  return `${file.indexStatus}${file.workTreeStatus}`.trim() || '?';
}

function statusTone(file: SourceControlFileStatus): string {
  if (file.indexStatus === '?' && file.workTreeStatus === '?') return 'text-info-foreground';
  if (file.indexStatus === 'D' || file.workTreeStatus === 'D') return 'text-status-fail-foreground';
  if (file.indexStatus === 'R' || file.workTreeStatus === 'R') return 'text-violet-foreground';
  return 'text-warning-foreground';
}

function statusTooltip(file: SourceControlFileStatus): string {
  if (file.indexStatus === '?' && file.workTreeStatus === '?') return '未跟踪';
  if (file.indexStatus === 'D' || file.workTreeStatus === 'D') return '已删除';
  if (file.indexStatus === 'R' || file.workTreeStatus === 'R') return '已重命名';
  if (file.indexStatus === 'A') return '已新增';
  if (file.indexStatus === 'M' || file.workTreeStatus === 'M') return '已修改';
  return '变更';
}

// ── file row ─────────────────────────────────────────────────────

interface FileRowProps {
  file: SourceControlFileStatus;
  onStage?: (path: string) => void;
  onUnstage?: (path: string) => void;
  onDiscard?: (path: string) => void;
  disabled: boolean;
}

function FileRow({ file, onStage, onUnstage, onDiscard, disabled }: FileRowProps) {
  const [hovered, setHovered] = useState(false);

  return (
    <div
      className="group mb-0.5 flex items-center gap-1.5 rounded px-1.5 py-1 text-xs transition-colors hover:bg-accent/40"
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
    >
      <span
        className={cn('w-4 shrink-0 text-center text-[10px] font-bold', statusTone(file))}
        title={statusTooltip(file)}
      >
        {statusLabel(file)}
      </span>
      <div className="min-w-0 flex-1">
        <div className="truncate font-mono text-foreground">{file.path}</div>
        {file.originalPath && (
          <div className="truncate font-mono text-[10px] text-muted-foreground">
            ← {file.originalPath}
          </div>
        )}
      </div>
      {/* Action buttons — visible on hover */}
      <div className={cn('flex shrink-0 items-center gap-0.5', !hovered && 'opacity-0')}>
        {onStage && (
          <button
            onClick={() => onStage(file.path)}
            disabled={disabled}
            title="暂存"
            className="rounded p-0.5 text-muted-foreground transition-colors hover:bg-accent hover:text-foreground disabled:opacity-30"
          >
            <Plus className="h-3.5 w-3.5" />
          </button>
        )}
        {onUnstage && (
          <button
            onClick={() => onUnstage(file.path)}
            disabled={disabled}
            title="取消暂存"
            className="rounded p-0.5 text-muted-foreground transition-colors hover:bg-accent hover:text-foreground disabled:opacity-30"
          >
            <Minus className="h-3.5 w-3.5" />
          </button>
        )}
        {onDiscard && (
          <button
            onClick={() => onDiscard(file.path)}
            disabled={disabled}
            title="放弃更改"
            className="rounded p-0.5 text-muted-foreground transition-colors hover:bg-destructive/20 hover:text-destructive disabled:opacity-30"
          >
            <Undo2 className="h-3.5 w-3.5" />
          </button>
        )}
      </div>
    </div>
  );
}

// ── collapsible section ──────────────────────────────────────────

interface SectionProps {
  title: string;
  count: number;
  collapsed: boolean;
  onToggle: () => void;
  actionLabel?: string;
  onAction?: () => void;
  actionDisabled?: boolean;
  children: React.ReactNode;
}

function Section({ title, count, collapsed, onToggle, actionLabel, onAction, actionDisabled, children }: SectionProps) {
  return (
    <div className={cn('flex flex-col', collapsed && 'shrink-0')}>
      <div className="flex shrink-0 items-center gap-1 px-1.5 py-1 text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">
        <button
          onClick={onToggle}
          className="flex items-center gap-1 transition-colors hover:text-foreground"
        >
          {collapsed ? <ChevronRight className="h-3 w-3" /> : <ChevronDown className="h-3 w-3" />}
          <span>{title}</span>
        </button>
        <span className="rounded bg-secondary px-1.5 py-0.5 text-[10px] text-muted-foreground">{count}</span>
        {actionLabel && onAction && (
          <button
            onClick={onAction}
            disabled={actionDisabled}
            className="ml-auto rounded px-1.5 py-0.5 text-[10px] font-normal normal-case tracking-normal text-muted-foreground transition-colors hover:bg-accent hover:text-foreground disabled:opacity-30"
          >
            {actionLabel}
          </button>
        )}
      </div>
      {!collapsed && (
        <div className="px-1 pb-1">{children}</div>
      )}
    </div>
  );
}

// ── main panel ───────────────────────────────────────────────────

export function SourceControlPanel() {
  const currentProjectId = useProjectStore((s) => s.currentProjectId);
  const currentProject = useProjectStore((s) => s.projects.find((p) => p.id === s.currentProjectId));
  const lastModel = useSessionStore((s) => s.lastModel);
  const status = useSourceControlStore((s) => s.status);
  const commitMessage = useSourceControlStore((s) => s.commitMessage);
  const loading = useSourceControlStore((s) => s.loading);
  const generating = useSourceControlStore((s) => s.generating);
  const committing = useSourceControlStore((s) => s.committing);
  const staging = useSourceControlStore((s) => s.staging);
  const loadStatus = useSourceControlStore((s) => s.loadStatus);
  const setCommitMessage = useSourceControlStore((s) => s.setCommitMessage);
  const generateCommitMessage = useSourceControlStore((s) => s.generateCommitMessage);
  const stageFiles = useSourceControlStore((s) => s.stageFiles);
  const unstageFiles = useSourceControlStore((s) => s.unstageFiles);
  const discardChanges = useSourceControlStore((s) => s.discardChanges);
  const commit = useSourceControlStore((s) => s.commit);

  const scmModelId = lastModel?.id;
  const scmProviderId = lastModel?.providerId;

  const [stagedCollapsed, setStagedCollapsed] = useState(false);
  const [changesCollapsed, setChangesCollapsed] = useState(false);

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

  const allFiles = status?.files ?? [];
  const stagedFiles = allFiles.filter((f) => f.staged);
  const unstagedFiles = allFiles.filter((f) => !f.staged || f.unstaged);
  const hasStaged = stagedFiles.length > 0;
  const hasChanges = allFiles.length > 0;
  const canCommit = hasStaged && commitMessage.trim().length > 0 && !committing;
  const busy = staging || committing || generating;

  const handleStage = (path: string) => void stageFiles(currentProjectId, [path]);
  const handleUnstage = (path: string) => void unstageFiles(currentProjectId, [path]);
  const handleDiscard = (path: string) => void discardChanges(currentProjectId, [path]);
  const handleStageAll = () => void stageFiles(currentProjectId, []);
  const handleUnstageAll = () => void unstageFiles(currentProjectId, []);

  return (
    <div className="flex flex-1 flex-col overflow-hidden">
      {/* ── Header ──────────────────────────────────────────── */}
      <div className="flex items-center justify-between border-b bg-secondary/20 px-3 py-2">
        <div className="min-w-0">
          <div className="flex items-center gap-2 text-xs font-semibold text-foreground">
            <GitBranch className="h-3.5 w-3.5 text-muted-foreground" />
            <span>{status?.branch ?? 'HEAD'}</span>
            {status && (status.ahead > 0 || status.behind > 0) && (
              <span className="text-[10px] font-normal text-muted-foreground">
                ↑{status.ahead} ↓{status.behind}
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

      {/* ── File lists ─────────────────────────────────────── */}
      <div className="flex flex-1 flex-col overflow-auto">
        {hasChanges ? (
          <>
            {/* Staged section */}
            <Section
              title="已暂存的更改"
              count={stagedFiles.length}
              collapsed={stagedCollapsed}
              onToggle={() => setStagedCollapsed(!stagedCollapsed)}
              actionLabel={hasStaged ? '全部取消暂存' : undefined}
              onAction={hasStaged ? handleUnstageAll : undefined}
              actionDisabled={busy}
            >
              {hasStaged ? (
                stagedFiles.map((file) => (
                  <FileRow
                    key={`staged:${file.path}`}
                    file={file}
                    onUnstage={handleUnstage}
                    disabled={busy}
                  />
                ))
              ) : (
                <div className="px-2 py-1 text-[11px] text-muted-foreground">
                  暂无已暂存的更改
                </div>
              )}
            </Section>

            {/* Unstaged section */}
            <Section
              title="更改"
              count={unstagedFiles.length}
              collapsed={changesCollapsed}
              onToggle={() => setChangesCollapsed(!changesCollapsed)}
              actionLabel={unstagedFiles.length > 0 ? '全部暂存' : undefined}
              onAction={unstagedFiles.length > 0 ? handleStageAll : undefined}
              actionDisabled={busy}
            >
              {unstagedFiles.length > 0 ? (
                unstagedFiles.map((file) => (
                  <FileRow
                    key={`unstaged:${file.path}`}
                    file={file}
                    onStage={handleStage}
                    onDiscard={handleDiscard}
                    disabled={busy}
                  />
                ))
              ) : (
                <div className="px-2 py-1 text-[11px] text-muted-foreground">
                  工作区干净
                </div>
              )}
            </Section>
          </>
        ) : (
          <div className="flex flex-1 items-center justify-center gap-2 text-xs text-muted-foreground">
            <Check className="h-4 w-4 text-status-pass-foreground" />
            工作区干净
          </div>
        )}
      </div>

      {/* ── Commit area ────────────────────────────────────── */}
      <div className="shrink-0 border-t p-3">
        <textarea
          value={commitMessage}
          onChange={(event) => setCommitMessage(event.target.value)}
          placeholder="提交信息（支持 Conventional Commits 格式）"
          className="min-h-20 w-full resize-none rounded-md border border-border bg-background px-2 py-2 text-xs outline-none focus:ring-1 focus:ring-primary"
        />
        <div className="mt-2 flex gap-2">
          <button
            onClick={() => void generateCommitMessage(currentProjectId, scmModelId, scmProviderId)}
            disabled={!hasChanges || generating || committing}
            className="flex flex-1 items-center justify-center gap-1 rounded-md border border-border px-2 py-1.5 text-xs transition-colors hover:bg-accent disabled:opacity-40"
          >
            {generating ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Sparkles className="h-3.5 w-3.5" />}
            AI 生成
          </button>
          <button
            onClick={() => void commit(currentProjectId)}
            disabled={!canCommit}
            className="flex flex-1 items-center justify-center gap-1 rounded-md bg-primary px-2 py-1.5 text-xs text-primary-foreground transition-colors hover:bg-primary/90 disabled:opacity-40"
          >
            {committing ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <GitCommitHorizontal className="h-3.5 w-3.5" />}
            提交
          </button>
        </div>
        {!hasStaged && hasChanges && (
          <p className="mt-1.5 text-[10px] text-muted-foreground">
            请先暂存要提交的更改
          </p>
        )}
      </div>
    </div>
  );
}
