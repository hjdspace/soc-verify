# 用例数据库化架构

用例数据（子系统 + 用例 + 仿真历史）使用 `better-sqlite3` 持久化到项目目录 `.socverify/cases.db`，取代当前的内存缓存 + 插件实时扫描架构。数据库成为所有消费者（UI、AI Agent、时序违例、Dashboard）的单一数据源，插件降级为「扫描器」仅在刷新时调用。

## 背景

当前架构中，`PluginBackedDiscovery` 通过 `SubsysDiscoveryPlugin` 和 `CaseParserPlugin` 实时扫描文件系统获取用例数据，结果缓存在内存 Map 中。`CaseStatsService` 和 `CaseIndexManager` 各自创建独立的 `PluginBackedDiscovery` 实例，缓存不共享。`SimulationManager` 的历史记录是内存数组，重启即丢失。

性能瓶颈：切换到子系统页时，`listSubsysWithCaseCount` 为了显示子系统列表的 caseCount，首次需全量扫描所有子系统的用例配置文件（万级用例耗时数秒）。无持久化导致每次重启都要重新扫描。多个功能模块（时序违例的 case→subsys 映射、AI Agent 的 list_cases/get_case_stats、Dashboard 概览）各自调用插件或 CaseStatsService，数据不一致且重复加载。

## 决策

### 1. SQLite 作为用例数据的主存储

使用 `better-sqlite3`（与 ADR 0012 时序违例模块一致），WAL 模式 + PRAGMA 优化。数据库文件位于项目目录 `.socverify/cases.db`，跟随项目，自然隔离，关闭项目时关闭连接。

### 2. DB 成为主数据源，插件变为扫描器

`SubsysDiscoveryPlugin` 和 `CaseParserPlugin` 不再作为实时数据源。项目打开时，后台调用插件全量扫描，结果写入 DB。此后所有读取（UI、AI Agent、时序违例）走 DB 查询。用户点「刷新」按钮时重新调用插件扫描并更新 DB。

### 3. 项目打开时秒开 + 后台增量扫描

打开项目时检查 DB 是否已有数据。有则 UI 立即可用（秒开），后台并行跑一次全量扫描对比 DB，有差异则更新 DB 并通知 UI 刷新。不加文件监听（case_cfg 不会高频变动，已有「刷新」按钮）。

### 4. 仿真历史持久化——每次 run 完整记录

`simulation_runs` 表存储每次仿真运行的完整记录（case_name, subsys, status, start_time, end_time, duration_ms, corner, seed, options_json）。`SimulationManager` 发出 `run:completed` 事件时，独立事件监听器写入 DB。`CaseStatsService` 改为从 DB 读「最近一次状态」，而非内存 history。`SimulationManager` 仍保持内存状态管理活跃运行。

### 5. 搜索使用 SQL LIKE

`LIKE '%query%'` 子串匹配，万级数据 < 5ms。移除 `CaseIndexManager` 及其内存倒排索引。

### 6. 仿真阶段（Phase）作为用例属性

扩展 `CaseParserPlugin` 返回可选 `phase` 字段。`cases` 表含 `phase` 列。阶段列表（如 DVR1/DVR2/DVR3/DVS1/DVS2/POST）由插件从 case_cfg 解析，Dashboard 通过 `SELECT DISTINCT phase FROM cases` 获取。

### 7. 前端不自动展开文件节点

加载用例后文件节点默认折叠，用户点击展开。避免一次性渲染万级 DOM 节点。

## DB Schema

```sql
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
    created_at TEXT DEFAULT (datetime('now', 'localtime')),
    updated_at TEXT DEFAULT (datetime('now', 'localtime')),
    UNIQUE(name, subsys),
    FOREIGN KEY (subsys) REFERENCES subsystems(name)
);

-- simulation_runs 表
CREATE TABLE IF NOT EXISTS simulation_runs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
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
```

## Dashboard 视图（基于 simulation_runs SQL 聚合）

- **趋势图**：每日/每周 pass/fail 数量（`GROUP BY date(start_time)`）
- **子系统热力图**：各子系统 pass/fail 分布（`GROUP BY subsys`）
- **最近失败**：最近 N 条 fail 记录（`WHERE status='fail' ORDER BY start_time DESC`）
- **回归进度**：总数 / 已跑 / 未跑 / 通过率（`COUNT` + `LEFT JOIN cases`）
- **耗时分布**：仿真耗时直方图（`GROUP BY duration_ms bucket`）
- **不稳定用例**：有 pass 又有 fail 的用例（`GROUP BY case_name HAVING SUM(pass)>0 AND SUM(fail)>0`）
- **按阶段通过率**：按 phase 分组的通过率（`JOIN cases ON case_name GROUP BY phase`）

## 对现有模块的影响

| 模块 | 变化 |
|------|------|
| `PluginBackedDiscovery` | 保留，变为「扫描器」，仅在刷新/初始扫描时调用 |
| `CaseStatsService` | 重构为从 DB 读取，移除 `PluginBackedDiscovery` 依赖 |
| `CaseIndexManager` | 移除，搜索改为 DB LIKE 查询 |
| `CaseStatsRegistry` | 简化，改为管理 DB 连接而非 Service 实例 |
| `SimulationManager` | 保持不变，新增 `run:completed` 事件监听器写 DB |
| `project-router.ts` | getSubsystems / getCases / searchCases 改为查 DB |
| `host/tools/sim-tools.ts` | list_subsys / list_cases 改为查 DB |
| `host/tools/coverage-tools.ts` | get_case_stats / get_project_overview 改为查 DB |
| `CaseParserPlugin` | 扩展返回可选 `phase` 字段 |
| `SubsysList.tsx` | 不再自动展开文件节点 |

## Considered options

- **轻量优化（不改架构）**：让 `SubsysDiscoveryPlugin.discover()` 直接返回 caseCount，或缓存到 JSON 文件。否决——无法解决多消费者数据共享和持久化需求。
- **FTS5 全文搜索**：SQLite 内建 FTS5。否决——万级数据 LIKE 足够快（< 5ms），FTS5 不支持任意位置子串匹配，且增加虚拟表维护复杂度。
- **文件监听自动增量更新**：监听 case_cfg 文件变化自动更新 DB。否决——case_cfg 不会高频变动，已有「刷新」按钮，文件监听增加复杂度且不可靠。
- **全局 DB（userData 下所有项目共享）**：否决——项目间自然隔离更安全，`.socverify/` 已有约定，跟随项目走换机器不丢失。
- **仿真历史仅存最近一次状态**：否决——无法支持 Dashboard 趋势图、不稳定用例识别等时间维度查询。

## Consequences

- 项目首次打开仍需全量扫描（后台），但后续打开秒开（DB 缓存）。
- `CaseParserPlugin` 接口需扩展 `phase` 字段（向后兼容，可选）。
- `SimulationManager` history 仍保留内存态用于活跃运行，终态持久化到 DB。
- better-sqlite3 已在 dependencies 中（ADR 0012），无需新增依赖。
- DB 文件加入 `.gitignore`（`.socverify/` 已在 gitignore 中）。
