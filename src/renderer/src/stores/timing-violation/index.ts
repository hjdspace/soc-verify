/**
 * Timing Violation Store 统一入口 — re-export 4 个子 store + 共享类型 + 导出/导入纯函数。
 *
 * 拆分自原 timing-violation.ts（917 行），按领域分为：
 * - tv-data:         违例列表 / 筛选 / 排序 / 分页 / 数据管理 / 配置 / 选择状态 / refreshAll
 * - tv-confirmations: 确认流程 / AI 建议
 * - tv-patterns:     Pattern CRUD / 历史匹配
 * - tv-scan:          回归扫描 / 批量处理
 * - tv-ops:           导出 / 导入纯函数
 *
 * 兼容代理：旧 useTimingViolationStore 保留为组合 store，
 * 内部代理到 4 个子 store，渐进迁移完成后删除。
 */

export { useTvDataStore } from './tv-data';
export { useTvConfirmationsStore } from './tv-confirmations';
export { useTvPatternsStore } from './tv-patterns';
export { useTvScanStore } from './tv-scan';
export { exportViolations, exportPatterns, importPatterns, mergeDatabases } from './tv-ops';

// 共享类型
export type {
  ConfirmationStatus,
  SortField,
  SortOrder,
  ViolationWithConfirmation,
  ViolationStatistics,
  ViolationMetadata,
  ParseResult,
  ConfirmResult,
  AutoConfirmResult,
  ViolationPattern,
  PatternSuggestion,
  RegressionFileInfo,
  ScanResult,
  BatchProcessResult,
  TvConfig,
  AISuggestion,
  CaseCornerInfo,
  AllCaseCorners,
} from './tv-types';

// ── 兼容代理：旧 useTimingViolationStore ──────────────────────
//
// 组合 4 个子 store 的状态和 action，使旧引用无需修改即可工作。
// 这是一个过渡层——所有消费端迁移到子 store 后删除。
//
// 实现：一个 Zustand store，订阅 4 个子 store 的变化，
// 任一变化时合并快照到自身。action 委托到子 store。

import { create } from 'zustand';
import { useTvDataStore } from './tv-data';
import { useTvConfirmationsStore } from './tv-confirmations';
import { useTvPatternsStore } from './tv-patterns';
import { useTvScanStore } from './tv-scan';
import { exportViolations, exportPatterns, importPatterns, mergeDatabases } from './tv-ops';
import type {
  ConfirmationStatus,
  SortField,
  SortOrder,
  ViolationWithConfirmation,
  ViolationStatistics,
  ViolationMetadata,
  ParseResult,
  ConfirmResult,
  AISuggestion,
  ViolationPattern,
  ScanResult,
  BatchProcessResult,
  TvConfig,
  CaseCornerInfo,
  AllCaseCorners,
} from './tv-types';

