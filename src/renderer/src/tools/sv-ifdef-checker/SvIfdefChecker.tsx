/**
 * SvIfdefChecker — SystemVerilog ifdef/endif balance checker.
 *
 * Ported from the Python `sv_ifdef_checker` plugin.
 * Features: select file or directory, scan SV files, check ifdef balance,
 * display results table + detail panel + summary.
 */

import { useState, useCallback, useRef, useEffect } from 'react';
import { FolderOpen, Play, Copy, CheckCircle2, XCircle, AlertCircle } from 'lucide-react';
import { trpc } from '@renderer/lib/trpc';
import type { ToolComponentProps } from '../registry';
import { cn } from '@renderer/lib/utils';

type CheckResult = {
  filePath: string;
  totalIfdef: number;
  totalIfndef: number;
  totalEndif: number;
  inlineMatches: number;
  unmatchedIfdef: Array<{ type: string; condition: string; line: number; content: string }>;
  unmatchedEndif: Array<{ line: number; content: string }>;
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

export function SvIfdefChecker({ projectRoot, onProjectRootChange }: ToolComponentProps) {
  const [inputPath, setInputPath] = useState(projectRoot ?? '');
  const [mode, setMode] = useState<'directory' | 'file'>('directory');
  const [recursive, setRecursive] = useState(true);
  const [includeSvi, setIncludeSvi] = useState(true);
  const [_scanning, _setScanning] = useState(false);
  const [checking, setChecking] = useState(false);
  const [results, setResults] = useState<CheckResult[]>([]);
  const [summary, setSummary] = useState<CheckSummary | null>(null);
  const [selectedFile, setSelectedFile] = useState<CheckResult | null>(null);
  const [status, setStatus] = useState('就绪');
  const [copied, setCopied] = useState(false);
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
    setSelectedFile(null);

    try {
      const res = await trpc.tools.svIfdefChecker.check.mutate({
        inputPath,
        mode,
        recursive,
        includeSvi,
      });
      setResults(res.results as CheckResult[]);
      setSummary(res.summary as CheckSummary);
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
      const fileName = r.filePath.split(/[/\\]/).pop() ?? r.filePath;
      const status = r.errorMessage ? '❌' : r.isBalanced ? '✅' : '⚠️';
      lines.push(`${status} ${fileName} (ifdef=${r.totalIfdef}, ifndef=${r.totalIfndef}, endif=${r.totalEndif}, inline=${r.inlineMatches})`);
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

      {/* ── Summary ── */}
      {summary && (
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
      )}

      {/* ── Results table + detail ── */}
      {results.length > 0 && (
        <div className="flex min-h-0 flex-1 gap-2">
          {/* Results table */}
          <div className="flex min-w-0 flex-1 flex-col rounded border border-border">
            <div className="border-b border-border bg-muted/30 px-2 py-1 text-xs font-semibold">
              检查结果 ({results.length})
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
                  {results.map((r, i) => {
                    const fileName = r.filePath.split(/[/\\]/).pop() ?? r.filePath;
                    const isErr = !!r.errorMessage;
                    const isBalanced = r.isBalanced && !isErr;
                    return (
                      <tr
                        key={i}
                        onClick={() => setSelectedFile(r)}
                        className={cn(
                          'cursor-pointer border-b border-border/50 hover:bg-accent/30',
                          selectedFile?.filePath === r.filePath && 'bg-accent/50',
                        )}
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
                        <td className="px-2 py-1 truncate" title={r.filePath}>{fileName}</td>
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
              <div className="border-b border-border bg-muted/30 px-2 py-1 text-xs font-semibold">
                {(selectedFile.filePath.split(/[/\\]/).pop() ?? '')}
              </div>
              <div className="min-h-0 flex-1 overflow-auto p-2 text-xs">
                {selectedFile.errorMessage ? (
                  <div className="text-red-500">{selectedFile.errorMessage}</div>
                ) : selectedFile.isBalanced ? (
                  <div className="text-green-500">✅ 文件 ifdef/endif 完全匹配</div>
                ) : (
                  <div className="flex flex-col gap-2">
                    {selectedFile.unmatchedIfdef.length > 0 && (
                      <div>
                        <div className="mb-1 font-medium text-yellow-600 dark:text-yellow-400">
                          未匹配的 ifdef/ifndef ({selectedFile.unmatchedIfdef.length})
                        </div>
                        {selectedFile.unmatchedIfdef.map((u, i) => (
                          <div key={i} className="mb-1 rounded border border-border/50 p-1">
                            <div className="font-mono text-[10px] text-muted-foreground">
                              行 {u.line} - {u.type} {u.condition}
                            </div>
                            <div className="font-mono text-[10px] break-all">{u.content}</div>
                          </div>
                        ))}
                      </div>
                    )}
                    {selectedFile.unmatchedEndif.length > 0 && (
                      <div>
                        <div className="mb-1 font-medium text-red-600 dark:text-red-400">
                          多余的 endif ({selectedFile.unmatchedEndif.length})
                        </div>
                        {selectedFile.unmatchedEndif.map((u, i) => (
                          <div key={i} className="mb-1 rounded border border-border/50 p-1">
                            <div className="font-mono text-[10px] text-muted-foreground">行 {u.line}</div>
                            <div className="font-mono text-[10px] break-all">{u.content}</div>
                          </div>
                        ))}
                      </div>
                    )}
                  </div>
                )}
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
