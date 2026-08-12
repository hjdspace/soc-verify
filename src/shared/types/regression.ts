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
