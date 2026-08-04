/**
 * TVDashboard — 时序违例主容器
 *
 * 包含：文件选择按钮 + 解析结果摘要 + 统计卡片 + 筛选栏 + 虚拟滚动表格。
 * 工具栏包含自动确认按钮和批量确认/忽略按钮。
 * 从 useTimingViolationStore 获取状态和操作。
 */

import { useEffect, useRef, useState } from 'react';
import { FolderOpen, Loader2, AlertCircle, FileText, Trash2, Zap, CheckSquare, XCircle, History, ListChecks, Download, Upload, ChevronDown, ChevronRight, FileSpreadsheet, Database } from 'lucide-react';
import { useTimingViolationStore } from '@renderer/stores/timing-violation';
import { useProjectStore } from '@renderer/stores/project';
import { TVStatsCards } from './TVStatsCards';
import { TVDistributionCharts } from './TVDistributionCharts';
import { TVFilterBar } from './TVFilterBar';
import { TVViolationTable } from './TVViolationTable';
import { TVConfirmationDialog } from './TVConfirmationDialog';
import { TVAutoConfirmDialog } from './TVAutoConfirmDialog';
import { TVPatternManager } from './TVPatternManager';
import { TVScanDialog } from './TVScanDialog';
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
  const confirming = useTimingViolationStore((s) => s.confirming);
  const selectedViolationIds = useTimingViolationStore((s) => s.selectedViolationIds);
  const showConfirmDialog = useTimingViolationStore((s) => s.showConfirmDialog);
  const confirmDialogViolation = useTimingViolationStore((s) => s.confirmDialogViolation);
  const showPatternManager = useTimingViolationStore((s) => s.showPatternManager);
  const showScanDialog = useTimingViolationStore((s) => s.showScanDialog);

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
  const clearAllData = useTimingViolationStore((s) => s.clearAllData);

  // 确认相关 Actions
  const autoConfirmByInterval = useTimingViolationStore((s) => s.autoConfirmByInterval);
  const updateConfirmation = useTimingViolationStore((s) => s.updateConfirmation);
  const batchUpdateConfirmations = useTimingViolationStore((s) => s.batchUpdateConfirmations);
  const toggleViolationSelection = useTimingViolationStore((s) => s.toggleViolationSelection);
  const selectAllVisibleViolations = useTimingViolationStore((s) => s.selectAllVisibleViolations);
  const clearSelection = useTimingViolationStore((s) => s.clearSelection);
  const openConfirmDialog = useTimingViolationStore((s) => s.openConfirmDialog);
  const closeConfirmDialog = useTimingViolationStore((s) => s.closeConfirmDialog);
  const setShowPatternManager = useTimingViolationStore((s) => s.setShowPatternManager);
  const applyHistoricalConfirmations = useTimingViolationStore((s) => s.applyHistoricalConfirmations);
  const setShowScanDialog = useTimingViolationStore((s) => s.setShowScanDialog);

  // 导出/导入 Actions
  const exportViolations = useTimingViolationStore((s) => s.exportViolations);
  const exportPatterns = useTimingViolationStore((s) => s.exportPatterns);
  const importPatterns = useTimingViolationStore((s) => s.importPatterns);
  const exporting = useTimingViolationStore((s) => s.exporting);
  const importing = useTimingViolationStore((s) => s.importing);

  // 本地 UI 状态
  const [showAutoConfirm, setShowAutoConfirm] = useState(false);
  const [showCharts, setShowCharts] = useState(true);
  const [showExportMenu, setShowExportMenu] = useState(false);

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

  const selectedCount = selectedViolationIds.size;
  const selectedIds = Array.from(selectedViolationIds);

  const handleConfirmSubmit = (status: 'pending' | 'confirmed' | 'ignored', confirmer: string, result: 'pass' | 'issue', reason: string) => {
    if (selectedCount > 0) {
      void batchUpdateConfirmations(projectId, selectedIds, status, confirmer, result, reason);
    } else if (confirmDialogViolation) {
      void updateConfirmation(projectId, confirmDialogViolation.id, status, confirmer, result, reason);
    }
  };

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

        {/* 自动确认按钮 */}
        <button
          onClick={() => setShowAutoConfirm(true)}
          disabled={parsing || confirming || total === 0}
          className={cn(
            'flex items-center gap-1.5 rounded-md border border-border px-3 py-1.5 text-xs font-medium transition-colors',
            'hover:bg-amber-500/10 hover:text-amber-600 dark:hover:text-amber-400',
            (parsing || confirming || total === 0) && 'opacity-40 cursor-not-allowed',
          )}
          title="自动确认（复位时间/区间）"
        >
          <Zap className="h-3.5 w-3.5" />
          自动确认
        </button>

        {/* Pattern 管理按钮 */}
        <button
          onClick={() => setShowPatternManager(true)}
          className={cn(
            'flex items-center gap-1.5 rounded-md border border-border px-3 py-1.5 text-xs font-medium transition-colors',
            'hover:bg-accent hover:text-foreground',
          )}
          title="管理历史确认模式"
        >
          <ListChecks className="h-3.5 w-3.5" />
          Pattern
        </button>

        {/* 应用历史确认按钮（备选功能：对所有待确认违例应用历史 Pattern） */}
        <button
          onClick={() => {
            void applyHistoricalConfirmations(projectId);
          }}
          disabled={confirming || total === 0}
          className={cn(
            'flex items-center gap-1.5 rounded-md border border-border px-3 py-1.5 text-xs font-medium transition-colors',
            'hover:bg-blue-500/10 hover:text-blue-600 dark:hover:text-blue-400',
            (confirming || total === 0) && 'opacity-40 cursor-not-allowed',
          )}
          title="一键应用历史确认模式（对所有待确认违例）"
        >
          <History className="h-3.5 w-3.5" />
          应用历史确认
        </button>

        {/* 回归扫描按钮 */}
        <button
          onClick={() => setShowScanDialog(true)}
          disabled={parsing}
          className={cn(
            'flex items-center gap-1.5 rounded-md border border-border px-3 py-1.5 text-xs font-medium transition-colors',
            'hover:bg-accent hover:text-foreground',
            parsing && 'opacity-40 cursor-not-allowed',
          )}
          title="扫描回归目录"
        >
          <FolderOpen className="h-3.5 w-3.5" />
          回归扫描
        </button>

        {/* 导出/导入下拉菜单 */}
        <div className="relative">
          <button
            onClick={() => setShowExportMenu((v) => !v)}
            disabled={exporting || importing || total === 0}
            className={cn(
              'flex items-center gap-1.5 rounded-md border border-border px-3 py-1.5 text-xs font-medium transition-colors',
              'hover:bg-accent hover:text-foreground',
              (exporting || importing || total === 0) && 'opacity-40 cursor-not-allowed',
            )}
            title="导出/导入"
          >
            {exporting || importing ? (
              <Loader2 className="h-3.5 w-3.5 animate-spin" />
            ) : (
              <Download className="h-3.5 w-3.5" />
            )}
            导出/导入
          </button>
            {showExportMenu && (
              <>
                <div className="fixed inset-0 z-10" onClick={() => setShowExportMenu(false)} />
                <div className="absolute right-0 top-full z-20 mt-1 w-48 rounded-md border border-border bg-background shadow-lg">
                  <div className="px-2 py-1 text-[10px] font-semibold uppercase text-muted-foreground">导出违例数据</div>
                  <button
                    onClick={() => { setShowExportMenu(false); void exportViolations(projectId, 'excel', filterCaseName ?? undefined, filterCorner ?? undefined); }}
                    className="flex w-full items-center gap-2 px-3 py-1.5 text-xs hover:bg-accent"
                  >
                    <FileSpreadsheet className="h-3.5 w-3.5" />
                    Excel (.xlsx)
                  </button>
                  <button
                    onClick={() => { setShowExportMenu(false); void exportViolations(projectId, 'csv', filterCaseName ?? undefined, filterCorner ?? undefined); }}
                    className="flex w-full items-center gap-2 px-3 py-1.5 text-xs hover:bg-accent"
                  >
                    <FileText className="h-3.5 w-3.5" />
                    CSV (.csv)
                  </button>
                  <div className="my-1 border-t border-border" />
                  <div className="px-2 py-1 text-[10px] font-semibold uppercase text-muted-foreground">导出 Pattern</div>
                  <button
                    onClick={() => { setShowExportMenu(false); void exportPatterns(projectId, 'excel'); }}
                    className="flex w-full items-center gap-2 px-3 py-1.5 text-xs hover:bg-accent"
                  >
                    <FileSpreadsheet className="h-3.5 w-3.5" />
                    Pattern Excel
                  </button>
                  <button
                    onClick={() => { setShowExportMenu(false); void exportPatterns(projectId, 'csv'); }}
                    className="flex w-full items-center gap-2 px-3 py-1.5 text-xs hover:bg-accent"
                  >
                    <FileText className="h-3.5 w-3.5" />
                    Pattern CSV
                  </button>
                  <button
                    onClick={() => { setShowExportMenu(false); void exportPatterns(projectId, 'db'); }}
                    className="flex w-full items-center gap-2 px-3 py-1.5 text-xs hover:bg-accent"
                  >
                    <Database className="h-3.5 w-3.5" />
                    Pattern DB
                  </button>
                  <div className="my-1 border-t border-border" />
                  <button
                    onClick={() => { setShowExportMenu(false); void importPatterns(projectId); }}
                    className="flex w-full items-center gap-2 px-3 py-1.5 text-xs hover:bg-accent"
                  >
                    <Upload className="h-3.5 w-3.5" />
                    导入 Pattern DB
                  </button>
                </div>
              </>
            )}
        </div>

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

        <div className="ml-auto flex items-center gap-2">
          {/* 批量操作按钮 */}
          {selectedCount > 0 && (
            <>
              <span className="text-[11px] text-primary">
                已选 {selectedCount} 条
              </span>
              <button
                onClick={() => openConfirmDialog(null)}
                disabled={confirming}
                className={cn(
                  'flex items-center gap-1 rounded-md border border-border px-2 py-1 text-[11px] transition-colors',
                  'hover:bg-accent hover:text-foreground',
                  confirming && 'opacity-40 cursor-not-allowed',
                )}
                title="批量确认选中违例"
              >
                <CheckSquare className="h-3 w-3" />
                批量确认
              </button>
              <button
                onClick={clearSelection}
                disabled={confirming}
                className="flex items-center gap-1 rounded-md border border-border px-2 py-1 text-[11px] text-muted-foreground hover:bg-accent hover:text-foreground"
                title="取消选择"
              >
                <XCircle className="h-3 w-3" />
                取消选择
              </button>
            </>
          )}
          <button
            onClick={() => {
              if (window.confirm('确定要清空所有违例数据吗？此操作不可撤销。')) {
                void clearAllData(projectId);
              }
            }}
            disabled={parsing || total === 0}
            className={cn(
              'flex items-center gap-1 rounded-md border border-border px-2 py-1 text-[11px] text-muted-foreground transition-colors',
              'hover:bg-destructive/10 hover:text-destructive',
              (parsing || total === 0) && 'opacity-40 cursor-not-allowed',
            )}
            title="清空所有违例数据"
          >
            <Trash2 className="h-3 w-3" />
            清空数据
          </button>
          {statistics && (
            <span className="text-[11px] text-muted-foreground">
              数据库共 {statistics.total.toLocaleString()} 条违例
            </span>
          )}
        </div>
      </div>

      {/* 统计卡片 */}
      <div className="shrink-0 px-3 py-2">
        <TVStatsCards statistics={statistics} loading={loadingStatistics} />
      </div>

      {/* 分布图表（可折叠） */}
      {statistics && statistics.total > 0 && (
        <div className="shrink-0 border-b">
          <button
            onClick={() => setShowCharts((v) => !v)}
            className="flex w-full items-center gap-1.5 px-3 py-1.5 text-xs font-medium text-muted-foreground hover:bg-accent/50"
          >
            {showCharts ? <ChevronDown className="h-3.5 w-3.5" /> : <ChevronRight className="h-3.5 w-3.5" />}
            分布图表
          </button>
          {showCharts && (
            <TVDistributionCharts
              statistics={statistics}
              loading={loadingStatistics}
              onSubsysClick={(subsys) => useTimingViolationStore.getState().setFilterSubsys(subsys)}
              onCornerClick={(corner) => useTimingViolationStore.getState().setFilterCorner(corner)}
              onCaseClick={(caseName) => useTimingViolationStore.getState().setFilterCaseName(caseName)}
              onStatusClick={(status) => useTimingViolationStore.getState().setFilterStatus(status)}
            />
          )}
        </div>
      )}

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
        selectedViolationIds={selectedViolationIds}
        onToggleSelect={toggleViolationSelection}
        onSelectAll={selectAllVisibleViolations}
        onRowConfirm={(v) => openConfirmDialog(v)}
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

      {/* Pattern 管理面板 */}
      <TVPatternManager open={showPatternManager} onClose={() => setShowPatternManager(false)} />

      {/* 回归扫描对话框 */}
      <TVScanDialog open={showScanDialog} onClose={() => setShowScanDialog(false)} />

      {/* 自动确认对话框 */}
      <TVAutoConfirmDialog
        open={showAutoConfirm}
        confirming={confirming}
        defaultResetTimeNs={1000}
        onSubmit={async (opts) => {
          // 自动确认针对所有用例（或当前筛选的用例），不要求必须选择用例
          const caseName = filterCaseName ?? undefined;
          await autoConfirmByInterval(projectId, caseName, opts);
          setShowAutoConfirm(false);
        }}
        onClose={() => setShowAutoConfirm(false)}
      />

      {/* 确认对话框 */}
      <TVConfirmationDialog
        open={showConfirmDialog}
        violation={confirmDialogViolation}
        batchIds={selectedCount > 0 ? selectedIds : []}
        confirming={confirming}
        onSubmit={handleConfirmSubmit}
        onClose={closeConfirmDialog}
      />
    </div>
  );
}
