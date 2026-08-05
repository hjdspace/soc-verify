/**
 * GitManager — multi-repository management tool.
 *
 * Ported from the Python `git_manager` plugin.
 * Features: discover repos, view repo info cards, tag management,
 * batch update (DV/DE/subsys), real-time log output.
 */

import { useState, useCallback, useRef, useEffect } from 'react';
import { FolderOpen, RefreshCw, GitBranch, Tag, Play } from 'lucide-react';
import { trpc } from '@renderer/lib/trpc';
import type { ToolComponentProps } from '../registry';
import { cn } from '@renderer/lib/utils';

type GitRepoInfo = {
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

type UpdateStats = {
  total: number;
  success: number;
  failed: Array<{ name: string; reason: string }>;
};

export function GitManager({ projectRoot, onProjectRootChange }: ToolComponentProps) {
  const [projectDir, setProjectDir] = useState(projectRoot ?? '');
  const [repos, setRepos] = useState<GitRepoInfo[]>([]);
  const [selectedRepo, setSelectedRepo] = useState<GitRepoInfo | null>(null);
  const [repoTags, setRepoTags] = useState<string[]>([]);
  const [selectedTag, setSelectedTag] = useState('');
  const [discovering, setDiscovering] = useState(false);
  const [updating, setUpdating] = useState(false);
  const [checkingOut, setCheckingOut] = useState(false);
  const [logs, setLogs] = useState<string[]>([]);
  const [updateStats, setUpdateStats] = useState<UpdateStats | null>(null);
  const [status, setStatus] = useState('请选择项目目录');
  const [subsysFilter, setSubsysFilter] = useState('');
  const logRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (projectRoot) setProjectDir(projectRoot);
  }, [projectRoot]);

  useEffect(() => {
    if (logRef.current) {
      logRef.current.scrollTop = logRef.current.scrollHeight;
    }
  }, [logs]);

  const handleBrowse = useCallback(async () => {
    const res = await trpc.tools.selectDirectory.mutate({
      title: '选择项目目录',
      defaultPath: projectDir || undefined,
    });
    if (res.path) {
      setProjectDir(res.path);
      onProjectRootChange(res.path);
    }
  }, [projectDir, onProjectRootChange]);

  const handleDiscover = useCallback(async () => {
    if (!projectDir) {
      setStatus('请先选择项目目录');
      return;
    }

    setDiscovering(true);
    setStatus('正在扫描仓库...');
    setRepos([]);
    setSelectedRepo(null);

    try {
      const res = await trpc.tools.gitManager.discoverRepos.mutate({
        projectDir,
        repoType: 'all',
      });
      setRepos(res.repos as GitRepoInfo[]);
      setStatus(`扫描完成: 找到 ${(res.repos as GitRepoInfo[]).length} 个仓库`);
    } catch (err) {
      setStatus(`扫描失败: ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      setDiscovering(false);
    }
  }, [projectDir]);

  const handleGetTags = useCallback(async (repo: GitRepoInfo) => {
    setSelectedRepo(repo);
    setRepoTags([]);
    setSelectedTag('');

    try {
      const res = await trpc.tools.gitManager.getRepoTags.query({
        repo: { name: repo.name, path: repo.path, repoType: repo.repoType },
        projectDir,
      });
      setRepoTags(res.tags as string[]);
    } catch {
      setRepoTags([]);
    }
  }, [projectDir]);

  const handleCheckoutTag = useCallback(async () => {
    if (!selectedRepo || !selectedTag) return;

    setCheckingOut(true);
    setLogs([]);

    try {
      const res = await trpc.tools.gitManager.checkoutTag.mutate({
        repo: { name: selectedRepo.name, path: selectedRepo.path, repoType: selectedRepo.repoType },
        tag: selectedTag,
        projectDir,
      });
      setLogs(res.logs as string[]);
      setStatus(`标签切换${(res.logs as string[]).some((l) => l.includes('successfully')) ? '成功' : '失败'}`);
    } catch (err) {
      setStatus(`标签切换失败: ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      setCheckingOut(false);
    }
  }, [selectedRepo, selectedTag, projectDir]);

  const handleUpdateAll = useCallback(async (repoType: 'de' | 'dv') => {
    if (!projectDir) return;

    setUpdating(true);
    setLogs([]);
    setUpdateStats(null);
    setStatus(`正在更新${repoType.toUpperCase()}仓库...`);

    try {
      const res = await trpc.tools.gitManager.updateAllRepos.mutate({
        projectDir,
        repoType,
      });
      setLogs(res.logs as string[]);
      setUpdateStats(res.stats as UpdateStats);
      const s = res.stats as UpdateStats;
      setStatus(`更新完成: ${s.success}/${s.total} 成功, ${s.failed.length} 失败`);
    } catch (err) {
      setStatus(`更新失败: ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      setUpdating(false);
    }
  }, [projectDir]);

  const handleUpdateSubsys = useCallback(async () => {
    if (!projectDir || !subsysFilter) return;

    setUpdating(true);
    setLogs([]);
    setUpdateStats(null);
    setStatus(`正在更新 ${subsysFilter} subsys 仓库...`);

    try {
      const res = await trpc.tools.gitManager.updateSubsysRepos.mutate({
        projectDir,
        subsysName: subsysFilter,
        repoType: 'dv',
      });
      setLogs(res.logs as string[]);
      setUpdateStats(res.stats as UpdateStats);
      const s = res.stats as UpdateStats;
      setStatus(`更新完成: ${s.success}/${s.total} 成功, ${s.failed.length} 失败`);
    } catch (err) {
      setStatus(`更新失败: ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      setUpdating(false);
    }
  }, [projectDir, subsysFilter]);

  const filteredRepos = subsysFilter
    ? repos.filter((r) => {
        let name = r.name;
        if (name.startsWith('udtb/')) name = name.substring(5);
        return name.startsWith(`${subsysFilter}_`) || name === `${subsysFilter}_sys`;
      })
    : repos;

  return (
    <div className="flex h-full flex-col gap-3 p-4">
      <input type="hidden" value={projectRoot ?? ''} onChange={(e) => onProjectRootChange(e.target.value)} />

      {/* ── Toolbar ── */}
      <div className="rounded border border-border p-3">
        <div className="flex items-center gap-1">
          <FolderOpen className="h-4 w-4 text-muted-foreground" />
          <input
            type="text"
            value={projectDir}
            onChange={(e) => setProjectDir(e.target.value)}
            placeholder="请选择项目根目录 ($PROJ_DIR)"
            className="min-w-0 flex-1 rounded border border-border bg-background px-2 py-1.5 text-xs"
          />
          <button
            onClick={handleBrowse}
            className="rounded border border-border px-2 py-1.5 text-xs hover:bg-accent whitespace-nowrap"
          >
            浏览
          </button>
          <button
            onClick={handleDiscover}
            disabled={discovering || !projectDir}
            className="flex items-center gap-1 rounded bg-primary px-3 py-1.5 text-xs font-medium text-primary-foreground disabled:opacity-50"
          >
            <RefreshCw className={cn('h-3 w-3', discovering && 'animate-spin')} />
            {discovering ? '扫描中...' : '扫描仓库'}
          </button>
        </div>

        {/* Update buttons */}
        {repos.length > 0 && (
          <div className="mt-2 flex items-center gap-2">
            <span className="text-xs font-medium">批量更新:</span>
            <button
              onClick={() => handleUpdateAll('dv')}
              disabled={updating}
              className="flex items-center gap-1 rounded border border-border px-3 py-1 text-xs hover:bg-accent disabled:opacity-50"
            >
              <Play className="h-3 w-3" />
              更新 DV
            </button>
            <button
              onClick={() => handleUpdateAll('de')}
              disabled={updating}
              className="flex items-center gap-1 rounded border border-border px-3 py-1 text-xs hover:bg-accent disabled:opacity-50"
            >
              <Play className="h-3 w-3" />
              更新 DE
            </button>
            <div className="flex items-center gap-1">
              <input
                type="text"
                value={subsysFilter}
                onChange={(e) => setSubsysFilter(e.target.value)}
                placeholder="subsys名"
                className="w-24 rounded border border-border bg-background px-2 py-1 text-xs"
              />
              <button
                onClick={handleUpdateSubsys}
                disabled={updating || !subsysFilter}
                className="flex items-center gap-1 rounded border border-border px-3 py-1 text-xs hover:bg-accent disabled:opacity-50"
              >
                <Play className="h-3 w-3" />
                更新 Subsys
              </button>
            </div>
          </div>
        )}
      </div>

      {/* ── Status ── */}
      <div className="text-xs text-muted-foreground">{status}</div>

      {/* ── Update stats ── */}
      {updateStats && (
        <div className="grid grid-cols-3 gap-2">
          <div className="rounded border border-border p-2 text-center">
            <div className="text-lg font-bold">{updateStats.total}</div>
            <div className="text-[10px] text-muted-foreground">总数</div>
          </div>
          <div className="rounded border border-green-500/30 bg-green-500/5 p-2 text-center">
            <div className="text-lg font-bold text-green-600 dark:text-green-400">{updateStats.success}</div>
            <div className="text-[10px] text-muted-foreground">成功</div>
          </div>
          <div className="rounded border border-red-500/30 bg-red-500/5 p-2 text-center">
            <div className="text-lg font-bold text-red-600 dark:text-red-400">{updateStats.failed.length}</div>
            <div className="text-[10px] text-muted-foreground">失败</div>
          </div>
        </div>
      )}

      {/* ── Repo list + detail ── */}
      {repos.length > 0 && (
        <div className="flex min-h-0 flex-1 gap-2">
          {/* Repo cards */}
          <div className="flex min-w-0 flex-1 flex-col rounded border border-border">
            <div className="border-b border-border bg-muted/30 px-2 py-1 text-xs font-semibold">
              仓库列表 ({filteredRepos.length})
            </div>
            <div className="min-h-0 flex-1 overflow-auto">
              <div className="grid grid-cols-2 gap-2 p-2">
                {filteredRepos.map((repo) => (
                  <div
                    key={repo.path}
                    onClick={() => handleGetTags(repo)}
                    className={cn(
                      'cursor-pointer rounded border p-2 hover:bg-accent/30',
                      repo.repoType === 'de' ? 'border-blue-500/30' : 'border-green-500/30',
                      selectedRepo?.path === repo.path && 'bg-accent/50',
                    )}
                  >
                    <div className="flex items-center gap-1">
                      <span className={cn(
                        'rounded px-1 text-[10px] font-medium',
                        repo.repoType === 'de' ? 'bg-blue-500/10 text-blue-600 dark:text-blue-400' : 'bg-green-500/10 text-green-600 dark:text-green-400',
                      )}>
                        {repo.repoType.toUpperCase()}
                      </span>
                      <span className="truncate text-xs font-medium" title={repo.name}>{repo.name}</span>
                      {repo.hasChanges && (
                        <span className="ml-auto rounded bg-orange-500/10 px-1 text-[10px] text-orange-600 dark:text-orange-400">
                          未提交
                        </span>
                      )}
                    </div>
                    <div className="mt-1 flex items-center gap-1 text-[10px] text-muted-foreground">
                      <GitBranch className="h-2.5 w-2.5" />
                      <span className="truncate">{repo.currentBranch}</span>
                    </div>
                    <div className="flex items-center gap-1 text-[10px] text-muted-foreground">
                      <Tag className="h-2.5 w-2.5" />
                      <span className="truncate" title={repo.currentTag}>{repo.currentTag}</span>
                    </div>
                    <div className="mt-1 truncate text-[10px] text-muted-foreground" title={repo.lastCommitMessage}>
                      {repo.lastCommitHash} {repo.lastCommitMessage}
                    </div>
                    <div className="text-[10px] text-muted-foreground">{repo.lastCommitTime}</div>
                  </div>
                ))}
              </div>
            </div>
          </div>

          {/* Tag management panel */}
          {selectedRepo && (
            <div className="flex w-64 flex-col rounded border border-border">
              <div className="border-b border-border bg-muted/30 px-2 py-1 text-xs font-semibold">
                {selectedRepo.name} — 标签管理
              </div>
              <div className="flex flex-col gap-2 p-2">
                <div className="text-[10px] text-muted-foreground">
                  当前标签: <span className="font-mono">{selectedRepo.currentTag}</span>
                </div>
                {selectedRepo.subsysTag && (
                  <div className="text-[10px] text-muted-foreground">
                    Subsys: <span className="font-mono">{selectedRepo.subsysTag}</span>
                  </div>
                )}
                <div className="flex flex-col gap-1">
                  <label className="text-xs font-medium">选择标签</label>
                  <select
                    value={selectedTag}
                    onChange={(e) => setSelectedTag(e.target.value)}
                    className="rounded border border-border bg-background px-2 py-1 text-xs"
                  >
                    <option value="" disabled>选择标签...</option>
                    {repoTags.map((tag) => (
                      <option key={tag} value={tag}>{tag}</option>
                    ))}
                  </select>
                </div>
                <button
                  onClick={handleCheckoutTag}
                  disabled={checkingOut || !selectedTag}
                  className="flex items-center justify-center gap-1 rounded bg-primary px-3 py-1.5 text-xs font-medium text-primary-foreground disabled:opacity-50"
                >
                  {checkingOut ? '切换中...' : '切换标签'}
                </button>
              </div>
            </div>
          )}
        </div>
      )}

      {/* ── Log output ── */}
      {logs.length > 0 && (
        <div className="h-48 overflow-auto rounded border border-border bg-zinc-900 p-2" ref={logRef}>
          <pre className="whitespace-pre-wrap font-mono text-[11px] leading-relaxed">
            {logs.map((line, i) => {
              let color = '#d4d4d4';
              if (line.startsWith('✅')) color = '#4ade80';
              else if (line.startsWith('⚠️')) color = '#facc15';
              else if (line.startsWith('❌')) color = '#f87171';
              else if (line.startsWith('='.repeat(10)) || line.startsWith('-'.repeat(10))) color = '#666666';
              else if (line.startsWith('[')) color = '#8ab4f8';
              return (
                <div key={i} style={{ color }}>
                  {line}
                </div>
              );
            })}
          </pre>
        </div>
      )}
    </div>
  );
}
