/**
 * Case Database Schema 定义
 *
 * 参考 docs/adr/0017-case-database-architecture.md → DB Schema
 * 参考 docs/prd/prd-case-database.md → DB Schema
 */

/** 创建所有表 + 索引的 SQL */
export const SCHEMA_SQL = `
-- subsystems 表
CREATE TABLE IF NOT EXISTS subsystems (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL UNIQUE,
    path TEXT,
    description TEXT,
    created_at TEXT DEFAULT (datetime('now', 'localtime')),
    updated_at TEXT DEFAULT (datetime('now', 'localtime'))
);

-- cases 表
CREATE TABLE IF NOT EXISTS cases (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    subsys TEXT NOT NULL,
    path TEXT NOT NULL,
    file_path TEXT,
    base_case TEXT,
    base TEXT,
    block TEXT,
    phase TEXT,
    -- 后仿标记：1 = 需要跑后仿（gate-level / post-sim），用于后仿用例挑选（ADR 0017 扩展）
    post_sim INTEGER NOT NULL DEFAULT 0,
    created_at TEXT DEFAULT (datetime('now', 'localtime')),
    updated_at TEXT DEFAULT (datetime('now', 'localtime')),
    UNIQUE(name, subsys),
    FOREIGN KEY (subsys) REFERENCES subsystems(name)
);

-- simulation_runs 表
CREATE TABLE IF NOT EXISTS simulation_runs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    run_id TEXT,
    case_name TEXT NOT NULL,
    subsys TEXT NOT NULL,
    status TEXT NOT NULL,
    start_time TEXT NOT NULL,
    end_time TEXT,
    duration_ms INTEGER,
    corner TEXT,
    seed TEXT,
    options_json TEXT,
    created_at TEXT DEFAULT (datetime('now', 'localtime'))
);

-- scan_metadata 表（记录扫描状态）
CREATE TABLE IF NOT EXISTS scan_metadata (
    key TEXT PRIMARY KEY,
    value TEXT
);

-- 索引
CREATE INDEX IF NOT EXISTS idx_cases_subsys ON cases(subsys);
CREATE INDEX IF NOT EXISTS idx_cases_name ON cases(name);
CREATE INDEX IF NOT EXISTS idx_cases_phase ON cases(phase);
CREATE INDEX IF NOT EXISTS idx_cases_filepath ON cases(file_path);
CREATE INDEX IF NOT EXISTS idx_runs_case_subsys ON simulation_runs(case_name, subsys);
CREATE INDEX IF NOT EXISTS idx_runs_status ON simulation_runs(status);
CREATE INDEX IF NOT EXISTS idx_runs_start_time ON simulation_runs(start_time);
`;

/** PRAGMA 优化配置 */
export const PRAGMA_SQL = `
PRAGMA journal_mode = WAL;
PRAGMA synchronous = NORMAL;
PRAGMA cache_size = 10000;
PRAGMA temp_store = MEMORY;
PRAGMA mmap_size = 268435456;
`;

/**
 * 增量列迁移：CREATE TABLE IF NOT EXISTS 不会给已存在的表补充新列，
 * 旧库需通过 ALTER TABLE 补齐。每项在列缺失时执行。
 */
export const COLUMN_MIGRATIONS: { table: string; column: string; ddl: string }[] = [
  { table: 'cases', column: 'post_sim', ddl: 'ALTER TABLE cases ADD COLUMN post_sim INTEGER NOT NULL DEFAULT 0' },
  { table: 'simulation_runs', column: 'run_id', ddl: 'ALTER TABLE simulation_runs ADD COLUMN run_id TEXT' },
];
