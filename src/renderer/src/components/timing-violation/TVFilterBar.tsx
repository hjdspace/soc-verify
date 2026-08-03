/**
 * TVFilterBar — 筛选栏
 *
 * 包含用例名下拉、corner 下拉、状态下拉、子系统下拉 + 搜索框。
 * 下拉选项从 metadata 动态获取。
 */

import { Search, X, RotateCcw } from 'lucide-react';
import { cn } from '@renderer/lib/utils';
import type {
  ViolationMetadata,
  ConfirmationStatus,
} from '@renderer/stores/timing-violation';

type FilterBarProps = {
  metadata: ViolationMetadata;
  filterCaseName: string | null;
  filterCorner: string | null;
  filterStatus: ConfirmationStatus | null;
  filterSubsys: string | null;
  searchText: string;
  onCaseNameChange: (v: string | null) => void;
  onCornerChange: (v: string | null) => void;
  onStatusChange: (v: ConfirmationStatus | null) => void;
  onSubsysChange: (v: string | null) => void;
  onSearchTextChange: (v: string) => void;
  onReset: () => void;
};

const STATUS_OPTIONS: { value: ConfirmationStatus; label: string }[] = [
  { value: 'pending', label: '待确认' },
  { value: 'confirmed', label: '已确认' },
  { value: 'ignored', label: '已忽略' },
];

const selectClass =
  'h-7 rounded-md border border-border bg-background px-2 text-xs text-foreground focus:outline-none focus:ring-1 focus:ring-primary';

export function TVFilterBar({
  metadata,
  filterCaseName,
  filterCorner,
  filterStatus,
  filterSubsys,
  searchText,
  onCaseNameChange,
  onCornerChange,
  onStatusChange,
  onSubsysChange,
  onSearchTextChange,
  onReset,
}: FilterBarProps) {
  const hasActiveFilters =
    filterCaseName || filterCorner || filterStatus || filterSubsys || searchText;

  return (
    <div className="flex flex-wrap items-center gap-2 border-b bg-secondary/20 px-3 py-2">
      {/* 用例名下拉 */}
      <select
        value={filterCaseName ?? ''}
        onChange={(e) => onCaseNameChange(e.target.value || null)}
        className={selectClass}
        title="按用例筛选"
      >
        <option value="">所有用例</option>
        {metadata.cases.map((c) => (
          <option key={c} value={c}>{c}</option>
        ))}
      </select>

      {/* Corner 下拉 */}
      <select
        value={filterCorner ?? ''}
        onChange={(e) => onCornerChange(e.target.value || null)}
        className={selectClass}
        title="按 Corner 筛选"
      >
        <option value="">所有 Corner</option>
        {metadata.corners.map((c) => (
          <option key={c} value={c}>{c}</option>
        ))}
      </select>

      {/* 状态下拉 */}
      <select
        value={filterStatus ?? ''}
        onChange={(e) => onStatusChange((e.target.value || null) as ConfirmationStatus | null)}
        className={selectClass}
        title="按状态筛选"
      >
        <option value="">所有状态</option>
        {STATUS_OPTIONS.map((s) => (
          <option key={s.value} value={s.value}>{s.label}</option>
        ))}
      </select>

      {/* 子系统下拉 */}
      <select
        value={filterSubsys ?? ''}
        onChange={(e) => onSubsysChange(e.target.value || null)}
        className={selectClass}
        title="按子系统筛选"
      >
        <option value="">所有子系统</option>
        {metadata.subsys.map((s) => (
          <option key={s} value={s}>{s}</option>
        ))}
      </select>

      {/* 搜索框 */}
      <div className="relative ml-auto">
        <Search className="absolute left-2 top-1/2 h-3 w-3 -translate-y-1/2 text-muted-foreground" />
        <input
          type="text"
          value={searchText}
          onChange={(e) => onSearchTextChange(e.target.value)}
          placeholder="搜索 Hier / Check..."
          className={cn(
            'h-7 w-48 rounded-md border border-border bg-background pl-7 pr-2 text-xs text-foreground',
            'focus:outline-none focus:ring-1 focus:ring-primary',
          )}
        />
        {searchText && (
          <button
            onClick={() => onSearchTextChange('')}
            className="absolute right-1.5 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground"
          >
            <X className="h-3 w-3" />
          </button>
        )}
      </div>

      {/* 重置筛选 */}
      {hasActiveFilters && (
        <button
          onClick={onReset}
          className="flex items-center gap-1 rounded-md border border-border px-2 py-1 text-[11px] text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
          title="重置筛选"
        >
          <RotateCcw className="h-3 w-3" />
          重置
        </button>
      )}
    </div>
  );
}
