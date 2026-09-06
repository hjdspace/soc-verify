/**
 * RTL 设计视图领域类型（ADR 0032 / spec: docs/specs/rtl-design-view-spec.md）。
 *
 * 提炼模型三件套：Module Definition（按 defName 聚合）/ Module Instance 树 /
 * 连线表（per-definition 的 i2i / top2i 边）。领域术语见 CONTEXT.md「RTL 解析域」。
 */

/** Design Source 配置（持久化于 <projectRoot>/.socverify/design/config.json） */
export type DesignSourceConfig = {
  /** 输入来源；旧配置缺失该字段时按 filelist 迁移 */
  source?: 'filelist' | 'directory';
  /** VCS 风格 .f 文件列表（相对项目根或绝对路径，支持 +incdir+/+define+/-f 嵌套） */
  filelists: string[];
  /** 无 filelist 项目的目录扫描配置 */
  directory?: {
    /** 扫描根目录（相对项目根或绝对路径） */
    root: string;
    /** 相对扫描根目录的 glob 排除规则 */
    excludes: string[];
    /** include 搜索目录（相对项目根或绝对路径） */
    incdirs: string[];
    /** 宏定义（NAME 或 NAME=value） */
    defines: string[];
  };
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
  /** bundle 打标（refresh 管线 analyzePorts 产出入库；extractor 不产出，可缺省） */
  bundles?: PortAnalysis;
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
  /** 子树实例数（含自身；spec story 5：树节点模块统计，快速判断子系统规模） */
  instCount: number;
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

// ─── Protocol Bundle（规则引擎，ADR 0032 主题 3 / spec 决策 11-15） ────────

/** 按关键信号方向推断角色：signal 为 input → 本模块是 input 角色（如 slave） */
export type BundleRoleDetection = {
  signal: string;
  input: string;
  output: string;
};

/** Bundle 规则（spec「规则形态」：前缀聚类 + requires 判别 + minSignals + singleton 正则） */
export type BundleRule = {
  id: string;
  /** 展示协议名（如 AXI4-Lite / clock） */
  protocol: string;
  description?: string;
  /** 信号名清单（端口名 = prefix + sig）；singleton 规则无此项 */
  signals?: string[];
  /** 满足其一即协议成立（AXI4 的 awid/arid/awlen/wlast） */
  requiresAnyOf?: string[];
  /** 全须满足（AXI4-Lite 的 awaddr/awvalid/wvalid/bresp） */
  requiresAllOf?: string[];
  /** 入束信号下限 */
  minSignals?: number;
  roleDetection?: BundleRoleDetection;
  /** singleton 规则：每个匹配端口独立成束（clk/rst） */
  singleton?: boolean;
  /** singleton 正则（rst 匹配 rst_n/rst_ni/aresetn/por_n 等变体） */
  pattern?: string;
};

export type BundleRuleDoc = {
  /** 规则匹配顺序（priority 优先），单端口只入一个 bundle */
  priority: string[];
  rules: BundleRule[];
};

/** bundle 成员信号：name = RTL 端口名（含前缀），sig = 剥离前缀后的信号名 */
export type BundleSignal = { name: string; sig: string };

/** 打标结果：一个 Protocol Bundle（同 protocol 不同前缀各自成束） */
export type BundleGroup = {
  protocol: string;
  /** 聚类前缀（如 s_axil_）；裸名为 ''，singleton 为端口名 */
  prefix: string;
  singleton: boolean;
  /** roleDetection 推断结果（master/slave），无法推断为 null */
  role: string | null;
  signals: BundleSignal[];
};

/** per-Module Definition 的端口打标结果（入库，供框图粗边/接口分组/树徽标消费） */
export type PortAnalysis = {
  bundles: BundleGroup[];
  /** 未入束端口名（自定义信号单列） */
  leftovers: string[];
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
  /** 子树实例数（含自身） */
  instCount: number;
};

export type DesignDefRow = {
  name: string;
  src: string | null;
  paramDefaults: Record<string, unknown>;
  ports: { name: string; direction: string; width: number }[];
  /** bundle 打标（refresh 管线入库；接口分组/框图粗边/树徽标的公共消费索引） */
  bundles: PortAnalysis;
};

export type DesignEdgeRow = {
  module: string;
  net: string | null;
  kind: 'i2i' | 'top2i';
  width: number;
  cells: { inst: string; port: string }[];
  topPorts: string[];
};

// ─── 框图子图（issue 05：getSubgraph 的返回结构） ────────────────

export type SubgraphPortRow = { name: string; direction: string; width: number };

/** 框图 box = 直接子实例（带其 def 端口表与打标，供端口 hover 与粗边两端聚合） */
export type SubgraphNodeRow = DesignInstRow & {
  ports: SubgraphPortRow[];
  bundles: PortAnalysis;
};

export type DesignSubgraphRow = {
  /** 图根实例（带 def 端口表，top2i 边的图根侧端口 hover） */
  root: (DesignInstRow & { ports: SubgraphPortRow[] }) | null;
  nodes: SubgraphNodeRow[];
  /** 图根 def 的连线表（cells.inst 已转完整实例路径） */
  edges: DesignEdgeRow[];
  /** 图根 def 的 bundle 打标（粗边聚类 + 图根端口分组） */
  bundles: PortAnalysis;
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
