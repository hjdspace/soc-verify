/**
 * LogAnalyzer — EDA simulation log analysis tool.
 *
 * Ported from the Python `log_analyzer` plugin.
 * Features: file selection, log analysis, formatted result display, report export.
 */

import { useState, useCallback } from 'react';
import { FolderOpen, Play, Download, AlertCircle, AlertTriangle, AlertOctagon } from 'lucide-react';
import { trpc } from '@renderer/lib/trpc';
import type { ToolComponentProps } from '../registry';
import { cn } from '@renderer/lib/utils';

type ErrorEntry = {
  type: string;
  label: string;
  category: 'error' | 'fatal' | 'warning';
  time?: string;
  file?: string;
  line?: string;
  message: string;
  context: string[];
  occurrenceCount?: number;
};

type AnalysisSummary = {
  totalErrors: number;
  totalWarnings: number;
  totalFatals: number;
  entries: ErrorEntry[];
  filePath: string;
  analyzedAt: string;
};

export function LogAnalyzer({ projectRoot, onProjectRootChange }: ToolComponentProps) {
  const [logPath, setLogPath] = useState('');
  const [analyzing, setAnalyzing] = useState(false);
  const [summary, setSummary] = useState<AnalysisSummary | null>(null);
  const [status, setStatus] = useState('就绪');

  const handleSelectFile = useCallback(async () => {
    const result = await trpc.tools.selectFiles.mutate({
      title: '选择仿真日志文件',
      filters: [{ name: 'Log文件', extensions: ['log'] }, { name: '所有文件', extensions: ['*'] }],
      defaultPath: projectRoot ?? undefined,
    });
    if (result.paths.length > 0) {
      setLogPath(result.paths[0]);
    }
  }, [projectRoot]);

  const handleAnalyze = useCallback(async () => {
    if (!logPath) {
      setStatus('请先选择日志文件');
      return;
    }
    setAnalyzing(true);
    setStatus('分析中...');
    setSummary(null);
    try {
      const res = await trpc.tools.logAnalyzer.analyze.mutate({ logPath });
      setSummary(res);
      if (res.entries.length === 0) {
        setStatus('未发现任何错误或警告');
      } else {
        setStatus(`分析完成：致命 ${res.totalFatals}，错误 ${res.totalErrors}，警告 ${res.totalWarnings}`);
      }
    } catch (err) {
      setStatus(`分析失败: ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      setAnalyzing(false);
    }
  }, [logPath]);

  const handleExport = useCallback(async (format: 'html' | 'txt') => {
    if (!summary) return;
    const result = await trpc.tools.saveFileDialog.mutate({
      title: '导出分析报告',
      defaultPath: `log_report.${format}`,
      filters: format === 'html'
        ? [{ name: 'HTML文件', extensions: ['html'] }]
        : [{ name: '文本文件', extensions: ['txt'] }],
    });
    if (result.path) {
      try {
        await trpc.tools.logAnalyzer.exportReport.mutate({
          summary,
          savePath: result.path,
          format,
        });
        setStatus('报告导出成功');
      } catch (err) {
        setStatus(`导出失败: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
  }, [summary]);

  return (
    <div className="flex h-full flex-col gap-3 p-4">
      {/* ── File selection ── */}
      <div className="flex items-center gap-2">
        <button
          onClick={handleSelectFile}
          className="flex items-center gap-1.5 rounded border border-border px-3 py-1.5 text-xs hover:bg-accent"
        >
          <FolderOpen className="h-3.5 w-3.5" />
          选择日志
        </button>
        <input
          value={logPath}
          onChange={(e) => setLogPath(e.target.value)}
          placeholder="选择或输入仿真日志文件路径..."
          className="min-w-0 flex-1 rounded border border-border bg-background px-2 py-1.5 text-xs"
        />
        <button
          onClick={handleAnalyze}
          disabled={analyzing || !logPath}
          className="flex items-center gap-1.5 rounded bg-primary px-3 py-1.5 text-xs text-primary-foreground disabled:opacity-50"
        >
          <Play className="h-3.5 w-3.5" />
          {analyzing ? '分析中...' : '分析'}
        </button>
      </div>

      {/* ── Project root override (hidden input for drag-drop) ── */}
      <input
        type="hidden"
        value={projectRoot ?? ''}
        onChange={(e) => onProjectRootChange(e.target.value)}
      />

      {/* ── Status ── */}
      <div className="text-xs text-muted-foreground">{status}</div>

      {/* ── Summary cards ── */}
      {summary && (
        <div className="flex gap-3">
          <div className="flex items-center gap-2 rounded border border-border px-3 py-2">
            <AlertOctagon className="h-4 w-4 text-red-600" />
            <div>
              <div className="text-[10px] text-muted-foreground">致命</div>
              <div className="text-lg font-bold text-red-600">{summary.totalFatals}</div>
            </div>
          </div>
          <div className="flex items-center gap-2 rounded border border-border px-3 py-2">
            <AlertCircle className="h-4 w-4 text-red-500" />
            <div>
              <div className="text-[10px] text-muted-foreground">错误</div>
              <div className="text-lg font-bold text-red-500">{summary.totalErrors}</div>
            </div>
          </div>
          <div className="flex items-center gap-2 rounded border border-border px-3 py-2">
            <AlertTriangle className="h-4 w-4 text-yellow-500" />
            <div>
              <div className="text-[10px] text-muted-foreground">警告</div>
              <div className="text-lg font-bold text-yellow-500">{summary.totalWarnings}</div>
            </div>
          </div>
          <div className="flex-1" />
          <button
            onClick={() => handleExport('html')}
            className="flex items-center gap-1.5 rounded border border-border px-3 py-1.5 text-xs hover:bg-accent"
          >
            <Download className="h-3.5 w-3.5" />
            导出HTML
          </button>
          <button
            onClick={() => handleExport('txt')}
            className="flex items-center gap-1.5 rounded border border-border px-3 py-1.5 text-xs hover:bg-accent"
          >
            <Download className="h-3.5 w-3.5" />
            导出TXT
          </button>
        </div>
      )}

      {/* ── Results ── */}
      {summary && summary.entries.length > 0 && (
        <div className="min-h-0 flex-1 overflow-auto rounded border border-border">
          {summary.entries.map((entry, i) => (
            <div
              key={i}
              className={cn(
                'border-b border-border p-3',
                entry.category === 'warning' ? 'border-l-4 border-l-yellow-500' : 'border-l-4 border-l-red-500',
              )}
            >
              <div className="flex items-center gap-2">
                <span
                  className={cn(
                    'text-xs font-semibold',
                    entry.category === 'warning' ? 'text-yellow-500' : 'text-red-500',
                  )}
                >
                  {entry.label}
                </span>
                {entry.occurrenceCount && (
                  <span className="rounded bg-blue-500/10 px-1.5 py-0.5 text-[10px] text-blue-500">
                    重复 {entry.occurrenceCount} 次
                  </span>
                )}
              </div>
              <div className="mt-1 space-y-0.5 text-xs">
                {entry.time && <div className="text-muted-foreground">时间: {entry.time}</div>}
                {entry.file && (
                  <div className="text-muted-foreground">
                    文件: {entry.file}{entry.line ? `:${entry.line}` : ''}
                  </div>
                )}
                <div className="text-foreground">{entry.message}</div>
              </div>
              {entry.context.length > 0 && (
                <details className="mt-2">
                  <summary className="cursor-pointer text-[10px] text-muted-foreground hover:text-foreground">
                    上下文 ({entry.context.length} 行)
                  </summary>
                  <pre className="mt-1 overflow-auto rounded bg-muted p-2 text-[10px] leading-relaxed">
                    {entry.context.join('\n')}
                  </pre>
                </details>
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
