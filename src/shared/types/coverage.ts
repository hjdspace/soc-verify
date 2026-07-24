/**
 * 覆盖率域类型定义。
 *
 * 数据模型遵循 ADR 0007（层级树 + 8 metric × CoverageTriplet）。
 * 生命周期遵循 ADR 0008（per-merge-session，非 per-runId）。
 * 预处理流水线遵循 ADR 0006（平台运行 EDA 命令 + 插件解析文本报告）。
 */

// ─── 8 种覆盖率指标 ─────────────────────────────────────────────

export type CoverageMetric =
  | 'line'
  | 'branch'
  | 'toggle'
  | 'condition'
  | 'fsm_state'
  | 'fsm_transition'
  | 'functional'
  | 'assertion';

/** 所有 metric 的有序列表，UI 列顺序依赖此常量。 */
export const COVERAGE_METRICS: readonly CoverageMetric[] = [
  'line',
  'branch',
  'toggle',
  'condition',
  'fsm_state',
  'fsm_transition',
  'functional',
  'assertion',
] as const;

/**
 * 行业默认覆盖率目标（百分比）。assertion 无默认目标。
 * 用户可在项目设置中覆盖（EdaToolConfig 不含 target，targets 单独存储）。
 */
export const DEFAULT_COVERAGE_TARGETS: Readonly<Partial<Record<CoverageMetric, number>>> = {
  line: 95,
  branch: 90,
  toggle: 85,
  condition: 85,
  fsm_state: 100,
  fsm_transition: 90,
  functional: 100,
};

// ─── Coverage Triplet ───────────────────────────────────────────

/**
 * 某节点上某 metric 的三元组。
 * `null` 表示该 metric 不适用于此模块（如纯组合逻辑模块没有 fsm coverage）。
 */
export type CoverageTriplet = {
  percentage: number | null;
  covered: number | null;
  total: number | null;
};

/** N/A 三元组常量。 */
export const NA_TRIPLET: CoverageTriplet = {
  percentage: null,
  covered: null,
  total: null,
};

/** 从 covered/total 计算 triplet 的辅助函数。total=0 时 percentage=100（全空视为已覆盖）。 */
export function triplet(covered: number, total: number): CoverageTriplet {
  return {
    covered,
    total,
    percentage: total === 0 ? 100 : (covered / total) * 100,
  };
}

// ─── 层级模块树 ─────────────────────────────────────────────────

/**
 * 覆盖率层级模块树节点。反映设计层次（如 tb_top → chip_top → dut → u_block）。
 * 粒度边界：模块级（ADR 0007 决策 5），不建模 bin/实例级。
 */
export type CoverageNode = {
  name: string;
  path: string;
  depth: number;
  metrics: Record<CoverageMetric, CoverageTriplet>;
  children: CoverageNode[];
};

/** 未覆盖项（文件/行号级，ADR 0007 决策 5）。 */
export type UncoveredItem = {
  module: string;
  file?: string;
  line?: number;
  signal?: string;
  description: string;
};

/**
 * 测试用例覆盖率贡献度。
 * 来源于 urg -grade testfile（VCS）或 imc report -test（Cadence）。
 * 用于 AI 分析哪些测试用例对覆盖率提升有效，辅助收敛决策。
 */
export type TestContribution = {
  /** 测试用例名称 */
  testName: string;
  /** 综合评分（urg grade score，0-100，越高贡献越大） */
  score?: number;
  /** 排名（1 = 贡献最大） */
  rank?: number;
  /** 各 metric 的覆盖率百分比（IMC report -test 格式） */
  coverage?: Partial<Record<CoverageMetric, number>>;
};

// ─── EDA 工具与配置 ─────────────────────────────────────────────

export type EdaTool = 'imc' | 'vcs-urg' | 'vcover' | 'unknown';

/**
 * EDA Tool Configuration（ADR 0006，项目级配置）。
 * 指定 EDA 工具类型、cov_merge 默认路径、命令模板。
 * 命令模板支持占位符：`{covMergeDir}` `{reportDir}`。
 */
