/**
 * GitQuickPull — lightweight batch git pull tool.
 *
 * Ported from the Python `git_quick_pull` plugin.
 * Features: select environment (DV/DE/All), choose pull mode,
 * execute batch pull with real-time log output.
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

type PullLogEntry = {
  repoName: string;
  lines: string[];
  success: boolean;
  reason: string | null;
};

export function GitQuickPull({ projectRoot, onProjectRootChange }: ToolComponentProps) {
  const [projectDir, setProjectDir] = useState(projectRoot ?? '');
  const [repoType, setRepoType] = useState<'dv' | 'de' | 'all'>('all');
  const [mode, setMode] = useState<'pull' | 'pull_reset' | 'custom'>('pull');
  const [customCommand, setCustomCommand] = useState('git pull --rebase');
  const [scanning, setScanning] = useState(false);
  const [executing, setExecuting] = useState(false);
  const [repos, setRepos] = useState<RepoInfo[]>([]);
  const [logs, setLogs] = useState<PullLogEntry[]>([]);
  const [stats, setStats] = useState<PullStats | null>(null);
  const [status, setStatus] = useState('请选择项目目录');
  const [copied, setCopied] = useState(false);
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
    if (mode === 'pull_reset') {
      const confirmed = window.confirm(
        '⚠️ pull_reset 模式会丢弃本地更改！\n\n确定要继续吗？',
      );
      if (!confirmed) return;
    }

    setExecuting(true);
    setLogs([]);
    setStats(null);
    setStatus('正在执行批量 pull...');
    try {
      const res = await trpc.tools.gitQuickPull.executePull.mutate({
        repos,
        mode,
        customCommand: mode === 'custom' ? customCommand : null,
      });
      setLogs(res.logs as PullLogEntry[]);
      setStats(res.stats as PullStats);
      const s = res.stats as PullStats;
      if (s.success === s.total) {
        setStatus(`🎉 所有仓库更新成功! (${s.success}/${s.total})`);
      } else if (s.success > 0) {
        setStatus(`⚠️ 部分成功 (${s.success}/${s.total}), 跳过 ${s.skipped.length}, 失败 ${s.failed.length}`);
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
    const lines: string[] = [];
    for (const entry of logs) {
      lines.push(...entry.lines);
    }
    navigator.clipboard.writeText(lines.join('\n'));
    setCopied(true);
    setTimeout(() => setCopied(false), 1500);
  }, [logs]);

  const allLogLines = logs.flatMap((l) => l.lines);

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
              placeholder="例如: git pull --rebase"
              className="rounded border border-border bg-background px-2 py-1.5 text-xs font-mono"
            />
          </div>
        )}
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
        {logs.length > 0 && (
          <button
            onClick={handleCopy}
            className="flex items-center gap-1.5 rounded border border-border px-4 py-1.5 text-xs font-medium hover:bg-accent"
          >
            {copied ? <CheckCircle2 className="h-3 w-3 text-green-500" /> : <Copy className="h-3 w-3" />}
            {copied ? '已复制' : '复制日志'}
          </button>
        )}
      </div>

      {/* ── Status + repo count ── */}
      <div className="flex items-center justify-between text-xs text-muted-foreground">
        <span>{status}</span>
        {repos.length > 0 && <span>找到 {repos.length} 个仓库</span>}
      </div>

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
      {allLogLines.length > 0 && (
        <div className="min-h-0 flex-1 overflow-auto rounded border border-border bg-zinc-900 p-2" ref={logRef}>
          <pre className="whitespace-pre-wrap font-mono text-[11px] leading-relaxed">
            {allLogLines.map((line, i) => {
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
