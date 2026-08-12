# ADR 0020: Regression Suite Redesign

## Status

Accepted

## Date

2026-08-12

## Context

The existing regression suite feature (`RegressionPanel`, `regression-manager.ts`, `regression-router.ts`) has two problems:

1. **GUI blank screen**: Clicking "回归套件" in the "更多" menu causes the entire CenterArea to go blank — likely an unhandled exception in the tRPC call chain or a type mismatch in `RegressionSuite` import.
2. **Wrong conceptual model**: The old design required users to manually create "suites" as JSON files containing `caseIds: string[]`, then executed them one-by-one via `PluginBackedSimulation`. The actual `runsim` tool supports regression natively via `runsim -regr <file>`, which submits batch simulations to LSF. The old model ignored this capability entirely.

The real-world regression workflow is:
- Regression list files (`.lst`) live under `$PROJ_ENV/<subsys>/regression/` and `$PROJ_ENV/udtb/<subsys>/<block>/regression/`
- Regression group files (`.grp`) reference multiple `.lst` files
- `runsim -regr <file>` parses the file and submits all ON cases to LSF
- Options like `-tag`, `-nt` (non-tag), `-fm` (fail mode), `-cov`, `-regr_work`, `-merge` control execution behavior

## Decision

Completely rewrite the regression suite feature. The new design auto-discovers regression lists from the `$PROJ_ENV` directory tree and executes them via `runsim -regr`.

### Key decisions

| # | Decision | Alternatives considered |
|---|----------|------------------------|
| 1 | **Auto-discovery from $PROJ_ENV** — scan `$PROJ_ENV/<subsys>/regression/`, `$PROJ_ENV/udtb/<subsys>/<block>/regression/`, and `$PROJ_ENV/udtb/usvp/regression/<short>/` | Manual suite creation (old model); plugin-based discovery |
| 2 | **File type detection by content** — a file is a List if it has lines matching `^\s*(ON\|OFF)\s*,`; a Group if it has file-path-like lines without ON/OFF | By extension (`.lst`/`.grp`); hybrid |
| 3 | **Merge ip2soc lists into subsystem dimension** — lists from `udtb/<subsys>/<block>/regression/` are attributed to `<subsys>` with `block` as a property | Two-level tree (subsys > block); flat list |
| 4 | **usvp short-name mapping via config** — `.socverify/usvp-subsys-map.json` maps short names (`apcpu` → `apcpu_sys`) | Hardcode; fuzzy match; plugin |
| 5 | **Parse-only depth (no semantic expansion)** — `.lst` entries are parsed for display but seed × plusargs cross-product expansion is left to runsim | Full semantic expansion; no parsing at all |
| 6 | **Execution via `spawnRunsim()`** — stream stdout/stderr to terminal panel, record status in JSON history | `PluginBackedSimulation` one-by-one; inline output area |
| 7 | **Lazy `.grp` recursion** — discover parses one level; full recursion on user expand, max depth 10, cycle detection | Eager full recursion; no depth limit |
| 8 | **No environment variable expansion** — `.grp` file paths preserved as-is (e.g., `$PROJ_DIR/...`), runsim handles expansion | Expand at parse time; expand at execution time |
| 9 | **MVP progress: no parsing** — show "submitted" status + terminal output; no progress bar | Parse runsim output for real-time progress |
| 10 | **Remove `compareRuns`** — no case-level result comparison in Phase 1 | Keep simplified comparison |

### New domain model

- **Regression List**: a `.lst` file containing case entries (ON/OFF, block, case, seed, iterative, tags, priority, config, cfg_def, env_base, plusargs)
- **Regression Group**: a `.grp` file containing file path references to `.lst` or other `.grp` files
- **Regression Entry**: one row in a `.lst` file
- **Regression Run**: one execution of `runsim -regr` with optional tags/coverage/merge options
- **Regression History**: persisted JSON records of past regression runs

### Removed concepts

- `RegressionSuite` (manual case-ID collection) — completely removed
- `RegressionResult` (case-level pass/fail aggregation) — replaced by `RegressionHistoryEntry`
- `compareRuns` procedure — removed

## Consequences

- Old `.socverify/regressions/*.json` and `*.result.json` files are not migrated; users clean them up manually.
- `RegressionTab` in the dashboard is untouched in Phase 1 (it reads from `simulation_runs` DB table, independent of this feature).
- `regression-analyzer` and `regression-list-gen` tools remain as independent auxiliary tools.
- `PROJ_ENV` must be configured in env settings for the feature to work.
- `runsim` must be on PATH for execution (not for discovery).
