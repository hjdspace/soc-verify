/**
 * Knowledge Base 类型定义（主进程入口）。
 *
 * 跨进程共享类型已收拢到 `src/shared/kb-types.ts`，
 * 本文件重新导出以保持主进程内部 import 路径不变。
 *
 * 仅供主进程内部使用的类型（不跨进程的内部类型）
 * 仍定义在本文件中。
 *
 * @see ADR 0021 — anydoc 文档知识库
 * @see ADR 0022 — 双转换引擎 + KB AI 模型配置
 */

// ── 跨进程共享类型（重新导出） ──────────────────────────────────
export type {
  ConvertEngineId,
  ConvertEngineInfo,
  KbFormat,
  KbEntryState,
  KbRegistration,
  KbDisposal,
  KbMount,
  KbHealthStatus,
  KbWikiHealth,
  KbStatus,
  KbListEntry,
  KbErrorCode,
  KbError,
  KbRecoveryReport,
  KbDocStatus,
  KbDocument,
  KbCategory,
  KbDocStatusEvent,
  KbLlmSettings,
  KbSettings,
} from '@shared/kb-types';

// ── 主进程内部类型（不跨进程） ──────────────────────────────────

/** index.md 中的单条索引条目 */
export type IndexEntry = {
  /** 文档标题（LLM 产出或文档名） */
  title: string;
  /** Markdown 文件相对于 docs/ 的路径（如 `协议手册/DDR5.md`） */
  path: string;
  /** 分类名称 */
  category: string;
  /** 一句话摘要 */
  summary: string;
  /** 关键词列表 */
  keywords: string[];
};

/** LLM 分类结果 */
export type ClassificationResult = {
  /** 分类名称 */
  category: string;
  /** 文档标题 */
  title: string;
  /** 一句话摘要 */
  summary: string;
  /** 关键词列表 */
  keywords: string[];
};
