/**
 * SvIfdefChecker — SystemVerilog ifdef/endif balance checker.
 *
 * Ported from the Python `sv_ifdef_checker` plugin.
 * Features: select file or directory, scan SV files, check ifdef balance,
 * display results in three tabs (Overview / Details / Errors) with
 * filtering, double-click to open file with gvim.
 */

import { useState, useCallback, useRef, useEffect, useMemo } from 'react';
import {
  FolderOpen,
  Play,
  Copy,
  CheckCircle2,
  XCircle,
  AlertCircle,
  FileText,
  ListChecks,
  Bug,
  Filter,
  ExternalLink,
} from 'lucide-react';
import { trpc } from '@renderer/lib/trpc';
import type { ToolComponentProps } from '../registry';
import { cn } from '@renderer/lib/utils';

// ── Types ──────────────────────────────────────────────────────────

type UnmatchedIfdef = {
  type: string;
  condition: string;
  line: number;
  content: string;
};

type UnmatchedEndif = {
  line: number;
  content: string;
};

type CheckResult = {
  filePath: string;
  totalIfdef: number;
  totalIfndef: number;
  totalEndif: number;
  inlineMatches: number;
  unmatchedIfdef: UnmatchedIfdef[];
  unmatchedEndif: UnmatchedEndif[];
  isBalanced: boolean;
  errorMessage: string | null;
};

type CheckSummary = {
  totalFiles: number;
  balancedFiles: number;
  unbalancedFiles: number;
  errorFiles: number;
  totalIfdef: number;
  totalIfndef: number;
  totalEndif: number;
  totalInline: number;
};

type ErrorRow = {
  filePath: string;
  fileName: string;
  line: number;
  errorType: string;
  content: string;
  condition: string;
  category: 'unmatched-ifdef' | 'unmatched-ifndef' | 'extra-endif' | 'file-error';
};

type StatusFilter = 'all' | 'balanced' | 'unbalanced' | 'error';
type ErrorFilter = 'all' | 'unmatched-ifdef' | 'unmatched-ifndef' | 'extra-endif' | 'file-error';
type TabId = 'overview' | 'details' | 'errors';

// ── Helper functions ───────────────────────────────────────────────

function getFileName(filePath: string): string {
  return filePath.split(/[/\\]/).pop() ?? filePath;
}

function getRelativePath(filePath: string, basePath: string): string {
  if (basePath && filePath.startsWith(basePath)) {
    const rel = filePath.substring(basePath.length).replace(/^[/\\]/, '');
    return rel || getFileName(filePath);
  }
  return getFileName(filePath);
}

// ── Sub-components ─────────────────────────────────────────────────

/** Summary cards row. */
function SummaryCards({ summary }: { summary: CheckSummary }) {
  return (
    <div className="grid grid-cols-4 gap-2">
      <div className="rounded border border-border p-2 text-center">
        <div className="text-lg font-bold">{summary.totalFiles}</div>
        <div className="text-[10px] text-muted-foreground">总文件数</div>
      </div>
      <div className="rounded border border-green-500/30 bg-green-500/5 p-2 text-center">
        <div className="text-lg font-bold text-green-600 dark:text-green-400">{summary.balancedFiles}</div>
        <div className="text-[10px] text-muted-foreground">平衡</div>
      </div>
      <div className="rounded border border-yellow-500/30 bg-yellow-500/5 p-2 text-center">
        <div className="text-lg font-bold text-yellow-600 dark:text-yellow-400">{summary.unbalancedFiles}</div>
        <div className="text-[10px] text-muted-foreground">不平衡</div>
      </div>
      <div className="rounded border border-red-500/30 bg-red-500/5 p-2 text-center">
        <div className="text-lg font-bold text-red-600 dark:text-red-400">{summary.errorFiles}</div>
        <div className="text-[10px] text-muted-foreground">错误</div>
      </div>
    </div>
  );
}

