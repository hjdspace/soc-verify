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

/** 任务类型：convertSource=来源转换（issue 03）；compileSource=短来源编译（issue 08） */
export type WikiTaskKind = 'convertSource' | 'compileSource';

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

