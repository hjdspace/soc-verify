/**
 * Timing Violation Store 共享类型。
 *
 * 从原 timing-violation.ts 中提取，供 4 个子 store
 *（tv-data / tv-confirmations / tv-patterns / tv-scan）+ tv-ops 共享。
 */

// ── 确认状态 ──────────────────────────────────────────────

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
  resetIntervalStartNs: number | null;
  resetIntervalEndNs: number | null;
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

/** 全量用例→corner 映射（数据管理下拉列表用） */
export type AllCaseCorners = Record<string, Array<{ corner: string | null; count: number }>>;
