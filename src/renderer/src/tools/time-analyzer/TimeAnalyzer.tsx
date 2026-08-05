/**
 * TimeAnalyzer — simulation time and memory analysis tool.
 *
 * Ported from the Python `time_analyzer` plugin.
 * Features: directory selection, time/memory extraction, table display,
 * unit conversion, CSV export.
 */

import { useState, useCallback } from 'react';
import { FolderOpen, Play, Download, Clock } from 'lucide-react';
import { trpc } from '@renderer/lib/trpc';
import type { ToolComponentProps } from '../registry';
import { cn } from '@renderer/lib/utils';

type CaseTimeData = {
  case: string;
  compile: number;
  sim: number;
  total: number;
  compileMemory: number;
  simMemory: number;
};

type AnalysisResult = {
  cases: CaseTimeData[];
  totals: CaseTimeData;
};

type TimeUnit = 'seconds' | 'minutes' | 'hours';

const UNIT_LABELS: Record<TimeUnit, string> = {
  seconds: '秒',
  minutes: '分钟',
  hours: '小时',
};

function formatTime(minutes: number, unit: TimeUnit): string {
  const factor = unit === 'seconds' ? 60 : unit === 'hours' ? 1 / 60 : 1;
  const value = minutes * factor;
  if (value === 0) return '0';
  if (value < 0.01) return value.toFixed(4);
  if (value < 1) return value.toFixed(3);
  return value.toFixed(2);
}

