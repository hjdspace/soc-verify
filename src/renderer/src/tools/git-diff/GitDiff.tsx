/**
 * GitDiff — file version comparison tool.
 *
 * Ported from the Python `git_diff` plugin.
 * Features: open repo, select file, select two commits, compare diffs.
 */

import { useState, useCallback, useEffect, useRef } from 'react';
import { FolderOpen, FileSearch, GitCompare, ArrowDown, ArrowUp } from 'lucide-react';
import { trpc } from '@renderer/lib/trpc';
import type { ToolComponentProps } from '../registry';
import { cn } from '@renderer/lib/utils';

type CommitInfo = {
  sha: string;
  shortSha: string;
  author: string;
  authorEmail: string;
  date: string;
  message: string;
  summary: string;
};

type DiffLine = {
  lineType: 'context' | 'add' | 'delete' | 'modify';
  oldLineNo: number | null;
  newLineNo: number | null;
  content: string;
};

type DiffStats = {
  addedLines: number;
  deletedLines: number;
  modifiedLines: number;
  contextLines: number;
  totalChanges: number;
};

type DiffResult = {
  diffLines: DiffLine[];
  stats: DiffStats;
  hunks: Array<{ oldStart: number; oldCount: number; newStart: number; newCount: number; lines: DiffLine[] }>;
};

type RepoInfo = {
  repoRoot: string;
  currentBranch: string;
  branches: string[];
};

