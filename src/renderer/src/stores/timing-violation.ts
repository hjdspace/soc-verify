/**
 * Timing Violation Zustand store
 *
 * 管理时序违例模块的筛选/排序/搜索状态、违例列表数据、统计信息和元数据。
 * 筛选状态在切换 Destination 后恢复（持久化在 store 内存中）。
 */

import { create } from 'zustand';
import { trpc } from '@renderer/lib/trpc';
import { getToast } from '@renderer/lib/trpc-utils';

// ── 类型 ──────────────────────────────────────────────────

export type ConfirmationStatus = 'pending' | 'confirmed' | 'ignored';

export type SortField = 'time_fs' | 'num' | 'hier' | 'created_at';
export type SortOrder = 'asc' | 'desc';

export type ViolationWithConfirmation = {
  id: number;
  caseName: string;
  corner: string | null;
  seed: string | null;
  subsys: string | null;
  num: number;
  hier: string;
  timeFs: number;
  timeDisplay: string;
  checkInfo: string;
  filePath: string;
  createdAt: string;
  status: ConfirmationStatus;
  confirmer: string | null;
  result: string | null;
  reason: string | null;
  isAutoConfirmed: boolean;
  confirmedAt: string | null;
};

export type ViolationStatistics = {
  total: number;
  confirmed: number;
  pending: number;
  ignored: number;
  bySubsys: Record<string, number>;
  byCorner: Record<string, number>;
  byCase: Record<string, number>;
};

export type ViolationMetadata = {
  corners: string[];
  cases: string[];
  subsys: string[];
};

export type ParseResult = {
  success: boolean;
  total: number;
  inserted: number;
  skipped: number;
  appliedHistorical?: number;
  errors: string[];
};

// ── 确认相关类型 ──────────────────────────────────────────

export type ConfirmResult = 'pass' | 'issue';

export type AutoConfirmResult = {
  confirmedCount: number;
};

// ── Pattern 相关类型 ──────────────────────────────────────

export type ViolationPattern = {
  id: number;
  hierPattern: string;
  checkPattern: string;
  defaultConfirmer: string | null;
  defaultResult: string | null;
  defaultReason: string | null;
  matchCount: number;
  lastUsed: string;
};

export type PatternSuggestion = {
  pattern: ViolationPattern;
  matchType: 'exact' | 'fuzzy';
} | null;

// ── 扫描相关类型 ──────────────────────────────────────────

export type RegressionFileInfo = {
  filePath: string;
  subsys: string;
  cornerName: string;
  caseName: string;
  seed: string;
  relativePath: string;
  fileSize: number;
  modifiedTime: string;
  caseStatus: 'PASS' | 'FAIL';
};

export type ScanResult = {
  totalFiles: number;
  validFiles: RegressionFileInfo[];
  invalidPaths: string[];
  scanTime: number;
  subsysGroups: Record<string, RegressionFileInfo[]>;
  cornerGroups: Record<string, RegressionFileInfo[]>;
  caseGroups: Record<string, RegressionFileInfo[]>;
  statusGroups: Record<string, RegressionFileInfo[]>;
};

export type BatchProcessResult = {
  totalInserted: number;
  totalSkipped: number;
  totalErrors: string[];
  processedCount: number;
};

// ── 配置类型 ────────────────────────────────────────────────

export type TvConfig = {
  dataDir: string;
  corners: string[];
  subsysPatterns: string[];
  defaultResetTimeNs: number;
  autoBackup: boolean;
  backupInterval: number;
};

// ── AI 建议类型 ───────────────────────────────────────────

export type AISuggestion = {
  confirmer: string | undefined;
  result: string | undefined;
  reason: string | undefined;
  confidence: number;
  analysis?: string;
};

// ── 用例 Corner 信息类型 ────────────────────────────────

export type CaseCornerInfo = {
  corner: string | null;
  count: number;
};

// ── Store 类型 ─────────────────────────────────────────────

interface TimingViolationState {
  // 数据
  violations: ViolationWithConfirmation[];
  total: number;
  statistics: ViolationStatistics | null;
  metadata: ViolationMetadata;

  // 分页
  page: number;
  pageSize: number;

