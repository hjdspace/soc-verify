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
  | 'deleteNotSupported'     // 删除库不支持（已挂载或目录不可访问）
  | 'unknownFilesPresent'    // 库目录包含未知文件，拒绝递归删除（issue 20）
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

/**
 * wiki 来源转换状态。failed 的错误码/信息持久于 manifest，重开可见。
 * withdrawn = 来源已被用户撤回（issue 20）：原件和旧修订仍保留，
 * 但来源不再活跃；引用此来源的页面标为待复核。
 */
export type WikiSourceStatus = 'ready' | 'converting' | 'failed' | 'withdrawn';

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
  /**
   * PDF 图像资产提取状态（issue 11；仅 .pdf 来源写此字段）。
   * 与机械全文转换解耦：扫描版 PDF 转换失败仍可提图，此字段单独可见。
   */
  pdfAssets?: WikiPdfAssetsStatus;
  importedAt: string;
  updatedAt: string;
};

/** PDF 资产提取错误码（主进程 pdf-asset-store 的 PdfAssetStoreErrorCode 同集） */
export type WikiPdfAssetErrorCode =
  | 'sourceNotFound'
  | 'notPdf'
  | 'originalHashMismatch'
  | 'malformed'
  | 'password'
  | 'runtimeUnavailable'
  | 'aborted'
  | 'io';