type TimingViolationCompatState = {
  // tv-data 状态
  violations: ViolationWithConfirmation[];
  total: number;
  statistics: ViolationStatistics | null;
  metadata: ViolationMetadata;
  page: number;
  pageSize: number;
  filterCaseName: string | null;
  filterCorner: string | null;
  filterStatus: ConfirmationStatus | null;
  filterSubsys: string | null;
  searchText: string;
  sortField: SortField;
  sortOrder: SortOrder;
  parsing: boolean;
  parseResult: ParseResult | null;
  parseProgress: { processedLines: number; foundViolations: number } | null;
  loadingViolations: boolean;
  loadingStatistics: boolean;
  loadingMetadata: boolean;
  selectedViolationIds: Set<number>;
  tvConfig: TvConfig | null;
  loadingConfig: boolean;
  savingConfig: boolean;
  managingData: boolean;
  caseCorners: CaseCornerInfo[];
  loadingCaseCorners: boolean;
  allCaseCorners: AllCaseCorners | null;
  refreshingSubsys: boolean;

  // tv-data actions
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
  refreshSubsys: (projectId: string) => Promise<void>;
  loadAllCaseCorners: (projectId: string) => Promise<void>;
  setFilterCaseName: (v: string | null) => void;
  setFilterCorner: (v: string | null) => void;
  setFilterStatus: (v: ConfirmationStatus | null) => void;
  setFilterSubsys: (v: string | null) => void;
  setSearchText: (v: string) => void;
  setSort: (field: SortField) => void;
  setPage: (page: number) => void;
  resetFilters: () => void;
  toggleViolationSelection: (id: number) => void;
  selectAllVisibleViolations: () => void;
  clearSelection: () => void;
  loadTvConfig: (projectId: string) => Promise<void>;
  saveTvConfig: (projectId: string, config: TvConfig) => Promise<void>;

  // tv-confirmations 状态
  confirming: boolean;
  showConfirmDialog: boolean;
  confirmDialogViolation: ViolationWithConfirmation | null;
  aiSuggesting: boolean;
  aiSuggestion: AISuggestion | null;
  aiSuggestionViolationId: number | null;

  // tv-confirmations actions
  autoConfirmByResetTime: (projectId: string, caseName: string | undefined, resetTimeNs: number) => Promise<void>;
  autoConfirmByInterval: (projectId: string, caseName: string | undefined, opts: { resetTimeNs?: number; intervalStartNs?: number; intervalEndNs?: number }) => Promise<void>;
  updateConfirmation: (projectId: string, violationId: number, status: ConfirmationStatus, confirmer: string, result: ConfirmResult, reason: string) => Promise<void>;
  batchUpdateConfirmations: (projectId: string, violationIds: number[], status: ConfirmationStatus, confirmer: string, result: ConfirmResult, reason: string) => Promise<void>;
  openConfirmDialog: (violation: ViolationWithConfirmation | null) => void;
  closeConfirmDialog: () => void;
  suggestConfirmation: (projectId: string, violationId: number) => Promise<void>;
  startAISuggestion: (projectId: string, violationId: number) => Promise<{ sessionId: string; promptMessage: string } | null>;
  parseAISuggestionResponse: (responseText: string) => Promise<AISuggestion | null>;
  clearAISuggestion: () => void;
  applyAISuggestion: (projectId: string, violationId: number, suggestion: AISuggestion) => Promise<void>;
  applyHistoricalConfirmations: (projectId: string, caseName?: string, corner?: string) => Promise<void>;

  // tv-patterns 状态
  patterns: ViolationPattern[];
  loadingPatterns: boolean;
  showPatternManager: boolean;

  // tv-patterns actions
  loadPatterns: (projectId: string) => Promise<void>;
  clearAllPatterns: (projectId: string) => Promise<void>;
  setShowPatternManager: (show: boolean) => void;

  // tv-scan 状态
  scanning: boolean;
  scanResult: ScanResult | null;
  batchProcessing: boolean;
  batchProgress: BatchProcessResult | null;
  showScanDialog: boolean;

  // tv-scan actions
  scanRegression: (projectId: string, regressionRoot: string, useStandardStructure: boolean) => Promise<void>;
  batchProcess: (projectId: string, filePaths: string[]) => Promise<void>;
  pickRegressionDir: () => Promise<string | null>;
  setShowScanDialog: (show: boolean) => void;

  // tv-ops 代理（无状态，纯函数代理）
  exporting: boolean;
  importing: boolean;
  exportViolations: (projectId: string, format: 'excel' | 'csv', caseName?: string, corner?: string) => Promise<void>;
  exportPatterns: (projectId: string, format: 'excel' | 'csv' | 'db') => Promise<void>;
  importPatterns: (projectId: string) => Promise<void>;
  mergeDatabases: (projectId: string, sourceFilePaths: string[]) => Promise<void>;
};

/** 从 4 个子 store 合并出当前快照 */
function snapshot(): TimingViolationCompatState {
  return {
    ...useTvDataStore.getState(),
    ...useTvConfirmationsStore.getState(),
    ...useTvPatternsStore.getState(),
    ...useTvScanStore.getState(),
    // 导出/导入代理（纯函数，无持久状态）
    exporting: false,
    importing: false,
    exportViolations: (projectId: string, format: 'excel' | 'csv', caseName?: string, corner?: string) =>
      exportViolations(projectId, format, caseName, corner),
    exportPatterns: (projectId: string, format: 'excel' | 'csv' | 'db') =>
      exportPatterns(projectId, format),
    importPatterns: (projectId: string) => importPatterns(projectId),
    mergeDatabases: (projectId: string, sourceFilePaths: string[]) =>
      mergeDatabases(projectId, sourceFilePaths),
  };
}

export const useTimingViolationStore = create<TimingViolationCompatState>(() => snapshot());

// 订阅各子 store，变化时同步到组合 store
useTvDataStore.subscribe((state) => {
  useTimingViolationStore.setState({ ...state });
});
useTvConfirmationsStore.subscribe((state) => {
  useTimingViolationStore.setState({ ...state });
});
useTvPatternsStore.subscribe((state) => {
  useTimingViolationStore.setState({ ...state });
});
useTvScanStore.subscribe((state) => {
  useTimingViolationStore.setState({ ...state });
});