  // 筛选
  filterCaseName: string | null;
  filterCorner: string | null;
  filterStatus: ConfirmationStatus | null;
  filterSubsys: string | null;
  searchText: string;

  // 排序
  sortField: SortField;
  sortOrder: SortOrder;

  // 解析状态
  parsing: boolean;
  parseResult: ParseResult | null;
  parseProgress: { processedLines: number; foundViolations: number } | null;

  // 加载状态
  loadingViolations: boolean;
  loadingStatistics: boolean;
  loadingMetadata: boolean;

  // 确认状态
  confirming: boolean;
  selectedViolationIds: Set<number>;
  showConfirmDialog: boolean;
  confirmDialogViolation: ViolationWithConfirmation | null;

  // AI 建议状态
  aiSuggesting: boolean;
  aiSuggestion: AISuggestion | null;
  aiSuggestionViolationId: number | null;

  // Pattern 状态
  patterns: ViolationPattern[];
  loadingPatterns: boolean;
  showPatternManager: boolean;

  // 扫描状态
  scanning: boolean;
  scanResult: ScanResult | null;
  batchProcessing: boolean;
  batchProgress: BatchProcessResult | null;
  showScanDialog: boolean;

  // 导出/导入状态
  exporting: boolean;
  importing: boolean;

  // 配置状态
  tvConfig: TvConfig | null;
  loadingConfig: boolean;
  savingConfig: boolean;

  // 数据管理状态
  managingData: boolean;

  // 用例 Corner 信息（更新 corner 对话框使用）
  caseCorners: CaseCornerInfo[];
  loadingCaseCorners: boolean;

  // ── Actions ─────────────────────────────
  pickAndParse: (projectId: string) => Promise<void>;
  parseFile: (projectId: string, filePath: string, caseName?: string, corner?: string) => Promise<void>;
  setParseProgress: (progress: { processedLines: number; foundViolations: number } | null) => void;
  loadViolations: (projectId: string) => Promise<void>;
  loadStatistics: (projectId: string) => Promise<void>;
  loadMetadata: (projectId: string) => Promise<void>;
  refreshAll: (projectId: string) => Promise<void>;
  clearAllData: (projectId: string) => Promise<void>;
  clearCaseData: (projectId: string, caseName: string, corner?: string) => Promise<void>;
  updateCorner: (projectId: string, caseName: string, newCorner: string, oldCorner?: string) => Promise<void>;
  loadCaseCorners: (projectId: string, caseName: string) => Promise<void>;

  setFilterCaseName: (v: string | null) => void;
  setFilterCorner: (v: string | null) => void;
  setFilterStatus: (v: ConfirmationStatus | null) => void;
  setFilterSubsys: (v: string | null) => void;
  setSearchText: (v: string) => void;
  setSort: (field: SortField) => void;
  setPage: (page: number) => void;

  resetFilters: () => void;

  // 确认相关 Actions
  autoConfirmByResetTime: (projectId: string, caseName: string | undefined, resetTimeNs: number) => Promise<void>;
  autoConfirmByInterval: (projectId: string, caseName: string | undefined, opts: { resetTimeNs?: number; intervalStartNs?: number; intervalEndNs?: number }) => Promise<void>;
  updateConfirmation: (projectId: string, violationId: number, status: ConfirmationStatus, confirmer: string, result: ConfirmResult, reason: string) => Promise<void>;
  batchUpdateConfirmations: (projectId: string, violationIds: number[], status: ConfirmationStatus, confirmer: string, result: ConfirmResult, reason: string) => Promise<void>;

  // AI 建议相关 Actions
  suggestConfirmation: (projectId: string, violationId: number) => Promise<void>;
  startAISuggestion: (projectId: string, violationId: number) => Promise<{ sessionId: string; promptMessage: string } | null>;
  parseAISuggestionResponse: (responseText: string) => Promise<AISuggestion | null>;
  clearAISuggestion: () => void;
  applyAISuggestion: (projectId: string, violationId: number, suggestion: AISuggestion) => Promise<void>;

  toggleViolationSelection: (id: number) => void;
  selectAllVisibleViolations: () => void;
  clearSelection: () => void;
  openConfirmDialog: (violation: ViolationWithConfirmation | null) => void;
  closeConfirmDialog: () => void;