/** Instruction statistics row. */
function InstructionStats({ summary }: { summary: CheckSummary }) {
  return (
    <div className="grid grid-cols-4 gap-2">
      <div className="rounded border border-border px-2 py-1 text-center">
        <span className="text-xs text-muted-foreground">ifdef: </span>
        <span className="text-xs font-bold">{summary.totalIfdef}</span>
      </div>
      <div className="rounded border border-border px-2 py-1 text-center">
        <span className="text-xs text-muted-foreground">ifndef: </span>
        <span className="text-xs font-bold">{summary.totalIfndef}</span>
      </div>
      <div className="rounded border border-border px-2 py-1 text-center">
        <span className="text-xs text-muted-foreground">endif: </span>
        <span className="text-xs font-bold">{summary.totalEndif}</span>
      </div>
      <div className="rounded border border-border px-2 py-1 text-center">
        <span className="text-xs text-muted-foreground">内联匹配: </span>
        <span className="text-xs font-bold">{summary.totalInline}</span>
      </div>
    </div>
  );
}

/** Overview tab content — summary + problem files list. */
function OverviewTab({
  summary,
  results,
  basePath,
  onOpenFile,
}: {
  summary: CheckSummary;
  results: CheckResult[];
  basePath: string;
  onOpenFile: (filePath: string, lineNumber?: number) => void;
}) {
  const problemFiles = results.filter((r) => !r.isBalanced || r.errorMessage);

  return (
    <div className="flex min-h-0 flex-1 flex-col gap-3 overflow-auto p-2">
      <SummaryCards summary={summary} />
      <InstructionStats summary={summary} />

      {problemFiles.length > 0 && (
        <div className="flex flex-col gap-1">
          <div className="text-xs font-semibold text-muted-foreground">
            存在问题的文件 ({problemFiles.length})
          </div>
          {problemFiles.map((r, i) => {
            const fileName = getFileName(r.filePath);
            const relPath = getRelativePath(r.filePath, basePath);
            return (
              <div key={i} className="rounded border border-border/50 p-2 text-xs">
                <div className="flex items-center gap-2">
                  {r.errorMessage ? (
                    <AlertCircle className="h-3.5 w-3.5 shrink-0 text-red-500" />
                  ) : (
                    <XCircle className="h-3.5 w-3.5 shrink-0 text-yellow-500" />
                  )}
                  <span className="font-medium">{fileName}</span>
                  <button
                    onClick={() => onOpenFile(r.filePath)}
                    className="ml-auto flex items-center gap-0.5 text-[10px] text-muted-foreground hover:text-foreground"
                    title="用 gvim 打开"
                  >
                    <ExternalLink className="h-3 w-3" />
                    打开
                  </button>
                </div>
                <div className="mt-0.5 text-[10px] text-muted-foreground">{relPath}</div>
                {r.errorMessage && (
                  <div className="mt-1 text-red-500">错误: {r.errorMessage}</div>
                )}
                {r.unmatchedIfdef.length > 0 && (
                  <div className="mt-1">
                    <div className="text-yellow-600 dark:text-yellow-400">
                      未匹配的 ifdef/ifndef: {r.unmatchedIfdef.length} 个
                    </div>
                    {r.unmatchedIfdef.map((u, j) => (
                      <button
                        key={j}
                        onClick={() => onOpenFile(r.filePath, u.line)}
                        className="mt-0.5 block w-full rounded px-1 py-0.5 text-left font-mono text-[10px] hover:bg-accent/30"
                        title="双击跳转到该行"
                      >
                        行 {u.line}: {u.type} {u.condition}
                      </button>
                    ))}
                  </div>
                )}
                {r.unmatchedEndif.length > 0 && (
                  <div className="mt-1">
                    <div className="text-red-600 dark:text-red-400">
                      多余的 endif: {r.unmatchedEndif.length} 个
                    </div>
                    {r.unmatchedEndif.map((u, j) => (
                      <button
                        key={j}
                        onClick={() => onOpenFile(r.filePath, u.line)}
                        className="mt-0.5 block w-full rounded px-1 py-0.5 text-left font-mono text-[10px] hover:bg-accent/30"
                        title="双击跳转到该行"
                      >
                        行 {u.line}: endif
                      </button>
                    ))}
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

/** Details tab — full results table with status filter + double-click to open. */
function DetailsTab({
  results,
  basePath,
  onOpenFile,
}: {
  results: CheckResult[];
  basePath: string;
  onOpenFile: (filePath: string, lineNumber?: number) => void;
}) {
  const [filter, setFilter] = useState<StatusFilter>('all');
  const [selectedFile, setSelectedFile] = useState<CheckResult | null>(null);

  const filteredResults = useMemo(() => {
    if (filter === 'all') return results;
    return results.filter((r) => {
      if (filter === 'error') return !!r.errorMessage;
      if (filter === 'balanced') return r.isBalanced && !r.errorMessage;
      if (filter === 'unbalanced') return !r.isBalanced && !r.errorMessage;
      return true;
    });
  }, [results, filter]);

  const filterCounts = useMemo(() => {
    return {
      all: results.length,
      balanced: results.filter((r) => r.isBalanced && !r.errorMessage).length,
      unbalanced: results.filter((r) => !r.isBalanced && !r.errorMessage).length,
      error: results.filter((r) => !!r.errorMessage).length,
    };
  }, [results]);

  return (
    <div className="flex min-h-0 flex-1 gap-2">
      {/* Results table */}
      <div className="flex min-w-0 flex-1 flex-col rounded border border-border">
        {/* Filter bar */}
        <div className="flex items-center gap-2 border-b border-border bg-muted/30 px-2 py-1">
          <Filter className="h-3 w-3 text-muted-foreground" />
          <div className="flex items-center gap-1">
            {([
              ['all', '全部', filterCounts.all],
              ['balanced', '正常', filterCounts.balanced],
              ['unbalanced', '不匹配', filterCounts.unbalanced],
              ['error', '错误', filterCounts.error],
            ] as const).map(([value, label, count]) => (
              <button
                key={value}
                onClick={() => setFilter(value)}
                className={cn(
                  'rounded px-2 py-0.5 text-[10px] font-medium',
                  filter === value
                    ? 'bg-primary text-primary-foreground'
                    : 'text-muted-foreground hover:bg-accent',
                )}
              >
                {label} ({count})
              </button>
            ))}
          </div>
          <span className="ml-auto text-[10px] text-muted-foreground">
            显示 {filteredResults.length}/{results.length}
          </span>
        </div>

        <div className="min-h-0 flex-1 overflow-auto">
          <table className="w-full text-xs">
            <thead className="sticky top-0 bg-muted/50">
              <tr className="text-left">
                <th className="px-2 py-1">状态</th>
                <th className="px-2 py-1">文件名</th>
                <th className="px-2 py-1 text-center">ifdef</th>
                <th className="px-2 py-1 text-center">ifndef</th>
                <th className="px-2 py-1 text-center">endif</th>
                <th className="px-2 py-1 text-center">inline</th>
              </tr>
            </thead>
            <tbody>
              {filteredResults.map((r, i) => {
                const fileName = getFileName(r.filePath);
                const relPath = getRelativePath(r.filePath, basePath);
                const isErr = !!r.errorMessage;
                const isBalanced = r.isBalanced && !isErr;
                return (
                  <tr
                    key={i}
                    onClick={() => setSelectedFile(r)}
                    onDoubleClick={() => onOpenFile(r.filePath)}
                    className={cn(
                      'cursor-pointer border-b border-border/50 hover:bg-accent/30',
                      selectedFile?.filePath === r.filePath && 'bg-accent/50',
                    )}
                    title="双击用 gvim 打开文件"
                  >
                    <td className="px-2 py-1">
                      {isErr ? (
                        <AlertCircle className="h-3.5 w-3.5 text-red-500" />
                      ) : isBalanced ? (
                        <CheckCircle2 className="h-3.5 w-3.5 text-green-500" />
                      ) : (
                        <XCircle className="h-3.5 w-3.5 text-yellow-500" />
                      )}
                    </td>
                    <td className="px-2 py-1 truncate" title={relPath}>{fileName}</td>
                    <td className="px-2 py-1 text-center">{r.totalIfdef}</td>
                    <td className="px-2 py-1 text-center">{r.totalIfndef}</td>
                    <td className="px-2 py-1 text-center">{r.totalEndif}</td>
                    <td className="px-2 py-1 text-center">{r.inlineMatches}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </div>

      {/* Detail panel */}
      {selectedFile && (
        <div className="flex w-72 flex-col rounded border border-border">
          <div className="flex items-center gap-1 border-b border-border bg-muted/30 px-2 py-1">
            <span className="text-xs font-semibold">{getFileName(selectedFile.filePath)}</span>
            <button
              onClick={() => onOpenFile(selectedFile.filePath)}
              className="ml-auto flex items-center gap-0.5 text-[10px] text-muted-foreground hover:text-foreground"
              title="用 gvim 打开"
            >
              <ExternalLink className="h-3 w-3" />
              打开
            </button>
          </div>
          <div className="min-h-0 flex-1 overflow-auto p-2 text-xs">
            {selectedFile.errorMessage ? (
              <div className="text-red-500">{selectedFile.errorMessage}</div>
            ) : selectedFile.isBalanced ? (
              <div className="text-green-500">文件 ifdef/endif 完全匹配</div>
            ) : (
              <div className="flex flex-col gap-2">
                {selectedFile.unmatchedIfdef.length > 0 && (
                  <div>
                    <div className="mb-1 font-medium text-yellow-600 dark:text-yellow-400">
                      未匹配的 ifdef/ifndef ({selectedFile.unmatchedIfdef.length})
                    </div>
                    {selectedFile.unmatchedIfdef.map((u, i) => (
                      <button
                        key={i}
                        onClick={() => onOpenFile(selectedFile.filePath, u.line)}
                        className="mb-1 block w-full rounded border border-border/50 p-1 text-left hover:bg-accent/30"
                        title="点击用 gvim 打开并跳转到该行"
                      >
                        <div className="font-mono text-[10px] text-muted-foreground">
                          行 {u.line} - {u.type} {u.condition}
                        </div>
                        <div className="font-mono text-[10px] break-all">{u.content}</div>
                      </button>
                    ))}
                  </div>
                )}
                {selectedFile.unmatchedEndif.length > 0 && (
                  <div>
                    <div className="mb-1 font-medium text-red-600 dark:text-red-400">
                      多余的 endif ({selectedFile.unmatchedEndif.length})
                    </div>
                    {selectedFile.unmatchedEndif.map((u, i) => (
                      <button
                        key={i}
                        onClick={() => onOpenFile(selectedFile.filePath, u.line)}
                        className="mb-1 block w-full rounded border border-border/50 p-1 text-left hover:bg-accent/30"
                        title="点击用 gvim 打开并跳转到该行"
                      >
                        <div className="font-mono text-[10px] text-muted-foreground">行 {u.line}</div>
                        <div className="font-mono text-[10px] break-all">{u.content}</div>
                      </button>
                    ))}
                  </div>
                )}
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

/** Errors tab — flat list of all errors with type filter + double-click to open at line. */
function ErrorsTab({
  results,
  basePath,
  onOpenFile,
}: {
  results: CheckResult[];
  basePath: string;
  onOpenFile: (filePath: string, lineNumber?: number) => void;
}) {
  const [filter, setFilter] = useState<ErrorFilter>('all');

  const errorRows = useMemo(() => {
    const rows: ErrorRow[] = [];
    for (const r of results) {
      const relPath = getRelativePath(r.filePath, basePath);

      if (r.errorMessage) {
        rows.push({
          filePath: r.filePath,
          fileName: relPath,
          line: 0,
          errorType: '文件读取错误',
          content: r.errorMessage,
          condition: '',
          category: 'file-error',
        });
        continue;
      }

      for (const u of r.unmatchedIfdef) {
        rows.push({
          filePath: r.filePath,
          fileName: relPath,
          line: u.line,
          errorType: `未匹配的 ${u.type}`,
          content: u.content,
          condition: u.condition,
          category: u.type === 'ifdef' ? 'unmatched-ifdef' : 'unmatched-ifndef',
        });
      }

      for (const u of r.unmatchedEndif) {
        rows.push({
          filePath: r.filePath,
          fileName: relPath,
          line: u.line,
          errorType: '多余的 endif',
          content: u.content,
          condition: '',
          category: 'extra-endif',
        });
      }
    }
    return rows;
  }, [results, basePath]);

  const filteredErrors = useMemo(() => {
    if (filter === 'all') return errorRows;
    return errorRows.filter((r) => r.category === filter);
  }, [errorRows, filter]);

  const errorCounts = useMemo(() => {
    return {
      all: errorRows.length,
      'unmatched-ifdef': errorRows.filter((r) => r.category === 'unmatched-ifdef').length,
      'unmatched-ifndef': errorRows.filter((r) => r.category === 'unmatched-ifndef').length,
      'extra-endif': errorRows.filter((r) => r.category === 'extra-endif').length,
      'file-error': errorRows.filter((r) => r.category === 'file-error').length,
    };
  }, [errorRows]);

  if (errorRows.length === 0) {
    return (
      <div className="flex min-h-0 flex-1 items-center justify-center text-xs text-muted-foreground">
        <CheckCircle2 className="mr-2 h-5 w-5 text-green-500" />
        没有发现错误
      </div>
    );
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col rounded border border-border">
      {/* Filter bar */}
      <div className="flex items-center gap-2 border-b border-border bg-muted/30 px-2 py-1">
        <Filter className="h-3 w-3 text-muted-foreground" />
        <div className="flex flex-wrap items-center gap-1">
          {([
            ['all', '全部', errorCounts.all],
            ['unmatched-ifdef', '未匹配 ifdef', errorCounts['unmatched-ifdef']],
            ['unmatched-ifndef', '未匹配 ifndef', errorCounts['unmatched-ifndef']],
            ['extra-endif', '多余 endif', errorCounts['extra-endif']],
            ['file-error', '文件错误', errorCounts['file-error']],
          ] as const).map(([value, label, count]) => (
            <button
              key={value}
              onClick={() => setFilter(value)}
              className={cn(
                'rounded px-2 py-0.5 text-[10px] font-medium',
                filter === value
                  ? 'bg-primary text-primary-foreground'
                  : 'text-muted-foreground hover:bg-accent',
              )}
            >
              {label} ({count})
            </button>
          ))}
        </div>
        <span className="ml-auto text-[10px] text-muted-foreground">
          显示 {filteredErrors.length}/{errorRows.length}
        </span>
      </div>

      {/* Error table */}
      <div className="min-h-0 flex-1 overflow-auto">
        <table className="w-full text-xs">
          <thead className="sticky top-0 bg-muted/50">
            <tr className="text-left">
              <th className="px-2 py-1">文件</th>
              <th className="px-2 py-1 text-center">行号</th>
              <th className="px-2 py-1">类型</th>
              <th className="px-2 py-1">内容</th>
              <th className="px-2 py-1">条件</th>
            </tr>
          </thead>
          <tbody>
            {filteredErrors.map((row, i) => (
              <tr
                key={i}
                onDoubleClick={() => row.line > 0 && onOpenFile(row.filePath, row.line)}
                className={cn(
                  'cursor-pointer border-b border-border/50 hover:bg-accent/30',
                  row.category === 'file-error' && 'bg-red-500/5',
                  row.category === 'extra-endif' && 'bg-red-500/5',
                  (row.category === 'unmatched-ifdef' || row.category === 'unmatched-ifndef') &&
                    'bg-yellow-500/5',
                )}
                title={row.line > 0 ? '双击用 gvim 打开并跳转到该行' : '双击用 gvim 打开文件'}
              >
                <td className="px-2 py-1 truncate" title={row.filePath}>{row.fileName}</td>
                <td className="px-2 py-1 text-center font-mono">
                  {row.line > 0 ? row.line : '-'}
                </td>
                <td className="px-2 py-1">
                  <span
                    className={cn(
                      'rounded px-1 py-0.5 text-[10px] font-medium',
                      row.category === 'file-error' && 'bg-red-500/10 text-red-600 dark:text-red-400',
                      row.category === 'extra-endif' && 'bg-red-500/10 text-red-600 dark:text-red-400',
                      (row.category === 'unmatched-ifdef' || row.category === 'unmatched-ifndef') &&
                        'bg-yellow-500/10 text-yellow-600 dark:text-yellow-400',
                    )}
                  >
                    {row.errorType}
                  </span>
                </td>
                <td className="px-2 py-1 font-mono text-[10px] break-all">{row.content}</td>
                <td className="px-2 py-1 font-mono text-[10px]">{row.condition}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

// ── Main component ─────────────────────────────────────────────────

export function SvIfdefChecker({ projectRoot, onProjectRootChange }: ToolComponentProps) {
  const [inputPath, setInputPath] = useState(projectRoot ?? '');
  const [mode, setMode] = useState<'directory' | 'file'>('directory');
  const [recursive, setRecursive] = useState(true);
  const [includeSvi, setIncludeSvi] = useState(true);
  const [checking, setChecking] = useState(false);
  const [results, setResults] = useState<CheckResult[]>([]);
  const [summary, setSummary] = useState<CheckSummary | null>(null);
  const [activeTab, setActiveTab] = useState<TabId>('overview');
  const [status, setStatus] = useState('就绪');
  const [copied, setCopied] = useState(false);
  const [basePath, setBasePath] = useState('');
  const _logRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (projectRoot) setInputPath(projectRoot);
  }, [projectRoot]);

  const handleBrowse = useCallback(async () => {
    if (mode === 'directory') {
      const res = await trpc.tools.selectDirectory.mutate({
        title: '选择目录',
        defaultPath: inputPath || undefined,
      });
      if (res.path) {
        setInputPath(res.path);
        onProjectRootChange(res.path);
      }
    } else {
      const res = await trpc.tools.selectFiles.mutate({
        title: '选择 SV 文件',
        filters: [{ name: 'SystemVerilog', extensions: ['sv', 'svi'] }],
        defaultPath: inputPath || undefined,
      });
      if (res.paths.length > 0) {
        setInputPath(res.paths[0]);
      }
    }
  }, [mode, inputPath, onProjectRootChange]);

  const handleCheck = useCallback(async () => {
    if (!inputPath) {
      setStatus('请先选择路径');
      return;
    }

    setChecking(true);
    setStatus('正在检查...');
    setResults([]);
    setSummary(null);
    setActiveTab('overview');

    try {
      const res = await trpc.tools.svIfdefChecker.check.mutate({
        inputPath,
        mode,
        recursive,
        includeSvi,
      });
      setResults(res.results as CheckResult[]);
      setSummary(res.summary as CheckSummary);
      // Compute base path for relative path display.
      if (mode === 'directory') {
        setBasePath(inputPath);
      } else {
        const lastSep = Math.max(inputPath.lastIndexOf('/'), inputPath.lastIndexOf('\\'));
        setBasePath(lastSep >= 0 ? inputPath.substring(0, lastSep) : '');
      }
      const s = res.summary as CheckSummary;
      setStatus(
        `检查完成: ${s.balancedFiles}/${s.totalFiles} 个文件平衡, ${s.unbalancedFiles} 个不平衡, ${s.errorFiles} 个错误`,
      );
    } catch (err) {
      setStatus(`检查失败: ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      setChecking(false);
    }
  }, [inputPath, mode, recursive, includeSvi]);

  const handleOpenFile = useCallback(async (filePath: string, lineNumber?: number) => {
    try {
      await trpc.tools.svIfdefChecker.openFile.mutate({
        filePath,
        lineNumber: lineNumber ?? null,
      });
      setStatus(`已打开文件: ${getFileName(filePath)}${lineNumber ? ` (行 ${lineNumber})` : ''}`);
    } catch (err) {
      setStatus(`打开文件失败: ${err instanceof Error ? err.message : String(err)}`);
    }
  }, []);

  const handleCopy = useCallback(() => {
    const lines: string[] = [];
    if (summary) {
      lines.push('=== 汇总 ===');
      lines.push(`总文件数: ${summary.totalFiles}`);
      lines.push(`平衡文件: ${summary.balancedFiles}`);
      lines.push(`不平衡文件: ${summary.unbalancedFiles}`);
      lines.push(`错误文件: ${summary.errorFiles}`);
      lines.push(`ifdef 总数: ${summary.totalIfdef}`);
      lines.push(`ifndef 总数: ${summary.totalIfndef}`);
      lines.push(`endif 总数: ${summary.totalEndif}`);
      lines.push(`inline 匹配: ${summary.totalInline}`);
      lines.push('');
    }
    for (const r of results) {
      const fileName = getFileName(r.filePath);
      const s = r.errorMessage ? '[错误]' : r.isBalanced ? '[正常]' : '[不匹配]';
      lines.push(`${s} ${fileName} (ifdef=${r.totalIfdef}, ifndef=${r.totalIfndef}, endif=${r.totalEndif}, inline=${r.inlineMatches})`);
      if (!r.isBalanced || r.errorMessage) {
        lines.push(`  路径: ${r.filePath}`);
        if (r.errorMessage) lines.push(`  错误: ${r.errorMessage}`);
        for (const u of r.unmatchedIfdef) {
          lines.push(`  未匹配 ${u.type} (行 ${u.line}): ${u.content}`);
        }
        for (const u of r.unmatchedEndif) {
          lines.push(`  多余 endif (行 ${u.line}): ${u.content}`);
        }
      }
      lines.push('');
    }
    navigator.clipboard.writeText(lines.join('\n'));
    setCopied(true);
    setTimeout(() => setCopied(false), 1500);
  }, [results, summary]);

  const problemCount = results.filter((r) => !r.isBalanced || r.errorMessage).length;

  return (
    <div className="flex h-full flex-col gap-3 p-4">
      <input type="hidden" value={projectRoot ?? ''} onChange={(e) => onProjectRootChange(e.target.value)} />

      {/* ── Input config ── */}
      <div className="rounded border border-border p-3">
        <div className="flex items-center gap-4">
          {/* Mode switch */}
          <div className="flex items-center gap-2">
            <label className="flex items-center gap-1 text-xs cursor-pointer">
              <input
                type="radio"
                checked={mode === 'directory'}
                onChange={() => setMode('directory')}
                className="h-3 w-3"
              />
              目录扫描
            </label>
            <label className="flex items-center gap-1 text-xs cursor-pointer">
              <input
                type="radio"
                checked={mode === 'file'}
                onChange={() => setMode('file')}
                className="h-3 w-3"
              />
              单文件
            </label>
          </div>

          {/* Options */}
          {mode === 'directory' && (
            <div className="flex items-center gap-4">
              <label className="flex items-center gap-1 text-xs cursor-pointer">
                <input
                  type="checkbox"
                  checked={recursive}
                  onChange={(e) => setRecursive(e.target.checked)}
                  className="h-3 w-3"
                />
                递归子目录
              </label>
              <label className="flex items-center gap-1 text-xs cursor-pointer">
                <input
                  type="checkbox"
                  checked={includeSvi}
                  onChange={(e) => setIncludeSvi(e.target.checked)}
                  className="h-3 w-3"
                />
                包含 .svi
              </label>
            </div>
          )}
        </div>

        {/* Path input */}
        <div className="mt-2 flex items-center gap-1">
          <input
            type="text"
            value={inputPath}
            onChange={(e) => setInputPath(e.target.value)}
            placeholder={mode === 'directory' ? '请选择或输入目录路径' : '请选择或输入 SV 文件路径'}
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
      </div>

      {/* ── Buttons ── */}
      <div className="flex items-center gap-2">
        <button
          onClick={handleCheck}
          disabled={checking || !inputPath}
          className="flex items-center gap-1.5 rounded bg-primary px-4 py-1.5 text-xs font-medium text-primary-foreground disabled:opacity-50"
        >
          <Play className={cn('h-3 w-3', checking && 'animate-pulse')} />
          {checking ? '检查中...' : '开始检查'}
        </button>
        {results.length > 0 && (
          <button
            onClick={handleCopy}
            className="flex items-center gap-1.5 rounded border border-border px-4 py-1.5 text-xs font-medium hover:bg-accent"
          >
            {copied ? <CheckCircle2 className="h-3 w-3 text-green-500" /> : <Copy className="h-3 w-3" />}
            {copied ? '已复制' : '复制结果'}
          </button>
        )}
      </div>

      {/* ── Status ── */}
      <div className="text-xs text-muted-foreground">{status}</div>

      {/* ── Summary (always visible when results exist) ── */}
      {summary && <SummaryCards summary={summary} />}

      {/* ── Tabbed results ── */}
      {results.length > 0 && (
        <div className="flex min-h-0 flex-1 flex-col rounded border border-border">
          {/* Tab headers */}
          <div className="flex items-center gap-1 border-b border-border bg-muted/30 px-1">
            <TabButton
              active={activeTab === 'overview'}
              onClick={() => setActiveTab('overview')}
              icon={<ListChecks className="h-3 w-3" />}
              label="概览"
              badge={problemCount > 0 ? problemCount : undefined}
            />
            <TabButton
              active={activeTab === 'details'}
              onClick={() => setActiveTab('details')}
              icon={<FileText className="h-3 w-3" />}
              label="详细结果"
              badge={results.length}
            />
            <TabButton
              active={activeTab === 'errors'}
              onClick={() => setActiveTab('errors')}
              icon={<Bug className="h-3 w-3" />}
              label="错误详情"
              badge={problemCount > 0 ? problemCount : undefined}
              badgeColor="red"
            />
          </div>

          {/* Tab content */}
          <div className="flex min-h-0 flex-1 flex-col p-2">
            {activeTab === 'overview' && summary && (
              <OverviewTab
                summary={summary}
                results={results}
                basePath={basePath}
                onOpenFile={handleOpenFile}
              />
            )}
            {activeTab === 'details' && (
              <DetailsTab
                results={results}
                basePath={basePath}
                onOpenFile={handleOpenFile}
              />
            )}
            {activeTab === 'errors' && (
              <ErrorsTab
                results={results}
                basePath={basePath}
                onOpenFile={handleOpenFile}
              />
            )}
          </div>
        </div>
      )}
    </div>
  );
}

// ── Tab button helper ──────────────────────────────────────────────

function TabButton({
  active,
  onClick,
  icon,
  label,
  badge,
  badgeColor = 'primary',
}: {
  active: boolean;
  onClick: () => void;
  icon: React.ReactNode;
  label: string;
  badge?: number;
  badgeColor?: 'primary' | 'red';
}) {
  return (
    <button
      onClick={onClick}
      className={cn(
        'flex items-center gap-1.5 rounded-t px-3 py-1.5 text-xs font-medium',
        active
          ? 'border-b-2 border-primary bg-background text-foreground'
          : 'text-muted-foreground hover:text-foreground',
      )}
    >
      {icon}
      {label}
      {badge !== undefined && badge > 0 && (
        <span
          className={cn(
            'rounded-full px-1.5 py-0.5 text-[9px] font-bold',
            badgeColor === 'red'
              ? 'bg-red-500/10 text-red-600 dark:text-red-400'
              : 'bg-primary/10 text-primary',
          )}
        >
          {badge}
        </span>
      )}
    </button>
  );
}