export type EdaToolConfig = {
  tool: EdaTool;
  covMergeDir: string;
  summaryCommand?: string;
  detailCommand?: string;
  metricsCommand?: string;
  /** CSV 格式覆盖率报告命令（urg -format csv），生成结构化数据供 AI 消费 */
  csvCommand?: string;
  /** 测试用例贡献度分析命令（urg -grade testfile / imc report -test） */
  gradeCommand?: string;
  /** Covergroup bin 级覆盖详情命令（imc report -bins / urg -detail） */
  binsCommand?: string;
};

/**
 * 各 EDA 工具的默认命令模板。
 *
 * VCS urg 工具说明：
 *   - urg 默认生成 HTML 报告，必须加 `-format text` 才能生成可解析的 ASCII 文本报告
 *   - `-format csv` 生成 CSV 格式，适合 AI/pandas 直接消费
 *   - `-grade testfile` 生成测试用例贡献度排名（gradedtests.txt）
 *   - `-show tests` 在报告中标注每个覆盖点由哪个测试用例覆盖
 *
 * Cadence IMC 工具说明：
 *   - IMC 通过 TCL `report` 子命令生成文本报告，用 `-execcmd` 直接执行单条命令
 *   - `report -test` 生成按测试用例的覆盖率贡献分析（等效 urg -grade testfile）
 *   - `report -bins` 生成 covergroup bin 级覆盖详情
 *   - IMC 不支持 CSV 格式输出，csvCommand 为 undefined
 */
export const DEFAULT_EDA_COMMANDS: Readonly<Record<Exclude<EdaTool, 'unknown'>, EdaToolConfig>> = {
  imc: {
    tool: 'imc',
    covMergeDir: 'cov_merge',
    summaryCommand:
      'imc -load {covMergeDir} -execcmd "report -summary -out {reportDir}/summary.txt"',
    detailCommand:
      'imc -load {covMergeDir} -execcmd "report -detail -all -out {reportDir}/detail.txt"',
    metricsCommand:
      'imc -load {covMergeDir} -execcmd "report_metrics -out {reportDir}/metrics.txt"',
    // IMC 不支持 CSV 格式，不设 csvCommand
    gradeCommand:
      'imc -load {covMergeDir} -execcmd "report -test -out {reportDir}/grade.txt"',
    binsCommand:
      'imc -load {covMergeDir} -execcmd "report -bins -out {reportDir}/bins.txt"',
  },
  'vcs-urg': {
    tool: 'vcs-urg',
    covMergeDir: 'urgReport',
    // 修正：必须加 -format text 才能生成可解析的 ASCII 文本报告
    summaryCommand: 'urg -dir {covMergeDir} -format text -report {reportDir}',
    detailCommand: 'urg -dir {covMergeDir} -format text -detail -report {reportDir}',
    metricsCommand: 'urg -dir {covMergeDir} -format text -metrics -report {reportDir}',
    // CSV 格式：结构化数据，AI 可直接消费
    csvCommand: 'urg -dir {covMergeDir} -format csv -report {reportDir}/csv',
    // 测试用例贡献度排名
    gradeCommand: 'urg -dir {covMergeDir} -grade testfile -report {reportDir}',
    // urg 没有 report -bins 等效命令，用 -detail 获取 bin 级信息
    binsCommand: undefined,
  },
  vcover: {
    tool: 'vcover',
    covMergeDir: 'cov_work',
    summaryCommand: 'vcover report -summary {covMergeDir} -output {reportDir}/summary.txt',
    detailCommand: 'vcover report -detail {covMergeDir} -output {reportDir}/detail.txt',
    metricsCommand: 'vcover report -metrics {covMergeDir} -output {reportDir}/metrics.txt',
  },
};

// ─── CoverageData（插件返回 + 平台缓存） ───────────────────────

/**
 * 完整覆盖率数据。由 CoverageParserPlugin 解析文本报告生成，平台缓存到
 * `.socverify/coverage/<sessionId>.json`。
 */
