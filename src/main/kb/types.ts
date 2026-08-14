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
