/**
 * GitManager — multi-repository management tool.
 *
 * Ported from the Python `git_manager` plugin.
 * Features:
 * - Auto-discover DE/DV repos from project directory (no manual input needed)
 * - Cache-first loading: instant display from cache, background refresh outdated repos
 * - Parallel scanning with non-blocking spawn (no GUI freeze)
 * - DE/DV tab switching
 * - Rich repo cards with full info (tag, subsys tag, branch, commit, status)
 * - Tag selection dialog with search (cqp_query / checkout_cqp_tag)
 * - Batch update (DV/DE/subsys) with real-time log dialog
 * - Single repo update to master latest
 * - Refresh single repo via context menu
 * - Subsys-filtered batch update (right-click on xxx_sys repos)
 * - Search filter per tab
 */

import { useState, useCallback, useEffect, useMemo, useRef } from 'react';
import { RefreshCw, Play, Search, GitBranch, Layers, Database } from 'lucide-react';
import { trpc } from '@renderer/lib/trpc';
import type { ToolComponentProps } from '../registry';
import { cn } from '@renderer/lib/utils';
import { RepoCard, type GitRepoInfo } from './RepoCard';
import { TagDialog } from './TagDialog';
import { UpdateDialog } from './UpdateDialog';
import { SingleRepoUpdateDialog } from './SingleRepoUpdateDialog';

type TabType = 'de' | 'dv';
type DialogState =
  | { type: 'tag'; repo: GitRepoInfo }
  | { type: 'update'; repoType: 'de' | 'dv'; subsysName?: string }
  | { type: 'singleUpdate'; repo: GitRepoInfo }
  | null;

