/**
 * Shared KB types — 知识库跨进程类型契约。
 *
 * 主进程（main）和渲染进程（renderer）共同 import 此文件，
 * 消除「渲染端手工复刻主进程类型」的漂移风险。
 *
 * 沿用 src/shared/ask-types.ts、browser-types.ts 的跨进程类型惯例。
 *
 * @see ADR 0021 — anydoc 文档知识库
 */

// ── 转换引擎 ──────────────────────────────────────────────────────

/** 引擎 ID（设置页可切换） */
export type ConvertEngineId = 'anydoc';

/** 引擎元信息（tRPC 输出，剥离 convert 函数） */
export type ConvertEngineInfo = {
  id: ConvertEngineId;
  label: string;
  description: string;
  supportedExtensions: string[];
};

// ── 注册表 ──────────────────────────────────────────────────────

/** 库目录格式：wiki = LLM Wiki 新布局（ADR 0034）；legacy = 旧 ADR 0021 布局（已停用） */
export type KbFormat = 'wiki' | 'legacy';

/** 注册条目的目录可达性/结构状态 */
export type KbEntryState =
  | 'ok'                // 目录可访问且格式与登记一致
  | 'unreadable'        // 离线/权限/已删除——保留登记，绝不当旧格式处置
  | 'structureChanged'; // 目录内容与登记格式不符（被替换/清空/含未知文件）

/** 已注册的知识库条目（存应用全局配置） */
export type KbRegistration = {
  /** 库 ID（kbId）：wiki 格式时持久于库内 .kb/manifest.json，与本机根路径分离 */
  id: string;
  /** 库名称（用户指定） */
  name: string;
  /** 库根目录绝对路径（本机路径） */
  path: string;
  /** 注册时间（Unix ms） */
  registeredAt: number;
  /** 登记时的目录格式 */
  format: KbFormat;
};

/**
 * 旧格式库处置记录（存应用全局配置 kb-disposals.json）。
 *
 * 已确认旧格式的登记条目移出活动表后在此保留路径，不删除任何文件；
 * 用户可据此手动迁移或清理。离线/权限问题不会产生处置记录。
 */
export type KbDisposal = {
  /** 处置记录 ID（沿用被处置条目的 kbId；注册前拦截的旧目录无 kbId 时用路径哈希） */
  id: string;
  /** 被处置的库根路径 */
  path: string;
  /** 最后已知库名称 */
  name: string;
  /** 最后已知 kbId（未注册过的目录为 null） */
  kbId: string | null;
  /** 处置原因 */
  reason: 'legacyFormat';
  /** 处置时间（Unix ms） */
  detectedAt: number;
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

/** 库结构健康检查结果（legacy 布局；wiki 布局用 KbWikiHealth） */
export type KbHealthStatus = {
  /** sources/ 目录是否存在 */
  hasSources: boolean;
  /** docs/ 目录是否存在 */
  hasDocs: boolean;
  /** index.md 文件是否存在 */
  hasIndex: boolean;
};

/** wiki 布局健康检查结果（kb.status 使用） */
export type KbWikiHealth = {
  hasSchema: boolean;
  hasPurpose: boolean;
  hasManifest: boolean;
  hasRaw: boolean;
  hasWiki: boolean;
};

/** kb.status 返回的完整状态 */
export type KbStatus = {
  /** 当前挂载的库（未挂载时为 null） */
  mounted: (KbMount & { name: string; path: string; format: KbFormat; state: KbEntryState }) | null;
  /** 结构健康检查（legacy 布局字段；wiki 布局时全 false） */
  health: KbHealthStatus;
  /** wiki 布局健康检查（挂载库为 wiki 格式时有值） */
  wikiHealth: KbWikiHealth | null;
};

/** kb.list 返回的单条库信息（含统计） */
export type KbListEntry = {
  id: string;
  name: string;
  path: string;
  registeredAt: number;
  /** 目录格式 */
  format: KbFormat;
  /** 目录可达性/结构状态 */
  state: KbEntryState;
  /** state=unreadable 时的底层 errno code（如 EACCES/ENOENT） */
  stateReason?: string;
  /** 文档数量（wiki 布局的统计由后继票接入，恒为 0） */
  documentCount: number;
  /** 分类数量（同上，恒为 0） */
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
  | 'pathUnreadable'      // 库目录不可访问（离线/权限不足）——不会按旧格式处置
  | 'kbIdConflict'        // 复制库身份冲突（同 kbId 已登记在别的路径）；可用 asCopy 注册为副本
  | 'manifestCorrupted'   // .kb/manifest.json 存在但不可解析/结构非法
  | 'legacyFormat'        // 旧格式目录已停用；处置记录已保留（不删除任何文件）
  | 'mountLimitExceeded'  // 超过挂载上限
  | 'notMounted'          // 库未挂载到当前项目
  | 'alreadyMounted'      // 库已挂载到当前项目
  | 'structureIncompatible' // 目录结构不兼容
  | 'deleteNotSupported'  // 删除库尚未支持（issue 01 范围外）；请使用注销
  | 'notAvailableForWikiLayout'; // 旧分类读写入口对新布局不可用（能力未就绪）

/** 结构化错误 */
export type KbError = {
  code: KbErrorCode;
  message: string;
};

/** 事务恢复报告（挂载 wiki 库时执行 recoverTransactions 的结果） */
export type KbRecoveryReport = {
  /** 清理掉的未持久化/已提交事务数 */
  cleaned: number;
  /** roll-forward 完成的新版事务数 */
  rolledForward: number;
  /** 回滚到旧版的事务数 */
  rolledBack: number;
  /** 无法自动恢复的事务描述（现场已保留） */
  failures: string[];
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

// ── 知识库设置 ──────────────────────────────────────────────────

/** KB AI 模型配置（字段为空 = 自动） */
export type KbLlmSettings = {
  /** 显式指定的凭证 providerId；空 = 自动（跟随 Agent 面板） */
  providerId?: string;
  /** 显式指定的模型 ID；空 = 自动 */
  model?: string;
};

export type KbSettings = {
  convertEngine: ConvertEngineId;
  llm: KbLlmSettings;
};
