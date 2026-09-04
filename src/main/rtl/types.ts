/**
 * RTL 设计视图领域类型（ADR 0032 / spec: docs/specs/rtl-design-view-spec.md）。
 *
 * 提炼模型三件套：Module Definition（按 defName 聚合）/ Module Instance 树 /
 * 连线表（per-definition 的 i2i / top2i 边）。领域术语见 CONTEXT.md「RTL 解析域」。
 */

/** Design Source 配置（持久化于 <projectRoot>/.socverify/design/config.json） */
export type DesignSourceConfig = {
  /** VCS 风格 .f 文件列表（相对项目根或绝对路径，支持 +incdir+/+define+/-f 嵌套） */
  filelists: string[];
  /** 顶层模块名；null = 未选择（先经 detectTops 从 elaborated top units 中检测） */
  top: string | null;
};

/** slang 诊断（elaboration 失败时的源文件+行号定位，slang 的诊断质量是该引擎的附加优势） */
export type SlangDiagnostic = {
  file: string;
  line: number;
  column: number | null;
  severity: 'error' | 'warning' | 'info' | 'note' | 'fatal';
  message: string;
};

/** elaboration 失败的结构化错误（rtl-router.refresh 返回给 UI 呈现） */
export type ElaborationError = {
  message: string;
  diagnostics: SlangDiagnostic[];
  /** yosys 输出尾部（诊断之外的上下文，如 read_slang 包装错误） */
  logTail: string;
};

// ─── 提炼模型（write_json → 自有模型；raw write_json 不持久化） ──────────

export type ExtractedPort = {
  name: string;
  direction: 'input' | 'output' | 'inout';
  /** 位宽（含常量位） */
  width: number;
};

/** Module Definition — 按 defName 聚合（uniquified 命名 `<defName>$<完整实例路径>` 的 defName 部分） */
export type ExtractedDef = {
  name: string;
  src: string | null;
  paramDefaults: Record<string, unknown>;
  ports: ExtractedPort[];
};

/** Module Instance — 树节点（path 为从顶层起的完整实例路径，如 `spike_top.u_subsys0.gen_ip[0].u_ip`） */
export type ExtractedInst = {
  path: string;
  /** 最后一段实例名（generate 展开形如 `gen_ip[3].u_ip`） */
  name: string;
  /** 所属 Module Definition 名 */
  module: string;
  /** 父实例 path；顶层实例为 null */
  parent: string | null;
  depth: number;
  src: string | null;
  /** 实例参数覆盖（write_json cell.parameters） */
  params: Record<string, unknown>;
};

/** 连线端点：定义内部某个子实例的端口 */
export type ExtractedEdgeCell = { inst: string; port: string };

/**
 * 连线边（per Module Definition）：定义内部信号聚合。
 * i2i = ≥2 个子实例端口互连；top2i = 1 个子实例端口 + 本定义端口。
 */
export type ExtractedEdge = {
  module: string;
  /** 关联的 RTL 网名（netnames hdlname 锚点）；无名位段为 null */
  net: string | null;
  kind: 'i2i' | 'top2i';
  /** 参与互连的位数 */
  width: number;
  cells: ExtractedEdgeCell[];
  topPorts: string[];
};

export type ExtractedDesign = {
  top: string;
  defs: ExtractedDef[];
  insts: ExtractedInst[];
  edges: ExtractedEdge[];
};

// ─── DB 行类型（tRPC 返回给渲染端的结构；纯类型，渲染端可安全 import type） ──

export type DesignInstRow = {
  path: string;
  name: string;
  module: string;
  parent: string | null;
  depth: number;
  src: string | null;
  params: Record<string, unknown>;
};

export type DesignDefRow = {
  name: string;
  src: string | null;
  paramDefaults: Record<string, unknown>;
  ports: { name: string; direction: string; width: number }[];
};

export type DesignEdgeRow = {
  module: string;
  net: string | null;
  kind: 'i2i' | 'top2i';
  width: number;
  cells: { inst: string; port: string }[];
  topPorts: string[];
};

/** rtl-router.getStatus 的返回结构（Design View 数据源） */
export type DesignStatus = {
  configured: boolean;
  hasData: boolean;
  top: string | null;
  lastElaboratedAt: string | null;
  elapsedMs: number | null;
  /** 源文件 mtime 相对上次 elaboration 有变化（提示过期，不做自动重跑） */
  stale: boolean;
  elaborating: boolean;
  lastError: ElaborationError | null;
  yosysAvailable: boolean;
  yosysPath: string | null;
  missingDlls: string[];
};

/** rtl-router.refresh 的返回结构 */
export type DesignRefreshResult =
  | { ok: true; top: string; defCount: number; instCount: number }
  | { ok: false; error: ElaborationError };
