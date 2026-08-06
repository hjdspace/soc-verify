/**
 * SingleRepoUpdateDialog — single repo update to master dialog.
 *
 * Ported from the Python `git_manager` plugin's `update_dialog.py` SingleRepoUpdateDialog.
 * Performs: git fetch origin → git checkout master → git pull origin master.
 */

import { useState, useCallback, useRef, useEffect } from 'react';
import { X, Play, AlertCircle } from 'lucide-react';
import { trpc } from '@renderer/lib/trpc';
import type { GitRepoInfo } from './RepoCard';

type SingleRepoUpdateDialogProps = {
  repo: GitRepoInfo;
  onClose: () => void;
  onComplete?: () => void;
};

export function SingleRepoUpdateDialog({ repo, onClose, onComplete }: SingleRepoUpdateDialogProps) {
  const [logs, setLogs] = useState<string[]>([]);
  const [running, setRunning] = useState(false);
  const [success, setSuccess] = useState<boolean | null>(null);
  const [summary, setSummary] = useState('');
  const logRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (logRef.current) {
      logRef.current.scrollTop = logRef.current.scrollHeight;
    }
  }, [logs]);

  const startUpdate = useCallback(async () => {
    setRunning(true);
    setLogs([]);
    setSuccess(null);
    setSummary('');

    try {
      const res = await trpc.tools.gitManager.updateRepoToMaster.mutate({
        repo: { name: repo.name, path: repo.path, repoType: repo.repoType },
      });
      setLogs(res.logs as string[]);
      setSuccess(res.success as boolean);
      setSummary(res.summary as string);
    } catch (err) {
      setLogs([`❌ 更新失败: ${err instanceof Error ? err.message : String(err)}`]);
      setSuccess(false);
      setSummary(err instanceof Error ? err.message : String(err));
    } finally {
      setRunning(false);
      if (onComplete) onComplete();
    }
  }, [repo, onComplete]);

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50" onClick={running ? undefined : onClose}>
      <div
        className="flex max-h-[80vh] w-[700px] flex-col rounded-lg border border-border bg-background shadow-2xl"
        onClick={(e) => e.stopPropagation()}
      >
        {/* Header */}
        <div className="flex items-center justify-between border-b border-border px-4 py-3">
          <span className="text-sm font-bold">更新仓库到master最新版本</span>
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
          <div className="text-xs font-bold">{repo.name}</div>
          <div className="mt-1 flex items-start gap-2 text-xs text-muted-foreground">
            <AlertCircle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
            <span>
              此操作将把仓库更新到master分支的最新版本。
              <br />
              操作步骤: 1. git fetch origin → 2. checkout master → 3. git pull origin master
            </span>
          </div>
          <div className="mt-1 truncate text-[10px] font-mono text-muted-foreground/70" title={repo.path}>
            {repo.path}
          </div>
        </div>

        {/* Log display */}
        <div className="flex min-h-[250px] flex-1 flex-col p-3">
          <div className="mb-2 flex items-center justify-between">
            <span className="text-xs font-semibold">执行日志:</span>
            {running && (
              <span className="flex items-center gap-1 text-xs text-yellow-600 dark:text-yellow-400">
                <span className="h-2 w-2 animate-pulse rounded-full bg-yellow-500" />
                执行中...
              </span>
            )}
          </div>

          <div
            ref={logRef}
            className="min-h-[180px] flex-1 overflow-auto rounded border border-zinc-700 bg-zinc-900 p-2"
          >
            {logs.length === 0 ? (
              <div className="flex h-full items-center justify-center text-xs text-zinc-500">
                {running ? '等待输出...' : '点击"开始更新"执行操作'}
              </div>
            ) : (
              <pre className="whitespace-pre-wrap font-mono text-[11px] leading-relaxed">
                {logs.map((line, i) => {
                  let color = '#d4d4d4';
                  if (line.startsWith('✅')) color = '#4ade80';
                  else if (line.startsWith('❌')) color = '#f87171';
                  else if (line.startsWith('='.repeat(10))) color = '#666666';
                  return (
                    <div key={i} style={{ color }}>
                      {line}
                    </div>
                  );
                })}
              </pre>
            )}
          </div>

          {/* Result summary */}
          {success !== null && (
            <div
              className={`mt-2 rounded border p-2 text-xs ${
                success
                  ? 'border-green-500/30 bg-green-500/5 text-green-600 dark:text-green-400'
                  : 'border-red-500/30 bg-red-500/5 text-red-600 dark:text-red-400'
              }`}
            >
              {success ? '🎉' : '❌'} {summary}
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
              className="flex items-center gap-1 rounded bg-green-600 px-4 py-1.5 text-xs font-bold text-white hover:bg-green-700 disabled:opacity-50"
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