export function GitDiff({ projectRoot, onProjectRootChange }: ToolComponentProps) {
  const [repoPath, setRepoPath] = useState(projectRoot ?? '');
  const [repoInfo, setRepoInfo] = useState<RepoInfo | null>(null);
  const [trackedFiles, setTrackedFiles] = useState<string[]>([]);
  const [selectedFile, setSelectedFile] = useState('');
  const [commits, setCommits] = useState<CommitInfo[]>([]);
  const [oldCommit, setOldCommit] = useState('');
  const [newCommit, setNewCommit] = useState('');
  const [diff, setDiff] = useState<DiffResult | null>(null);
  const [loading, setLoading] = useState(false);
  const [status, setStatus] = useState('请选择 Git 仓库');
  const [fileFilter, setFileFilter] = useState('');
  const diffRef = useRef<HTMLDivElement>(null);
  const [diffIndex, setDiffIndex] = useState(0);

  useEffect(() => {
    if (projectRoot) setRepoPath(projectRoot);
  }, [projectRoot]);

  const handleOpenRepo = useCallback(async () => {
    if (!repoPath) {
      setStatus('请输入仓库路径');
      return;
    }

    setLoading(true);
    setStatus('正在打开仓库...');

    try {
      const res = await trpc.tools.gitDiff.openRepo.query({ repoPath });
      const info = res as unknown as RepoInfo;
      setRepoInfo(info);
      setStatus(`仓库: ${info.repoRoot} (分支: ${info.currentBranch})`);

      // Load tracked files
      const filesRes = await trpc.tools.gitDiff.getTrackedFiles.query({ repoPath });
      setTrackedFiles(filesRes.files as string[]);
    } catch (err) {
      setStatus(`打开仓库失败: ${err instanceof Error ? err.message : String(err)}`);
      setRepoInfo(null);
    } finally {
      setLoading(false);
    }
  }, [repoPath]);

  const handleBrowse = useCallback(async () => {
    const res = await trpc.tools.selectDirectory.mutate({
      title: '选择 Git 仓库',
      defaultPath: repoPath || undefined,
    });
    if (res.path) {
      setRepoPath(res.path);
      onProjectRootChange(res.path);
    }
  }, [repoPath, onProjectRootChange]);

  const handleSelectFile = useCallback(async (file: string) => {
    setSelectedFile(file);
    setCommits([]);
    setOldCommit('');
    setNewCommit('');
    setDiff(null);

    if (!file) return;

    try {
      const res = await trpc.tools.gitDiff.getFileCommits.query({
        repoPath,
        filePath: file,
      });
      setCommits(res.commits as CommitInfo[]);

      // Auto-select first two commits if available
      if ((res.commits as CommitInfo[]).length >= 2) {
        const c = res.commits as CommitInfo[];
        setOldCommit(c[1].sha);
        setNewCommit(c[0].sha);
      } else if ((res.commits as CommitInfo[]).length === 1) {
        setOldCommit((res.commits as CommitInfo[])[0].sha);
      }
    } catch (err) {
      setStatus(`获取提交历史失败: ${err instanceof Error ? err.message : String(err)}`);
    }
  }, [repoPath]);

  const handleCompare = useCallback(async () => {
    if (!selectedFile) {
      setStatus('请先选择文件');
      return;
    }

    setLoading(true);
    setStatus('正在比较版本...');

    try {
      const res = await trpc.tools.gitDiff.calculateDiff.mutate({
        repoPath,
        filePath: selectedFile,
        oldCommitSha: oldCommit || undefined,
        newCommitSha: newCommit || undefined,
      });
      setDiff(res as unknown as DiffResult);
      setDiffIndex(0);
      const s = (res as unknown as DiffResult).stats;
      setStatus(`比较完成: +${s.addedLines} -${s.deletedLines}`);
    } catch (err) {
      setStatus(`比较失败: ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      setLoading(false);
    }
  }, [repoPath, selectedFile, oldCommit, newCommit]);

  // Filter tracked files
  const filteredFiles = fileFilter
    ? trackedFiles.filter((f) => f.toLowerCase().includes(fileFilter.toLowerCase()))
    : trackedFiles;

  // Navigate to next/prev diff hunk
  const handleNextDiff = useCallback(() => {
    if (!diff || diff.hunks.length === 0) return;
    setDiffIndex((prev) => Math.min(prev + 1, diff.hunks.length - 1));
  }, [diff]);

  const handlePrevDiff = useCallback(() => {
    if (!diff || diff.hunks.length === 0) return;
    setDiffIndex((prev) => Math.max(prev - 1, 0));
  }, [diff]);

  useEffect(() => {
    if (diff && diff.hunks.length > 0 && diffRef.current) {
      const hunk = diff.hunks[diffIndex];
      if (hunk) {
        // Find the element for this hunk
        const el = diffRef.current.querySelector(`[data-hunk="${diffIndex}"]`);
        el?.scrollIntoView({ behavior: 'smooth', block: 'start' });
      }
    }
  }, [diff, diffIndex]);

  return (
    <div className="flex h-full flex-col gap-3 p-4">
      <input type="hidden" value={projectRoot ?? ''} onChange={(e) => onProjectRootChange(e.target.value)} />

      {/* ── Repo selection ── */}
      <div className="rounded border border-border p-3">
        <div className="flex items-center gap-1">
          <FolderOpen className="h-4 w-4 text-muted-foreground" />
          <input
            type="text"
            value={repoPath}
            onChange={(e) => setRepoPath(e.target.value)}
            placeholder="请选择或输入 Git 仓库路径"
            className="min-w-0 flex-1 rounded border border-border bg-background px-2 py-1.5 text-xs"
          />
          <button
            onClick={handleBrowse}
            className="rounded border border-border px-2 py-1.5 text-xs hover:bg-accent whitespace-nowrap"
          >
            浏览
          </button>
          <button
            onClick={handleOpenRepo}
            disabled={loading || !repoPath}
            className="rounded bg-primary px-3 py-1.5 text-xs font-medium text-primary-foreground disabled:opacity-50"
          >
            打开
          </button>
        </div>
      </div>

      {/* ── Status ── */}
      <div className="text-xs text-muted-foreground">{status}</div>

      {repoInfo && (
        <div className="flex min-h-0 flex-1 gap-2">
          {/* ── Left: file + version selector ── */}
          <div className="flex w-64 flex-col gap-2">
            {/* File selector */}
            <div className="flex flex-col rounded border border-border">
              <div className="flex items-center gap-1 border-b border-border bg-muted/30 px-2 py-1">
                <FileSearch className="h-3 w-3" />
                <span className="text-xs font-semibold">文件列表</span>
                <input
                  type="text"
                  value={fileFilter}
                  onChange={(e) => setFileFilter(e.target.value)}
                  placeholder="过滤..."
                  className="ml-auto w-24 rounded border border-border bg-background px-1.5 py-0.5 text-xs"
                />
              </div>
              <div className="max-h-48 overflow-auto">
                {filteredFiles.map((file) => (
                  <div
                    key={file}
                    onClick={() => handleSelectFile(file)}
                    className={cn(
                      'cursor-pointer truncate px-2 py-1 text-xs hover:bg-accent/30',
                      selectedFile === file ? 'bg-accent/50 font-medium' : '',
                    )}
                    title={file}
                  >
                    {file}
                  </div>
                ))}
              </div>
            </div>

            {/* Version selector */}
            {commits.length > 0 && (
              <div className="flex flex-col rounded border border-border">
                <div className="border-b border-border bg-muted/30 px-2 py-1 text-xs font-semibold">
                  提交历史 ({commits.length})
                </div>
                <div className="max-h-48 overflow-auto">
                  {commits.map((commit) => (
                    <div
                      key={commit.sha}
                      className="border-b border-border/50 px-2 py-1 text-xs"
                    >
                      <div className="flex items-center gap-1">
                        <input
                          type="radio"
                          name="oldCommit"
                          checked={oldCommit === commit.sha}
                          onChange={() => setOldCommit(commit.sha)}
                          className="h-2.5 w-2.5"
                        />
                        <input
                          type="radio"
                          name="newCommit"
                          checked={newCommit === commit.sha}
                          onChange={() => setNewCommit(commit.sha)}
                          className="h-2.5 w-2.5"
                        />
                        <span className="font-mono text-[10px] text-blue-500">{commit.shortSha}</span>
                      </div>
                      <div className="ml-5 truncate text-[10px] text-muted-foreground" title={commit.message}>
                        {commit.summary} ({commit.author})
                      </div>
                    </div>
                  ))}
                </div>
              </div>
            )}

            {/* Compare button */}
            <button
              onClick={handleCompare}
              disabled={loading || !selectedFile}
              className="flex items-center justify-center gap-1.5 rounded bg-primary px-3 py-1.5 text-xs font-medium text-primary-foreground disabled:opacity-50"
            >
              <GitCompare className="h-3 w-3" />
              {loading ? '比较中...' : '比较版本'}
            </button>
          </div>

          {/* ── Right: diff viewer ── */}
          <div className="flex min-w-0 flex-1 flex-col rounded border border-border">
            {/* Diff toolbar */}
            {diff && (
              <div className="flex items-center gap-2 border-b border-border bg-muted/30 px-2 py-1">
                <span className="text-xs font-semibold">差异</span>
                <div className="ml-auto flex items-center gap-2">
                  <span className="text-[10px] text-muted-foreground">
                    +{diff.stats.addedLines} -{diff.stats.deletedLines}
                  </span>
                  {diff.hunks.length > 0 && (
                    <>
                      <button onClick={handlePrevDiff} className="rounded p-1 hover:bg-accent">
                        <ArrowUp className="h-3 w-3" />
                      </button>
                      <span className="text-[10px]">
                        {diffIndex + 1}/{diff.hunks.length}
                      </span>
                      <button onClick={handleNextDiff} className="rounded p-1 hover:bg-accent">
                        <ArrowDown className="h-3 w-3" />
                      </button>
                    </>
                  )}
                </div>
              </div>
            )}

            {/* Diff content */}
            <div className="min-h-0 flex-1 overflow-auto" ref={diffRef}>
              {diff ? (
                <table className="w-full font-mono text-[11px] leading-relaxed">
                  <tbody>
                    {diff.diffLines.map((line, i) => {
                      // Check if this line is in a hunk boundary
                      const hunkIdx = diff.hunks.findIndex(
                        (h) =>
                          line.oldLineNo !== null &&
                          line.oldLineNo >= h.oldStart &&
                          line.oldLineNo < h.oldStart + h.oldCount,
                      );
                      return (
                        <tr
                          key={i}
                          data-hunk={hunkIdx >= 0 ? hunkIdx : undefined}
                          className={cn(
                            line.lineType === 'add' && 'bg-green-500/10',
                            line.lineType === 'delete' && 'bg-red-500/10',
                            line.lineType === 'context' && '',
                          )}
                        >
                          <td className="w-10 select-none px-2 text-right text-[10px] text-muted-foreground">
                            {line.oldLineNo ?? ''}
                          </td>
                          <td className="w-10 select-none px-2 text-right text-[10px] text-muted-foreground">
                            {line.newLineNo ?? ''}
                          </td>
                          <td className="w-4 select-none px-1 text-center">
                            {line.lineType === 'add' ? '+' : line.lineType === 'delete' ? '-' : ' '}
                          </td>
                          <td className="whitespace-pre-wrap break-all px-2">
                            {line.content}
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              ) : (
                <div className="flex h-full items-center justify-center text-xs text-muted-foreground">
                  选择文件和两个版本进行比较
                </div>
              )}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
