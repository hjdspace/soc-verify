/**
 * BatchExecution — batch simulation execution tool.
 *
 * Ported from the Python `batch_execution` plugin.
 * Features: parse case files, generate runsim commands,
 * parallel execution with status tracking, per-case log viewing.
 */

import { useState, useCallback, useRef } from 'react';
import { Plus, Trash2, Play, Square, RefreshCw, FileText } from 'lucide-react';
import { trpc } from '@renderer/lib/trpc';
import type { ToolComponentProps } from '../registry';
import { cn } from '@renderer/lib/utils';

type CaseRow = {
  id: number;
  name: string;
  command: string;
  selected: boolean;
  status: 'pending' | 'running' | 'success' | 'failed' | 'unknown';
  startTime: string;
  endTime: string;
  log: string;
};

export function BatchExecution({ projectRoot, onProjectRootChange }: ToolComponentProps) {
  const [rows, setRows] = useState<CaseRow[]>([]);
  const [parallelCount, setParallelCount] = useState(1);
  const [executing, setExecuting] = useState(false);
  const [activeLogRow, setActiveLogRow] = useState<number | null>(null);
  const [status, setStatus] = useState('就绪');
  const nextId = useRef(0);

  const handleAddCases = useCallback(async () => {
    const res = await trpc.tools.selectFiles.mutate({
      title: '选择用例文件',
      filters: [
        { name: '用例文件', extensions: ['txt', 'cfg', 'list', 'lst'] },
        { name: '所有文件', extensions: ['*'] },
      ],
      defaultPath: projectRoot ?? undefined,
    });
    if (res.paths.length === 0) return;

    try {
      const parsed = await trpc.tools.batchExecution.parseCaseFiles.mutate({ filePaths: res.paths });
      const newRows: CaseRow[] = [];
      for (const c of parsed.cases) {
        const exists = rows.some((r) => r.name === c.name);
        if (exists) continue;
        newRows.push({
          id: nextId.current++,
          name: c.name,
          command: c.command,
          selected: true,
          status: 'pending',
          startTime: '',
          endTime: '',
          log: '',
        });
      }
      setRows((prev) => [...prev, ...newRows]);
      setStatus(`添加了 ${newRows.length} 个用例`);
    } catch (err) {
      setStatus(`解析失败: ${err instanceof Error ? err.message : String(err)}`);
    }
  }, [projectRoot, rows]);

  const handleClearAll = useCallback(() => {
    setRows([]);
    setActiveLogRow(null);
    setStatus('已清除所有用例');
  }, []);

  const handleToggleSelect = (id: number) => {
    setRows((prev) => prev.map((r) => (r.id === id ? { ...r, selected: !r.selected } : r)));
  };

  const handleRemoveRow = (id: number) => {
    setRows((prev) => prev.filter((r) => r.id !== id));
    if (activeLogRow === id) setActiveLogRow(null);
  };

  const handleExecute = useCallback(async () => {
    const selected = rows.filter((r) => r.selected);
    if (selected.length === 0) {
      setStatus('请选择要执行的用例');
      return;
    }

    setExecuting(true);
    setStatus(`开始执行 ${selected.length} 个用例...`);

    // Reset status for selected rows
    setRows((prev) => prev.map((r) => (r.selected ? { ...r, status: 'pending', startTime: '', endTime: '', log: '' } : r)));

    try {
      const res = await trpc.tools.batchExecution.execute.mutate({
        tasks: selected.map((r) => ({ rowIndex: r.id, caseName: r.name, command: r.command })),
        maxParallel: parallelCount,
        cwd: projectRoot ?? process.cwd(),
      });

      // Update rows with results
      setRows((prev) => prev.map((r) => {
        const result = res.results.find((rr) => rr.rowIndex === r.id);
        if (!result) return r;
        return {
          ...r,
          status: result.status,
          startTime: result.startTime,
          endTime: result.endTime,
          log: result.log,
        };
      }));

      const successCount = res.results.filter((r) => r.status === 'success').length;
      const failCount = res.results.filter((r) => r.status === 'failed').length;
      setStatus(`执行完成：成功 ${successCount}，失败 ${failCount}`);
    } catch (err) {
      setStatus(`执行失败: ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      setExecuting(false);
    }
  }, [rows, parallelCount, projectRoot]);

  const statusColor = (status: CaseRow['status']): string => {
    switch (status) {
      case 'running': return 'text-blue-500';
      case 'success': return 'text-green-500';
      case 'failed': return 'text-red-500';
      case 'unknown': return 'text-orange-500';
      default: return 'text-muted-foreground';
    }
  };

  const statusLabel = (status: CaseRow['status']): string => {
    switch (status) {
      case 'pending': return '等待执行';
      case 'running': return '正在执行';
      case 'success': return '执行成功';
      case 'failed': return '执行失败';
      case 'unknown': return '状态未知';
    }
  };

  return (
    <div className="flex h-full flex-col gap-3 p-4">
      {/* Hidden input for project root */}
      <input type="hidden" value={projectRoot ?? ''} onChange={(e) => onProjectRootChange(e.target.value)} />

      {/* ── Toolbar ── */}
      <div className="flex items-center gap-2">
        <button onClick={handleAddCases} className="flex items-center gap-1.5 rounded border border-border px-3 py-1.5 text-xs hover:bg-accent">
          <Plus className="h-3.5 w-3.5" />
          添加用例
        </button>
        <button onClick={handleClearAll} disabled={executing} className="flex items-center gap-1.5 rounded border border-border px-3 py-1.5 text-xs hover:bg-accent disabled:opacity-50">
          <Trash2 className="h-3.5 w-3.5" />
          清除所有
        </button>
        <div className="flex-1" />
        <label className="flex items-center gap-1.5 text-xs text-muted-foreground">
          并行执行数
          <input
            type="number"
            min={1}
            max={10}
            value={parallelCount}
            onChange={(e) => setParallelCount(Math.max(1, Math.min(10, parseInt(e.target.value, 10) || 1)))}
            className="w-16 rounded border border-border bg-background px-2 py-1 text-xs"
          />
        </label>
        <button
          onClick={handleExecute}
          disabled={executing || rows.filter((r) => r.selected).length === 0}
          className="flex items-center gap-1.5 rounded bg-primary px-4 py-1.5 text-xs text-primary-foreground disabled:opacity-50"
        >
          {executing ? <Square className="h-3.5 w-3.5" /> : <Play className="h-3.5 w-3.5" />}
          {executing ? '执行中...' : '开始执行'}
        </button>
      </div>

      {/* ── Status ── */}
      <div className="text-xs text-muted-foreground">{status}</div>

      {/* ─── Case table ── */}
      <div className="min-h-0 flex-1 overflow-auto rounded border border-border">
        <table className="w-full text-xs">
          <thead className="sticky top-0 bg-muted">
            <tr>
              <th className="border-b border-border px-2 py-2 text-center w-10">
                <input
                  type="checkbox"
                  checked={rows.length > 0 && rows.every((r) => r.selected)}
                  onChange={(e) => setRows((prev) => prev.map((r) => ({ ...r, selected: e.target.checked })))}
                />
              </th>
              <th className="border-b border-border px-2 py-2 text-left font-semibold">用例名</th>
              <th className="border-b border-border px-2 py-2 text-center font-semibold w-20">状态</th>
              <th className="border-b border-border px-2 py-2 text-left font-semibold">命令</th>
              <th className="border-b border-border px-2 py-2 text-center font-semibold w-20">开始</th>
              <th className="border-b border-border px-2 py-2 text-center font-semibold w-20">结束</th>
              <th className="border-b border-border px-2 py-2 text-center w-10"></th>
            </tr>
          </thead>
          <tbody>
            {rows.length === 0 ? (
              <tr>
                <td colSpan={7} className="px-3 py-8 text-center text-muted-foreground">
                  点击"添加用例"导入用例文件
                </td>
              </tr>
            ) : (
              rows.map((row) => (
                <tr
                  key={row.id}
                  className={cn(
                    'cursor-pointer hover:bg-accent/50',
                    activeLogRow === row.id && 'bg-accent',
                  )}
                  onClick={() => setActiveLogRow(activeLogRow === row.id ? null : row.id)}
                >
                  <td className="border-b border-border px-2 py-1.5 text-center">
                    <input
                      type="checkbox"
                      checked={row.selected}
                      onChange={() => handleToggleSelect(row.id)}
                      onClick={(e) => e.stopPropagation()}
                    />
                  </td>
                  <td className="border-b border-border px-2 py-1.5" title={row.name}>{row.name}</td>
                  <td className={cn('border-b border-border px-2 py-1.5 text-center font-medium', statusColor(row.status))}>
                    {statusLabel(row.status)}
                  </td>
                  <td className="border-b border-border px-2 py-1.5" title={row.command}>
                    <span className="block max-w-[300px] truncate font-mono text-[10px]">{row.command}</span>
                  </td>
                  <td className="border-b border-border px-2 py-1.5 text-center tabular-nums">{row.startTime}</td>
                  <td className="border-b border-border px-2 py-1.5 text-center tabular-nums">{row.endTime}</td>
                  <td className="border-b border-border px-2 py-1.5 text-center">
                    <button
                      onClick={(e) => { e.stopPropagation(); handleRemoveRow(row.id); }}
                      className="text-muted-foreground hover:text-destructive"
                    >
                      <Trash2 className="h-3 w-3" />
                    </button>
                  </td>
                </tr>
              ))
            )}
          </tbody>
        </table>
      </div>

      {/* ── Log viewer ── */}
      {activeLogRow !== null && (
        <div className="h-48 shrink-0 overflow-auto rounded border border-border bg-muted/30 p-2">
          {(() => {
            const row = rows.find((r) => r.id === activeLogRow);
            if (!row) return null;
            return (
              <>
                <div className="mb-1 flex items-center gap-2 text-xs font-medium">
                  <FileText className="h-3 w-3" />
                  {row.name} - 执行日志
                </div>
                {row.log ? (
                  <pre className="whitespace-pre-wrap font-mono text-[10px] leading-relaxed text-foreground/80">{row.log}</pre>
                ) : (
                  <div className="text-xs text-muted-foreground">暂无日志输出</div>
                )}
              </>
            );
          })()}
        </div>
      )}
    </div>
  );
}