export function GitManager({ projectRoot }: ToolComponentProps) {
  const [repos, setRepos] = useState<GitRepoInfo[]>([]);
  const [activeTab, setActiveTab] = useState<TabType>('dv');
  const [searchText, setSearchText] = useState('');
  const [discovering, setDiscovering] = useState(false);
  const [refreshingRepo, setRefreshingRepo] = useState<string | null>(null);
  const [dialog, setDialog] = useState<DialogState>(null);
  const [status, setStatus] = useState('就绪');
  const [progress, setProgress] = useState<{ value: number; message: string } | null>(null);
  const [fromCache, setFromCache] = useState(false);
  const [backgroundRefreshing, setBackgroundRefreshing] = useState(false);
  // Track if the initial load has been done to avoid duplicate calls
  const initialLoadDone = useRef(false);

  // ── Cache-first discover ──
  // 1. Try to load from cache (instant, non-blocking query)
  // 2. If cache exists: show cached repos immediately, then trigger background refresh
  // 3. If no cache: full parallel scan (non-blocking spawn)
  const discoverRepos = useCallback(async () => {
    if (!projectRoot) {
      setStatus('未设置项目目录，请在主窗口中打开项目');
      return;
    }

    setDiscovering(true);
    setStatus('正在加载仓库...');

    // Step 1: Try cache first (instant query, non-blocking)
    try {
      const cached = await trpc.tools.gitManager.discoverReposCached.query({
        projectDir: projectRoot,
      });

      if (cached.repos && cached.repos.length > 0) {
        // Cache hit — display immediately
        const cachedRepos = cached.repos as GitRepoInfo[];
        setRepos(cachedRepos);
        setFromCache(true);

        const deCount = cachedRepos.filter((r) => r.repoType === 'de').length;
        const dvCount = cachedRepos.filter((r) => r.repoType === 'dv').length;

        if (cached.dirChanged || cached.outdatedCount > 0) {
          setStatus(`从缓存加载 ${cachedRepos.length} 个仓库 (${deCount} DE + ${dvCount} DV)，后台刷新中...`);
          setBackgroundRefreshing(true);
          setProgress({ value: 0, message: `后台刷新 ${cached.outdatedCount} 个仓库...` });

          // Step 2: Trigger background refresh (mutation returns immediately with cached data,
          // IPC events push individual repo updates)
          trpc.tools.gitManager.discoverRepos
            .mutate({ projectDir: projectRoot, repoType: 'all' })
            .then(() => {
              setBackgroundRefreshing(false);
              setProgress(null);
            })
            .catch((err: unknown) => {
              setBackgroundRefreshing(false);
              setProgress(null);
              setStatus(`后台刷新失败: ${err instanceof Error ? err.message : String(err)}`);
            });
        } else {
          setStatus(`从缓存加载 ${cachedRepos.length} 个仓库 (${deCount} DE + ${dvCount} DV)`);
          setProgress(null);
        }

        setDiscovering(false);
        return;
      }
    } catch {
      // Cache query failed — fall through to full scan
    }

    // Step 3: No cache — full parallel scan
    setFromCache(false);
    setRepos([]);
    setProgress({ value: 0, message: '开始并行扫描...' });

    try {
      const res = await trpc.tools.gitManager.discoverRepos.mutate({
        projectDir: projectRoot,
        repoType: 'all',
      });
      const allRepos = res.repos as GitRepoInfo[];
      setRepos(allRepos);

      const deCount = allRepos.filter((r) => r.repoType === 'de').length;
      const dvCount = allRepos.filter((r) => r.repoType === 'dv').length;
      setStatus(`已加载 ${allRepos.length} 个仓库 (${deCount} DE + ${dvCount} DV)`);
      setProgress({ value: 100, message: '扫描完成' });

      setTimeout(() => setProgress(null), 1500);
    } catch (err) {
      setStatus(`扫描失败: ${err instanceof Error ? err.message : String(err)}`);
      setProgress(null);
    } finally {
      setDiscovering(false);
    }
  }, [projectRoot]);

  // ── Full parallel re-scan (for "refresh all" button) ──
  const fullRescan = useCallback(async () => {
    if (!projectRoot) return;

    setDiscovering(true);
    setFromCache(false);
    setStatus('正在并行扫描仓库...');
    setProgress({ value: 0, message: '开始并行扫描...' });

    try {
      const res = await trpc.tools.gitManager.discoverReposParallel.mutate({
        projectDir: projectRoot,
        repoType: 'all',
      });
      const allRepos = res.repos as GitRepoInfo[];
      setRepos(allRepos);

      const deCount = allRepos.filter((r) => r.repoType === 'de').length;
      const dvCount = allRepos.filter((r) => r.repoType === 'dv').length;
      setStatus(`已加载 ${allRepos.length} 个仓库 (${deCount} DE + ${dvCount} DV)`);
      setProgress({ value: 100, message: '扫描完成' });

      setTimeout(() => setProgress(null), 1500);
    } catch (err) {
      setStatus(`扫描失败: ${err instanceof Error ? err.message : String(err)}`);
      setProgress(null);
    } finally {
      setDiscovering(false);
    }
  }, [projectRoot]);

  // ── Listen to IPC events for background refresh progress ──
  useEffect(() => {
    if (!window.eventBridge) return;

    const unsubscribe = window.eventBridge.onGitManagerEvent((event) => {
      if (event.type === 'progress') {
        const pct = event.total ? Math.round((event.completed! / event.total) * 100) : 0;
        setProgress({
          value: pct,
          message: `后台刷新: ${event.repoName} (${event.completed}/${event.total})`,
        });
      } else if (event.type === 'repoRefreshed') {
        // Update the single repo in state
        const refreshed = event.repo as GitRepoInfo;
        setRepos((prev) =>
          prev.map((r) => (r.path === refreshed.path ? { ...r, ...refreshed } : r)),
        );
      } else if (event.type === 'scanComplete') {
        if (event.fromCache) {
          // Background scan started from cache — events will follow
        } else {
          setProgress({ value: 100, message: '扫描完成' });
          setTimeout(() => setProgress(null), 1500);
        }
      } else if (event.type === 'error') {
        setStatus(`错误: ${event.message}`);
        setProgress(null);
      }
    });

    return unsubscribe;
  }, []);

  // ── Auto-discover on mount ──
  useEffect(() => {
    if (projectRoot && !initialLoadDone.current) {
      initialLoadDone.current = true;
      discoverRepos();
    }
  }, [projectRoot, discoverRepos]);

  // Filter repos by tab and search
  const deRepos = useMemo(() => repos.filter((r) => r.repoType === 'de'), [repos]);
  const dvRepos = useMemo(() => repos.filter((r) => r.repoType === 'dv'), [repos]);
  const currentRepos = activeTab === 'de' ? deRepos : dvRepos;
  const filteredRepos = useMemo(() => {
    if (!searchText.trim()) return currentRepos;
    const q = searchText.toLowerCase().trim();
    return currentRepos.filter((r) => r.name.toLowerCase().includes(q));
  }, [currentRepos, searchText]);

  // ── Handlers ──
  const handleRefreshRepo = useCallback(async (repo: GitRepoInfo) => {
    setRefreshingRepo(repo.path);
    setStatus(`正在刷新仓库: ${repo.name}...`);

    try {
      const res = await trpc.tools.gitManager.refreshRepoInfo.mutate({
        repo: { name: repo.name, path: repo.path, repoType: repo.repoType },
        projectDir: projectRoot ?? '',
      });
      const refreshed = res.repo as GitRepoInfo;
      setRepos((prev) =>
        prev.map((r) => (r.path === refreshed.path ? refreshed : r)),
      );
      setStatus(`已刷新仓库: ${repo.name}`);
    } catch (err) {
      setStatus(`刷新失败: ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      setRefreshingRepo(null);
    }
  }, [projectRoot]);

  const handleCardClick = useCallback((repo: GitRepoInfo) => {
    setDialog({ type: 'tag', repo });
  }, []);

  const handleUpdateToMaster = useCallback((repo: GitRepoInfo) => {
    setDialog({ type: 'singleUpdate', repo });
  }, []);

  const handleSubsysUpdate = useCallback((repo: GitRepoInfo) => {
    const name = repo.name.replace('udtb/', '').replace('_sys', '');
    setDialog({ type: 'update', repoType: repo.repoType, subsysName: name });
  }, []);

  const handleBatchUpdate = useCallback((repoType: 'de' | 'dv') => {
    setDialog({ type: 'update', repoType });
  }, []);

  const handleDialogClose = useCallback(() => {
    setDialog(null);
  }, []);

  const handleDialogComplete = useCallback(() => {
    // Refresh repos after any dialog operation completes
    fullRescan();
  }, [fullRescan]);

  // Clear search when switching tabs
  const handleTabSwitch = useCallback((tab: TabType) => {
    setActiveTab(tab);
    setSearchText('');
  }, []);

  return (
    <div className="flex h-full flex-col gap-2 p-3">
      {/* ── Toolbar ── */}
      <div className="flex items-center gap-2 rounded border border-border p-2">
        {/* Project path indicator */}
        <div className="flex min-w-0 flex-1 items-center gap-1.5 text-xs text-muted-foreground">
          <GitBranch className="h-3.5 w-3.5 shrink-0" />
          <span className="truncate" title={projectRoot ?? ''}>
            {projectRoot ?? '未设置项目目录'}
          </span>
        </div>

        {/* Cache indicator badge */}
        {fromCache && (
          <span className="flex items-center gap-1 rounded bg-muted px-1.5 py-0.5 text-[10px] text-muted-foreground">
            <Database className="h-2.5 w-2.5" />
            缓存
          </span>
        )}

        {/* Background refreshing indicator */}
        {backgroundRefreshing && (
          <span className="flex items-center gap-1 rounded bg-yellow-500/10 px-1.5 py-0.5 text-[10px] text-yellow-600 dark:text-yellow-400">
            <RefreshCw className="h-2.5 w-2.5 animate-spin" />
            后台刷新中
          </span>
        )}

        {/* Refresh All (full parallel re-scan) */}
        <button
          onClick={fullRescan}
          disabled={discovering || !projectRoot}
          className="flex items-center gap-1 rounded border border-border px-3 py-1.5 text-xs font-medium hover:bg-accent disabled:opacity-50"
          title="重新并行扫描所有仓库（跳过缓存）"
        >
          <RefreshCw className={cn('h-3 w-3', discovering && 'animate-spin')} />
          {discovering ? '扫描中...' : '刷新全部'}
        </button>

        {/* Update DV */}
        {dvRepos.length > 0 && (
          <button
            onClick={() => handleBatchUpdate('dv')}
            disabled={discovering}
            className="flex items-center gap-1 rounded bg-green-600 px-3 py-1.5 text-xs font-bold text-white hover:bg-green-700 disabled:opacity-50"
          >
            <Play className="h-3 w-3" />
            一键更新DV
          </button>
        )}

        {/* Update DE */}
        {deRepos.length > 0 && (
          <button
            onClick={() => handleBatchUpdate('de')}
            disabled={discovering}
            className="flex items-center gap-1 rounded bg-blue-600 px-3 py-1.5 text-xs font-bold text-white hover:bg-blue-700 disabled:opacity-50"
          >
            <Play className="h-3 w-3" />
            一键更新DE
          </button>
        )}
      </div>

      {/* ── Progress bar ── */}
      {progress && (
        <div className="flex items-center gap-2">
          <div className="h-1.5 flex-1 overflow-hidden rounded-full bg-muted">
            <div
              className="h-full rounded-full bg-primary transition-all duration-300"
              style={{ width: `${progress.value}%` }}
            />
          </div>
          <span className="text-[10px] text-muted-foreground">{progress.message}</span>
        </div>
      )}

      {/* ── Status ── */}
      <div className="text-xs text-muted-foreground">{status}</div>

      {/* ── No project root ── */}
      {!projectRoot && (
        <div className="flex flex-1 items-center justify-center">
          <div className="text-center">
            <GitBranch className="mx-auto mb-2 h-8 w-8 text-muted-foreground/50" />
            <p className="text-sm text-muted-foreground">
              请先在主窗口中打开项目，Git Manager 将自动扫描 $PROJ_RTL 和 $PROJ_ENV 目录下的仓库
            </p>
          </div>
        </div>
      )}

      {/* ── Repo tabs + cards ── */}
      {projectRoot && repos.length > 0 && (
        <div className="flex min-h-0 flex-1 flex-col">
          {/* Tabs */}
          <div className="flex items-center gap-1 border-b border-border">
            <button
              onClick={() => handleTabSwitch('dv')}
              className={cn(
                'flex items-center gap-1.5 px-3 py-2 text-xs font-medium transition-colors',
                activeTab === 'dv'
                  ? 'border-b-2 border-green-500 text-foreground'
                  : 'text-muted-foreground hover:text-foreground',
              )}
            >
              <Layers className="h-3.5 w-3.5" />
              DV Repositories
              <span className="rounded bg-muted px-1.5 py-0.5 text-[10px]">{dvRepos.length}</span>
            </button>
            <button
              onClick={() => handleTabSwitch('de')}
              className={cn(
                'flex items-center gap-1.5 px-3 py-2 text-xs font-medium transition-colors',
                activeTab === 'de'
                  ? 'border-b-2 border-blue-500 text-foreground'
                  : 'text-muted-foreground hover:text-foreground',
              )}
            >
              <Layers className="h-3.5 w-3.5" />
              DE Repositories
              <span className="rounded bg-muted px-1.5 py-0.5 text-[10px]">{deRepos.length}</span>
            </button>

            {/* Search */}
            <div className="ml-auto flex items-center gap-1 rounded border border-border px-2 py-1">
              <Search className="h-3 w-3 text-muted-foreground" />
              <input
                type="text"
                value={searchText}
                onChange={(e) => setSearchText(e.target.value)}
                placeholder="搜索仓库名..."
                className="w-32 bg-transparent text-xs outline-none"
              />
            </div>
          </div>

          {/* Cards grid */}
          <div className="min-h-0 flex-1 overflow-auto p-2">
            {filteredRepos.length === 0 ? (
              <div className="flex h-full items-center justify-center text-xs text-muted-foreground">
                {searchText ? '未找到匹配的仓库' : '暂无仓库'}
              </div>
            ) : (
              <div className="grid grid-cols-2 gap-2 lg:grid-cols-3 xl:grid-cols-4">
                {filteredRepos.map((repo) => (
                  <RepoCard
                    key={repo.path}
                    repo={repo}
                    onClick={handleCardClick}
                    onRefresh={handleRefreshRepo}
                    onUpdateToMaster={handleUpdateToMaster}
                    onSubsysUpdate={handleSubsysUpdate}
                    isRefreshing={refreshingRepo === repo.path}
                  />
                ))}
              </div>
            )}
          </div>
        </div>
      )}

      {/* ── Loading state ── */}
      {projectRoot && discovering && repos.length === 0 && (
        <div className="flex flex-1 items-center justify-center">
          <div className="text-center">
            <RefreshCw className="mx-auto mb-2 h-8 w-8 animate-spin text-muted-foreground/50" />
            <p className="text-sm text-muted-foreground">正在扫描仓库...</p>
          </div>
        </div>
      )}

      {/* ── Empty state ── */}
      {projectRoot && !discovering && repos.length === 0 && (
        <div className="flex flex-1 items-center justify-center">
          <div className="text-center">
            <GitBranch className="mx-auto mb-2 h-8 w-8 text-muted-foreground/50" />
            <p className="text-sm text-muted-foreground">
              未找到 Git 仓库。请确保 $PROJ_RTL 或 $PROJ_ENV 环境变量已配置且包含 Git 仓库。
            </p>
            <button
              onClick={fullRescan}
              className="mt-3 rounded border border-border px-3 py-1.5 text-xs hover:bg-accent"
            >
              重新扫描
            </button>
          </div>
        </div>
      )}

      {/* ── Dialogs ── */}
      {dialog?.type === 'tag' && (
        <TagDialog
          repo={dialog.repo}
          projectDir={projectRoot!}
          onClose={handleDialogClose}
          onCheckoutSuccess={() => {
            // Refresh the specific repo after successful checkout
            handleRefreshRepo(dialog.repo);
          }}
        />
      )}

      {dialog?.type === 'update' && (
        <UpdateDialog
          projectDir={projectRoot!}
          repoType={dialog.repoType}
          subsysName={dialog.subsysName}
          onClose={handleDialogClose}
          onComplete={handleDialogComplete}
        />
      )}

      {dialog?.type === 'singleUpdate' && (
        <SingleRepoUpdateDialog
          repo={dialog.repo}
          onClose={handleDialogClose}
          onComplete={() => {
            // Refresh the specific repo after successful update
            handleRefreshRepo(dialog.repo);
          }}
        />
      )}
    </div>
  );
}
