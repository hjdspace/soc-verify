/**
 * 数据库 Schema 定义
 *
 * 参考 docs/timing-violation-handoff.md §4.3
 * 参考 docs/prd-timing-violation.md Implementation Decisions → Schema 设计
 */

/** 创建所有表 + 索引的 SQL */
export const SCHEMA_SQL = `
-- timing_violations 表
CREATE TABLE IF NOT EXISTS timing_violations (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    case_name TEXT NOT NULL,
    corner TEXT,
    seed TEXT,
    subsys TEXT,
    num INTEGER NOT NULL,
    hier TEXT NOT NULL,
    time_fs INTEGER NOT NULL,
    time_display TEXT NOT NULL,
    check_info TEXT NOT NULL,
    file_path TEXT NOT NULL,
    created_at TEXT DEFAULT (datetime('now', 'localtime')),
    UNIQUE(case_name, corner, seed, hier, check_info, time_fs)
);

-- confirmation_records 表（1:1 with violations）
CREATE TABLE IF NOT EXISTS confirmation_records (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    violation_id INTEGER NOT NULL UNIQUE,
    status TEXT NOT NULL DEFAULT 'pending',
    confirmer TEXT,
    result TEXT,
    reason TEXT,
    is_auto_confirmed INTEGER DEFAULT 0,
    confirmed_at TEXT,
    created_at TEXT DEFAULT (datetime('now', 'localtime')),
    updated_at TEXT DEFAULT (datetime('now', 'localtime')),
    FOREIGN KEY (violation_id) REFERENCES timing_violations(id)
);

-- violation_patterns 表
CREATE TABLE IF NOT EXISTS violation_patterns (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    hier_pattern TEXT NOT NULL,
    check_pattern TEXT NOT NULL,
    default_confirmer TEXT,
    default_result TEXT,
    default_reason TEXT,
    match_count INTEGER DEFAULT 1,
    last_used TEXT DEFAULT (datetime('now', 'localtime')),
    UNIQUE(hier_pattern, check_pattern)
);

-- 索引
CREATE INDEX IF NOT EXISTS idx_violations_case_corner ON timing_violations(case_name, corner);
CREATE INDEX IF NOT EXISTS idx_violations_hier_check ON timing_violations(hier, check_info);
CREATE INDEX IF NOT EXISTS idx_violations_subsys ON timing_violations(subsys);
CREATE INDEX IF NOT EXISTS idx_violations_time_fs ON timing_violations(time_fs);
CREATE INDEX IF NOT EXISTS idx_violations_created_at ON timing_violations(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_confirmations_violation ON confirmation_records(violation_id);
CREATE INDEX IF NOT EXISTS idx_confirmations_status ON confirmation_records(status);
CREATE INDEX IF NOT EXISTS idx_patterns_hier_check ON violation_patterns(hier_pattern, check_pattern);
`;

/** PRAGMA 优化配置 */
export const PRAGMA_SQL = `
PRAGMA journal_mode = WAL;
PRAGMA synchronous = NORMAL;
PRAGMA cache_size = 10000;
PRAGMA temp_store = MEMORY;
PRAGMA mmap_size = 268435456;
`;
