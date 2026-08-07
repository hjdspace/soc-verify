/**
 * TimeAnalyzer — simulation time and memory analysis tool.
 *
 * Ported from the Python `time_analyzer` plugin.
 * Features: directory selection, time/memory extraction, table display,
 * unit conversion (minutes/hours/days), CSV export.
 *
 * Default directory is resolved from $PROJ_WORK (via tRPC), matching
 * the Python `get_default_analysis_dir()` behavior.
 */

import { useState, useCallback, useEffect } from 'react';
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

type TimeUnit = 'minutes' | 'hours' | 'days';

const UNIT_LABELS: Record<TimeUnit, string> = {
  minutes: '分钟',
  hours: '小时',
  days: '天',
};

/** Precision per unit (matches Python UNIT_PRECISION). */
const UNIT_PRECISION: Record<TimeUnit, number> = {
  minutes: 2,
  hours: 2,
  days: 3,
};

/** Conversion factors: how many minutes one unit represents. */
const UNIT_TO_MINUTES: Record<TimeUnit, number> = {
  minutes: 1,
  hours: 60,
  days: 1440,
};

/**
 * Format a time value (given in minutes) for display in the target unit.
 *
 * Matches Python's `TimeUnitConverter.format_time()`:
 * 1. Convert to target unit
 * 2. Format to unit-specific precision
 * 3. Strip trailing zeros
 */
function formatTime(minutes: number, unit: TimeUnit): string {
  if (minutes === 0) return '0';
  const value = minutes / UNIT_TO_MINUTES[unit];
  const precision = UNIT_PRECISION[unit];
  let formatted = value.toFixed(precision);
  if (formatted.includes('.')) {
    formatted = formatted.replace(/0+$/, '').replace(/\.$/, '');
  }
  return formatted;
}

export function TimeAnalyzer({ projectRoot, onProjectRootChange }: ToolComponentProps) {
  // Initialize with projectRoot if available; will be overridden by $PROJ_WORK on mount
  const [analysisDir, setAnalysisDir] = useState(projectRoot ?? '');
  const [analyzing, setAnalyzing] = useState(false);
  const [result, setResult] = useState<AnalysisResult | null>(null);
  const [unit, setUnit] = useState<TimeUnit>('minutes');
  const [status, setStatus] = useState('就绪');

  // On mount: fetch the default analysis directory ($PROJ_WORK or cwd) from backend.
  // Only set it if the user hasn't already provided a projectRoot via URL param,
  // so that an explicitly-passed project path takes precedence.
  useEffect(() => {
    if (projectRoot) {
      setAnalysisDir(projectRoot);
      return;
    }
    // Fetch $PROJ_WORK from backend
    trpc.tools.timeAnalyzer.getDefaultDir
      .query()
      .then((res) => {
        if (res.dir) {
          setAnalysisDir(res.dir);
        }
      })
      .catch(() => {
        // Ignore — user can manually select a directory
      });
  }, [projectRoot]);

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
          placeholder="选择要分析的目录（默认 $PROJ_WORK）..."
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
                <option value="minutes">分钟</option>
                <option value="hours">小时</option>
                <option value="days">天</option>
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
