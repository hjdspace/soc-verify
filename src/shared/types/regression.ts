// ── Regression domain types ────────────────────────────
// See ADR 0020 for design rationale.

/** One row in a `.lst` regression list file. */
export type RegressionEntry = {
  enabled: boolean;          // ON / OFF
  block: string;
  caseName: string;
  seed: string;              // rand | [1,2,3] | [1:100] | [1:100:2] | 12345
  iterative: string;         // number | "all"
  tags: string[];            // [RTL0.1, mini, cq]
  priority: 'H' | 'M' | 'L' | '';
  config: string;            // config file name
  cfgDef: string;            // default | DEF1 | [DEF1,DEF2]
  envBase: string;           // env/base parameter
  plusargs: string;          // raw plusargs string
};

/** A regression list file (`.lst`) — contains case entries. */
export type RegressionList = {
  type: 'list';
  filePath: string;          // absolute path
  subsys: string;
  block: string;             // inferred from directory path
  entries: RegressionEntry[];
  tagSet: string[];          // deduplicated tags across all entries
  onCount: number;
  offCount: number;
};

/** A regression group file (`.grp`) — contains file path references. */
export type RegressionGroup = {
  type: 'group';
  filePath: string;          // absolute path
  subsys: string;
  block: string;
  refPaths: string[];        // referenced file paths (raw, unexpanded)
};

/** Union of list and group items. */
export type RegressionItem = RegressionList | RegressionGroup;

/** Result of `discover` — regression items grouped by subsystem. */
export type RegressionDiscoveryResult = {
  subsys: string;
  items: RegressionItem[];
}[];

/** Options passed to `runsim -regr` during a regression run. */
export type RegressionRunOptions = {
  tags?: string[];           // -tag
  nonTags?: string[];        // -nt (non-tag: exclude these tags)
  failMode?: boolean;        // -fm (fail mode: only failed cases)
  coverage?: boolean;        // -cov
  regrWork?: string;         // -regr_work
  merge?: boolean;           // -merge (requires coverage=true)
  dashboard?: string;        // -m (submit to dashboard with DE TAG)
};

/** A persisted regression execution record. */
export type RegressionHistoryEntry = {
  runId: string;
  filePath: string;
  subsys: string;
  command: string;
  options: RegressionRunOptions;
  submittedAt: number;
  status: 'running' | 'completed' | 'aborted' | 'failed';
  exitCode: number | null;
  stdoutTail: string;        // last N lines of stdout
};

// ── 运行中回归跟踪（RegressionRunTracker，TitleBar 回归徽章数据源）──

/** 运行中回归：runsim -regr 提交后由主进程单例跟踪 */
export type ActiveRegressionRun = {
  runId: string;
  subsys: string;
  filePath: string;
  submittedAt: number;
  /** 从终端输出解析出的进度 x（已完成用例数）；未解析到时缺省，UI 降级不显示 */
  completed?: number;
  /** 从终端输出解析出的进度 y（总用例数） */
  total?: number;
};

/** 回归终态（terminal exitCode 映射：0→completed、null→aborted、其余→failed） */
export type RegressionRunFinalStatus = 'completed' | 'failed' | 'aborted';

/** regression:event 载荷（主进程 → 渲染进程，经 preload eventBridge） */
export type RegressionEvent = {
  type: 'started' | 'progress' | 'finished';
  run: ActiveRegressionRun;
  /** type === 'finished' 时的终态 */
  status?: RegressionRunFinalStatus;
};
