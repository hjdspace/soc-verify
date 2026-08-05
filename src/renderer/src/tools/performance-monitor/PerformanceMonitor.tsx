/**
 * PerformanceMonitor — Electron app performance monitor.
 *
 * Ported from the Python `performance_monitor` plugin.
 * Displays CPU usage, memory usage, process metrics, and a history table.
 * Polls metrics every 2 seconds with configurable interval.
 */

import { useState, useEffect, useRef, useCallback } from 'react';
import { Cpu, MemoryStick, Gauge, Trash2 } from 'lucide-react';
import { trpc } from '@renderer/lib/trpc';
import type { ToolComponentProps } from '../registry';
import { cn } from '@renderer/lib/utils';

type Metrics = {
  timestamp: number;
  cpuUsage: number;
  cpuCores: number;
  memoryTotal: number;
  memoryUsed: number;
  memoryUsage: number;
  diskTotal: number;
  diskUsed: number;
  diskUsage: number;
  processMemory: number;
  processUptime: number;
  memoryTotalFormatted: string;
  memoryUsedFormatted: string;
  diskTotalFormatted: string;
  diskUsedFormatted: string;
  processMemoryFormatted: string;
  uptimeFormatted: string;
};

const MAX_HISTORY = 100;

export function PerformanceMonitor(_props: ToolComponentProps) {
  const [metrics, setMetrics] = useState<Metrics | null>(null);
  const [history, setHistory] = useState<Metrics[]>([]);
  const [interval, setIntervalMs] = useState(2000);
  const [autoScroll, setAutoScroll] = useState(true);
  const tableRef = useRef<HTMLDivElement>(null);

  const fetchMetrics = useCallback(async () => {
    try {
      const data = await trpc.tools.systemMonitor.getMetrics.query();
      setMetrics(data);
      setHistory((prev) => {
        const next = [...prev, data];
        if (next.length > MAX_HISTORY) next.shift();
        return next;
      });
    } catch (err) {
      console.error('[perf-monitor] failed to fetch metrics:', err);
    }
  }, []);

  useEffect(() => {
    fetchMetrics();
    const id = setInterval(fetchMetrics, interval);
    return () => clearInterval(id);
  }, [fetchMetrics, interval]);

  // Auto-scroll table
  useEffect(() => {
    if (autoScroll && tableRef.current) {
      tableRef.current.scrollTop = tableRef.current.scrollHeight;
    }
  }, [history, autoScroll]);

  const handleClearHistory = useCallback(() => {
    setHistory([]);
  }, []);

  if (!metrics) {
    return (
      <div className="flex h-full items-center justify-center text-sm text-muted-foreground">
        正在获取性能数据...
      </div>
    );
  }

  const getColor = (usage: number) => {
    if (usage < 60) return 'text-green-500';
    if (usage < 80) return 'text-yellow-500';
    return 'text-red-500';
  };

  return (
    <div className="flex h-full flex-col gap-4 p-4">
      {/* ── Overview metrics ── */}
      <div className="grid grid-cols-3 gap-3">
        {/* CPU */}
        <MetricCard
          icon={<Cpu className="h-4 w-4" />}
          label="CPU 使用率"
          value={`${metrics.cpuUsage.toFixed(1)}%`}
          sub={`${metrics.cpuCores} 核`}
          valueClass={getColor(metrics.cpuUsage)}
        />
        {/* Memory */}
        <MetricCard
          icon={<MemoryStick className="h-4 w-4" />}
          label="内存使用率"
          value={`${metrics.memoryUsage.toFixed(1)}%`}
          sub={metrics.memoryUsedFormatted}
          valueClass={getColor(metrics.memoryUsage)}
        />
        {/* Process memory */}
        <MetricCard
          icon={<Gauge className="h-4 w-4" />}
          label="进程内存"
          value={metrics.processMemoryFormatted}
          sub={`运行 ${metrics.uptimeFormatted}`}
        />
      </div>

      {/* ── Controls ── */}
      <div className="flex items-center gap-4">
        <div className="flex items-center gap-2">
          <span className="text-xs text-muted-foreground">更新间隔:</span>
          <select
            value={interval}
            onChange={(e) => setIntervalMs(Number(e.target.value))}
            className="rounded border border-border bg-background px-2 py-0.5 text-xs"
          >
            <option value={1000}>1 秒</option>
            <option value={2000}>2 秒</option>
            <option value={5000}>5 秒</option>
            <option value={10000}>10 秒</option>
          </select>
        </div>
        <label className="flex items-center gap-1 text-xs">
          <input
            type="checkbox"
            checked={autoScroll}
            onChange={(e) => setAutoScroll(e.target.checked)}
            className="h-3 w-3"
          />
          自动滚动
        </label>
        <button
          onClick={handleClearHistory}
          className="flex items-center gap-1 rounded border border-border px-2 py-0.5 text-xs hover:bg-accent"
        >
          <Trash2 className="h-3 w-3" /> 清除历史
        </button>
      </div>

      {/* ── History table ── */}
      <div className="min-h-0 flex-1 overflow-auto rounded border border-border" ref={tableRef}>
        <table className="w-full text-xs">
          <thead className="sticky top-0 bg-muted">
            <tr>
              <th className="px-3 py-2 text-left font-medium">时间</th>
              <th className="px-3 py-2 text-right font-medium">CPU</th>
              <th className="px-3 py-2 text-right font-medium">内存</th>
              <th className="px-3 py-2 text-right font-medium">进程内存</th>
              <th className="px-3 py-2 text-right font-medium">磁盘</th>
              <th className="px-3 py-2 text-right font-medium">运行时间</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-border">
            {history.map((m, i) => (
              <tr key={i} className="hover:bg-accent">
                <td className="px-3 py-1.5">
                  {new Date(m.timestamp).toLocaleTimeString('zh-CN')}
                </td>
                <td className={cn('px-3 py-1.5 text-right tabular-nums', getColor(m.cpuUsage))}>
                  {m.cpuUsage.toFixed(1)}%
                </td>
                <td className={cn('px-3 py-1.5 text-right tabular-nums', getColor(m.memoryUsage))}>
                  {m.memoryUsage.toFixed(1)}%
                </td>
                <td className="px-3 py-1.5 text-right tabular-nums">{m.processMemoryFormatted}</td>
                <td className="px-3 py-1.5 text-right tabular-nums">{m.diskUsage}%</td>
                <td className="px-3 py-1.5 text-right">{m.uptimeFormatted}</td>
              </tr>
            ))}
          </tbody>
        </table>
        {history.length === 0 && (
          <div className="flex h-full items-center justify-center text-xs text-muted-foreground">
            暂无历史数据
          </div>
        )}
      </div>
    </div>
  );
}

function MetricCard({
  icon,
  label,
  value,
  sub,
  valueClass,
}: {
  icon: React.ReactNode;
  label: string;
  value: string;
  sub: string;
  valueClass?: string;
}) {
  return (
    <div className="rounded border border-border p-3">
      <div className="mb-1 flex items-center gap-2 text-muted-foreground">
        {icon}
        <span className="text-xs">{label}</span>
      </div>
      <div className={cn('text-xl font-bold tabular-nums', valueClass)}>{value}</div>
      <div className="mt-0.5 text-xs text-muted-foreground">{sub}</div>
    </div>
  );
}
