/**
 * TVDashboard — 时序违例主容器
 *
 * 包含：文件选择按钮 + 解析结果摘要 + 统计卡片 + 筛选栏 + 虚拟滚动表格。
 * 从 useTimingViolationStore 获取状态和操作。
 */

import { useEffect, useRef } from 'react';
import { FolderOpen, Loader2, AlertCircle, FileText } from 'lucide-react';
import { useTimingViolationStore } from '@renderer/stores/timing-violation';
import { useProjectStore } from '@renderer/stores/project';
import { TVStatsCards } from './TVStatsCards';
import { TVFilterBar } from './TVFilterBar';
import { TVViolationTable } from './TVViolationTable';
import { cn } from '@renderer/lib/utils';

export function TVDashboard() {
  const projectId = useProjectStore((s) => s.currentProjectId);

  // Store state
  const violations = useTimingViolationStore((s) => s.violations);
  const total = useTimingViolationStore((s) => s.total);
  const statistics = useTimingViolationStore((s) => s.statistics);
  const metadata = useTimingViolationStore((s) => s.metadata);
  const parsing = useTimingViolationStore((s) => s.parsing);
  const parseResult = useTimingViolationStore((s) => s.parseResult);
  const loadingViolations = useTimingViolationStore((s) => s.loadingViolations);
  const loadingStatistics = useTimingViolationStore((s) => s.loadingStatistics);

  // Filter/sort state
  const filterCaseName = useTimingViolationStore((s) => s.filterCaseName);
  const filterCorner = useTimingViolationStore((s) => s.filterCorner);
  const filterStatus = useTimingViolationStore((s) => s.filterStatus);
  const filterSubsys = useTimingViolationStore((s) => s.filterSubsys);
  const searchText = useTimingViolationStore((s) => s.searchText);
  const sortField = useTimingViolationStore((s) => s.sortField);
  const sortOrder = useTimingViolationStore((s) => s.sortOrder);
  const page = useTimingViolationStore((s) => s.page);
  const pageSize = useTimingViolationStore((s) => s.pageSize);

  // Actions
  const pickAndParse = useTimingViolationStore((s) => s.pickAndParse);
  const loadViolations = useTimingViolationStore((s) => s.loadViolations);
  const loadStatistics = useTimingViolationStore((s) => s.loadStatistics);
  const loadMetadata = useTimingViolationStore((s) => s.loadMetadata);
  const setFilterCaseName = useTimingViolationStore((s) => s.setFilterCaseName);
  const setFilterCorner = useTimingViolationStore((s) => s.setFilterCorner);
  const setFilterStatus = useTimingViolationStore((s) => s.setFilterStatus);
  const setFilterSubsys = useTimingViolationStore((s) => s.setFilterSubsys);
  const setSearchText = useTimingViolationStore((s) => s.setSearchText);
  const setSort = useTimingViolationStore((s) => s.setSort);
  const setPage = useTimingViolationStore((s) => s.setPage);
  const resetFilters = useTimingViolationStore((s) => s.resetFilters);

  // 搜索防抖
  const searchTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  // 初始加载
  useEffect(() => {
    if (!projectId) return;
    void loadViolations(projectId);
    void loadStatistics(projectId);
    void loadMetadata(projectId);
  }, [projectId, loadViolations, loadStatistics, loadMetadata]);

  // 筛选/排序/分页变化时重新加载
  useEffect(() => {
    if (!projectId) return;
    void loadViolations(projectId);
  }, [projectId, filterCaseName, filterCorner, filterStatus, filterSubsys, sortField, sortOrder, page, loadViolations]);

  // 统计在筛选变化时更新
  useEffect(() => {
    if (!projectId) return;
    void loadStatistics(projectId);
  }, [projectId, filterCaseName, filterCorner, loadStatistics]);

  // 搜索防抖
  useEffect(() => {
    if (searchTimer.current) clearTimeout(searchTimer.current);
    if (!projectId) return;
    searchTimer.current = setTimeout(() => {
      void loadViolations(projectId);
    }, 300);
    return () => {
      if (searchTimer.current) clearTimeout(searchTimer.current);
    };
  }, [searchText, projectId, loadViolations]);

  if (!projectId) {
    return (
      <div className="flex flex-1 items-center justify-center text-sm text-muted-foreground">
        请先打开项目
      </div>
    );
  }

  return (
    <div className="flex flex-1 flex-col overflow-hidden">
      {/* 工具栏 */}
      <div className="flex shrink-0 items-center gap-2 border-b bg-secondary/20 px-3 py-2">
        <button
          onClick={() => void pickAndParse(projectId)}
          disabled={parsing}
          className={cn(
            'flex items-center gap-1.5 rounded-md border border-border px-3 py-1.5 text-xs font-medium transition-colors',
            'hover:bg-accent hover:text-foreground',
            parsing && 'opacity-60 cursor-not-allowed',
          )}
        >
          {parsing ? (
            <Loader2 className="h-3.5 w-3.5 animate-spin" />
          ) : (
            <FolderOpen className="h-3.5 w-3.5" />
          )}
          {parsing ? '解析中...' : '选择文件'}
        </button>

        {parseResult && (
          <div className="flex items-center gap-2 text-[11px]">
            {parseResult.errors.length > 0 && (
              <span className="flex items-center gap-1 text-amber-600 dark:text-amber-400">
                <AlertCircle className="h-3 w-3" />
                {parseResult.errors.length} 个错误
              </span>
            )}
            <span className="text-muted-foreground">
              总数: {parseResult.total} · 新增: <span className="text-green-600 dark:text-green-400">{parseResult.inserted}</span> · 跳过: {parseResult.skipped}
            </span>
          </div>
        )}

        <div className="ml-auto text-[11px] text-muted-foreground">
          {statistics && `数据库共 ${statistics.total.toLocaleString()} 条违例`}
        </div>
      </div>

      {/* 统计卡片 */}
      <div className="shrink-0 px-3 py-2">
        <TVStatsCards statistics={statistics} loading={loadingStatistics} />
      </div>

      {/* 筛选栏 */}
      <TVFilterBar
        metadata={metadata}
        filterCaseName={filterCaseName}
        filterCorner={filterCorner}
        filterStatus={filterStatus}
        filterSubsys={filterSubsys}
        searchText={searchText}
        onCaseNameChange={setFilterCaseName}
        onCornerChange={setFilterCorner}
        onStatusChange={setFilterStatus}
        onSubsysChange={setFilterSubsys}
        onSearchTextChange={setSearchText}
        onReset={resetFilters}
      />

      {/* 违例列表表格 */}
      <TVViolationTable
        violations={violations}
        total={total}
        loading={loadingViolations}
        sortField={sortField}
        sortOrder={sortOrder}
        onSort={setSort}
        page={page}
        pageSize={pageSize}
        onPageChange={setPage}
      />

      {/* 空状态提示 */}
      {violations.length === 0 && !loadingViolations && !parsing && (
        <div className="pointer-events-none absolute inset-0 flex items-center justify-center">
          <div className="flex flex-col items-center gap-2 text-muted-foreground">
            <FileText className="h-8 w-8 opacity-30" />
            <p className="text-sm">导入 vio_summary.log 文件开始分析</p>
          </div>
        </div>
      )}
    </div>
  );
}
