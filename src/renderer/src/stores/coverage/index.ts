/**
 * Coverage Store 统一入口 — re-export 4 个子 store + 共享类型。
 *
 * 拆分自原 coverage.ts（1093 行），按领域分为：
 * - coverage-core:    会话生命周期 / 树数据 / 导入 / 调试 / 深度分析 / 视图路由
 * - coverage-gaps:    目标 / 缺口 / 分诊 / 排除 / Delta / 趋势
 * - coverage-closure: 闭环流程 / Test Promotion
 * - coverage-export:  报告导出
 */

export { useCoverageCoreStore } from './coverage-core';
export { useCoverageGapsStore } from './coverage-gaps';
export { useCoverageClosureStore } from './coverage-closure';
export { useCoverageExportStore } from './coverage-export';

// 共享类型
export type {
  ClosureStatus,
  TargetIterationStatus,
  ClosureTargetStatus,
  TargetIteration,
  TargetModule,
  ClosureTarget,
  ClosureSession,
  ClosureLiveProgress,
  ExportFormat,
  ExportScope,
  CoverageView,
  ImportProgressEvent,
  ImportStepLogEntry,
  DetailProgressEvent,
  DetailParseStepLogEntry,
} from './coverage-types';