export function TimeAnalyzer({ projectRoot, onProjectRootChange }: ToolComponentProps) {
  const [analysisDir, setAnalysisDir] = useState(projectRoot ?? '');
  const [analyzing, setAnalyzing] = useState(false);
  const [result, setResult] = useState<AnalysisResult | null>(null);
  const [unit, setUnit] = useState<TimeUnit>('minutes');
  const [status, setStatus] = useState('就绪');

  const handleSelectDir = useCallback(async () => {
    const res = await trpc.tools.selectDirectory.mutate({
      title: '选择分析目录',
      defaultPath: analysisDir || undefined,
    });
    if (res.path) setAnalysisDir(res.path);
  }, [analysisDir]);

  const handleAnalyze = useCallback(async () => {
    if (!analysisDir) {
      setStatus('请先选择分析目录');
      return;
    }
    setAnalyzing(true);
    setStatus('扫描中...');
    setResult(null);
    try {
      const res = await trpc.tools.timeAnalyzer.analyze.mutate({ analysisDir });
      setResult(res);
      setStatus(`分析完成：找到 ${res.cases.length} 个用例`);
    } catch (err) {
      setStatus(`分析失败: ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      setAnalyzing(false);
    }
  }, [analysisDir]);

  const handleExport = useCallback(async () => {
    if (!result) return;
    const res = await trpc.tools.saveFileDialog.mutate({
      title: '导出CSV',
      defaultPath: `simulation_time_${Date.now()}.csv`,
      filters: [{ name: 'CSV文件', extensions: ['csv'] }],
    });
    if (res.path) {
      try {
        await trpc.tools.timeAnalyzer.exportCsv.mutate({
          data: result,
          savePath: res.path,
          unit,
        });
        setStatus('导出成功');
      } catch (err) {
        setStatus(`导出失败: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
  }, [result, unit]);

  return (
    <div className="flex h-full flex-col gap-3 p-4">
      {/* ── Directory selection ── */}
      <div className="flex items-center gap-2">
        <button
          onClick={handleSelectDir}
          className="flex items-center gap-1.5 rounded border border-border px-3 py-1.5 text-xs hover:bg-accent"
        >
          <FolderOpen className="h-3.5 w-3.5" />
          浏览
        </button>
        <input
          value={analysisDir}
          onChange={(e) => setAnalysisDir(e.target.value)}
          placeholder="选择要分析的目录..."
          className="min-w-0 flex-1 rounded border border-border bg-background px-2 py-1.5 text-xs"
        />
        <button
          onClick={handleAnalyze}
          disabled={analyzing || !analysisDir}
          className="flex items-center gap-1.5 rounded bg-primary px-3 py-1.5 text-xs text-primary-foreground disabled:opacity-50"
        >
          <Play className="h-3.5 w-3.5" />
          {analyzing ? '分析中...' : '开始分析'}
        </button>
      </div>

      {/* Hidden input for project root */}
      <input
        type="hidden"
        value={projectRoot ?? ''}
        onChange={(e) => onProjectRootChange(e.target.value)}
      />

      {/* ── Status + controls ── */}
      <div className="flex items-center gap-3">
        <span className="text-xs text-muted-foreground">{status}</span>
        <div className="flex-1" />
        {result && (
          <>
            <div className="flex items-center gap-1.5">
              <Clock className="h-3 w-3 text-muted-foreground" />
              <select
                value={unit}
                onChange={(e) => setUnit(e.target.value as TimeUnit)}
                className="rounded border border-border bg-background px-1.5 py-1 text-xs"
              >
                <option value="seconds">秒</option>
                <option value="minutes">分钟</option>
                <option value="hours">小时</option>
              </select>
            </div>
            <button
              onClick={handleExport}
              className="flex items-center gap-1.5 rounded border border-border px-3 py-1.5 text-xs hover:bg-accent"
            >
              <Download className="h-3.5 w-3.5" />
              导出CSV
            </button>
          </>
        )}
      </div>

      {/* ── Table ── */}
      {result && (
        <div className="min-h-0 flex-1 overflow-auto rounded border border-border">
          <table className="w-full text-xs">
            <thead className="sticky top-0 bg-muted">
              <tr>
                <th className="border-b border-border px-3 py-2 text-left font-semibold">用例名称</th>
                <th className="border-b border-border px-3 py-2 text-right font-semibold">编译时间({UNIT_LABELS[unit]})</th>
                <th className="border-b border-border px-3 py-2 text-right font-semibold">仿真时间({UNIT_LABELS[unit]})</th>
                <th className="border-b border-border px-3 py-2 text-right font-semibold">总时间({UNIT_LABELS[unit]})</th>
                <th className="border-b border-border px-3 py-2 text-right font-semibold">编译内存(MB)</th>
                <th className="border-b border-border px-3 py-2 text-right font-semibold">仿真内存(MB)</th>
              </tr>
            </thead>
            <tbody>
              {result.cases.map((c, i) => (
                <tr key={i} className={cn(i % 2 === 1 && 'bg-muted/50')}>
                  <td className="border-b border-border px-3 py-1.5" title={c.case}>{c.case}</td>
                  <td className="border-b border-border px-3 py-1.5 text-right tabular-nums">{formatTime(c.compile, unit)}</td>
                  <td className="border-b border-border px-3 py-1.5 text-right tabular-nums">{formatTime(c.sim, unit)}</td>
                  <td className="border-b border-border px-3 py-1.5 text-right font-medium tabular-nums">{formatTime(c.total, unit)}</td>
                  <td className="border-b border-border px-3 py-1.5 text-right tabular-nums">{c.compileMemory.toFixed(2)}</td>
                  <td className="border-b border-border px-3 py-1.5 text-right tabular-nums">{c.simMemory.toFixed(2)}</td>
                </tr>
              ))}
              {/* Totals row */}
              <tr className="bg-muted font-semibold">
                <td className="border-t-2 border-border px-3 py-2">总计</td>
                <td className="border-t-2 border-border px-3 py-2 text-right tabular-nums">{formatTime(result.totals.compile, unit)}</td>
                <td className="border-t-2 border-border px-3 py-2 text-right tabular-nums">{formatTime(result.totals.sim, unit)}</td>
                <td className="border-t-2 border-border px-3 py-2 text-right tabular-nums">{formatTime(result.totals.total, unit)}</td>
                <td className="border-t-2 border-border px-3 py-2 text-right tabular-nums">{result.totals.compileMemory.toFixed(2)}</td>
                <td className="border-t-2 border-border px-3 py-2 text-right tabular-nums">{result.totals.simMemory.toFixed(2)}</td>
              </tr>
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