/** PDF 图像资产提取状态（WikiSourceRecord.pdfAssets） */
export type WikiPdfAssetsStatus = {
  status: 'ready' | 'failed';
  /** 提取到的资产记录数（位图对象 + 页面渲染，含同图多次出现的位置记录） */
  assetCount: number;
  errorCode?: WikiPdfAssetErrorCode;
  errorMessage?: string;
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
  /** PDF 图像资产提取状态（仅 .pdf 来源） */
  pdfAssets?: WikiPdfAssetsStatus;
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
 * 任务阶段。queued → converting →（vision →）analyzing → generating → validating
 * → awaiting_review → committing → published。
 * 终态 done/failed/cancelled；配置或预算不足为 blocked（issue 10：等待用户动作，
 * 不自动重启、不静默裁切）。
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
  | 'cancelled'
  | 'blocked';

/**
 * 任务进度（spec §5「phase 与进度分开保存」；issue 10 引入）。
 * 长来源分段编译时表示「已完成段数 / 总段数」；
 * vision 阶段（issue 13）表示「已解读张数 / 总张数」，reused 为缓存命中数。
 */
export type WikiTaskProgress = {
  done: number;
  total: number;
  /** 缓存命中（复用既有成功解读）张数（vision 阶段；缺省 = 无该统计） */
  reused?: number;
};

/** 任务类型：convertSource=来源转换（issue 03）；compileSource=短来源编译（issue 08） */
export type WikiTaskKind = 'convertSource' | 'compileSource';

/** 任务失败记录（重试新 attempt 时保留上一次失败原因） */
export type WikiTaskError = {
  code: string;
  message: string;
  at: string;
};

/**
 * 任务一次 attempt 的 token 用量汇总（issue 09）。
 *
 * 只汇总各阶段 API 实际给出的字段；整次运行没有任何 usage 时为 null
 * —— 不伪造 0，也不把缺失当成 0 用量展示。
 */
export type WikiTaskUsage = {
  inputTokens?: number;
  outputTokens?: number;
  totalTokens?: number;
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
  /** 本次 attempt 汇总的 token 用量（无可获得 usage 时为 null；issue 09） */
  usage: WikiTaskUsage | null;
  /** 模型调用内部有界退避重试次数（本次 attempt；issue 09） */
  retryCount: number;
  /** 分段进度（issue 10；未分段任务为 null） */
  progress: WikiTaskProgress | null;
  /** 用户明确选择仅按文字继续（issue 12）：视觉缺口不阻止编译，提案标 partial */
  textOnly?: boolean;
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
      /** 本次 attempt 汇总用量（issue 09；缺省表示未变化） */
      usage?: WikiTaskUsage | null;
      /** 本次 attempt 内部重试次数（issue 09；缺省表示未变化） */
      retryCount?: number;
      /** 分段进度（issue 10；缺省表示未变化） */
      progress?: WikiTaskProgress | null;
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

/**
 * KB 模型角色设置（spec §3）：compile（分类/编译，即 `llm` 字段）、
 * vision（图像解读）。角色相互独立 —— 视觉必须显式选择凭证与模型，
 * 文本对话成功不代表支持图片输入，不自动跟随 compile 角色。
 */
export type KbSettings = {
  convertEngine: ConvertEngineId;
  /** compile 角色（来源分类与编译） */
  llm: KbLlmSettings;
  /** vision 角色（图像解读；缺省/空 = 未配置，视觉任务 blocked） */
  vision?: KbLlmSettings;
  /** embedding 角色（向量索引；缺省/空 = 未配置，嵌入降级为关键词检索） */
  embedding?: EmbeddingSettings;
};

// ── 图像解读（spec §3，issue 12）────────────────────────────────

/** 单次模型调用的真实 token 用量（API 返回才写；缺失字段不伪造 0） */
export type WikiLlmUsage = {
  inputTokens?: number;
  outputTokens?: number;
  totalTokens?: number;
};

/** 单张图像的模型解读记录（.kb/vision/<sourceId>/<revision>/<assetId>.json） */
export type WikiVisionInterpretation = {
  /** 资产身份 = 图像字节 SHA256（内容寻址，与 pdf-assets 清单一致） */
  assetId: string;
  sourceId: string;
  /** 解读时的来源修订 */
  sourceRevision: string;
  /** 1-based 页码（PDF）；来源不提供时为 null */
  page: number | null;
  /** 提取方式（与资产记录一致：object=位图对象 / page-render=整页渲染） */
  method: 'object' | 'page-render';
  /** 解读模型配置指纹（模型名，仅供显示与复用判断） */
  model: string;
  /** 提示词版本（提示变更后旧解读不复用） */
  promptVersion: string;
  /** 上下文指纹：图片字节 hash + 处理参数 + 模型 + 提示版本 + 输出语言 + 邻近文本 hash */
  contextHash: string;
  /** 发送图像的处理参数（'orig'=原图 / 'maxEdge=2048'=等比缩小；issue 13） */
  processParams?: string;
  /** 解读输出语言（issue 13；参与缓存指纹） */
  language?: string;
  /** 本次模型调用真实 token 用量（成功解读时记录；issue 13） */
  usage?: WikiLlmUsage;
  status: 'ok' | 'failed';
  /** 图类型（时序图/框图/位段图/照片…；模型输出） */
  imageType: string | null;
  /** 可见元素/信号（原样记录，不换算） */
  visibleElements: string | null;
  /** 关系或时序 */
  relations: string | null;
  /** 可辨认的原文数值（保留原值；不清晰写「不清晰」，不补齐） */
  visibleValues: string | null;
  /** 无法确定项 */
  uncertainties: string | null;
  /** 模型输出原文 */
  text: string | null;
  errorCode?: string;
  errorMessage?: string;
  interpretedAt: string;
};

/** 视觉缺口：未获得解读的资产（用户明确选择仅按文字继续时随提案持久化） */
export type WikiVisionGap = {
  assetId: string;
  page: number | null;
  /** 缺口原因（visionNotConfigured / 模型失败信息摘要） */
  reason: string;
};

// ── Wiki 页面与规则（LLM Wiki 新布局，spec §2，issue 04）───────

/** 固定八类页面类型（本期不支持新增） */
export type WikiPageType =
  | 'source' | 'entity' | 'concept' | 'comparison'
  | 'synthesis' | 'query' | 'pitfall' | 'interface';

// ── schema.md 受约束表 ─────────────────────────────────────────

export type WikiSchemaIssueCode =
  | 'missingPageTypes'
  | 'missingHeader'
  | 'unparseableRow'
  | 'unknownType'
  | 'missingType'
  | 'duplicateType'
  | 'missingDir'
  | 'invalidDir'
  | 'duplicateDir'
  | 'reservedDir';

export type WikiSchemaIssue = {
  code: WikiSchemaIssueCode;
  message: string;
  /** 表中出错行的 1-based 行号（缺失段类 issue 无行号） */
  line?: number;
};

/** 类型 → wiki 内相对目录（`concepts`、`entities/nested`） */
export type WikiSchemaRouting = { typeDirs: Record<WikiPageType, string> };

export type WikiSchemaParseResult =
  | { ok: true; routing: WikiSchemaRouting }
  | { ok: false; issues: WikiSchemaIssue[] };

// ── 页面 frontmatter ───────────────────────────────────────────

export type WikiSourceRef = {
  sourceId: string;
  sourceRevision: string;
  parsedHash: string;
};

export type WikiPageFrontmatter = {
  type: WikiPageType;
  title: string;
  summary: string;
  keywords: string[];
  tags: string[];
  sources: WikiSourceRef[];
  created: string;
  updated: string;
};

export type WikiPageIssueCode =
  | 'missingFrontmatter'
  | 'badYaml'
  | 'duplicateKey'
  | 'notAnObject'
  | 'tooDeep'
  | 'missingField'
  | 'badFieldType'
  | 'unknownType'
  | 'badSources'
  | 'badDate';

export type WikiPageIssue = { code: WikiPageIssueCode; message: string };

export type WikiPageParseResult =
  | { ok: true; frontmatter: WikiPageFrontmatter; body: string }
  | { ok: false; issues: WikiPageIssue[] };

// ── 页面目录 ───────────────────────────────────────────────────

export type WikiCatalogPage = {
  /** 页面主键：`<路由目录>/<文件名去 .md>`，含类型路径（标题/basename 不作主键） */
  pageId: string;
  /** 库内相对路径（`wiki/concepts/axi-outstanding.md`） */
  relPath: string;
  /** 所在路由目录对应的类型（正文声明不同类型 → routeMismatch） */
  type: WikiPageType;
  kind: 'page';
  parse: WikiPageParseResult;
  /** 正文声明的 type 与所在目录路由不一致 */
  routeMismatch: boolean;
};

export type WikiCatalogAggregate = {
  /** `index` / `overview` / `log` */
  pageId: string;
  relPath: string;
  kind: 'aggregate';
};

export type WikiCatalogOrphan = {
  /** 库内相对路径（不在任何路由目录，也不是聚合页） */
  relPath: string;
  kind: 'orphan';
};

export type WikiCatalog = {
  typeDirs: Record<WikiPageType, string>;
  pages: WikiCatalogPage[];
  aggregates: WikiCatalogAggregate[];
  orphans: WikiCatalogOrphan[];
};

export type WikiCatalogResult =
  | { ok: true; catalog: WikiCatalog }
  | { ok: false; schemaIssues: WikiSchemaIssue[] };

// ── wikilink ───────────────────────────────────────────────────

export type WikiLinkKind = 'link' | 'embed';

export type WikiLinkOccurrence = {
  kind: WikiLinkKind;
  /** `#` 前的目标（可为空串 = 纯本页 heading 链接） */
  target: string;
  /** `#heading` 原文（不含 #；未指定为 undefined） */
  heading?: string;
  /** `|别名`（未指定为 undefined） */
  alias?: string;
};

export type WikiLinkResolution =
  | { status: 'resolved'; pageId: string }
  | { status: 'ambiguous'; candidates: string[] }
  | { status: 'unresolved' };

/** 抽取结果 + 解析结论（主进程统一解析，UI/图谱/Lint 消费同一实现） */
export type WikiResolvedLink = WikiLinkOccurrence & { resolution: WikiLinkResolution };

/** 链接解析的目录查找索引（由页面目录构建） */
export type WikiCatalogEntryInfo = { pageId: string; title?: string };

export type WikiCatalogLookup = {
  /** pageId → 条目（完整类型路径主键） */
  byId: Map<string, WikiCatalogEntryInfo>;
  /** 文件名（去扩展名，小写）→ 命中的 pageId 列表 */
  byBasename: Map<string, string[]>;
  /** 标题 → 命中的 pageId 列表 */
  byTitle: Map<string, string[]>;
};

// ── 页面阅读视图 ───────────────────────────────────────────────

export type WikiPageView = {
  pageId: string;
  relPath: string;
  kind: 'page' | 'aggregate';
  content: string;
  parse: WikiPageParseResult;
  /** 仅 kind=page：正文 type 与所在目录路由不一致 */
  routeMismatch?: boolean;
  links: WikiResolvedLink[];
};

// ── 写作规则（schema/purpose）────────────────────────────────

export type WikiRulesView = {
  /** schema.md 原文；文件不存在为 null */
  schemaRaw: string | null;
  /** purpose.md 原文；文件不存在为 null */
  purposeRaw: string | null;
  /** schema 原文解析结果（供 UI 即时展示当前路由/问题） */
  schemaParse: WikiSchemaParseResult;
};

export type WikiRulesSaveInput = {
  /** 新 schema.md 全文；不保存传 undefined */
  schemaRaw?: string;
  /** 新 purpose.md 全文；不保存传 undefined */
  purposeRaw?: string;
};

export type WikiRulesSaveError =
  | { code: 'schemaInvalid'; message: string; issues: WikiSchemaIssue[] }
  | { code: 'pageDirRemap'; message: string };

export type WikiRulesSaveOutcome =
  | { ok: true; saved: { schema: boolean; purpose: boolean } }
  | { ok: false; error: WikiRulesSaveError };

// ── 默认模板 ───────────────────────────────────────────────────

export type WikiTemplateInfo = {
  type: WikiPageType;
  /** 默认路由目录 */
  dir: string;
  /** 模板正文段落标题（按写作顺序） */
  bodySections: string[];
  defaultSummary: string;
  defaultKeywords: string[];
  defaultTags: string[];
};

// ── 知识提案 staging 与审阅（spec §6，issue 05）────────────────

/**
 * staging 提案中的单个页面候选。
 *
 * - `before` 为 null = 新页（不存在于已发布 wiki/）；
 * - `proposed` 为整个候选页内容（frontmatter + 正文）；
 * - `baselineHash` 为生成提案时该页已发布内容的读取快照 hash，
 *   发布前用它检测基线冲突（issue 06 消费）；新页为 null
 *   （与 `before` 同源，不另设哨兵字符串以免与真实 hash 碰撞）。
 */
export type WikiStagedPage = {
  /** 页 identity：库内相对路径（`wiki/concepts/axi.md`） */
  relPath: string;
  /** pageId：`<路由目录>/<文件名去 .md>` */
  pageId: string;
  type: WikiPageType;
  /** 新页为 null */
  before: string | null;
  proposed: string;
  /** before 快照 hash；新页（`before === null`）为 null */
  baselineHash: string | null;
  /** 本页引用的来源修订（SourceRef，证据边） */
  sources: WikiSourceRef[];
};

/** 术语/范围：提案的种类（编译产出 vs 主动保存问答 vs 修复） */
export type WikiChangeSetOrigin = 'compile' | 'saveQuery' | 'fix';

/**
 * 持久化的知识变更集（.kb/staging/<changeSetId>.json）。
 *
 * 保存 `changeSetId`、任务身份、read/write baseline、before/proposed
 * 与来源引用；重开仍可审阅。正式 Wiki/索引在审阅与发布前不改变。
 */
export type WikiChangeSet = {
  changeSetId: string;
  /** 归属库身份 */
  kbId: string;
  /** 任务身份（queue taskId；saveQuery/fix 用合成 id） */
  taskId: string;
  /** 本变更集产生自哪种入口 */
  origin: WikiChangeSetOrigin;
  /** 编译时固定的来源修订（read baseline 的一部分） */
  sources: WikiSourceRef[];
  /** schema.md 文本 hash（编译基线） */
  schemaHash: string;
  /** purpose.md 文本 hash（编译基线） */
  purposeHash: string;
  /** 读依赖：本变更集参考过的已发布页 pageId（含其 revision hash） */
  readBaseline: Array<{ pageId: string; hash: string | null }>;
  pages: WikiStagedPage[];
  /** 知识待办输出（结构化，由 issue 25 消费同一结构；本票只落契约字段） */
  findings: WikiFinding[];
  /** 模型运行时未闭合/被丢弃的块说明（可见，不静默丢失） */
  warnings: string[];
  /**
   * 视觉缺口（issue 12）：用户明确选择仅按文字继续时列出未解读的资产。
   * 非空时 partial=true（审阅可见「部分产出」徽标）；完整视觉覆盖或缺省为 null。
   */
  visionGaps?: WikiVisionGap[] | null;
  /** 部分产出标记：visionGaps 非空时为 true，不冒充完整编译 */
  partial?: boolean;
  /**
   * 编译缓存指纹（issue 17）：编译时计算的完整指纹，发布成功后用于写入 compile-cache。
   * saveQuery/fix 变更集不设此字段（只有 compile origin 才参与缓存）。
   */
  compileCacheFingerprint?: string | null;
  createdAt: string;
  updatedAt: string;
};

/** 单个 hunk 的用户选择状态 */
export type WikiHunkDecision = 'pending' | 'accepted' | 'rejected';

/** 逐页的审阅选择（持久于 reviews/） */
export type WikiChangeSetPageReview = {
  pageId: string;
  relPath: string;
  /** hunkId → 选择；新页/frontmatter 整体接受（hunkId 0） */
  hunkStates: Record<number, WikiHunkDecision>;
  /** 整页选择（新页整体接受/拒绝） */
  pageDecision: WikiHunkDecision;
  /**
   * 记录选择时的差异指纹（`wikiPageDiffFingerprint`，只由 before/proposed 决定）。
   * 发布前重算不一致 → 差异已重新生成，旧 hunk 决定失效转 stale（issue 07）。
   * 旧 reviews 文件缺省（undefined）时跳过该检查，向后兼容。
   */
  hunksHash?: string | null;
};

/** 变更集的审阅状态（持久于 reviews/） */
export type WikiChangeSetReview = {
  changeSetId: string;
  pages: WikiChangeSetPageReview[];
  /** 是否所有页/块已明确处置 */
  settled: boolean;
  updatedAt: string;
  /**
   * 发布前基线变动的检测结果（issue 06）。
   * 非空即「旧批准已失效」：决策被重置为 pending，需重新生成差异后再批准。
   */
  stale?: WikiStaleReport | null;
  /** 成功发布的记录；commitId 在日志/历史/事件中唯一 */
  published?: WikiPublishedRef | null;
};

/** 基线变动报告（发布时检测到读/写集或来源/规则基线变化） */
export type WikiStaleReport = {
  detectedAt: string;
  /** 逐条说明哪个基线变了（可见，不只给一个布尔） */
  reasons: string[];
};

/** 已发布引用（写回 reviews/，避免同一变更集重复发布） */
export type WikiPublishedRef = {
  commitId: string;
  /** 发布 revision（manifest.publish.revision，单调递增） */
  revision: number;
  at: string;
  /** 部分接受（存在被拒绝的 hunk）：发布状态为 published_partial（issue 07） */
  partial?: boolean;
};

/** 渲染端变更集摘要（staging 列表） */
export type WikiChangeSetSummary = {
  changeSetId: string;
  kbId: string;
  taskId: string;
  origin: WikiChangeSetOrigin;
  pageCount: number;
  newPageCount: number;
  findingCount: number;
  settled: boolean;
  createdAt: string;
  updatedAt: string;
};

/**
 * 知识待办（finding）结构化字段（spec §9；issue 25 消费同一结构）。
 *
 * 本票只落契约字段与持久化，不接入 Lint 扫描本身。
 */
export type WikiFinding = {
  findingId: string;
  kbId: string;
  kind: string;
  pageIds: string[];
  evidenceRefs: string[];
  evidenceHashes: string[];
  status: 'open' | 'ignored' | 'resolved';
  createdAt: string;
  updatedAt: string;
};

/** staging 提案的读写错误码 */
export type WikiStagingErrorCode =
  | 'changeSetNotFound'
  | 'stagingCorrupted'
  | 'kbIdMismatch'
  | 'unknownPage'
  | 'invalidTarget'
  | 'duplicateTarget'
  | 'schemaUnavailable'
  | 'ioError';

export type WikiStagingError = { code: WikiStagingErrorCode; message: string };

export type WikiStagingResult<T> =
  | { ok: true; value: T }
  | { ok: false; error: WikiStagingError };

// ── 发布、页面历史与读取门禁（spec §6，issue 06）────────────────

/** 页面历史的操作类型（创建页记录 before 不存在，删除页保留完整旧内容） */
export type WikiPageHistoryOperation = 'create' | 'update' | 'delete';

/**
 * 页面历史条目（`.kb/page-history/<pageId>.jsonl` 的一行）。
 *
 * 参考 R17：历史不能由当前版本复原 —— 旧内容 hash、commitId、来源修订
 * 与操作类型都在此持久；创建页 `beforeHash` 为 null（before 不存在）。
 */
export type WikiPageHistoryEntry = {
  commitId: string;
  changeSetId: string;
  pageId: string;
  relPath: string;
  operation: WikiPageHistoryOperation;
  /** 旧内容 SHA256；创建页为 null */
  beforeHash: string | null;
  /** 新内容 SHA256 */
  afterHash: string;
  /** 本次发布的来源修订（证据边） */
  sources: WikiSourceRef[];
  at: string;
};

/** 单页发布结果摘要 */
export type WikiPublishedPage = {
  pageId: string;
  relPath: string;
  operation: WikiPageHistoryOperation;
  beforeHash: string | null;
  afterHash: string;
};

/** 发布错误码 */
export type WikiPublishErrorCode =
  | 'changeSetNotFound'    // 变更集不存在
  | 'kbIdMismatch'         // 变更集不属于本库
  | 'stagingCorrupted'     // staging 文件损坏（现场保留）
  | 'nothingAccepted'      // 没有任何被接受的候选页（拒绝/未处置 → 正式页面不变）
  | 'pendingDecisions'     // 存在未处置的页/hunk（所有未决项须明确处置才能发布，issue 07）
  | 'unresolvedLink'       // 本次新增链接的目标不存在/被拒绝/歧义（issue 07 跨页校验）
  | 'alreadyPublished'     // 该变更集已发布过（不静默重复发布）
  | 'readGateBlocked'      // 存在未恢复事务或并发发布，读取/写入暂停
  | 'manifestCorrupted'    // .kb/manifest.json 不可读/结构非法
  | 'stale'                // 读/写集或来源/规则基线变动（旧批准已失效）
  | 'invalidTarget'        // 写集目标非法（沙箱/聚合页/路由外）
  | 'ioError';

export type WikiPublishError = {
  code: WikiPublishErrorCode;
  message: string;
  /** stale 时的逐条变动说明 */
  detail?: string[];
};

/** 发布结果：成功携带 commitId（日志/历史/事件唯一身份）与发布的页 */
export type WikiPublishResult =
  | {
      ok: true;
      commitId: string;
      /** 单调递增的发布 revision（写入 manifest.publish.revision） */
      revision: number;
      pages: WikiPublishedPage[];
      /** 部分接受：至少一个候选页存在被拒绝的 hunk（published_partial，issue 07） */
      partial: boolean;
      /** 非阻断提示（如日志/历史重复项已跳过、既有断链保留） */
      warnings: string[];
    }
  | { ok: false; error: WikiPublishError };

/** 事务读取门禁状态（重启后恢复前暂停读取，避免读到混合页集） */
export type WikiReadGateStatus = {
  /** true = 存在未恢复的 prepared 事务，同库读取/发布暂停 */
  blocked: boolean;
  /** 未恢复事务 ID 列表（prepared 状态） */
  pending: string[];
  /** manifest 损坏、无法自动恢复的事务（现场保留，恢复报告用） */
  corrupt: string[];
};

// ── 统一关键词检索（spec §8，issue 14）──────────────────────────

/** 检索对象：wiki = 已发布知识页；parsed = 来源当前机械全文 */
export type WikiSearchKind = 'wiki' | 'parsed';

/** 检索结果单条（tRPC 与 Host Tool 共用同一 DTO，不复制排序） */
export type WikiSearchHit = {
  kind: WikiSearchKind;
  /** wiki = pageId（类型路径+文件名）；parsed = sourceId */
  id: string;
  /** 库内相对路径（`wiki/<...>.md` / `raw/parsed/<...>.md`） */
  relativePath: string;
  /** 运行时绝对路径（由当前挂载根解析；每次调用动态核对） */
  absolutePath: string;
  title: string;
  /** 正文命中片段；仅元数据命中时为 null */
  snippet: string | null;
  /** wiki 专有 */
  pageType?: WikiPageType;
  tags?: string[];
  keywords?: string[];
  sourceRefs?: WikiSourceRef[];
  /**
   * wiki：任一来源引用的修订与 manifest 当前修订不一致（或来源已不在
   * manifest）。parsed 只检索当前修订，恒为 false。
   */
  stale: boolean;
  /** parsed 专有：来源当前修订 */
  sourceRevision?: string;
  /** 排序值（越高越相关），不是正确率 */
  score: number;
  /** 图扩展补召回标记（仅图扩展搜索时存在；不存在 = 基础结果） */
  graphRelatedTo?: WikiGraphRelatedTo;
};

/**
 * 检索模式：
 * - keyword = 仅关键词
 * - keyword+graph = 关键词 + 图一跳扩展
 * - hybrid = 关键词 + 向量 RRF 融合
 * - hybrid+graph = 关键词 + 向量 RRF + 图一跳扩展
 */
export type WikiSearchMode = 'keyword' | 'keyword+graph' | 'hybrid' | 'hybrid+graph';

/** 向量搜索状态（issue 24，spec §8） */
export type VectorSearchStatus = {
  /** 嵌入降级：未配置/失败 → 关键词仍可用 */
  degraded: boolean;
  /** 降级原因（按库配置提示一次） */
  degradeReason?: string;
  /** 嵌入错误类型（如 notConfigured/auth/rateLimited/network） */
  errorKind?: EmbeddingErrorKind;
  /** 向量命中页数（RRF 融合后） */
  vectorPageHits: number;
};

export type WikiSearchResponse = {
  mode: WikiSearchMode;
  kbId: string;
  /** 索引覆盖状态（参与排名的候选数） */
  coverage: { wikiPages: number; parsedSources: number };
  hits: WikiSearchHit[];
  /** 图扩展信息（无图扩展时为 null） */
  graphExpansion?: WikiGraphExpansionInfo | null;
  /** 向量搜索状态（issue 24；未提供 embeddingService 时为 undefined） */
  vectorStatus?: VectorSearchStatus;
};

export type WikiSearchErrorCode =
  | 'emptyQuery'
  | 'notMounted'
  | 'notWikiLayout'
  | 'readGateBlocked'
  | 'catalogFailed';

export type WikiSearchError = { code: WikiSearchErrorCode; message: string };

export type WikiSearchOptions = {
  query: string;
  /** 默认 20，范围 1–50 */
  topK?: number;
  /** 按页面类型筛选（仅 wiki 命中） */
  pageType?: WikiPageType;
  /** 按标签筛选（仅 wiki 命中，精确匹配） */
  tag?: string;
  /** 限定检索对象；缺省两者都搜 */
  kind?: WikiSearchKind;
  /** 按修订过滤向量命中（issue 24；缺省不过滤） */
  revision?: string;
};

export type WikiSearchOutcome =
  | { ok: true; result: WikiSearchResponse }
  | { ok: false; error: WikiSearchError };

// ── 知识图谱与关联检索（spec §8/§9，issue 23）────────────────────

/** 图有向边：source → target（保留引用方向） */
export type WikiGraphEdge = {
  /** 发出链接的 pageId */
  source: string;
  /** 被链接的 pageId（已解析） */
  target: string;
  /** 链接在 source 页中的出现信息 */
  alias?: string;
  heading?: string;
};

/** 图节点：已发布知识页（聚合页/raw 不作为知识节点，spec §9） */
export type WikiGraphNode = {
  pageId: string;
  title: string;
  type: WikiPageType;
  /** 出链 pageId 集合（去重） */
  outlinks: string[];
  /** 入链 pageId 集合（去重） */
  inlinks: string[];
  /** 页面关键词（用于共享关键词信号） */
  keywords: string[];
  /** 页面来源引用（用于共享来源信号） */
  sources: WikiSourceRef[];
};

/** 断链信息：指向不存在或歧义目标的链接 */
export type WikiBrokenLink = {
  /** 发出链接的 pageId */
  source: string;
  /** 原始 target 文本 */
  target: string;
  /** unresolved = 目标不存在；ambiguous = 多个候选 */
  status: 'unresolved' | 'ambiguous';
  /** ambiguous 时的候选列表 */
  candidates?: string[];
};

/**
 * 图快照——按 kbId + publishedRevision 隔离（spec §9）。
 *
 * 变更后失效且不使用旧边推导新页；图 revision 落后时搜索只返回关键词
 * 并标 rebuilding。
 */
export type WikiGraphSnapshot = {
  kbId: string;
  /** 构建时的已发布 revision（manifest.publish.revision；无 publish 记录时为 0） */
  revision: number;
  /** pageId → 节点 */
  nodes: Map<string, WikiGraphNode>;
  /** 所有有效有向边（source → target） */
  edges: WikiGraphEdge[];
  /** 断链/歧义链接 */
  brokenLinks: WikiBrokenLink[];
};

/** Relatedness 信号（spec §9 初始四信号；SoC 类型亲和为中性） */
export type WikiRelatednessSignal =
  | 'sharedSources'   // 共享来源（同 sourceId 且兼容修订）
  | 'sharedKeywords'  // 共享关键词
  | 'linkNeighbor'    // 图邻居（入/出链一跳）
  | 'typeAffinity';   // 类型亲和（本期中性，恒 0 分）

/** 相关页面条目（UI 相关页面面板用） */
export type WikiRelatedPage = {
  pageId: string;
  title: string;
  type: WikiPageType;
  /** 综合相关度分数（越高越相关），不是语义置信度 */
  score: number;
  /** 触发的信号列表 */
  signals: WikiRelatednessSignal[];
  /** 各信号的具体贡献说明（UI 理由展示） */
  reasons: string[];
};

/** 相关页面查询结果 */
export type WikiRelatedResult =
  | {
      ok: true;
      kbId: string;
      revision: number;
      pageId: string;
      related: WikiRelatedPage[];
      /** 断链/歧义可见信息（UI 展示） */
      brokenLinks: WikiBrokenLink[];
    }
  | { ok: false; code: 'unknownPage' | 'catalogFailed' | 'readGateBlocked'; message: string };

/** 图扩展搜索附加信息 */
export type WikiGraphExpansionInfo = {
  /** 图 revision 是否落后于 manifest publish revision */
  rebuilding: boolean;
  /** 图扩展名额（0 = 未扩展） */
  quota: number;
  /** 实际图补召回数 */
  expanded: number;
};

/** 图扩展搜索结果中每个 hit 的图来源标记 */
export type WikiGraphRelatedTo = {
  /** 触发此 hit 的 seed pageId */
  seedPageId: string;
  /** seed 在基础结果中的排名（0-based） */
  seedRank: number;
  /** 关系说明（一跳邻居） */
  relation: 'one-hop';
};

// ── 图可视化视图模型（spec §9，issue 26）──────────────────────────
//
// 主进程图快照是唯一输入：`kb.wikiGraph` 把 `WikiGraphSnapshot` 投影为
// 可序列化结构（Map 不能走 tRPC）。renderer 只持有这份快照和用户操作，
// 不重新扫盘建第二张图（spec §9/§10）。

/**
 * 渲染端图节点。
 *
 * `keywords` 供关键词过滤使用（spec §9「大图先过滤和按需展开」）；
 * `inlinks`/`outlinks` 供邻接列表（WebGL 不可用降级）与节点详情使用。
 */
export type WikiGraphViewNode = {
  pageId: string;
  title: string;
  type: WikiPageType;
  /** 出链 pageId（去重） */
  outlinks: string[];
  /** 入链 pageId（去重） */
  inlinks: string[];
  /** 页面关键词（可为空） */
  keywords: string[];
};

/** 渲染端图边（保留引用方向 source → target） */
export type WikiGraphViewEdge = {
  source: string;
  target: string;
};

/** 图可视化数据（`kb.wikiGraph` 成功结果） */
export type WikiGraphViewOk = {
  ok: true;
  kbId: string;
  /** 与 manifest publish.revision 对齐；切库/重开图不得串 revision */
  revision: number;
  /** 图是否落后于当前发布 revision */
  rebuilding: boolean;
  nodes: WikiGraphViewNode[];
  edges: WikiGraphViewEdge[];
  brokenLinks: WikiBrokenLink[];
};

/** 图可视化数据读取结果 */
export type WikiGraphViewResult =
  | WikiGraphViewOk
  | { ok: false; code: 'catalogFailed' | 'readGateBlocked'; message: string };

// ── 只读证据读取（spec §2/§8，issue 15）────────────────────────

/** 读取对象：wiki = 已发布知识页；parsed = 来源机械全文；asset = 原图 */
export type WikiReadKind = 'wiki' | 'parsed' | 'asset';

/** 读取查询：全部从身份解析（kind/id/revision），不接受任意路径 */
export type WikiReadQuery = {
  kind: WikiReadKind;
  /** wiki = pageId（类型路径+文件名）；parsed/asset = sourceId */
  id: string;
  /** parsed/asset：来源修订（SourceRef.sourceRevision）；缺省 = 当前 */
  revision?: string;
  /** parsed：定位历史转换快照（SourceRef.parsedHash） */
  parsedHash?: string;
  /** asset：资产身份（图像字节 SHA256，内容寻址） */
  assetId?: string;
  /** 分页起始行（1-based，缺省 1） */
  startLine?: number;
  /** 单页字符预算（缺省 2 万，上限 5 万；超长行独占一页如实返回） */
  maxChars?: number;
};

/** wiki/parsed 共有的分页字段。各页按 next 顺序以 '\n' 拼接还原全文 */
export type WikiReadTextPageBase = {
  id: string;
  kbId: string;
  /** 库内相对路径（wiki/<...>.md 或 raw/parsed|revisions/...），仅展示 */
  relativePath: string;
  /** 运行时绝对路径（由当前挂载根解析，仅展示，不是读取入口） */
  absolutePath: string;
  /** 全文内容 SHA256（parsed = manifest parsedHash / 快照 hash） */
  hash: string;
  totalLines: number;
  totalChars: number;
  startLine: number;
  endLine: number;
  /** 下一页 startLine；null = 已到末尾 */
  next: number | null;
  /** 本页正文（不含页尾换行；与下一页之间以 '\n' 拼接） */
  content: string;
};

/** kind=wiki：已发布知识页 */
export type WikiReadWikiPage = WikiReadTextPageBase & {
  kind: 'wiki';
  title?: string;
  pageType?: WikiPageType;
};

/** kind=parsed：来源机械全文（当前或历史快照） */
export type WikiReadParsedPage = WikiReadTextPageBase & {
  kind: 'parsed';
  revision: string;
  isHistorical: boolean;
};

export type WikiReadTextPage = WikiReadWikiPage | WikiReadParsedPage;

/** asset 的读取结果：原图字节（base64）+ 记录元数据，不分页 */
export type WikiReadAsset = {
  kind: 'asset';
  id: string;
  kbId: string;
  assetId: string;
  /** 全文内容 hash = assetId（内容寻址） */
  hash: string;
  revision: string;
  relativePath: string;
  absolutePath: string;
  mimeType: string;
  ext: string;
  sizeBytes: number;
  /** 图像字节 base64 */
  dataBase64: string;
  /** 1-based PDF 页码（来源不提供时为 null） */
  page: number | null;
  /** 提取方式：object = 位图对象 / page-render = 整页渲染 */
  method: 'object' | 'page-render';
};

export type WikiReadResult = WikiReadTextPage | WikiReadAsset;

export type WikiReadErrorCode =
  | 'invalidKind'        // kind 不是 wiki/parsed/asset
  | 'emptyId'            // id 为空
  | 'invalidInput'       // 参数组合非法（wiki 带 revision、startLine < 1 等）
  | 'notWikiLayout'      // 挂载库不是 wiki 布局
  | 'readGateBlocked'    // 未恢复事务期间读取暂停
  | 'catalogFailed'      // schema.md 不可读/路由表无法解析
  | 'unknownPage'        // pageId 不在已发布页目录
  | 'invalidTarget'      // 目标存在但不是可读取的已发布页（聚合页 index/overview/log）
  | 'sourceNotFound'     // sourceId 不在 manifest
  | 'noParsed'           // 来源从未成功转换，无全文可读
  | 'snapshotNotFound'   // 修订/parsedHash 无对应快照或多快照未指定 hash
  | 'assetNotFound'      // assetId 不在资产清单或字节缺失
  | 'outsideRoot'        // realpath 逃逸出库根
  | 'outOfRange'         // startLine 超过总行数（不编造空页）
  | 'manifestCorrupted'  // manifest 不可读
  | 'ioError';           // 文件读取失败

export type WikiReadError = { code: WikiReadErrorCode; message: string };

export type WikiReadOutcome =
  | { ok: true; page: WikiReadResult }
  | { ok: false; error: WikiReadError };

// ── 向量嵌入（spec §8/§11，issue 21 — 向量能力 spike）──────────

/**
 * 嵌入角色配置（独立于 compile/vision 角色）。
 *
 * 凭证仍由主进程 credential manager 管理，不写进库或 renderer。
 * 嵌入端点常开但需要独立配置：未配置时关键词/图仍可用（降级）。
 */
export type EmbeddingSettings = {
  /** 显式指定的凭证 providerId；空 = 未配置（嵌入降级） */
  providerId?: string;
  /** 显式指定的嵌入模型 ID；空 = 未配置 */
  model?: string;
  /** 分块目标字符数（缺省 1000） */
  maxChunkChars?: number;
  /** 分块重叠字符数（缺省 200） */
  overlapChunkChars?: number;
  /** 并发数（缺省 1） */
  concurrency?: number;
};

/**
 * 嵌入端点解析后的运行时配置（由 llm-config 推导，不持久化 API key）。
 * 供 embedding-endpoint / embedding-service 消费。
 */
export type EmbeddingRuntimeConfig = {
  endpoint: string;
  apiKey: string;
  model: string;
  /** 输出维度（如配置端返回不一致则报错） */
  expectedDimensions?: number;
  /** 额外请求头 */
  extraHeaders?: Record<string, string>;
  maxChunkChars: number;
  overlapChunkChars: number;
  concurrency: number;
};

/** 嵌入空间指纹：同维度换模型不得共用空间 */
export type EmbeddingFingerprint = {
  /** SHA256 签名 */
  hash: string;
  /** 参与签名的配置摘要（供显示与诊断） */
  signature: {
    endpoint: string;
    model: string;
    expectedDimensions?: number;
    distanceMetric: string;
    maxChunkChars: number;
    overlapChunkChars: number;
    chunkerVersion: number;
  };
};

/** 嵌入 HTTP 错误分类（spec §11 验收 A16/A22） */
export type EmbeddingErrorKind =
  | 'notConfigured'       // 未配置嵌入端点
  | 'auth'                // 401/403
  | 'modelNotFound'      // 404 模型不存在
  | 'rateLimited'         // 429
  | 'timeout'             // 请求超时
  | 'network'             // 网络失败
  | 'dimensionMismatch'   // 返回维度与配置不符
  | 'oversizedInput'      // 输入过长
  | 'provider'            // 其他提供商错误
  | 'storage';            // 向量存储写入失败

/** 嵌入错误 */
export type EmbeddingError = {
  kind: EmbeddingErrorKind;
  message: string;
  /** HTTP 状态码（如有） */
  statusCode?: number;
};

/** 嵌入分块 */
export type EmbeddingChunk = {
  /** 块在页面中的 0-based 位置 */
  index: number;
  /** 块文本 */
  text: string;
  /** 标题面包屑（`## A > ### B`） */
  headingPath: string;
  /** 块在 body（去 frontmatter 后）中的起始字符偏移 */
  start: number;
  /** 块在 body 中的结束字符偏移（exclusive） */
  end: number;
  /** 超大原子块：保留全文不截短，但不参与向量嵌入 */
  oversize?: boolean;
};

/** 向量 upsert 输入行 */
export type VectorUpsertChunk = {
  chunkIndex: number;
  chunkText: string;
  headingPath: string;
  /** 块在 body 中的起始字符偏移（issue 22） */
  start: number;
  /** 块在 body 中的结束字符偏移（exclusive） */
  end: number;
  embedding: number[];
  /** 来源/页面修订（issue 22：按 revision 替换/过滤） */
  revision?: string;
};

/** 向量搜索命中（per-chunk） */
export type VectorSearchHit = {
  chunkId: string;
  pageId: string;
  chunkIndex: number;
  chunkText: string;
  headingPath: string;
  /** 1/(1+distance)，越高越相关 */
  score: number;
  /** 该 chunk 所属的页面/来源修订（issue 22：查询过滤过期 revision） */
  revision?: string;
  /** 块在 body 中的起始字符偏移（issue 22） */
  start?: number;
  /** 块在 body 中的结束字符偏移（exclusive） */
  end?: number;
};

/** 向量搜索结果（per-page 聚合） */
export type VectorPageResult = {
  id: string;
  score: number;
  matchedChunks?: Array<{ text: string; headingPath: string; score: number; start?: number; end?: number }>;
  /** 该页结果的来源/页面修订（issue 22） */
  revision?: string;
};

/** 向量索引覆盖状态 */
export type VectorCoverage = {
  /** 已索引页数 */
  pages: number;
  /** 已索引块数 */
  chunks: number;
  /** 当前嵌入指纹 hash（未索引时为 null） */
  fingerprintHash: string | null;
};

/** 分块覆盖报告（issue 22，spec §8/§10） */
export type ChunkCoverageReport = {
  /** 总分块数 */
  totalChunks: number;
  /** 可被向量覆盖的块数（非 oversize） */
  coveredChunks: number;
  /** 超大原子块跳过向量嵌入的块数 */
  skippedChunks: number;
  /** 跳过原因列表（每个 skipped chunk 一条） */
  skipReasons?: string[];
};

/** 向量索引状态（issue 22，spec §8：索引空间记录配置指纹与实际维度） */
export type VectorIndexStatus = {
  /** 当前嵌入指纹 hash */
  fingerprintHash: string | null;
  /** 指纹签名摘要（供显示与诊断） */
  fingerprintSignature?: EmbeddingFingerprint['signature'];
  /** 实际维度（从已存储向量推断；无数据时为 null） */
  actualDimensions: number | null;
  /** 配置预期维度 */
  expectedDimensions?: number;
  /** 索引错误状态（按端点/库可见） */
  errorStatus: VectorIndexErrorStatus | null;
};

/** 向量索引错误状态 */
export type VectorIndexErrorStatus = {
  kind: EmbeddingErrorKind;
  message: string;
  /** 记录时间（ISO） */
  at: string;
};

// ── 结构 Lint 与知识待办（spec §9，issue 25）──────────────────────

/**
 * 结构 finding 的规则类型（决定稳定身份）。
 *
 * 图洞察类型（issue 26）：`bridge-node` 和 `sparse-community` 是启发式建议，
 * 不阻断发布；文案明确标注为「启发式建议，桥接节点可为健康枢纽」。
 */
export type WikiFindingKind =
  | 'orphan'
  | 'no-outlinks'
  | 'broken-link'
  | 'bridge-node'
  | 'sparse-community';

/** finding 的用户处置状态 */
export type WikiFindingStatus = 'open' | 'ignored' | 'resolved';

/**
 * 结构 finding——从图快照推导出的知识待办。
 *
 * 稳定身份由 `kind + pageIds + evidenceRefs` 产生（`findingId` 为其 hash），
 * 证据 hash 控制是否仍适用；重复扫描保留 ignored/resolved，证据改变可重开。
 *
 * spec §9：知识待办字段至少为
 * `findingId/kbId/kind/pageIds/evidenceRefs/evidenceHashes/status/createdAt/updatedAt`。
 */
export type WikiStructuralFinding = {
  /** 稳定身份：sha256(kind + pageIds.join(',') + evidenceRefs.join(',')) 取前 16 字节 hex */
  findingId: string;
  /** 归属库身份 */
  kbId: string;
  /** 规则类型 */
  kind: WikiFindingKind;
  /** 涉及的页面 pageId 列表（orphan/no-outlinks 为单元素，broken-link 为 [source]） */
  pageIds: string[];
  /** 证据位置：页面路径、断链 target 等 */
  evidenceRefs: string[];
  /** 证据 hash：各页面内容/链接结构的 hash，控制是否仍适用 */
  evidenceHashes: string[];
  /** 用户处置状态 */
  status: WikiFindingStatus;
  /** 首次发现时间（ISO） */
  createdAt: string;
  /** 最后更新时间（ISO） */
  updatedAt: string;
};

/** lint 扫描的覆盖信息 */
export type WikiLintCoverage = {
  /** 已检查的页面数 */
  checkedPages: number;
  /** 总页面数 */
  totalPages: number;
  /** 检查范围描述 */
  scope: string;
  /** 未覆盖部分说明（空数组 = 全覆盖） */
  uncovered: string[];
};

/** lint 扫描结果 */
export type WikiLintRunResult =
  | {
      ok: true;
      kbId: string;
      revision: number;
      findings: WikiStructuralFinding[];
      coverage: WikiLintCoverage;
      /** 扫描时间（ISO） */
      ranAt: string;
      /** 是否被取消（部分结果仍返回） */
      canceled: boolean;
    }
  | { ok: false; code: 'catalogFailed' | 'readGateBlocked'; message: string };

/** finding 更新动作 */
export type WikiFindingAction = 'ignore' | 'unignore' | 'resolve' | 'reopen';

/** finding 更新结果 */
export type WikiFindingUpdateResult =
  | { ok: true; finding: WikiStructuralFinding }
  | { ok: false; code: 'findingNotFound'; message: string };

/** finding 列表查询过滤 */
export type WikiFindingFilter = {
  /** 按状态过滤（缺省返回全部） */
  status?: WikiFindingStatus;
  /** 按规则类型过滤 */
  kind?: WikiFindingKind;
};

// ── 图洞察（spec §9，issue 26）──────────────────────────────────

/** 图洞察成功结果（spec §9，issue 26） */
export type WikiGraphInsightOk = {
  ok: true;
  kbId: string;
  revision: number;
  /** 洞察产出的 findings（桥接节点 + 稀疏社区） */
  findings: WikiStructuralFinding[];
  /** 社区统计信息 */
  communities: WikiCommunitySummary[];
  /** 运行时间（ISO） */
  ranAt: string;
};

/** 图洞察结果（spec §9，issue 26） */
export type WikiGraphInsightResult = WikiGraphInsightOk
  | { ok: false; code: 'catalogFailed' | 'readGateBlocked'; message: string };

/** 社区统计摘要 */
export type WikiCommunitySummary = {
  /** 社区 ID（从 0 开始的序号） */
  communityId: number;
  /** 社区内的页面数 */
  size: number;
  /** 社区内边数（无向投影） */
  internalEdges: number;
  /** 社区是否为稀疏社区（内聚度低） */
  sparse: boolean;
  /** 社区成员 pageId 列表 */
  members: string[];
};

/** finding 列表查询结果 */
export type WikiFindingListResult =
  | { ok: true; findings: WikiStructuralFinding[] }
  | { ok: false; code: 'readGateBlocked' | 'ioError'; message: string };



