/**
 * 回归历史趋势表（Issue #6 / Plan Slice 5；Issue #7 接入状态 chips 筛选）。
 *
 * 列对照原型 .hist-row：子系统·回归文件 / 时间 / 通过·失败数 / 通过率 / 时长 / Δ。
 * 第一列展示子系统名和回归 list/group 文件名（从 filePath 提取），
 * 取代早期无语义的 #runId 数字。通过·失败数、通过率、Δ 无数据源，
 * 占位「—」；时长无 endTime 数据源，运行中显示「进行中」（原型语义），
 * 终态占位「—」，均不造假。点击行打开回归详情（regression-detail，workspace Tab）。
 *
 * Issue #7：标题行下方加状态 chips 筛选（FilterTable 模式）——计数徽标由
 * entries 实时派生，未匹配行经 FilterCollapseRow 平滑折叠（保持挂载，
 * 排序不受筛选影响——entries 顺序原样保留，只控制行的可见性）。
 */

import { useMemo, useState } from 'react';
import { History } from 'lucide-react';
import type { RegressionHistoryEntry } from '@shared/types';
import { cn } from '@renderer/lib/utils';
import {
  FilterCollapseRow,
  StatusFilterChips,
  type FilterChipDef,
  type FilterStatusKey,
} from '@renderer/components/ui/FilterTable';
import { formatRunTime } from './SuiteCardGrid';

const ROW_GRID = 'grid-cols-[1fr_90px_1fr_90px_80px_70px]';

type HistStatus = RegressionHistoryEntry['status'];

/** 状态 chips：圆点取语义状态变量，计数由 StatusFilterChips 从 entries 派生 */
const HIST_FILTERS: ReadonlyArray<FilterChipDef<HistStatus>> = [
  { key: 'all', label: '全部' },
  { key: 'running', label: '运行中', dot: 'var(--status-running)' },
  { key: 'completed', label: '已完成', dot: 'var(--status-pass)' },
  { key: 'failed', label: '失败', dot: 'var(--status-fail)' },
  { key: 'aborted', label: '已停止', dot: 'var(--status-aborted)' },
];

/** 运行状态 → 状态点语义色（与套件卡片一致） */
function histDotClass(status: RegressionHistoryEntry['status']): string {
  switch (status) {
    case 'running': return 'bg-status-running animate-pulse';
    case 'completed': return 'bg-status-pass';
    case 'failed': return 'bg-status-fail';
    case 'aborted': return 'bg-status-aborted';
  }
}

function HistoryRow({ entry, hideBorder, onOpen }: {
  entry: RegressionHistoryEntry;
  /** 末个可见行去掉分隔线（容器自带描边）；折叠壳内 :last-child 失效，改由宿主按序号传入 */
  hideBorder?: boolean;
  onOpen: () => void;
}) {
  return (
    <div
      role="button"
      tabIndex={0}
      className={cn(
        ROW_GRID,
        'cursor-pointer items-center gap-2.5 px-3.5 py-2 transition-colors hover:bg-accent',
        !hideBorder && 'border-b border-border',
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
      {/* 通过·失败数：无数据源，占位不造假（对比度下限 /70） */}
      <span className="truncate font-mono text-[11px] text-muted-foreground/70">—</span>
      {/* 通过率：无数据源，占位不造假 */}
      <span className="truncate text-right font-mono text-[11px] text-muted-foreground/70">—</span>
      {/* 时长：无 endTime 数据源；运行中显示进行中，终态占位 */}
      <span
        className={cn(
          'truncate text-right font-mono text-[11px]',
          entry.status === 'running' ? 'text-status-running-foreground' : 'text-muted-foreground/70',
        )}
      >
        {entry.status === 'running' ? '进行中' : '—'}
      </span>
      {/* Δ：无通过率序列，占位不造假 */}
      <span className="truncate text-right text-[11px] text-muted-foreground/70">—</span>
    </div>
  );
}

/** 历史趋势表面板：标题 + 状态 chips + 列头 + 行 / 骨架屏 / 空状态 */
export function HistoryTable({ entries, loading, onOpen }: {
  entries: RegressionHistoryEntry[];
  loading: boolean;
  onOpen: () => void;
}) {
  const [filter, setFilter] = useState<FilterStatusKey<HistStatus>>('all');

  /** 单遍派生：可见行数（0 命中提示用）+ 末个可见行序号（分隔线跟随可见末行，避免与容器描边成双线） */
  const { visibleCount, lastVisibleIndex } = useMemo(() => {
    let count = 0;
    let last = -1;
    entries.forEach((e, i) => {
      if (filter === 'all' || e.status === filter) {
        count += 1;
        last = i;
      }
    });
    return { visibleCount: count, lastVisibleIndex: last };
  }, [entries, filter]);

  return (
    <div className="flex min-w-0 flex-col overflow-hidden rounded-xl border border-border bg-card">
      <div className="flex items-center gap-2 border-b border-border px-3.5 py-2.5 text-xs font-semibold text-foreground">
        历史趋势
        {entries.length > 0 && (
          <span className="rounded-full bg-secondary px-[7px] font-mono text-[10.5px] font-normal text-muted-foreground">
            {entries.length} 次
          </span>
        )}
      </div>

      {entries.length > 0 && (
        <StatusFilterChips
          filters={HIST_FILTERS}
          items={entries}
          statusOf={(e) => e.status}
          value={filter}
          onChange={setFilter}
          className="px-2.5"
        />
      )}

      {/* 列头中文 ≥11px（10.5px 以下笔画粘连），透明度下限 /80 */}
      <div
        className={cn(
          ROW_GRID,
          'gap-2.5 border-b border-border px-3.5 py-2 text-[11px] uppercase tracking-[0.08em] text-muted-foreground/80',
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
          <span className="text-[11.5px] text-muted-foreground/80">从套件运行回归后此处展示历史趋势</span>
        </div>
      ) : (
        <>
          {entries.map((entry, i) => (
            <FilterCollapseRow
              key={entry.runId}
              shown={filter === 'all' || entry.status === filter}
              testId={`reg-hist-shell-${entry.runId}`}
            >
              <HistoryRow
                entry={entry}
                hideBorder={i === lastVisibleIndex}
                onOpen={onOpen}
              />
            </FilterCollapseRow>
          ))}
          {visibleCount === 0 && (
            <div
              className="px-3.5 py-8 text-center text-xs text-muted-foreground"
              data-testid="reg-hist-no-match"
            >
              该状态下暂无运行记录
            </div>
          )}
        </>
      )}
    </div>
  );
}
