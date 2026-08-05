/**
 * CodeLineCounter — Verilog/SystemVerilog code line counter tool.
 *
 * Ported from the Python `code_line_counter_plugin`.
 * Features: file/directory selection, extension filtering, line counting
 * with empty line / comment exclusion, CSV export.
 */

import { useState, useCallback } from 'react';
import { FolderOpen, FilePlus, Trash2, Play, Square, Download } from 'lucide-react';
import { trpc } from '@renderer/lib/trpc';
import type { ToolComponentProps } from '../registry';
import { cn } from '@renderer/lib/utils';

type FileInfo = {
  path: string;
  lines: number;
  extension: string;
  size: number;
};

type CountResult = {
  files: FileInfo[];
  summary: {
    totalFiles: number;
    totalLines: number;
    byExtension: Record<string, { files: number; lines: number }>;
    startTime: number;
    endTime: number;
  };
};

const VERILOG_EXTENSIONS = ['.v', '.sv', '.svh', '.svi'];

export function CodeLineCounter({ projectRoot, onProjectRootChange }: ToolComponentProps) {
  const [selectedPaths, setSelectedPaths] = useState<string[]>([]);
  const [extensions, setExtensions] = useState<Record<string, boolean>>({
    '.v': true, '.sv': true, '.svh': true, '.svi': true,
  });
  const [includeEmptyLines, setIncludeEmptyLines] = useState(true);
  const [includeComments, setIncludeComments] = useState(true);
  const [counting, setCounting] = useState(false);
  const [result, setResult] = useState<CountResult | null>(null);
  const [status, setStatus] = useState('就绪');

  const handleSelectFiles = useCallback(async () => {
    const res = await trpc.tools.selectFiles.mutate({
      title: '选择 Verilog 代码文件',
      filters: [{ name: 'Verilog', extensions: ['v', 'sv', 'svh', 'svi'] }],
      defaultPath: projectRoot ?? undefined,
    });
    if (res.paths.length > 0) {
      setSelectedPaths((prev) => [...prev, ...res.paths]);
    }
  }, [projectRoot]);

  const handleSelectDir = useCallback(async () => {
    const res = await trpc.tools.selectDirectory.mutate({
      title: '选择包含 Verilog 代码的目录',
      defaultPath: projectRoot ?? undefined,
    });
    if (res.path) {
      setSelectedPaths((prev) => [...prev, res.path]);
    }
  }, [projectRoot]);

  const handleClear = useCallback(() => {
    setSelectedPaths([]);
    setResult(null);
  }, []);

  const handleCount = useCallback(async () => {
    if (selectedPaths.length === 0) return;
    setCounting(true);
    setStatus('正在统计...');
    setResult(null);

    const selectedExts = Object.entries(extensions).filter(([, v]) => v).map(([k]) => k);
    try {
      const res = await trpc.tools.codeLineCounter.count.mutate({
        paths: selectedPaths,
        options: {
          extensions: selectedExts,
          includeEmptyLines,
          includeComments,
        },
      });
      setResult(res);
      setStatus(`统计完成 - 共 ${res.summary.totalFiles} 个文件，${res.summary.totalLines} 行代码`);
    } catch (err) {
      setStatus(`统计出错: ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      setCounting(false);
    }
  }, [selectedPaths, extensions, includeEmptyLines, includeComments]);

  const handleExport = useCallback(async () => {
    if (!result) return;
    const res = await trpc.tools.saveFileDialog.mutate({
      title: '导出统计结果',
      defaultPath: `code_line_count_${new Date().toISOString().slice(0, 10)}.csv`,
      filters: [{ name: 'CSV', extensions: ['csv'] }],
    });
    if (!res.path) return;
    try {
      await trpc.tools.codeLineCounter.exportCsv.mutate({
        savePath: res.path,
        result,
      });
      setStatus(`已导出到 ${res.path}`);
    } catch (err) {
      setStatus(`导出失败: ${err instanceof Error ? err.message : String(err)}`);
    }
  }, [result]);

  const formatSize = (bytes: number) => {
    if (bytes < 1024) return `${bytes} B`;
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
    return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  };

  return (
    <div className="flex h-full flex-col gap-3 p-4">
      {/* ── Path selection ── */}
      <div className="space-y-2">
        <div className="flex items-center gap-2">
          <button
            onClick={handleSelectFiles}
            className="flex items-center gap-1 rounded border border-border px-2 py-1 text-xs hover:bg-accent"
          >
            <FilePlus className="h-3 w-3" /> 选择文件
          </button>
          <button
            onClick={handleSelectDir}
            className="flex items-center gap-1 rounded border border-border px-2 py-1 text-xs hover:bg-accent"
          >
            <FolderOpen className="h-3 w-3" /> 选择目录
          </button>
          <button
            onClick={handleClear}
            className="flex items-center gap-1 rounded border border-border px-2 py-1 text-xs hover:bg-accent"
          >
            <Trash2 className="h-3 w-3" /> 清空
          </button>
        </div>
        {selectedPaths.length > 0 && (
          <div className="max-h-24 overflow-auto rounded border border-border bg-muted/30 p-2">
            {selectedPaths.map((p, i) => (
              <div key={i} className="truncate text-xs">{p}</div>
            ))}
          </div>
        )}
      </div>

      {/* ── Options ── */}
      <div className="flex flex-wrap items-center gap-4">
        <div className="flex items-center gap-2">
          <span className="text-xs text-muted-foreground">文件类型:</span>
          {VERILOG_EXTENSIONS.map((ext) => (
            <label key={ext} className="flex items-center gap-1 text-xs">
              <input
                type="checkbox"
                checked={extensions[ext] ?? false}
                onChange={(e) => setExtensions((prev) => ({ ...prev, [ext]: e.target.checked }))}
                className="h-3 w-3"
              />
              {ext}
            </label>
          ))}
        </div>
        <label className="flex items-center gap-1 text-xs">
          <input
            type="checkbox"
            checked={includeEmptyLines}
            onChange={(e) => setIncludeEmptyLines(e.target.checked)}
            className="h-3 w-3"
          />
          包含空行
        </label>
        <label className="flex items-center gap-1 text-xs">
          <input
            type="checkbox"
            checked={includeComments}
            onChange={(e) => setIncludeComments(e.target.checked)}
            className="h-3 w-3"
          />
          包含注释行
        </label>
      </div>

      {/* ── Actions ── */}
      <div className="flex items-center gap-2">
        <button
          onClick={handleCount}
          disabled={counting || selectedPaths.length === 0}
          className="flex items-center gap-1 rounded bg-primary px-3 py-1 text-xs text-primary-foreground disabled:opacity-50"
        >
          {counting ? <Square className="h-3 w-3" /> : <Play className="h-3 w-3" />}
          {counting ? '统计中' : '开始统计'}
        </button>
        <button
          onClick={handleExport}
          disabled={!result}
          className="flex items-center gap-1 rounded border border-border px-3 py-1 text-xs hover:bg-accent disabled:opacity-50"
        >
          <Download className="h-3 w-3" /> 导出 CSV
        </button>
        <span className="text-xs text-muted-foreground">{status}</span>
      </div>

      {/* ── Results ── */}
      <div className="flex min-h-0 flex-1 gap-3">
        {/* File table */}
        <div className="min-w-0 flex-1 overflow-auto rounded border border-border">
          {result && result.files.length > 0 ? (
            <table className="w-full text-xs">
              <thead className="sticky top-0 bg-muted">
                <tr>
                  <th className="px-3 py-2 text-left font-medium">文件路径</th>
                  <th className="px-3 py-2 text-right font-medium">行数</th>
                  <th className="px-3 py-2 text-center font-medium">类型</th>
                  <th className="px-3 py-2 text-right font-medium">大小</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-border">
                {result.files.map((file, i) => (
                  <tr key={i} className="hover:bg-accent">
                    <td className="truncate px-3 py-1.5" title={file.path}>{file.path}</td>
                    <td className="px-3 py-1.5 text-right tabular-nums">{file.lines}</td>
                    <td className="px-3 py-1.5 text-center text-muted-foreground">{file.extension}</td>
                    <td className="px-3 py-1.5 text-right text-muted-foreground">{formatSize(file.size)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          ) : (
            <div className="flex h-full items-center justify-center text-xs text-muted-foreground">
              {counting ? '统计中...' : '暂无数据'}
            </div>
          )}
        </div>

        {/* Summary */}
        {result && (
          <div className="w-64 shrink-0 overflow-auto rounded border border-border bg-muted/30 p-3">
            <h3 className="mb-2 text-xs font-semibold">统计汇总</h3>
            <div className="space-y-1 text-xs">
              <div className="flex justify-between">
                <span className="text-muted-foreground">总文件数:</span>
                <span className="tabular-nums">{result.summary.totalFiles}</span>
              </div>
              <div className="flex justify-between">
                <span className="text-muted-foreground">总行数:</span>
                <span className="tabular-nums">{result.summary.totalLines.toLocaleString()}</span>
              </div>
              <div className="flex justify-between">
                <span className="text-muted-foreground">耗时:</span>
                <span>{((result.summary.endTime - result.summary.startTime) / 1000).toFixed(2)} 秒</span>
              </div>
            </div>
            <h4 className="mt-3 mb-1 text-xs font-semibold">按类型统计</h4>
            <div className="space-y-1 text-xs">
              {Object.entries(result.summary.byExtension)
                .sort((a, b) => b[1].lines - a[1].lines)
                .map(([ext, stats]) => (
                  <div key={ext} className="flex justify-between">
                    <span className="text-muted-foreground">{ext}:</span>
                    <span className="tabular-nums">{stats.files} 文件, {stats.lines.toLocaleString()} 行</span>
                  </div>
                ))}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
