/**
 * TagDialog — tag selection and checkout dialog.
 *
 * Ported from the Python `git_manager` plugin's `tag_dialog.py`.
 * Features: tag list with search filter, tag checkout with log display.
 */

import { useState, useCallback, useRef, useEffect } from 'react';
import { Tag, Search, X, GitBranch } from 'lucide-react';
import { trpc } from '@renderer/lib/trpc';
import { cn } from '@renderer/lib/utils';
import type { GitRepoInfo } from './RepoCard';

type TagDialogProps = {
  repo: GitRepoInfo;
  projectDir: string;
  onClose: () => void;
  onCheckoutSuccess?: () => void;
};

export function TagDialog({ repo, projectDir, onClose, onCheckoutSuccess }: TagDialogProps) {
  const [tags, setTags] = useState<string[]>([]);
  const [selectedTag, setSelectedTag] = useState('');
  const [searchText, setSearchText] = useState('');
  const [loading, setLoading] = useState(true);
  const [checkingOut, setCheckingOut] = useState(false);
  const [logs, setLogs] = useState<string[]>([]);
  const [showLog, setShowLog] = useState(false);
  const logRef = useRef<HTMLDivElement>(null);

  // Load tags on mount
  useEffect(() => {
    let cancelled = false;
    (async () => {
      setLoading(true);
      try {
        const res = await trpc.tools.gitManager.getRepoTags.query({
          repo: { name: repo.name, path: repo.path, repoType: repo.repoType },
          projectDir,
        });
        if (!cancelled) {
          setTags(res.tags as string[]);
        }
      } catch {
        if (!cancelled) {
          setTags([]);
        }
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [repo, projectDir]);

  // Auto-scroll log to bottom
  useEffect(() => {
    if (logRef.current) {
      logRef.current.scrollTop = logRef.current.scrollHeight;
    }
  }, [logs]);

  const filteredTags = tags.filter((t) =>
    searchText ? t.toLowerCase().includes(searchText.toLowerCase()) : true,
  );

  const handleCheckout = useCallback(async () => {
    if (!selectedTag) return;
    setCheckingOut(true);
    setShowLog(true);
    setLogs([]);

    try {
      const res = await trpc.tools.gitManager.checkoutTag.mutate({
        repo: { name: repo.name, path: repo.path, repoType: repo.repoType },
        tag: selectedTag,
        projectDir,
      });
      setLogs(res.logs as string[]);
      const success = (res.logs as string[]).some((l) => l.includes('successfully'));
      if (success && onCheckoutSuccess) {
        onCheckoutSuccess();
      }
    } catch (err) {
      setLogs([`Error: ${err instanceof Error ? err.message : String(err)}`]);
    } finally {
      setCheckingOut(false);
    }
  }, [selectedTag, repo, projectDir, onCheckoutSuccess]);

  const hasNoTag = tags.length === 0 && !loading;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50" onClick={onClose}>
      <div
        className="flex max-h-[80vh] w-[600px] flex-col rounded-lg border border-border bg-background shadow-2xl"
        onClick={(e) => e.stopPropagation()}
      >
        {/* Header */}
        <div className="flex items-center justify-between border-b border-border px-4 py-3">
          <div className="flex items-center gap-2">
            <Tag className="h-4 w-4 text-primary" />
            <span className="text-sm font-bold">{repo.name}</span>
          </div>
          <button
            className="rounded p-1 hover:bg-foreground/10"
            onClick={onClose}
          >
            <X className="h-4 w-4" />
          </button>
        </div>

        {/* Repo info */}
        <div className="border-b border-border bg-muted/30 px-4 py-2 text-xs">
          <div className="flex items-center gap-2">
            <span className="text-muted-foreground">路径:</span>
            <span className="truncate font-mono" title={repo.path}>{repo.path}</span>
          </div>
          <div className="flex items-center gap-2">
            <span className="text-muted-foreground">当前标签:</span>
            <span className="font-medium text-blue-600 dark:text-blue-400">{repo.currentTag}</span>
          </div>
          {repo.subsysTag && (
            <div className="flex items-center gap-2">
              <span className="text-muted-foreground">Subsys:</span>
              <span className="font-medium text-purple-600 dark:text-purple-400">{repo.subsysTag}</span>
            </div>
          )}
        </div>

        {/* Tag list or Log */}
        {!showLog ? (
          <div className="flex min-h-[300px] flex-1 flex-col p-3">
            {/* Search */}
            <div className="flex items-center gap-2 rounded border border-border px-2 py-1.5">
              <Search className="h-3.5 w-3.5 text-muted-foreground" />
              <input
                type="text"
                value={searchText}
                onChange={(e) => setSearchText(e.target.value)}
                placeholder="搜索标签..."
                className="flex-1 bg-transparent text-xs outline-none"
                autoFocus
              />
            </div>

            {/* Tags */}
            <div className="mt-2 min-h-[200px] flex-1 overflow-auto rounded border border-border">
              {loading ? (
                <div className="flex h-full items-center justify-center text-xs text-muted-foreground">
                  加载标签中...
                </div>
              ) : hasNoTag ? (
                <div className="flex h-full items-center justify-center text-xs text-muted-foreground">
                  未找到标签
                </div>
              ) : (
                filteredTags.map((tag) => (
                  <div
                    key={tag}
                    onClick={() => setSelectedTag(tag)}
                    onDoubleClick={handleCheckout}
                    className={cn(
                      'cursor-pointer truncate px-3 py-1.5 text-xs hover:bg-accent/50',
                      selectedTag === tag && 'bg-primary/10 font-medium text-primary',
                    )}
                    title={tag}
                  >
                    {tag}
                  </div>
                ))
              )}
            </div>

            {/* Actions */}
            <div className="mt-2 flex justify-end gap-2">
              <button
                onClick={onClose}
                className="rounded border border-border px-3 py-1.5 text-xs hover:bg-accent"
              >
                关闭
              </button>
              <button
                onClick={handleCheckout}
                disabled={!selectedTag || checkingOut}
                className="flex items-center gap-1 rounded bg-primary px-3 py-1.5 text-xs font-medium text-primary-foreground disabled:opacity-50"
              >
                <GitBranch className="h-3 w-3" />
                {checkingOut ? '切换中...' : '切换到选定标签'}
              </button>
            </div>
          </div>
        ) : (
          <div className="flex min-h-[300px] flex-1 flex-col p-3">
            {/* Log title */}
            <div className="mb-2 flex items-center justify-between">
              <span className="text-xs font-semibold">执行日志:</span>
              {checkingOut && (
                <span className="flex items-center gap-1 text-xs text-yellow-600 dark:text-yellow-400">
                  <span className="h-2 w-2 animate-pulse rounded-full bg-yellow-500" />
                  执行中...
                </span>
              )}
            </div>

            {/* Log content */}
            <div
              ref={logRef}
              className="min-h-[200px] flex-1 overflow-auto rounded border border-zinc-700 bg-zinc-900 p-2"
            >
              <pre className="whitespace-pre-wrap font-mono text-[11px] leading-relaxed">
                {logs.length === 0 && checkingOut ? (
                  <span className="text-zinc-500">等待输出...</span>
                ) : (
                  logs.map((line, i) => {
                    let color = '#d4d4d4';
                    if (line.startsWith('✅') || line.includes('successfully')) color = '#4ade80';
                    else if (line.startsWith('⚠️')) color = '#facc15';
                    else if (line.startsWith('❌') || line.includes('failed')) color = '#f87171';
                    else if (line.startsWith('='.repeat(10)) || line.startsWith('-'.repeat(10))) color = '#666666';
                    else if (line.startsWith('[')) color = '#8ab4f8';
                    return (
                      <div key={i} style={{ color }}>
                        {line}
                      </div>
                    );
                  })
                )}
              </pre>
            </div>

            {/* Actions */}
            <div className="mt-2 flex justify-end gap-2">
              <button
                onClick={() => setShowLog(false)}
                disabled={checkingOut}
                className="rounded border border-border px-3 py-1.5 text-xs hover:bg-accent disabled:opacity-50"
              >
                返回标签列表
              </button>
              <button
                onClick={onClose}
                className="rounded bg-primary px-3 py-1.5 text-xs font-medium text-primary-foreground"
              >
                关闭
              </button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