  // Pattern 相关 Actions
  applyHistoricalConfirmations: (projectId: string, caseName?: string, corner?: string) => Promise<void>;
  loadPatterns: (projectId: string) => Promise<void>;
  clearAllPatterns: (projectId: string) => Promise<void>;
  setShowPatternManager: (show: boolean) => void;

  // 扫描相关 Actions
  scanRegression: (projectId: string, regressionRoot: string, useStandardStructure: boolean) => Promise<void>;
  batchProcess: (projectId: string, filePaths: string[]) => Promise<void>;
  pickRegressionDir: () => Promise<string | null>;
  setShowScanDialog: (show: boolean) => void;

  // 导出/导入 Actions
  exportViolations: (projectId: string, format: 'excel' | 'csv', caseName?: string, corner?: string) => Promise<void>;
  exportPatterns: (projectId: string, format: 'excel' | 'csv' | 'db') => Promise<void>;
  importPatterns: (projectId: string) => Promise<void>;
  mergeDatabases: (projectId: string, sourceFilePaths: string[]) => Promise<void>;

  // 配置 Actions
  loadTvConfig: (projectId: string) => Promise<void>;
  saveTvConfig: (projectId: string, config: TvConfig) => Promise<void>;
}

// ── 实现 ──────────────────────────────────────────────────