export type CoverageData = {
  sessionId: string;
  source: {
    covMergeDir: string;
    edaTool: EdaTool;
    reportGeneratedAt: number;
  };
  root: CoverageNode;
  targets: Partial<Record<CoverageMetric, number>>;
  /** detail 报告解析出的未覆盖项。 */
  uncovered?: Partial<Record<CoverageMetric, UncoveredItem[]>>;
  /** metrics 报告解析出的额外维度（密度/复杂度等）。 */
  metrics?: Record<string, number>;
  /** 测试用例覆盖率贡献度（urg -grade testfile / imc report -test）。 */
  testContributions?: TestContribution[];
  /** CSV 原始覆盖率数据（urg -format csv 生成的结构化数据）。 */
  csvData?: string;
};

// ─── Coverage Merge Session（ADR 0008） ─────────────────────────

/**
 * 一次覆盖率数据导入单元的元数据。存储在 `.socverify/coverage/sessions.json`。
 * 不与单个 Simulation Run 绑定。
 */
export type CoverageMergeSession = {
  sessionId: string;
  covMergeDir: string;
  edaTool: EdaTool;
  createdAt: number;
  reportDir: string;
};

// ─── 派生视图类型（向后兼容仪表盘等） ───────────────────────────

/**
 * 扁平覆盖率摘要（root 节点 8 metric 的百分比）。
 * 仅为向后兼容仪表盘等简单消费方保留；完整数据请使用 CoverageData。
 */
export type CoverageSummary = {
  overall: number;
  line: number;
  branch: number;
  toggle: number;
  condition: number;
  fsm_state: number;
  fsm_transition: number;
  functional: number;
  assertion: number;
};

/**
 * 从 CoverageNode（通常是 root）派生扁平 CoverageSummary。
 * N/A metric 按 0 处理。
 */
export function summarizeCoverage(node: CoverageNode): CoverageSummary {
  const pct = (m: CoverageMetric): number => node.metrics[m].percentage ?? 0;
  const values = COVERAGE_METRICS.map(pct);
  const overall = values.reduce((sum, v) => sum + v, 0) / values.length;
  return {
    overall,
    line: pct('line'),
    branch: pct('branch'),
    toggle: pct('toggle'),
    condition: pct('condition'),
    fsm_state: pct('fsm_state'),
    fsm_transition: pct('fsm_transition'),
    functional: pct('functional'),
    assertion: pct('assertion'),
  };
}

// ─── Coverage Gap（ADR 0007 决策 5 + PRD US-12） ────────────────

/**
 * 覆盖率缺口：某模块某 metric 低于 Target。
 * deficit = Target − Actual（正值表示未达标）。
 */
export type CoverageGap = {
  nodePath: string;
  nodeName: string;
  metric: CoverageMetric;
  target: number;
  actual: number;
  deficit: number;
};

/**
 * 遍历 CoverageNode 树，收集所有低于 Target 的 Gap。
 * N/A metric（percentage=null）跳过。
 */
export function detectGaps(
  node: CoverageNode,
  targets: Partial<Record<CoverageMetric, number>>,
): CoverageGap[] {
  const gaps: CoverageGap[] = [];
  const walk = (n: CoverageNode): void => {
    for (const metric of COVERAGE_METRICS) {
      const target = targets[metric];
      const tripletVal = n.metrics[metric];
      if (target === undefined || tripletVal.percentage === null) continue;
      if (tripletVal.percentage < target) {
        gaps.push({
          nodePath: n.path,
          nodeName: n.name,
          metric,
          target,
          actual: tripletVal.percentage,
          deficit: target - tripletVal.percentage,
        });
      }
    }
    for (const child of n.children) walk(child);
  };
  walk(node);
  return gaps;
}

// ─── Coverage Delta（PRD US-15） ────────────────────────────────

/**
 * 两个 Merge Session 之间某 metric 的覆盖率变化量。
 * delta = after − before；delta > 0 有效提升，delta = 0 stimulus 未命中。
 */
export type CoverageDelta = {
  metric: CoverageMetric;
  before: number;
  after: number;
  delta: number;
};

/**
 * 计算两个 CoverageSummary 之间的 Delta（逐 metric）。
 */
