/**
 * GitQuickPull — lightweight batch git pull tool.
 *
 * Ported from the Python `git_quick_pull` plugin.
 * Features: select environment (DV/DE/All), choose pull mode,
 * execute batch pull with real-time log output via IPC events.
 */

import { useState, useCallback, useRef, useEffect } from 'react';
import { FolderOpen, Play, Copy, CheckCircle2 } from 'lucide-react';
import { trpc } from '@renderer/lib/trpc';
import type { ToolComponentProps } from '../registry';
import { cn } from '@renderer/lib/utils';

type RepoInfo = {
  name: string;
  path: string;
  repoType: 'dv' | 'de';
};

type PullStats = {
  total: number;
  success: number;
  skipped: Array<{ name: string; reason: string }>;
  failed: Array<{ name: string; reason: string }>;
};

export function GitQuickPull({ projectRoot, onProjectRootChange }: ToolComponentProps) {
  const [projectDir, setProjectDir] = useState(projectRoot ?? '');
  const [repoType, setRepoType] = useState<'dv' | 'de' | 'all'>('all');
  const [mode, setMode] = useState<'pull' | 'pull_reset' | 'custom'>('pull');
  const [customCommand, setCustomCommand] = useState('git pull --rebase');
  const [scanning, setScanning] = useState(false);
  const [executing, setExecuting] = useState(false);
  const [repos, setRepos] = useState<RepoInfo[]>([]);
  const [logLines, setLogLines] = useState<string[]>([]);
  const [stats, setStats] = useState<PullStats | null>(null);
  const [completedCount, setCompletedCount] = useState(0);
  const [status, setStatus] = useState('请选择项目目录');
  const [copied, setCopied] = useState(false);
  const logRef = useRef<HTMLDivElement>(null);

  // Sync projectRoot prop → local state
  useEffect(() => {
    if (projectRoot) setProjectDir(projectRoot);
  }, [projectRoot]);

  // Auto-scroll log to bottom on new lines
  useEffect(() => {
    if (logRef.current) {
      logRef.current.scrollTop = logRef.current.scrollHeight;
    }
  }, [logLines]);

  // ── Real-time event listener (matches Python's pyqtSignal pattern) ──
  useEffect(() => {
    if (!window.eventBridge) return;
    const unsubscribe = window.eventBridge.onGitQuickPullLog((event) => {
      if (event.type === 'start') {
        setLogLines(event.lines);
        setCompletedCount(0);
        setStats(null);
      } else if (event.type === 'repo') {
        setLogLines((prev) => [...prev, ...event.lines]);
        setCompletedCount((prev) => prev + 1);
      } else if (event.type === 'end') {
        setLogLines((prev) => [...prev, ...event.lines]);
        if (event.stats) {
          setStats(event.stats as PullStats);
        }
      }
    });
    return unsubscribe;
  }, []);

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

  const handleScan = useCallback(async () => {
    if (!projectDir) {
      setStatus('请先选择项目目录');
      return;
    }
    setScanning(true);
    setStatus('正在扫描仓库...');
    try {
      const res = await trpc.tools.gitQuickPull.scanRepos.query({
        projectDir,
        repoType,
      });
      setRepos(res.repos as RepoInfo[]);
      const r = res.repos as RepoInfo[];
      setStatus(`扫描完成: 找到 ${r.length} 个仓库`);
    } catch (err) {
      setStatus(`扫描失败: ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      setScanning(false);
    }
  }, [projectDir, repoType]);

  const handleExecute = useCallback(async () => {
    if (repos.length === 0) {
      setStatus('请先扫描仓库');
      return;
    }

    // Validate custom command (matches Python's validation)
    if (mode === 'custom') {
      const cmd = customCommand.trim();
      if (!cmd) {
        setStatus('请输入自定义 Git 命令');
        return;
      }
      if (!cmd.toLowerCase().startsWith('git ')) {
        setStatus('自定义命令必须以 "git" 开头，例如: git pull --rebase origin master');
        return;
      }
    }

    // pull_reset danger confirmation (matches Python's detailed message)
    if (mode === 'pull_reset') {
      const confirmed = window.confirm(
        '⚠️ 危险操作确认\n\n' +
          '此操作将执行以下步骤:\n\n' +
          '1. git fetch origin\n' +
          '2. git reset --hard origin/master\n\n' +
          '⚠️ 这将丢弃所有本地未提交更改且不可恢复！\n\n' +
          '有未提交更改的仓库将被自动跳过。\n\n' +
          '确定要继续吗？',
      );
      if (!confirmed) return;
    }

    setExecuting(true);
    setLogLines([]);
    setStats(null);
    setCompletedCount(0);
    setStatus('正在执行批量 pull...');

    try {
      const res = await trpc.tools.gitQuickPull.executePull.mutate({
        repos,
        mode,
        customCommand: mode === 'custom' ? customCommand : null,
      });
      // Stats may already be set by the 'end' event, but set here for safety
      const s = res.stats as PullStats;
      setStats(s);
      if (s.success === s.total) {
        setStatus(`🎉 所有仓库更新成功! (${s.success}/${s.total})`);
      } else if (s.success > 0) {
        setStatus(
          `⚠️ 部分成功 (${s.success}/${s.total}), 跳过 ${s.skipped.length}, 失败 ${s.failed.length}`,
        );
      } else {
        setStatus(`❌ 所有仓库更新失败`);
      }
    } catch (err) {
      setStatus(`执行失败: ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      setExecuting(false);
    }
  }, [repos, mode, customCommand]);

  const handleCopy = useCallback(() => {
    navigator.clipboard.writeText(logLines.join('\n'));
    setCopied(true);
    setTimeout(() => setCopied(false), 1500);
  }, [logLines]);

  return (
    <div className="flex h-full flex-col gap-3 p-4">
      <input type="hidden" value={projectRoot ?? ''} onChange={(e) => onProjectRootChange(e.target.value)} />

      {/* ── Config ── */}
      <div className="rounded border border-border p-3">
        <div className="flex items-center gap-1">
          <input
            type="text"
            value={projectDir}
            onChange={(e) => setProjectDir(e.target.value)}
            placeholder="请选择项目根目录 ($PROJ_DIR)"
            className="min-w-0 flex-1 rounded border border-border bg-background px-2 py-1.5 text-xs"
          />
          <button
            onClick={handleBrowse}
            className="flex items-center gap-1 rounded border border-border px-2 py-1.5 text-xs hover:bg-accent whitespace-nowrap"
          >
            <FolderOpen className="h-3 w-3" />
            浏览
          </button>
        </div>

        <div className="mt-3 grid grid-cols-2 gap-3">
          {/* Environment */}
          <div className="flex flex-col gap-1">
            <label className="text-xs font-medium">环境选择</label>
            <select
              value={repoType}
              onChange={(e) => setRepoType(e.target.value as 'dv' | 'de' | 'all')}
              className="rounded border border-border bg-background px-2 py-1.5 text-xs"
            >
              <option value="all">DV + DE</option>
              <option value="dv">仅 DV</option>
              <option value="de">仅 DE</option>
            </select>
          </div>

          {/* Mode */}
          <div className="flex flex-col gap-1">
            <label className="text-xs font-medium">更新模式</label>
            <select
              value={mode}
              onChange={(e) => setMode(e.target.value as 'pull' | 'pull_reset' | 'custom')}
              className="rounded border border-border bg-background px-2 py-1.5 text-xs"
            >
              <option value="pull">git pull (标准)</option>
              <option value="pull_reset">git fetch + reset --hard (⚠️危险)</option>
              <option value="custom">自定义命令</option>
            </select>
          </div>
        </div>

        {mode === 'custom' && (
          <div className="mt-2 flex flex-col gap-1">
            <label className="text-xs font-medium">自定义命令</label>
            <input
              type="text"
              value={customCommand}
              onChange={(e) => setCustomCommand(e.target.value)}
              placeholder="例如: git pull --rebase origin master"
              className="rounded border border-border bg-background px-2 py-1.5 text-xs font-mono"
            />
          </div>
        )}

        {/* Info tips (matches Python's info_label) */}
        <div className="mt-2 rounded bg-muted/50 p-2 text-[10px] text-muted-foreground">
          ℹ️ pull 模式下有冲突的仓库会报错，不会覆盖本地更改
          <br />
          ℹ️ 强制重置模式下有未提交更改的仓库将被自动跳过
        </div>
      </div>

      {/* ── Buttons ── */}
      <div className="flex items-center gap-2">
        <button
          onClick={handleScan}
          disabled={scanning || !projectDir}
          className="flex items-center gap-1.5 rounded border border-border px-4 py-1.5 text-xs font-medium hover:bg-accent disabled:opacity-50"
        >
          {scanning ? '扫描中...' : '扫描仓库'}
        </button>
        <button
          onClick={handleExecute}
          disabled={executing || repos.length === 0}
          className="flex items-center gap-1.5 rounded bg-primary px-4 py-1.5 text-xs font-medium text-primary-foreground disabled:opacity-50"
        >
          <Play className={cn('h-3 w-3', executing && 'animate-pulse')} />
          {executing ? '执行中...' : '开始 Pull'}
        </button>
        {logLines.length > 0 && (
          <button
            onClick={handleCopy}
            className="flex items-center gap-1.5 rounded border border-border px-4 py-1.5 text-xs font-medium hover:bg-accent"
          >
            {copied ? <CheckCircle2 className="h-3 w-3 text-green-500" /> : <Copy className="h-3 w-3" />}
            {copied ? '已复制' : '复制日志'}
          </button>
        )}
      </div>

      {/* ── Status + repo count + progress ── */}
      <div className="flex items-center justify-between text-xs text-muted-foreground">
        <span>{status}</span>
        {repos.length > 0 && (
          <span>
            找到 {repos.length} 个仓库
            {executing && completedCount > 0 && ` · 已完成 ${completedCount}/${repos.length}`}
          </span>
        )}
      </div>

      {/* ── Progress bar ── */}
      {executing && repos.length > 0 && (
        <div className="h-1 w-full overflow-hidden rounded bg-border">
          <div
            className="h-full bg-primary transition-all duration-300"
            style={{ width: `${repos.length > 0 ? (completedCount / repos.length) * 100 : 0}%` }}
          />
        </div>
      )}

      {/* ── Stats summary ── */}
      {stats && (
        <div className="grid grid-cols-4 gap-2">
          <div className="rounded border border-border p-2 text-center">
            <div className="text-lg font-bold">{stats.total}</div>
            <div className="text-[10px] text-muted-foreground">总数</div>
          </div>
          <div className="rounded border border-green-500/30 bg-green-500/5 p-2 text-center">
            <div className="text-lg font-bold text-green-600 dark:text-green-400">{stats.success}</div>
            <div className="text-[10px] text-muted-foreground">成功</div>
          </div>
          <div className="rounded border border-yellow-500/30 bg-yellow-500/5 p-2 text-center">
            <div className="text-lg font-bold text-yellow-600 dark:text-yellow-400">{stats.skipped.length}</div>
            <div className="text-[10px] text-muted-foreground">跳过</div>
          </div>
          <div className="rounded border border-red-500/30 bg-red-500/5 p-2 text-center">
            <div className="text-lg font-bold text-red-600 dark:text-red-400">{stats.failed.length}</div>
            <div className="text-[10px] text-muted-foreground">失败</div>
          </div>
        </div>
      )}

      {/* ── Log output ── */}
      {logLines.length > 0 && (
        <div className="min-h-0 flex-1 overflow-auto rounded border border-border bg-zinc-900 p-2" ref={logRef}>
          <pre className="whitespace-pre-wrap font-mono text-[11px] leading-relaxed">
            {logLines.map((line, i) => {
              let color = '#d4d4d4';
              if (line.startsWith('✅')) color = '#4ade80';
              else if (line.startsWith('⚠️')) color = '#facc15';
              else if (line.startsWith('❌')) color = '#f87171';
              else if (line.startsWith('🎉')) color = '#4ade80';
              else if (line.startsWith('='.repeat(10)) || line.startsWith('-'.repeat(10))) color = '#666666';
              else if (line.startsWith('[')) color = '#8ab4f8';
              else if (line.startsWith('开始更新') || line.startsWith('更新完成') || line.startsWith('总仓库数') || line.startsWith('成功更新') || line.startsWith('跳过数量') || line.startsWith('失败数量') || line.startsWith('找到 ')) color = '#c0c0c0';
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
