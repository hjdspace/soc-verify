/**
 * Coverage Store 共享类型。
 *
 * 这些类型从原 coverage.ts 中提取，供 4 个子 store（core / gaps / closure / export）共享。
 * Closure 相关类型与 src/main/coverage/closure-manager.ts 中的定义结构兼容，
 * 但因渲染进程无法直接导入主进程模块，这里重新声明。
 *
 * 工单 04（ADR 0025）：工作项从 per-gap 重构为模块级 ClosureTarget。
 */

import type {
  CoverageSummary,
  CoverageMetric,
  CoverageGap,
  CoverageDelta,
  CoverageTriplet,
} from '@shared/types';

// ─── Closure 相关类型 ──────────────────────────────────────────

export type ClosureStatus = 'pending' | 'running' | 'completed' | 'failed' | 'aborted';
export type TargetIterationStatus = 'pending' | 'running' | 'completed' | 'failed';
export type ClosureTargetStatus = 'pending' | 'in_progress' | 'closed' | 'escalated' | 'failed';

export type TargetIteration = {
  round: number;
  generatedTests: string[];
  deltaBefore?: CoverageSummary;
  deltaAfter?: CoverageSummary;
  deltas?: CoverageDelta[];
  /** 豁免前覆盖率快照（per metric 三元组，ADR 0026 决策 4；未应用豁免时与 after 相等） */
  beforeExclusionMetrics?: Record<CoverageMetric, CoverageTriplet>;
  /** 豁免后覆盖率快照（per metric 三元组）；达标判定基于此数字 */
  afterExclusionMetrics?: Record<CoverageMetric, CoverageTriplet>;
  status: TargetIterationStatus;
  error?: string;
};

/** 目标模块标识 */
export type TargetModule = {
  path: string;
  name: string;
};

/** 模块级闭环工作项：同模块全部未达标 metric 聚合为单 target */
export type ClosureTarget = {
  id: string;
  module: TargetModule;
  gaps: CoverageGap[];
  iterations: TargetIteration[];
  status: ClosureTargetStatus;
  escalationReason?: string;
};

export type ClosureSession = {
  id: string;
  sessionId: string;
  createdAt: number;
  status: ClosureStatus;
  targets: ClosureTarget[];
  maxRounds: number;
  escalationThreshold: number;
  workspaceDir: string;
};

// ─── 实时事件进度（由 closure:event IPC 推送） ────────────────────

export type ClosureLiveProgress = {
  /** 当前是否正在运行 */
  running: boolean;
  /** 当前正在处理的 targetId 和 round（如有） */
  activeTargetId?: string;
  activeRound?: number;
  /** 最近一次 agent 状态 */
  agentSessionId?: string;
  agentPhase?: 'prompting' | 'ended' | 'recovering';
  /** 最近一轮 delta */
  lastDeltaOverall?: number;
  /** 最近一次错误（gap_failed / closure:error） */
  lastError?: string;
  /** 最近一轮扫描到的测试文件 */
  lastGeneratedTests?: string[];
  /** 最近一次升级事件（gap_escalated：targetId + 原因），供详情页展示 */
  lastEscalation?: { targetId: string; reason: string };
};

// ─── 报告导出类型 ──────────────────────────────────────────────

export type ExportFormat = 'html' | 'json';
export type ExportScope = 'current' | 'compare';

// ─── 视图路由类型 ──────────────────────────────────────────────

export type CoverageView = 'tree-table' | 'dashboard' | 'closure-detail';

// ─── 导入进度事件类型 ──────────────────────────────────────────

export type ImportProgressEvent = {
  step: string;
  message: string;
  percent?: number;
  durationMs?: number;
};

export type ImportStepLogEntry = {
  step: string;
  message: string;
  timestamp: number;
  durationMs?: number;
};

// ─── 详细解析进度事件类型 ──────────────────────────────────────

export type DetailProgressEvent = ImportProgressEvent;
export type DetailParseStepLogEntry = ImportStepLogEntry;

// ─── waive 生成进度事件类型（与 detail-progress 同结构） ─────────

export type WaiveProgressEvent = ImportProgressEvent;
export type WaiveStepLogEntry = ImportStepLogEntry;
