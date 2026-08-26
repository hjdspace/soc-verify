/**
 * 回归历史趋势表（Issue #6 / Plan Slice 5）。
 *
 * 列对照原型 .hist-row：子系统·回归文件 / 时间 / 通过·失败数 / 通过率 / 时长 / Δ。
 * 第一列展示子系统名和回归 list/group 文件名（从 filePath 提取），
 * 取代早期无语义的 #runId 数字。通过·失败数、通过率、Δ 无数据源，
 * 占位「—」；时长无 endTime 数据源，运行中显示「进行中」（原型语义），
 * 终态占位「—」，均不造假。点击行打开回归详情（regression-detail，workspace Tab）。
 */

import type { RegressionHistoryEntry } from '@shared/types';
import { History } from 'lucide-react';
import { cn } from '@renderer/lib/utils';
import { formatRunTime } from './SuiteCardGrid';

const ROW_GRID = 'grid-cols-[1fr_90px_1fr_90px_80px_70px]';

/** 运行状态 → 状态点语义色（与套件卡片一致） */
function histDotClass(status: RegressionHistoryEntry['status']): string {
  switch (status) {
    case 'running': return 'bg-status-running animate-pulse';
    case 'completed': return 'bg-status-pass';
    case 'failed': return 'bg-status-fail';
    case 'aborted': return 'bg-status-aborted';
  }
}

function HistoryRow({ entry, onOpen }: {
  entry: RegressionHistoryEntry;
  onOpen: () => void;
}) {
  return (
    <div
      role="button"
      tabIndex={0}
      className={cn(
        ROW_GRID,
        'cursor-pointer items-center gap-2.5 border-b border-border px-3.5 py-2 transition-colors last:border-b-0 hover:bg-accent',
      )}
      data-testid={`reg-hist-row-${entry.runId}`}
      onClick={onOpen}
      onKeyDown={(e) => {
        if (e.key === 'Enter') onOpen();
      }}
    >
      <span className="flex min-w-0 items-center gap-2">
        <span className={cn('size-2 shrink-0 rounded-full', histDotClass(entry.status))} />
        <span className="shrink-0 text-[11px] font-medium text-foreground">{entry.subsys}</span>
        <span className="truncate font-mono text-[11px] text-muted-foreground">
          {entry.filePath.split(/[/\\]/).pop() ?? entry.filePath}
        </span>
      </span>
      <span className="truncate text-[11px] text-muted-foreground">{formatRunTime(entry.submittedAt)}</span>
      {/* 通过·失败数：无数据源，占位不造假 */}
      <span className="truncate font-mono text-[11px] text-muted-foreground/50">—</span>
      {/* 通过率：无数据源，占位不造假 */}
      <span className="truncate text-right font-mono text-[11.5px] text-muted-foreground/50">—</span>
      {/* 时长：无 endTime 数据源；运行中显示进行中，终态占位 */}
      <span
        className={cn(
          'truncate text-right font-mono text-[11px]',
          entry.status === 'running' ? 'text-status-running-foreground' : 'text-muted-foreground/50',
        )}
      >
        {entry.status === 'running' ? '进行中' : '—'}
      </span>
      {/* Δ：无通过率序列，占位不造假 */}
      <span className="truncate text-right text-[10.5px] text-muted-foreground/50">—</span>
    </div>
  );
}

/** 历史趋势表面板：列头 + 行 / 骨架屏 / 空状态 */
export function HistoryTable({ entries, loading, onOpen }: {
  entries: RegressionHistoryEntry[];
  loading: boolean;
  onOpen: () => void;
}) {
  return (
    <div className="flex min-w-0 flex-col overflow-hidden rounded-xl border border-border bg-card">
      <div className="flex items-center gap-2 border-b border-border px-3.5 py-2.5 text-xs font-semibold text-foreground">
        历史趋势
        {entries.length > 0 && (
          <span className="rounded-full bg-secondary px-[7px] font-mono text-[10px] font-normal text-muted-foreground">
            {entries.length} 次
          </span>
        )}
      </div>

      <div
        className={cn(
          ROW_GRID,
          'gap-2.5 border-b border-border px-3.5 py-2 text-[10.5px] uppercase tracking-wider text-muted-foreground/70',
        )}
      >
        <span>子系统·回归</span>
        <span>时间</span>
        <span>通过·失败</span>
        <span className="text-right">通过率</span>
        <span className="text-right">时长</span>
        <span className="text-right">Δ</span>
      </div>

      {loading && entries.length === 0 ? (
        <div className="flex flex-col gap-2 p-4" data-testid="reg-hist-skeleton">
          {Array.from({ length: 5 }, (_, i) => (
            <div key={i} className="h-6 w-full animate-pulse rounded bg-muted" />
          ))}
        </div>
      ) : entries.length === 0 ? (
        <div
          className="flex flex-col items-center gap-2 px-3.5 py-10 text-muted-foreground"
          data-testid="reg-hist-empty"
        >
          <History className="size-6 opacity-30" />
          <span className="text-xs">暂无回归运行记录</span>
          <span className="text-[11px] opacity-60">从套件运行回归后此处展示历史趋势</span>
        </div>
      ) : (
        entries.map((entry) => (
          <HistoryRow key={entry.runId} entry={entry} onOpen={onOpen} />
        ))
      )}
    </div>
  );
}