export function calculateDelta(
  before: CoverageSummary,
  after: CoverageSummary,
): CoverageDelta[] {
  return COVERAGE_METRICS.map((metric) => {
    const b = before[metric];
    const a = after[metric];
    return { metric, before: b, after: a, delta: a - b };
  });
}

// ─── Coverage Triage（PRD US-16, US-17） ────────────────────────

/** Triage 根因分类（5 种）。 */
export type TriageCause =
  | 'missing_scenario'
  | 'wrong_config'
  | 'dead_code'
  | 'sampling_issue'
  | 'encoding_mismatch';

/** Triage 置信度（3 级）。 */
export type TriageConfidence = 'high' | 'medium' | 'low';

/**
 * 覆盖率 Triage 条目。对 Gap 进行根因分类 + 置信度评估。
 * 本切片只提供数据结构和手动标注；AI 自动分类在 Slice 6b。
 */
export type CoverageTriage = {
  id: string;
  sessionId: string;
  nodePath: string;
  metric: CoverageMetric;
  gap: CoverageGap;
  cause?: TriageCause;
  confidence?: TriageConfidence;
  note?: string;
  triagedAt?: number;
  triagedBy?: string;
};

// ─── Coverage Exclusion（PRD US-18, US-19） ─────────────────────

/** Exclusion 审批状态。 */
export type ExclusionStatus = 'pending' | 'approved' | 'rejected';

/**
 * 覆盖率排除项。建议排除的覆盖率项（如 dead code），
 * 必须人工审批后才能排除，不可自动排除。
 */
export type CoverageExclusion = {
  id: string;
  sessionId: string;
  nodePath: string;
  metric: CoverageMetric;
  reason: string;
  status: ExclusionStatus;
  requestedBy: string;
  approvedBy?: string;
  requestedAt: number;
  approvedAt?: number;
  rejectionReason?: string;
};

// ─── Test Promotion（ADR 0009 决策 10 / Issue #10 Slice 8） ──────

/**
 * Closure Workspace 中单个测试改动的审阅队列项。
 * 每项对应一个 AI 生成的测试文件，用户可接受（提升到正式目录）或拒绝（丢弃）。
 */
export type PromotionQueueItem = {
  /** 唯一标识（基于 gapId/round/fileName 生成） */
  id: string;
  /** 所属 Closure Session ID */
  closureId: string;
  /** 所属 Gap ID */
  gapId: string;
  /** 生成该测试的迭代轮次 */
  round: number;
  /** Closure Workspace 中的绝对路径 */
  sourcePath: string;
  /** 相对 Closure Workspace 的路径（即文件名） */
  relativePath: string;
  /** 提升后的目标路径（正式 testbench 目录下） */
  targetPath: string;
  /** 文件名 */
  fileName: string;
  /** 审阅状态 */
  status: 'pending' | 'accepted' | 'rejected';
};

/** Closure 结果摘要中单个 Gap 的状态 */
export type ClosureSummaryGap = {
  gapId: string;
  moduleName: string;
  metric: CoverageMetric;
  /** gap 终态：closed / escalated / failed / in_progress / pending */
  status: string;
  /** 已完成的迭代轮数 */
  rounds: number;
  /** 最后一轮 overall delta（百分点），无数据时为 null */
  finalDelta: number | null;
  /** 升级原因（escalated/failed 时有值） */
  escalationReason?: string;
};

/** Closure 闭环结束后的结果摘要 */
export type ClosureSummary = {
  closureId: string;
  /** closure 终态：completed / aborted / failed / running / pending */
  status: string;
  gaps: ClosureSummaryGap[];
  /** 所有 gap 最后一轮 overall delta 之和 */
  totalDelta: number | null;
  /** 已提升到正式目录的测试数量 */
  promotedCount: number;
  /** 仍待审阅的测试数量 */
  pendingCount: number;
  /** 已拒绝的测试数量 */
  rejectedCount: number;
};

/** promoteTests 返回值 */
export type PromotionResult = {
  /** 成功复制的测试文件数 */
  promoted: number;
  /** 拒绝（未复制）的测试文件数 */
  rejected: number;
};
