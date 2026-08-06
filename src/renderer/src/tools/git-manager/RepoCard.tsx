/**
 * RepoCard — repository information card component.
 *
 * Ported from the Python `git_manager` plugin's `repo_card.py`.
 * Displays repo name, tag, subsys tag, branch, last commit, status.
 * Left-click: open tag selection. Right-click: context menu.
 */

import { useState, useCallback, useRef, useEffect } from 'react';
import { GitBranch, Tag, MoreVertical, RefreshCw, Download, Layers } from 'lucide-react';
import { cn } from '@renderer/lib/utils';

export type GitRepoInfo = {
  name: string;
  path: string;
  repoType: 'de' | 'dv';
  currentBranch: string;
  currentTag: string;
  lastCommitHash: string;
  lastCommitMessage: string;
  lastCommitTime: string;
  hasChanges: boolean;
  tags: string[];
  subsysTag: string | null;
};

type RepoCardProps = {
  repo: GitRepoInfo;
  onClick: (repo: GitRepoInfo) => void;
  onRefresh: (repo: GitRepoInfo) => void;
  onUpdateToMaster: (repo: GitRepoInfo) => void;
  onSubsysUpdate?: (repo: GitRepoInfo) => void;
  isRefreshing?: boolean;
};

export function RepoCard({
  repo,
  onClick,
  onRefresh,
  onUpdateToMaster,
  onSubsysUpdate,
  isRefreshing,
}: RepoCardProps) {
  const [showMenu, setShowMenu] = useState(false);
  const menuRef = useRef<HTMLDivElement>(null);

  const isSysRepo = (() => {
    const name = repo.name.replace('udtb/', '');
    return name.endsWith('_sys');
  })();

  const closeMenu = useCallback(() => setShowMenu(false), []);

  useEffect(() => {
    if (!showMenu) return;
    const handleClick = (e: MouseEvent) => {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) {
        setShowMenu(false);
      }
    };
    document.addEventListener('mousedown', handleClick);
    return () => document.removeEventListener('mousedown', handleClick);
  }, [showMenu]);

  const handleContextMenu = useCallback((e: React.MouseEvent) => {
    e.preventDefault();
    setShowMenu(true);
  }, []);

  return (
    <div
      className={cn(
        'relative cursor-pointer rounded-lg border p-3 transition-colors',
        repo.repoType === 'de'
          ? 'border-blue-500/30 bg-blue-500/5 hover:border-blue-500/60 hover:bg-blue-500/10'
          : 'border-green-500/30 bg-green-500/5 hover:border-green-500/60 hover:bg-green-500/10',
        isRefreshing && 'border-yellow-500/60 bg-yellow-500/5',
      )}
      onClick={() => onClick(repo)}
      onContextMenu={handleContextMenu}
      title="左键点击: 选择标签 | 右键点击: 显示菜单"
    >
      {/* Header: name + type badge */}
      <div className="flex items-center gap-1.5">
        <span
          className={cn(
            'rounded px-1.5 py-0.5 text-[10px] font-bold',
            repo.repoType === 'de'
              ? 'bg-blue-500/15 text-blue-600 dark:text-blue-400'
              : 'bg-green-500/15 text-green-600 dark:text-green-400',
          )}
        >
          {repo.repoType.toUpperCase()}
        </span>
        <span className="truncate text-xs font-bold" title={repo.name}>
          {repo.name}
        </span>
        <button
          className="ml-auto rounded p-0.5 hover:bg-foreground/10"
          onClick={(e) => {
            e.stopPropagation();
            setShowMenu((v) => !v);
          }}
        >
          <MoreVertical className="h-3.5 w-3.5 text-muted-foreground" />
        </button>
      </div>

      {/* Separator */}
      <div className="my-1.5 border-t border-border/50" />

      {/* Tag */}
      <div className="flex items-center gap-1 text-[10px]">
        <Tag className="h-3 w-3 shrink-0 text-muted-foreground" />
        <span className="font-semibold text-muted-foreground">Tag:</span>
        <span
          className="truncate font-medium text-blue-600 dark:text-blue-400"
          title={repo.currentTag}
        >
          {repo.currentTag}
        </span>
      </div>

      {/* Subsys tag (only for xxx_sys repos) */}
      {isSysRepo && repo.subsysTag && (
        <div className="flex items-center gap-1 text-[10px]">
          <Layers className="h-3 w-3 shrink-0 text-muted-foreground" />
          <span className="font-semibold text-muted-foreground">Subsys:</span>
          <span
            className="truncate font-medium text-purple-600 dark:text-purple-400"
            title={repo.subsysTag}
          >
            {repo.subsysTag}
          </span>
        </div>
      )}

      {/* Branch */}
      <div className="flex items-center gap-1 text-[10px]">
        <GitBranch className="h-3 w-3 shrink-0 text-muted-foreground" />
        <span className="font-semibold text-muted-foreground">Branch:</span>
        <span className="truncate text-muted-foreground" title={repo.currentBranch}>
          {repo.currentBranch}
        </span>
      </div>

      {/* Last commit */}
      <div className="mt-1 text-[10px]">
        <div className="truncate text-muted-foreground" title={repo.lastCommitMessage}>
          <span className="font-mono text-muted-foreground">{repo.lastCommitHash}</span>{' '}
          {repo.lastCommitMessage}
        </div>
        <div className="text-muted-foreground/70">{repo.lastCommitTime}</div>
      </div>

      {/* Status indicator */}
      <div className="mt-1.5 flex items-center justify-end gap-1">
        <span
          className={cn(
            'h-2 w-2 rounded-full',
            repo.hasChanges ? 'bg-orange-500' : 'bg-green-500',
          )}
        />
        <span
          className={cn(
            'text-[10px] font-medium',
            repo.hasChanges ? 'text-orange-600 dark:text-orange-400' : 'text-green-600 dark:text-green-400',
          )}
        >
          {repo.hasChanges ? 'Modified' : 'Clean'}
        </span>
      </div>

      {/* Context menu */}
      {showMenu && (
        <div
          ref={menuRef}
          className="absolute right-0 top-full z-50 mt-1 min-w-[160px] rounded-lg border border-border bg-popover p-1 shadow-lg"
          onClick={(e) => e.stopPropagation()}
        >
          <button
            className="flex w-full items-center gap-2 rounded px-2 py-1.5 text-xs hover:bg-accent"
            onClick={(e) => {
              e.stopPropagation();
              setShowMenu(false);
              onRefresh(repo);
            }}
          >
            <RefreshCw className="h-3 w-3" />
            刷新仓库信息
          </button>

          {onSubsysUpdate && isSysRepo && (
            <button
              className="flex w-full items-center gap-2 rounded px-2 py-1.5 text-xs hover:bg-accent"
              onClick={(e) => {
                e.stopPropagation();
                setShowMenu(false);
                onSubsysUpdate(repo);
              }}
            >
              <Layers className="h-3 w-3" />
              更新 {repo.name.replace('udtb/', '').replace('_sys', '')} subsys
            </button>
          )}

          <div className="my-1 border-t border-border/50" />

          {(repo.currentBranch !== 'master' || repo.hasChanges) && (
            <button
              className="flex w-full items-center gap-2 rounded px-2 py-1.5 text-xs hover:bg-accent"
              onClick={(e) => {
                e.stopPropagation();
                setShowMenu(false);
                onUpdateToMaster(repo);
              }}
            >
              <Download className="h-3 w-3" />
              更新到Master最新
            </button>
          )}
        </div>
      )}
    </div>
  );
}
