/**
 * UpdateDialog — batch environment update dialog.
 *
 * Ported from the Python `git_manager` plugin's `update_dialog_enhanced.py`.
 * Supports DV/DE/subsys batch git pull with log display.
 */

import { useState, useCallback, useRef, useEffect } from 'react';
import { X, Play, AlertCircle } from 'lucide-react';
import { trpc } from '@renderer/lib/trpc';
import { cn } from '@renderer/lib/utils';

type UpdateDialogProps = {
  projectDir: string;
  repoType: 'de' | 'dv';
  subsysName?: string;
  onClose: () => void;
  onComplete?: () => void;
};

export function UpdateDialog({
  projectDir,
  repoType,
  subsysName,
  onClose,
  onComplete,
}: UpdateDialogProps) {
  const [logs, setLogs] = useState<string[]>([]);
  const [running, setRunning] = useState(false);
  const [stats, setStats] = useState<{ total: number; success: number; failed: Array<{ name: string; reason: string }> } | null>(null);
  const [confirmed, setConfirmed] = useState(false);
  const logRef = useRef<HTMLDivElement>(null);

  const envName = repoType.toUpperCase();

  // Auto-scroll log to bottom
  useEffect(() => {
    if (logRef.current) {
      logRef.current.scrollTop = logRef.current.scrollHeight;
    }
  }, [logs]);

  const startUpdate = useCallback(async () => {
    setRunning(true);
    setLogs([]);
    setStats(null);

    try {
      let res;
      if (subsysName) {
        res = await trpc.tools.gitManager.updateSubsysRepos.mutate({
          projectDir,
          subsysName,
          repoType,
        });
      } else {
        res = await trpc.tools.gitManager.updateAllRepos.mutate({
          projectDir,
          repoType,
        });
      }
      setLogs(res.logs as string[]);
      setStats(res.stats as { total: number; success: number; failed: Array<{ name: string; reason: string }> });
    } catch (err) {
      setLogs([`❌ 更新失败: ${err instanceof Error ? err.message : String(err)}`]);
    } finally {
      setRunning(false);
      if (onComplete) onComplete();
    }
  }, [projectDir, repoType, subsysName, onComplete]);

  const title = subsysName
    ? `${subsysName} Subsys ${envName}仓库批量更新`
    : `${envName}环境Git仓库批量更新`;

  const infoText = subsysName
    ? `此操作将对 ${subsysName} subsys 下的所有${envName}仓库执行 git pull。如果仓库有冲突，git pull 将报错并跳过该仓库。`
    : repoType === 'dv'
      ? '此操作将对所有DV目录下的Git仓库执行 git pull 更新到最新版本。包括 dv/ 目录下的直接仓库和 dv/udtb/ 目录下的所有仓库。如果仓库有冲突，git pull 将报错并跳过该仓库。'
      : '此操作将对所有DE目录下的Git仓库执行 git pull 更新到最新版本。包括所有DE相关的仓库目录。如果仓库有冲突，git pull 将报错并跳过该仓库。';

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50" onClick={running ? undefined : onClose}>
      <div
        className="flex max-h-[85vh] w-[800px] flex-col rounded-lg border border-border bg-background shadow-2xl"
        onClick={(e) => e.stopPropagation()}
      >
        {/* Header */}
        <div className="flex items-center justify-between border-b border-border px-4 py-3">
          <span className="text-sm font-bold">{title}</span>
          <button
            className="rounded p-1 hover:bg-foreground/10 disabled:opacity-50"
            onClick={onClose}
            disabled={running}
          >
            <X className="h-4 w-4" />
          </button>
        </div>

        {/* Info */}
        <div className="border-b border-border bg-muted/30 px-4 py-3">
          <div className="flex items-start gap-2 text-xs text-muted-foreground">
            <AlertCircle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
            <span>{infoText}</span>
          </div>
        </div>

        {/* Log display */}
        <div className="flex min-h-[300px] flex-1 flex-col p-3">
          <div className="mb-2 flex items-center justify-between">
            <span className="text-xs font-semibold">执行日志:</span>
            {running && (
              <span className="flex items-center gap-1 text-xs text-yellow-600 dark:text-yellow-400">
                <span className="h-2 w-2 animate-pulse rounded-full bg-yellow-500" />
                更新中...
              </span>
            )}
          </div>

          <div
            ref={logRef}
            className="min-h-[200px] flex-1 overflow-auto rounded border border-zinc-700 bg-zinc-900 p-2"
          >
            {logs.length === 0 ? (
              <div className="flex h-full items-center justify-center text-xs text-zinc-500">
                {running ? '等待输出...' : '点击"开始更新"执行批量更新'}
              </div>
            ) : (
              <pre className="whitespace-pre-wrap font-mono text-[11px] leading-relaxed">
                {logs.map((line, i) => {
                  let color = '#d4d4d4';
                  if (line.startsWith('✅')) color = '#4ade80';
                  else if (line.startsWith('⚠️')) color = '#facc15';
                  else if (line.startsWith('❌')) color = '#f87171';
                  else if (line.startsWith('='.repeat(10)) || line.startsWith('-'.repeat(10))) color = '#666666';
                  else if (line.startsWith('[')) color = '#8ab4f8';
                  else if (line.startsWith('🎉')) color = '#4ade80';
                  return (
                    <div key={i} style={{ color }}>
                      {line}
                    </div>
                  );
                })}
              </pre>
            )}
          </div>

          {/* Stats summary */}
          {stats && (
            <div className="mt-2 grid grid-cols-3 gap-2">
              <div className="rounded border border-border p-2 text-center">
                <div className="text-lg font-bold">{stats.total}</div>
                <div className="text-[10px] text-muted-foreground">总数</div>
              </div>
              <div className="rounded border border-green-500/30 bg-green-500/5 p-2 text-center">
                <div className="text-lg font-bold text-green-600 dark:text-green-400">{stats.success}</div>
                <div className="text-[10px] text-muted-foreground">成功</div>
              </div>
              <div className="rounded border border-red-500/30 bg-red-500/5 p-2 text-center">
                <div className="text-lg font-bold text-red-600 dark:text-red-400">{stats.failed.length}</div>
                <div className="text-[10px] text-muted-foreground">失败</div>
              </div>
            </div>
          )}

          {/* Actions */}
          <div className="mt-3 flex justify-end gap-2">
            <button
              onClick={onClose}
              disabled={running}
              className="rounded border border-border px-3 py-1.5 text-xs hover:bg-accent disabled:opacity-50"
            >
              关闭
            </button>
            <button
              onClick={startUpdate}
              disabled={running}
              className={cn(
                'flex items-center gap-1 rounded px-4 py-1.5 text-xs font-bold text-white disabled:opacity-50',
                repoType === 'dv' ? 'bg-green-600 hover:bg-green-700' : 'bg-blue-600 hover:bg-blue-700',
              )}
            >
              <Play className="h-3 w-3" />
              {running ? '更新中...' : '开始更新'}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
