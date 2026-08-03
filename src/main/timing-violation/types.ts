/**
 * Timing Violation 模块类型定义
 *
 * 参考文档：docs/timing-violation-handoff.md §4.3
 */

/** 违例记录（从日志解析后、入库前的中间形态） */
export type ParsedViolation = {
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
};

/** 数据库中的违例记录（含 id 和 created_at） */
export type ViolationRecord = ParsedViolation & {
  id: number;
  createdAt: string;
};

/** 确认状态 */
export type ConfirmationStatus = 'pending' | 'confirmed' | 'ignored';

/** 确认记录 */
export type ConfirmationRecord = {
  id: number;
  violationId: number;
  status: ConfirmationStatus;
  confirmer: string | null;
  result: string | null;
  reason: string | null;
  isAutoConfirmed: boolean;
  confirmedAt: string | null;
  createdAt: string;
  updatedAt: string;
};

/** 违例 + 关联确认（LEFT JOIN 结果） */
export type ViolationWithConfirmation = ViolationRecord & {
  status: ConfirmationStatus;
  confirmer: string | null;
  result: string | null;
  reason: string | null;
  isAutoConfirmed: boolean;
  confirmedAt: string | null;
};

/** Pattern 记录 */
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

/** 查询参数 */
export type QueryViolationsInput = {
  page: number;
  pageSize: number;
  caseName?: string;
  corner?: string;
  status?: ConfirmationStatus;
  subsys?: string;
  searchText?: string;
  sortField?: 'time_fs' | 'num' | 'hier' | 'created_at';
  sortOrder?: 'asc' | 'desc';
};

/** 查询结果 */
export type QueryViolationsResult = {
  total: number;
  items: ViolationWithConfirmation[];
};

/** 统计信息 */
export type ViolationStatistics = {
  total: number;
  confirmed: number;
  pending: number;
  ignored: number;
  bySubsys: Record<string, number>;
  byCorner: Record<string, number>;
  byCase: Record<string, number>;
};

/** 元数据 */
export type ViolationMetadata = {
  corners: string[];
  cases: string[];
  subsys: string[];
};

/** 解析日志结果 */
export type ParseLogResult = {
  success: boolean;
  total: number;
  inserted: number;
  skipped: number;
  errors: string[];
};

/** Worker 消息类型 */
export type WorkerMessage =
  | { type: 'batch'; violations: ParsedViolation[]; count: number }
  | { type: 'progress'; processed: number; total: number }
  | { type: 'done'; count: number }
  | { type: 'error'; message: string };

/** 解析日志输入参数 */
export type ParseLogInput = {
  filePath: string;
  caseName?: string;
  corner?: string;
};

/** 解析选项（caseName/corner 覆盖路径推断） */
export type ParseOptions = {
  caseName?: string;
  corner?: string;
  corners?: string[];
  subsysPatterns?: string[];
};

/** TV 配置 */
export type TvConfig = {
  dbPath: string;
  corners: string[];
  subsysPatterns: string[];
  defaultResetTimeNs: number;
  autoBackup: boolean;
  backupInterval: number;
};
