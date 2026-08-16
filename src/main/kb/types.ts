/**
 * Knowledge Base 类型定义。
 *
 * 注册表（Registration）存应用全局配置：
 *   - 用户注册任意目录为知识库
 *   - 空目录注册时初始化标准结构（sources/ docs/ index.md）
 *
 * 挂载（Mount）存项目配置：
 *   - v1 挂轂数量上限 1，数据结构用列表预留多库
 *
 * @see ADR 0021 — anydoc 文档知识库
 */

// ── 注册表 ──────────────────────────────────────────────────────

/** 已注册的知识库条目（存应用全局配置） */
export type KbRegistration = {
  /** 库 ID（由 name 生成，唯一标识） */
  id: string;
  /** 库名称（用户指定） */
  name: string;
  /** 库根目录绝对路径 */
  path: string;
  /** 注册时间（Unix ms） */
  registeredAt: number;
};

// ── 挂载关系 ────────────────────────────────────────────────────

/** 项目挂载的知识库条目（存项目配置 .socverify/kb-mounts.json） */
export type KbMount = {
  /** 挂载的知识库 ID */
  kbId: string;
  /** 挂载时间（Unix ms） */
  mountedAt: number;
};

// ── 库状态 ──────────────────────────────────────────────────────

/** 库结构健康检查结果 */
export type KbHealthStatus = {
  /** sources/ 目录是否存在 */
  hasSources: boolean;
  /** docs/ 目录是否存在 */
  hasDocs: boolean;
  /** index.md 文件是否存在 */
  hasIndex: boolean;
};

/** kb.status 返回的完整状态 */
export type KbStatus = {
  /** 当前挂载的库（未挂载时为 null） */
  mounted: KbMount & { name: string; path: string } | null;
  /** 结构健康检查 */
  health: KbHealthStatus;
};

/** kb.list 返回的单条库信息（含统计） */
export type KbListEntry = {
  id: string;
  name: string;
  path: string;
  registeredAt: number;
  /** docs/ 下的文档数量（.md 文件数，不含 assets/ 子目录） */
  documentCount: number;
  /** 分类数量（docs/ 下的一级子目录数） */
  categoryCount: number;
  /** 是否被当前项目挂载 */
  isMounted: boolean;
};

// ── 错误类型 ────────────────────────────────────────────────────

/** 注册/挂载操作的错误码 */
export type KbErrorCode =
  | 'alreadyRegistered'   // 库名称或路径已注册
  | 'notRegistered'       // 库未注册
  | 'pathNotFound'        // 路径不存在
  | 'pathNotDirectory'    // 路径不是目录
  | 'mountLimitExceeded'  // 超过挂载上限
  | 'notMounted'          // 库未挂载到当前项目
  | 'alreadyMounted'      // 库已挂载到当前项目
  | 'structureIncompatible'; // 目录结构不兼容

/** 结构化错误 */
export type KbError = {
  code: KbErrorCode;
  message: string;
};

// ── 文档状态与流水线 ────────────────────────────────────────────

/** 文档在流水线中的处理状态 */
export type KbDocStatus =
  | 'queued'        // 已入队 sources/，等待转换
  | 'converting'    // 正在转换（anydoc）
  | 'classifying'   // 转换完成，正在 LLM 分类
  | 'done'          // 全部完成（转换 + 分类 + index.md 合并）
  | 'failed';       // 转换或分类失败

/** 文档在流水线中的完整描述 */
export type KbDocument = {
  /** 文档名（不含扩展名，用作主键） */
  name: string;
  /** 源文件扩展名（含点，如 .docx） */
  sourceExt: string;
  /** 源文件绝对路径 */
  sourcePath: string;
  /** Markdown 文件绝对路径（docs/<分类>/<name>.md） */
  markdownPath: string;
  /** 分类名称（docs/ 下的子目录名） */
  category: string;
  /** 源文件大小（字节） */
  sourceSize: number;
  /** Markdown 文件大小（字节） */
  markdownSize: number;
  /** 图片数量 */
  assetCount: number;
  /** 当前状态 */
  status: KbDocStatus;
  /** 失败时的错误码（来自 anydoc ConvertErrorCode） */
  errorCode?: string;
  /** 失败时的用户可读错误信息 */
  errorMessage?: string;
  /** 转换完成时间（Unix ms） */
  convertedAt?: number;
  /** 分类完成时间（Unix ms） */
  classifiedAt?: number;
  /** AI 分类/摘要降级（LLM 未配置或调用失败，已归入未分类且无摘要） */
  aiDegraded?: boolean;
  /** AI 降级原因（用户可读） */
  aiError?: string;
};

/** 分类树节点（kb.categories 返回） */
export type KbCategory = {
  /** 分类名称（docs/ 子目录名） */
  name: string;
  /** 该分类下的文档数 */
  count: number;
};

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

/** 文档状态变化事件（kb:* IPC 通道推送） */
export type KbDocStatusEvent = {
  /** 文档名 */
  name: string;
  /** 新状态 */
  status: KbDocStatus;
  /** 失败时的错误码 */
  errorCode?: string;
  /** 失败时的错误信息 */
  errorMessage?: string;
  /** 分类（classifying/done 时有值） */
  category?: string;
  /** AI 分类/摘要降级标记（done 状态时有值） */
  aiDegraded?: boolean;
  /** AI 降级原因 */
  aiError?: string;
};