export const useTimingViolationStore = create<TimingViolationState>((set, get) => ({
  violations: [],
  total: 0,
  statistics: null,
  metadata: { corners: [], cases: [], subsys: [] },

  page: 1,
  pageSize: 200,

  filterCaseName: null,
  filterCorner: null,
  filterStatus: null,
  filterSubsys: null,
  searchText: '',

  sortField: 'num',
  sortOrder: 'asc',

  parsing: false,
  parseResult: null,
  parseProgress: null,

  loadingViolations: false,
  loadingStatistics: false,
  loadingMetadata: false,

  confirming: false,
  selectedViolationIds: new Set(),
  showConfirmDialog: false,
  confirmDialogViolation: null,

  // AI 建议状态
  aiSuggesting: false,
  aiSuggestion: null,
  aiSuggestionViolationId: null,

  patterns: [],
  loadingPatterns: false,
  showPatternManager: false,

  scanning: false,
  scanResult: null,
  batchProcessing: false,
  batchProgress: null,
  showScanDialog: false,

  exporting: false,
  importing: false,

  tvConfig: null,
  loadingConfig: false,
  savingConfig: false,
  managingData: false,
  caseCorners: [],
  loadingCaseCorners: false,

  pickAndParse: async (projectId) => {
    set({ parsing: true, parseResult: null, parseProgress: null });
    try {
      const fileResult = await trpc.violation.pickFile.mutate({ defaultPath: undefined });
      if (fileResult.canceled || !fileResult.filePath) {
        set({ parsing: false, parseProgress: null });
        return;
      }
      await get().parseFile(projectId, fileResult.filePath);
    } catch (err) {
      getToast().error('选择文件失败', err instanceof Error ? err.message : String(err));
      set({ parsing: false, parseProgress: null });
    }
  },

  parseFile: async (projectId, filePath, caseName, corner) => {
    set({ parsing: true, parseResult: null, parseProgress: null });
    try {
      const result = await trpc.violation.parseLog.mutate({
        projectId,
        filePath,
        caseName,
        corner,
      });
      set({ parseResult: result, parsing: false, parseProgress: null });
      const detailParts: string[] = [];
      if (result.appliedHistorical && result.appliedHistorical > 0) {
        detailParts.push(`历史确认自动应用 ${result.appliedHistorical} 条`);
      }
      if (result.errors.length > 0) {
        detailParts.push(`${result.errors.length} 个错误`);
      }
      getToast().success(
        `解析完成：${result.inserted} 条新增，${result.skipped} 条跳过`,
        detailParts.length > 0 ? detailParts.join('，') : undefined,
      );
      // 刷新数据
      await get().refreshAll(projectId);
    } catch (err) {
      getToast().error('解析日志失败', err instanceof Error ? err.message : String(err));
      set({ parsing: false, parseProgress: null });
    }
  },

  setParseProgress: (progress) => set({ parseProgress: progress }),

  loadViolations: async (projectId) => {
    set({ loadingViolations: true });
    try {
      const s = get();
      const result = await trpc.violation.queryViolations.query({
        projectId,
        page: s.page,
        pageSize: s.pageSize,
        caseName: s.filterCaseName ?? undefined,
        corner: s.filterCorner ?? undefined,
        status: s.filterStatus ?? undefined,
        subsys: s.filterSubsys ?? undefined,
        searchText: s.searchText || undefined,
        sortField: s.sortField,
        sortOrder: s.sortOrder,
      });
      set({ violations: result.items as ViolationWithConfirmation[], total: result.total, loadingViolations: false });
    } catch (err) {
      set({ loadingViolations: false });
      getToast().error('加载违例列表失败', err instanceof Error ? err.message : String(err));
    }
  },

  loadStatistics: async (projectId) => {
    set({ loadingStatistics: true });
    try {
      const s = get();
      const stats = await trpc.violation.getStatistics.query({
        projectId,
        caseName: s.filterCaseName ?? undefined,
        corner: s.filterCorner ?? undefined,
      });
      set({ statistics: stats as ViolationStatistics, loadingStatistics: false });
    } catch (err) {
      set({ loadingStatistics: false });
      getToast().error('加载统计信息失败', err instanceof Error ? err.message : String(err));
    }
  },

  loadMetadata: async (projectId) => {
    set({ loadingMetadata: true });
    try {
      const meta = await trpc.violation.getMetadata.query({ projectId });
      set({ metadata: meta as ViolationMetadata, loadingMetadata: false });
    } catch (err) {
      set({ loadingMetadata: false });
      getToast().error('加载元数据失败', err instanceof Error ? err.message : String(err));
    }
  },

  refreshAll: async (projectId) => {
    await Promise.all([
      get().loadViolations(projectId),
      get().loadStatistics(projectId),
      get().loadMetadata(projectId),
    ]);
  },

  clearAllData: async (projectId) => {
    try {
      const result = await trpc.violation.clearAllData.mutate({ projectId });
      getToast().success(`已清空 ${result.deleted} 条违例数据`);
      await get().refreshAll(projectId);
    } catch (err) {
      getToast().error('清空数据失败', err instanceof Error ? err.message : String(err));
    }
  },

  clearCaseData: async (projectId, caseName, corner) => {
    set({ managingData: true });
    try {
      const result = await trpc.violation.clearCaseData.mutate({ projectId, caseName, corner });
      const msg = corner
        ? `已清除 ${caseName} (${corner}) 的 ${result.deleted} 条数据`
        : `已清除 ${caseName} 的 ${result.deleted} 条数据`;
      getToast().success(msg);
      await get().refreshAll(projectId);
    } catch (err) {
      getToast().error('清除数据失败', err instanceof Error ? err.message : String(err));
    } finally {
      set({ managingData: false });
    }
  },

  updateCorner: async (projectId, caseName, newCorner, oldCorner) => {
    set({ managingData: true });
    try {
      const result = await trpc.violation.updateCorner.mutate({ projectId, caseName, newCorner, oldCorner });
      getToast().success(`已更新 ${result.updated} 条记录的 corner`);
      await get().refreshAll(projectId);
    } catch (err) {
      getToast().error('更新 corner 失败', err instanceof Error ? err.message : String(err));
    } finally {
      set({ managingData: false });
    }
  },

  loadCaseCorners: async (projectId, caseName) => {
    set({ loadingCaseCorners: true });
    try {
      const result = await trpc.violation.getCaseCorners.query({ projectId, caseName });
      set({ caseCorners: result as CaseCornerInfo[], loadingCaseCorners: false });
    } catch (err) {
      set({ loadingCaseCorners: false, caseCorners: [] });
      getToast().error('加载用例 Corner 信息失败', err instanceof Error ? err.message : String(err));
    }
  },

  setFilterCaseName: (v) => { set({ filterCaseName: v, page: 1 }); },
  setFilterCorner: (v) => { set({ filterCorner: v, page: 1 }); },
  setFilterStatus: (v) => { set({ filterStatus: v, page: 1 }); },
  setFilterSubsys: (v) => { set({ filterSubsys: v, page: 1 }); },
  setSearchText: (v) => { set({ searchText: v, page: 1 }); },

  setSort: (field) => {
    const current = get();
    if (current.sortField === field) {
      set({ sortOrder: current.sortOrder === 'asc' ? 'desc' : 'asc' });
    } else {
      set({ sortField: field, sortOrder: 'asc' });
    }
  },

  setPage: (page) => set({ page }),

  resetFilters: () => set({
    filterCaseName: null,
    filterCorner: null,
    filterStatus: null,
    filterSubsys: null,
    searchText: '',
    page: 1,
  }),

  // ── 确认相关 Actions ────────────────────────────────────

  autoConfirmByResetTime: async (projectId, caseName, resetTimeNs) => {
    set({ confirming: true });
    try {
      const result = await trpc.confirmation.autoConfirmByResetTime.mutate({
        projectId, caseName, resetTimeNs,
      });
      getToast().success(`自动确认完成：${result.confirmedCount} 条违例已确认`);
      await get().refreshAll(projectId);
    } catch (err) {
      getToast().error('自动确认失败', err instanceof Error ? err.message : String(err));
    } finally {
      set({ confirming: false });
    }
  },

  autoConfirmByInterval: async (projectId, caseName, opts) => {
    set({ confirming: true });
    try {
      const result = await trpc.confirmation.autoConfirmByInterval.mutate({
        projectId, caseName,
        resetTimeNs: opts.resetTimeNs,
        intervalStartNs: opts.intervalStartNs,
        intervalEndNs: opts.intervalEndNs,
      });
      getToast().success(`自动确认完成：${result.confirmedCount} 条违例已确认`);
      await get().refreshAll(projectId);
    } catch (err) {
      getToast().error('自动确认失败', err instanceof Error ? err.message : String(err));
    } finally {
      set({ confirming: false });
    }
  },

  updateConfirmation: async (projectId, violationId, status, confirmer, result, reason) => {
    set({ confirming: true });
    try {
      await trpc.confirmation.updateConfirmation.mutate({
        projectId, violationId, status, confirmer, result, reason,
      });
      getToast().success('确认成功');
      set({ showConfirmDialog: false, confirmDialogViolation: null });
      await get().refreshAll(projectId);
    } catch (err) {
      getToast().error('确认失败', err instanceof Error ? err.message : String(err));
    } finally {
      set({ confirming: false });
    }
  },

  batchUpdateConfirmations: async (projectId, violationIds, status, confirmer, result, reason) => {
    set({ confirming: true });
    try {
      const res = await trpc.confirmation.batchUpdateConfirmations.mutate({
        projectId, violationIds, status, confirmer, result, reason,
      });
      getToast().success(`批量确认完成：${res.updatedCount} 条已更新`);
      set({ showConfirmDialog: false, confirmDialogViolation: null, selectedViolationIds: new Set() });
      await get().refreshAll(projectId);
    } catch (err) {
      getToast().error('批量确认失败', err instanceof Error ? err.message : String(err));
    } finally {
      set({ confirming: false });
    }
  },

  toggleViolationSelection: (id) => {
    set((s) => {
      const next = new Set(s.selectedViolationIds);
      if (next.has(id)) {
        next.delete(id);
      } else {
        next.add(id);
      }
      return { selectedViolationIds: next };
    });
  },

  selectAllVisibleViolations: () => {
    set((s) => {
      const allIds = new Set(s.violations.map((v) => v.id));
      return { selectedViolationIds: allIds };
    });
  },

  clearSelection: () => set({ selectedViolationIds: new Set() }),

  openConfirmDialog: (violation) => set({ showConfirmDialog: true, confirmDialogViolation: violation }),
  closeConfirmDialog: () => set({ showConfirmDialog: false, confirmDialogViolation: null }),

  // ── AI 建议相关 Actions ────────────────────────────────

  suggestConfirmation: async (projectId, violationId) => {
    set({ aiSuggesting: true, aiSuggestion: null, aiSuggestionViolationId: violationId });
    try {
      const suggestion = await trpc.confirmation.suggestConfirmation.query({
        projectId,
        violationId,
      });
      set({ aiSuggestion: suggestion as AISuggestion, aiSuggesting: false });
    } catch (err) {
      set({ aiSuggesting: false, aiSuggestion: null, aiSuggestionViolationId: null });
      getToast().error('AI 建议获取失败', err instanceof Error ? err.message : String(err));
    }
  },

  startAISuggestion: async (projectId, violationId) => {
    set({ aiSuggesting: true, aiSuggestion: null, aiSuggestionViolationId: violationId });
    try {
      const result = await trpc.confirmation.startAISuggestion.mutate({
        projectId,
        violationId,
      });
      return result;
    } catch (err) {
      set({ aiSuggesting: false, aiSuggestion: null, aiSuggestionViolationId: null });
      getToast().error('AI 分析启动失败', err instanceof Error ? err.message : String(err));
      return null;
    }
  },

  parseAISuggestionResponse: async (responseText) => {
    try {
      const suggestion = await trpc.confirmation.parseAISuggestion.query({
        responseText,
      });
      set({ aiSuggestion: suggestion as AISuggestion, aiSuggesting: false });
      return suggestion as AISuggestion;
    } catch (err) {
      set({ aiSuggesting: false });
      getToast().error('AI 建议解析失败', err instanceof Error ? err.message : String(err));
      return null;
    }
  },

  clearAISuggestion: () => set({ aiSuggestion: null, aiSuggestionViolationId: null }),

  applyAISuggestion: async (projectId, violationId, suggestion) => {
    if (!suggestion.confirmer || !suggestion.result) {
      getToast().error('AI 建议信息不完整，无法应用');
      return;
    }
    await get().updateConfirmation(
      projectId,
      violationId,
      'confirmed',
      suggestion.confirmer,
      suggestion.result as ConfirmResult,
      suggestion.reason ?? '',
    );
    set({ aiSuggestion: null, aiSuggestionViolationId: null });
  },

  // ── Pattern 相关 Actions ────────────────────────────────────

  applyHistoricalConfirmations: async (projectId, caseName, corner) => {
    set({ confirming: true });
    try {
      const result = await trpc.confirmation.applyHistoricalConfirmations.mutate({
        projectId, caseName, corner,
      });
      const msg = caseName
        ? `应用历史确认完成：${result.appliedCount} 条违例已确认`
        : `全局应用历史确认完成：${result.appliedCount} 条违例已确认`;
      getToast().success(msg);
      await get().refreshAll(projectId);
    } catch (err) {
      getToast().error('应用历史确认失败', err instanceof Error ? err.message : String(err));
    } finally {
      set({ confirming: false });
    }
  },

  loadPatterns: async (projectId) => {
    set({ loadingPatterns: true });
    try {
      const result = await trpc.pattern.getPatterns.query({ projectId });
      set({ patterns: result as ViolationPattern[], loadingPatterns: false });
    } catch (err) {
      set({ loadingPatterns: false });
      getToast().error('加载 Pattern 列表失败', err instanceof Error ? err.message : String(err));
    }
  },

  clearAllPatterns: async (projectId) => {
    try {
      const result = await trpc.pattern.clearAllPatterns.mutate({ projectId });
      getToast().success(`已清除 ${result.deleted} 条 Pattern`);
      await get().loadPatterns(projectId);
    } catch (err) {
      getToast().error('清除 Pattern 失败', err instanceof Error ? err.message : String(err));
    }
  },

  setShowPatternManager: (show) => set({ showPatternManager: show }),

  // ── 扫描相关 Actions ────────────────────────────────────────

  scanRegression: async (projectId, regressionRoot, useStandardStructure) => {
    set({ scanning: true, scanResult: null });
    try {
      const result = await trpc.scan.scanRegression.mutate({
        projectId, regressionRoot, useStandardStructure,
      });
      set({ scanResult: result as ScanResult, scanning: false });
      getToast().success(`扫描完成：发现 ${result.totalFiles} 个文件`);
    } catch (err) {
      set({ scanning: false });
      getToast().error('扫描回归目录失败', err instanceof Error ? err.message : String(err));
    }
  },

  batchProcess: async (projectId, filePaths) => {
    set({ batchProcessing: true, batchProgress: null });
    try {
      const result = await trpc.scan.batchProcess.mutate({
        projectId, filePaths,
      });
      getToast().success(`批量处理完成：${result.totalInserted} 条新增`);
      set({ batchProcessing: false, batchProgress: null });
      await get().refreshAll(projectId);
    } catch (err) {
      set({ batchProcessing: false, batchProgress: null });
      getToast().error('批量处理失败', err instanceof Error ? err.message : String(err));
    }
  },

  pickRegressionDir: async () => {
    try {
      const result = await trpc.scan.pickDirectory.mutate({});
      if (result.canceled || !result.path) return null;
      return result.path;
    } catch {
      return null;
    }
  },

  setShowScanDialog: (show) => set({ showScanDialog: show }),

  // ── 导出/导入 Actions ────────────────────────────────────────

  exportViolations: async (projectId, format, caseName, corner) => {
    set({ exporting: true });
    try {
      const result = await trpc.violation.exportViolations.mutate({
        projectId,
        format,
        caseName,
        corner,
      });
      if (result.canceled) {
        set({ exporting: false });
        return;
      }
      getToast().success(`导出完成：${result.count} 条违例数据`);
      set({ exporting: false });
    } catch (err) {
      set({ exporting: false });
      getToast().error('导出违例数据失败', err instanceof Error ? err.message : String(err));
    }
  },

  exportPatterns: async (projectId, format) => {
    set({ exporting: true });
    try {
      const result = await trpc.pattern.exportPatterns.mutate({
        projectId,
        format,
      });
      if (result.canceled) {
        set({ exporting: false });
        return;
      }
      getToast().success(`导出完成：${result.count} 条 Pattern`);
      set({ exporting: false });
    } catch (err) {
      set({ exporting: false });
      getToast().error('导出 Pattern 失败', err instanceof Error ? err.message : String(err));
    }
  },

  importPatterns: async (projectId) => {
    set({ importing: true });
    try {
      const result = await trpc.pattern.importPatterns.mutate({
        projectId,
      });
      if (result.canceled) {
        set({ importing: false });
        return;
      }
      getToast().success(`导入完成：新增 ${result.importedCount} 条，更新 ${result.updatedCount} 条`);
      await get().loadPatterns(projectId);
      set({ importing: false });
    } catch (err) {
      set({ importing: false });
      getToast().error('导入 Pattern 失败', err instanceof Error ? err.message : String(err));
    }
  },

  mergeDatabases: async (projectId, sourceFilePaths) => {
    set({ importing: true });
    try {
      const result = await trpc.pattern.mergeDatabases.mutate({
        projectId,
        sourceFilePaths,
        backup: true,
      });
      const msg = `合并完成：${result.mergedViolations} 条违例，${result.mergedPatterns} 条 Pattern`;
      if (result.backupPath) {
        getToast().success(msg, `已备份到: ${result.backupPath}`);
      } else {
        getToast().success(msg);
      }
      await get().refreshAll(projectId);
      set({ importing: false });
    } catch (err) {
      set({ importing: false });
      getToast().error('数据库合并失败', err instanceof Error ? err.message : String(err));
    }
  },

  // ── 配置 Actions ────────────────────────────────────────────

  loadTvConfig: async (projectId) => {
    set({ loadingConfig: true });
    try {
      const config = await trpc.settings.getTvConfig.query({ projectId });
      set({ tvConfig: config as TvConfig, loadingConfig: false });
    } catch (err) {
      set({ loadingConfig: false });
      getToast().error('加载配置失败', err instanceof Error ? err.message : String(err));
    }
  },

  saveTvConfig: async (projectId, config) => {
    set({ savingConfig: true });
    try {
      await trpc.settings.updateTvConfig.mutate({ projectId, config });
      set({ tvConfig: config, savingConfig: false });
      getToast().success('配置已保存');
    } catch (err) {
      set({ savingConfig: false });
      getToast().error('保存配置失败', err instanceof Error ? err.message : String(err));
    }
  },
}));
