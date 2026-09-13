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

// ── Wiki 来源（LLM Wiki 新布局，spec §1）────────────────────────

/** wiki 来源转换状态。failed 的错误码/信息持久于 manifest，重开可见 */
export type WikiSourceStatus = 'ready' | 'converting' | 'failed';

/** manifest 中的来源修订记录（.kb/manifest.json 的 sources 字段） */
export type WikiSourceRecord = {
  /** 规范化相对路径（NFC、`/` 分隔、显示拼写，相对 raw/sources/） */
  sourcePath: string;
  /** 规范化完整相对路径（含目录与扩展名）的 SHA256 */
  sourceId: string;
  /** 源扩展名（小写含点） */
  ext: string;
  /** 当前原件字节大小 */
  size: number;
  /** 当前修订 = 原件字节 SHA256；同路径同字节不新增修订 */
  currentRevision: string;
  /** 当前 raw/parsed/<sourcePath>.md 所属修订；null = 从未成功转换。
   *  与 currentRevision 不同 = 失败/转换中，旧全文不得标成新版 */
  parsedRevision: string | null;
  /** 当前 parsed 全文 SHA256；null = 从未成功转换 */
  parsedHash: string | null;
  /** 转换引擎（'anydoc' | 'text'） */
  engine: string | null;
  /** 引擎/配置指纹；变更即触发重转（原件未变 ≠ 转换未变） */
  engineFingerprint: string | null;
  status: WikiSourceStatus;
  /** 失败错误码：WikiSourceErrorCode 或引擎错误码（如 anydoc 'encrypted'） */
  errorCode?: string;
  errorMessage?: string;
  /** 当前修订的资产数量 */
  assetCount: number;
  importedAt: string;
  updatedAt: string;
};

/** 渲染端来源列表条目（kb.sources 返回） */
export type WikiSourceSummary = {
  sourceId: string;
  sourcePath: string;
  ext: string;
  size: number;
  revision: string;
  revisionShort: string;
  status: WikiSourceStatus;
  errorCode?: string;
  errorMessage?: string;
  /** 当前 parsed 全文所属修订 */
  parsedRevision: string | null;
  parsedHash: string | null;
  /** 当前修订尚无对应成功转换（失败/转换中/从未转换） */
  parsedStale: boolean;
  assetCount: number;
  importedAt: string;
  updatedAt: string;
};

/** 来源修订信息（kb.sourceRevisions 返回；UI 核对修订用） */
export type WikiSourceRevisionInfo = {
  revision: string;
  /** true = 当前修订（原件在 raw/sources/） */
  isCurrent: boolean;
  /** revisions 区的旧原件文件名（保存原文件名） */
  originalFile?: string;
  size?: number;
  /** 该修订可定位的 parsed 快照 hash（内容寻址，可能多个） */
  parsedHashes: string[];
};

/** 来源 parsed 全文读取结果（kb.sourceParsed；身份解析而非任意路径） */
export type WikiParsedView = {
  sourceId: string;
  sourcePath: string;
  /** 该全文所属修订 */
  revision: string;
  parsedHash: string;
  /** true = 来自 revisions/ 的历史快照 */
  isHistorical: boolean;
  content: string;
};

/** wiki 来源导入/转换错误码 */
export type WikiSourceErrorCode =
  | 'invalidPath'
  | 'unsupportedFormat'
  | 'caseConflict'
  | 'sourceNotFound'
  | 'manifestCorrupted'
  | 'originalHashMismatch'
  | 'ioError';

// ── 持久任务队列（LLM Wiki 新布局，spec §5）────────────────────

/**
 * 任务阶段。queued → converting →（后继编译票：vision → analyzing →
 * generating → validating → awaiting_review → committing → published）。
 * 本票转换任务实际经历 queued/converting/committing，终态 done/failed/cancelled。
 */
export type WikiIngestPhase =
  | 'queued'
  | 'converting'
  | 'vision'
  | 'analyzing'
  | 'generating'
  | 'validating'
  | 'awaiting_review'
  | 'committing'
  | 'published'
  | 'done'
  | 'failed'
  | 'cancelled';

/** 任务类型（本票仅转换任务；编译任务由后继票扩展） */
export type WikiTaskKind = 'convertSource';

/** 任务失败记录（重试新 attempt 时保留上一次失败原因） */
export type WikiTaskError = {
  code: string;
  message: string;
  at: string;
};

/** 持久任务记录（.kb/queue.json 的 tasks 条目 + 快照/事件传输） */
export type WikiIngestTask = {
  /** 稳定任务 ID（跨重启不变） */
  taskId: string;
  /** 库身份绑定：任务只写回自己的库，不随 UI 焦点转移 */
  kbId: string;
  kind: WikiTaskKind;
  sourceId: string;
  /** 来源相对路径（显示用） */
  sourcePath: string;
  phase: WikiIngestPhase;
  /** 当前（或即将执行的）attempt 身份；每次实际执行前更新 */
  attemptId: string;
  /** 已启动的执行序号（从 1 起；暂停中止/重试/恢复都会推进） */
  attempt: number;
  /** 最近一次失败原因（重试不清除，成功或新失败时更新） */
  lastError: WikiTaskError | null;
  enqueuedAt: string;
  updatedAt: string;
};

/** 队列快照（kb.tasks 查询；重订阅先拉快照再按 seq 应用事件） */
export type WikiQueueSnapshot = {
  kbId: string;
  /** 队列级暂停（持久） */
  paused: boolean;
  /** 库级事件序号（单调递增，持久） */
  seq: number;
  /** 有重启恢复的任务等待继续 */
  restoredWaiting: boolean;
  /** 最近一次持久化失败信息（非 null 时调度暂停，操作可能报错） */
  lastPersistError: string | null;
  /** 任务列表（队列顺序） */
  tasks: WikiIngestTask[];
};

/** 任务/队列事件（kb:task 通道；携带库身份与 seq） */
export type WikiTaskEvent =
  | {
      type: 'task';
      kbId: string;
      seq: number;
      taskId: string;
      attemptId: string;
      phase: WikiIngestPhase;
      lastError?: WikiTaskError | null;
    }
  | {
      type: 'queue';
      kbId: string;
      seq: number;
      paused: boolean;
      restoredWaiting: boolean;
    };

/** 队列操作结构化错误码 */
export type WikiQueueErrorCode =
  | 'notAttached'        // 队列未附着（未挂载或附着失败）
  | 'kbIdMismatch'       // 请求的 kbId 与附着库不符
  | 'sourceNotFound'     // 来源不存在
  | 'taskNotFound'       // 任务不存在
  | 'invalidPhase'       // 当前阶段不允许该操作
  | 'committing'         // 任务正在提交，暂不允许取消
  | 'persistFailed'      // 队列持久化失败（操作不确认成功）
  | 'manifestCorrupted'  // 库 manifest 不可读
  | 'queueCorrupted'     // 队列文件损坏（现场保留，不静默清空）
  | 'queueKbIdMismatch'  // 队列文件属于别的库身份
  | 'queueIoError';      // 队列文件 IO 失败

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
