/**
 * TVDashboard — 时序违例主容器
 *
 * 包含：文件选择按钮 + 解析结果摘要 + 统计卡片 + 筛选栏 + 虚拟滚动表格。
 * 工具栏包含自动确认按钮和批量确认/忽略按钮。
 * 从 useTimingViolationStore 获取状态和操作。
 */

import { useEffect, useRef, useState } from 'react';
import { FolderOpen, Loader2, AlertCircle, FileText, Trash2, Zap, CheckSquare, XCircle, History, ListChecks, Download, Upload, ChevronDown, ChevronRight, FileSpreadsheet, Database, Settings, Edit3, RefreshCw } from 'lucide-react';
import { useTimingViolationStore } from '@renderer/stores/timing-violation';
import { useProjectStore } from '@renderer/stores/project';
import { useSessionStore } from '@renderer/stores/session';
import { useUiStore } from '@renderer/stores/ui';
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
  const parseProgress = useTimingViolationStore((s) => s.parseProgress);
  const setParseProgress = useTimingViolationStore((s) => s.setParseProgress);
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

// AI 建议相关
const startAISuggestion = useTimingViolationStore((s) => s.startAISuggestion);
const parseAISuggestionResponse = useTimingViolationStore((s) => s.parseAISuggestionResponse);
const clearAISuggestion = useTimingViolationStore((s) => s.clearAISuggestion);
const applyAISuggestion = useTimingViolationStore((s) => s.applyAISuggestion);
const aiSuggesting = useTimingViolationStore((s) => s.aiSuggesting);
const aiSuggestion = useTimingViolationStore((s) => s.aiSuggestion);
const aiSuggestionViolationId = useTimingViolationStore((s) => s.aiSuggestionViolationId);
  const setShowPatternManager = useTimingViolationStore((s) => s.setShowPatternManager);
  const applyHistoricalConfirmations = useTimingViolationStore((s) => s.applyHistoricalConfirmations);
  const setShowScanDialog = useTimingViolationStore((s) => s.setShowScanDialog);

  // 导出/导入 Actions
  const exportViolations = useTimingViolationStore((s) => s.exportViolations);
  const exportPatterns = useTimingViolationStore((s) => s.exportPatterns);
  const importPatterns = useTimingViolationStore((s) => s.importPatterns);
  const exporting = useTimingViolationStore((s) => s.exporting);
  const importing = useTimingViolationStore((s) => s.importing);

  // 配置状态
  const tvConfig = useTimingViolationStore((s) => s.tvConfig);
  const loadTvConfig = useTimingViolationStore((s) => s.loadTvConfig);
  const saveTvConfig = useTimingViolationStore((s) => s.saveTvConfig);

  // 数据管理 Actions
  const clearCaseData = useTimingViolationStore((s) => s.clearCaseData);
  const updateCorner = useTimingViolationStore((s) => s.updateCorner);
  const managingData = useTimingViolationStore((s) => s.managingData);
  const caseCorners = useTimingViolationStore((s) => s.caseCorners);
  const loadingCaseCorners = useTimingViolationStore((s) => s.loadingCaseCorners);
  const loadCaseCorners = useTimingViolationStore((s) => s.loadCaseCorners);
  const refreshSubsys = useTimingViolationStore((s) => s.refreshSubsys);
  const refreshingSubsys = useTimingViolationStore((s) => s.refreshingSubsys);
  const allCaseCorners = useTimingViolationStore((s) => s.allCaseCorners);
  const loadAllCaseCorners = useTimingViolationStore((s) => s.loadAllCaseCorners);

  // 本地 UI 状态
  const [showAutoConfirm, setShowAutoConfirm] = useState(false);
  const [showCharts, setShowCharts] = useState(true);
  const [showExportMenu, setShowExportMenu] = useState(false);
  const [showDataMenu, setShowDataMenu] = useState(false);
  const [showCornerEdit, setShowCornerEdit] = useState(false);
  const [cornerEditCase, setCornerEditCase] = useState('');
  const [cornerEditOld, setCornerEditOld] = useState('');
  const [cornerEditNew, setCornerEditNew] = useState('');

  // 搜索防抖
  const searchTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  // 初始加载
  useEffect(() => {
    if (!projectId) return;
    void loadViolations(projectId);
    void loadStatistics(projectId);
    void loadMetadata(projectId);
    void loadTvConfig(projectId);
  }, [projectId, loadViolations, loadStatistics, loadMetadata, loadTvConfig]);

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

  // 数据管理下拉列表打开时加载全量 corner 信息
  useEffect(() => {
    if (showDataMenu && projectId) {
      void loadAllCaseCorners(projectId);
    }
  }, [showDataMenu, projectId, loadAllCaseCorners]);

  // 监听解析进度 IPC 事件
  useEffect(() => {
    if (!window.eventBridge) return;
    const cleanup = window.eventBridge.onViolationParseProgress((data) => {
      if (data.processedLines === -1) {
        // 解析完成
        setParseProgress(null);
      } else {
        setParseProgress({
          processedLines: data.processedLines,
          foundViolations: data.foundViolations,
        });
      }
    });
    return cleanup;
  }, [setParseProgress]);

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

        {/* 解析进度指示器 */}
        {parsing && parseProgress && (
          <div className="flex items-center gap-2 text-[11px] text-muted-foreground">
            <Loader2 className="h-3 w-3 animate-spin" />
            <span>
              已处理 {parseProgress.processedLines.toLocaleString()} 行 · 发现 {parseProgress.foundViolations.toLocaleString()} 条违例
            </span>
          </div>
        )}

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

          {/* 数据管理下拉菜单 */}
          <div className="relative">
            <button
              onClick={() => setShowDataMenu((v) => !v)}
              disabled={managingData || total === 0}
              className={cn(
                'flex items-center gap-1 rounded-md border border-border px-2 py-1 text-[11px] transition-colors',
                'hover:bg-accent hover:text-foreground',
                (managingData || total === 0) && 'opacity-40 cursor-not-allowed',
              )}
              title="数据管理"
            >
              {managingData ? (
                <Loader2 className="h-3 w-3 animate-spin" />
              ) : (
                <Settings className="h-3 w-3" />
              )}
              数据管理
            </button>
            {showDataMenu && (
              <>
                <div className="fixed inset-0 z-10" onClick={() => setShowDataMenu(false)} />
                <div className="absolute right-0 top-full z-20 mt-1 w-64 rounded-md border border-border bg-background shadow-lg">
                  {/* 当存在 unknown 子系统时，显示刷新子系统按钮 */}
                  {statistics && statistics.bySubsys['unknown'] && (
                    <>
                      <button
                        onClick={() => {
                          setShowDataMenu(false);
                          void refreshSubsys(projectId);
                        }}
                        disabled={refreshingSubsys}
                        className={cn(
                          'flex w-full items-center gap-2 px-3 py-1.5 text-xs hover:bg-accent',
                          refreshingSubsys && 'opacity-50 cursor-not-allowed',
                        )}
                      >
                        {refreshingSubsys ? <Loader2 className="h-3 w-3 animate-spin" /> : <RefreshCw className="h-3 w-3 text-amber-600/70" />}
                        <span className="text-amber-600 dark:text-amber-400">刷新子系统信息</span>
                      </button>
                      <div className="my-1 border-t border-border" />
                    </>
                  )}
                  <div className="px-2 py-1 text-[10px] font-semibold uppercase text-muted-foreground">清除用例数据</div>
                  {metadata.cases.length === 0 ? (
                    <div className="px-3 py-1.5 text-[11px] text-muted-foreground/50">暂无用例</div>
                  ) : (
                    metadata.cases.slice(0, 10).map((c) => (
                      <button
                        key={c}
                        onClick={() => {
                          setShowDataMenu(false);
                          if (window.confirm(`确定要清除用例 "${c}" 的所有违例数据吗？`)) {
                            void clearCaseData(projectId, c);
                          }
                        }}
                        className="flex w-full items-center gap-2 px-3 py-1.5 text-xs hover:bg-accent"
                      >
                        <Trash2 className="h-3 w-3 text-destructive/70" />
                        <span className="truncate">{c}</span>
                      </button>
                    ))
                  )}
                  {metadata.cases.length > 10 && (
                    <div className="px-3 py-1 text-[10px] text-muted-foreground/50">
                      还有 {metadata.cases.length - 10} 个用例...
                    </div>
                  )}
                  <div className="my-1 border-t border-border" />
                  <div className="px-2 py-1 text-[10px] font-semibold uppercase text-muted-foreground">更新 Corner</div>
                  {metadata.cases.length === 0 ? (
                    <div className="px-3 py-1.5 text-[11px] text-muted-foreground/50">暂无用例</div>
                  ) : (
                    metadata.cases.slice(0, 10).map((c) => {
                      const corners = allCaseCorners?.[c];
                      return (
                        <button
                          key={c}
                          onClick={() => {
                            setShowDataMenu(false);
                            setCornerEditCase(c);
                            setCornerEditOld('');
                            setCornerEditNew('');
                            setShowCornerEdit(true);
                            void loadCaseCorners(projectId, c);
                          }}
                          className="flex w-full items-center gap-2 px-3 py-1.5 text-xs hover:bg-accent"
                        >
                          <Edit3 className="h-3 w-3 shrink-0 text-primary/70" />
                          <span className="min-w-0 truncate">{c}</span>
                          {corners && corners.length > 0 && (
                            <div className="ml-auto flex shrink-0 gap-1">
                              {corners.map((cc) => (
                                <span
                                  key={cc.corner ?? '__null__'}
                                  className={cn(
                                    'inline-flex items-center gap-0.5 rounded border px-1 py-0.5 text-[9px]',
                                    cc.corner === null
                                      ? 'border-amber-500/40 bg-amber-500/10 text-amber-600 dark:text-amber-400'
                                      : 'border-border bg-secondary/30 text-muted-foreground',
                                  )}
                                >
                                  {cc.corner === null ? '默认' : cc.corner}
                                  <span className="opacity-60">{cc.count}</span>
                                </span>
                              ))}
                            </div>
                          )}
                        </button>
                      );
                    })
                  )}
                </div>
              </>
            )}
          </div>
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
          <div className="flex items-center">
            <button
              onClick={() => setShowCharts((v) => !v)}
              className="flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium text-muted-foreground hover:bg-accent/50"
            >
              {showCharts ? <ChevronDown className="h-3.5 w-3.5" /> : <ChevronRight className="h-3.5 w-3.5" />}
              分布图表
            </button>
            {/* 刷新子系统按钮：当存在 unknown 子系统时显示 */}
            {statistics.bySubsys['unknown'] && (
              <button
                onClick={() => void refreshSubsys(projectId)}
                disabled={refreshingSubsys}
                className={cn(
                  'flex items-center gap-1 rounded px-2 py-0.5 text-[10px] font-medium transition-colors',
                  'text-amber-600 dark:text-amber-400 hover:bg-amber-500/10',
                  refreshingSubsys && 'opacity-50 cursor-not-allowed',
                )}
                title="更新 case cfg 后点击此按钮刷新子系统信息"
              >
                {refreshingSubsys ? <Loader2 className="h-3 w-3 animate-spin" /> : <RefreshCw className="h-3 w-3" />}
                刷新子系统
              </button>
            )}
          </div>
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
onRowAISuggest={(v) => {
  // 启动 AI 建议（流式模式）— 在右侧 AI 面板新开会话展示
  void (async () => {
    const result = await startAISuggestion(projectId, v.id);
    if (!result) return;

    // 在右侧 AI 面板创建新会话标签
    const sessionStore = useSessionStore.getState();
    const sessionId = `tv_ai_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
    const userMessage = {
      id: `msg_${sessionId}_user`,
      role: 'user' as const,
      content: result.promptMessage,
      timestamp: Date.now(),
    };
    const assistantMessage = {
      id: `msg_${sessionId}_assistant`,
      role: 'assistant' as const,
      content: '',
      timestamp: Date.now(),
      isStreaming: true,
    };
    const newSession = {
      id: sessionId,
      runtimeSessionId: result.sessionId,
      persistedSessionId: result.sessionId,
      projectId,
      name: `[TV分析] Vio#${v.num}`,
      status: 'streaming' as const,
      messages: [userMessage, assistantMessage],
      composer: { inputMessage: '', selectedSkills: [], contextFiles: [] },
      createdAt: Date.now(),
      model: sessionStore.lastModel ?? undefined,
      tvViolationId: v.id,
    };

    useSessionStore.setState((s) => ({
      sessions: [...s.sessions, newSession],
      currentSessionId: sessionId,
    }));

    // 如果右侧面板已折叠，展开它
    if (useUiStore.getState().rightPanelCollapsed) {
      useUiStore.getState().toggleRightPanel();
    }

    // 注册 sessionEvent 监听器，捕获 AI 响应完成事件
    if (window.eventBridge) {
      let responseText = '';
      const cleanup = window.eventBridge.onSessionEvent(({ sessionId: sid, event }) => {
        if (sid !== result.sessionId) return;
        const evt = event as Record<string, unknown>;
        const type = evt.type as string;

        if (type === 'message_update' || type === 'message_end') {
          const msg = evt.message as Record<string, unknown> | undefined;
          if (msg?.role !== 'assistant') return;
          // 提取文本
          const content = msg.content;
          if (typeof content === 'string') {
            responseText = content;
          } else if (Array.isArray(content)) {
            let text = '';
            for (const block of content) {
              if (typeof block === 'object' && block !== null) {
                const b = block as Record<string, unknown>;
                if (b.type === 'text' && typeof b.text === 'string') {
                  text += b.text;
                }
              }
            }
            responseText = text;
          }
        }

        if (type === 'agent_end') {
          // AI 响应完成，解析建议并更新 store
          cleanup();
          if (responseText) {
            void parseAISuggestionResponse(responseText);
          } else {
            useTimingViolationStore.setState({ aiSuggesting: false });
          }
        }
      });
    }
  })();
}}
aiSuggestingViolationId={aiSuggesting ? aiSuggestionViolationId : null}
aiSuggestionViolationId={aiSuggestionViolationId}
aiSuggestion={aiSuggestion}
onApplyAISuggestion={(v) => {
  if (aiSuggestion) {
    applyAISuggestion(projectId, v.id, aiSuggestion);
  }
}}
onClearAISuggestion={clearAISuggestion}
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
        defaultResetTimeNs={tvConfig?.defaultResetTimeNs ?? 1000}
        defaultIntervalStartNs={tvConfig?.resetIntervalStartNs ?? null}
        defaultIntervalEndNs={tvConfig?.resetIntervalEndNs ?? null}
        onSubmit={async (opts) => {
          // 自动确认针对所有用例（或当前筛选的用例），不要求必须选择用例
          const caseName = filterCaseName ?? undefined;
          await autoConfirmByInterval(projectId, caseName, opts);

          // 将用户使用的复位时间和区间持久化到配置，供 AI 分析使用
          if (tvConfig) {
            const updatedConfig = {
              ...tvConfig,
              defaultResetTimeNs: opts.resetTimeNs ?? tvConfig.defaultResetTimeNs,
              resetIntervalStartNs: opts.intervalStartNs ?? null,
              resetIntervalEndNs: opts.intervalEndNs ?? null,
            };
            await saveTvConfig(projectId, updatedConfig);
          }

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

      {/* Corner 编辑对话框 */}
      {showCornerEdit && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50">
          <div className="w-[420px] rounded-lg border border-border bg-popover p-4 shadow-2xl">
            <h3 className="mb-1 text-sm font-semibold">更新 Corner — {cornerEditCase}</h3>
            <p className="mb-3 text-[11px] text-muted-foreground">
              选择要更新的 Corner（仅显示该用例已有的 Corner），输入新 Corner 名称
            </p>
            {/* 当用例 Corner 分布 */}
            <div className="mb-3 rounded-md border border-border/50 bg-secondary/20 p-2">
              <div className="mb-1 text-[10px] font-semibold uppercase text-muted-foreground">
                当前用例 Corner 分布
              </div>
              {loadingCaseCorners ? (
                <div className="flex items-center gap-1.5 py-1 text-[11px] text-muted-foreground">
                  <Loader2 className="h-3 w-3 animate-spin" />
                  加载中...
                </div>
              ) : caseCorners.length === 0 ? (
                <div className="py-1 text-[11px] text-muted-foreground/50">暂无数据</div>
              ) : (
                <div className="flex flex-wrap gap-1.5">
                  {caseCorners.map((cc) => (
                    <span
                      key={cc.corner ?? '__null__'}
                      className={cn(
                        'inline-flex items-center gap-1 rounded border px-1.5 py-0.5 text-[10px]',
                        cc.corner === null
                          ? 'border-amber-500/40 bg-amber-500/10 text-amber-600 dark:text-amber-400'
                          : 'border-border bg-background text-foreground',
                      )}
                    >
                      {cc.corner === null ? '默认 (未匹配)' : cc.corner}
                      <span className="text-muted-foreground">{cc.count} 条</span>
                    </span>
                  ))}
                </div>
              )}
            </div>
            <div className="space-y-3">
              <div>
                <label className="mb-1 block text-[10px] font-semibold uppercase text-muted-foreground">
                  旧 Corner（可选，留空更新所有未匹配的）
                </label>
                <select
                  value={cornerEditOld}
                  onChange={(e) => setCornerEditOld(e.target.value)}
                  className="w-full rounded border border-border bg-background px-2 py-1.5 text-xs outline-none focus:ring-1 focus:ring-primary"
                >
                  <option value="">所有 Corner</option>
                  {caseCorners.map((cc) => (
                    <option key={cc.corner ?? '__null__'} value={cc.corner ?? ''}>
                      {cc.corner === null ? '默认 (未匹配)' : cc.corner} ({cc.count} 条)
                    </option>
                  ))}
                </select>
                <p className="mt-1 text-[10px] text-muted-foreground">
                  提示：选择「默认 (未匹配)」可单独更新未匹配到 Corner 的记录
                </p>
              </div>
              <div>
                <label className="mb-1 block text-[10px] font-semibold uppercase text-muted-foreground">
                  新 Corner
                </label>
                <input
                  type="text"
                  value={cornerEditNew}
                  onChange={(e) => setCornerEditNew(e.target.value)}
                  placeholder="输入新 corner 名称"
                  className="w-full rounded border border-border bg-background px-2 py-1.5 text-xs outline-none focus:ring-1 focus:ring-primary"
                />
              </div>
            </div>
            <div className="mt-4 flex justify-end gap-2">
              <button
                onClick={() => setShowCornerEdit(false)}
                className="rounded px-3 py-1.5 text-xs text-muted-foreground hover:bg-accent"
              >
                取消
              </button>
              <button
                onClick={() => {
                  if (cornerEditNew.trim()) {
                    void updateCorner(projectId, cornerEditCase, cornerEditNew.trim(), cornerEditOld || undefined);
                    setShowCornerEdit(false);
                  }
                }}
                disabled={!cornerEditNew.trim() || managingData}
                className={cn(
                  'flex items-center gap-1 rounded px-3 py-1.5 text-xs font-medium transition-colors',
                  cornerEditNew.trim() && !managingData
                    ? 'bg-primary text-primary-foreground hover:bg-primary/90'
                    : 'cursor-not-allowed bg-muted text-muted-foreground',
                )}
              >
                {managingData ? <Loader2 className="h-3 w-3 animate-spin" /> : <Edit3 className="h-3 w-3" />}
                更新
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
