# PRD: 用例数据库化架构 — 性能优化 + 数据共享 + Dashboard 基础

## Problem Statement

SoC 验证工程师在使用 SoC Verify 平台时，从其他页面切换到左侧面板的「子系统」页后，需要等待数秒才能看到子系统用例树。一个典型的 SoC 项目有 10~20 个子系统，总用例数往往上万，当前架构在加载和渲染这样规模的数据时存在明显瓶颈。

具体痛点：

1. **首次加载慢**：切换到子系统页时，`listSubsysWithCaseCount` 为了显示子系统列表的 caseCount，首次需全量扫描所有子系统的用例配置文件。万级用例下，I/O + 解析耗时数秒，UI 完全阻塞。

2. **无持久化**：每次应用重启都要重新全量扫描，即使数据没有变化。`PluginBackedDiscovery` 的 `caseCache` 是内存 Map，进程退出即丢失。

3. **缓存不共享**：`CaseStatsService` 和 `CaseIndexManager` 各自创建独立的 `PluginBackedDiscovery` 实例，内存缓存不共享，导致同一份数据被扫描两次。

4. **仿真历史丢失**：`SimulationManager` 的 history 是内存数组，重启即丢失。无法支持「每日通过数趋势图」「不稳定用例识别」等跨会话的时间维度查询。

5. **多消费者数据不一致**：UI 子系统列表、AI Agent 的 list_cases / get_case_stats、时序违例的 case→subsys 映射各自调用插件或 CaseStatsService，数据可能不一致且重复加载。

6. **前端渲染卡顿**：展开子系统后自动展开所有文件节点，万级用例的 DOM 节点一次性渲染，造成 UI 卡顿。

7. **Dashboard 缺乏数据基础**：未来的 Dashboard 需要展示每日/每周通过数趋势、子系统热力图、按仿真阶段分组的通过率等丰富视图，当前没有持久化的历史数据支撑。

## Solution

引入项目级 SQLite 数据库（`.socverify/cases.db`），作为用例数据（子系统 + 用例 + 仿真历史）的单一数据源。数据库成为所有消费者（UI、AI Agent、时序违例、Dashboard）的统一读取入口，插件系统降级为「扫描器」仅在项目打开（后台增量扫描）和用户点击「刷新」时调用。

**后端性能优化**：项目打开时检查 DB 是否已有数据，有则 UI 立即可用（秒开），后台并行全量扫描增量更新。第二次打开直接用 DB，无需等待。

**前端渲染优化**：加载用例后文件节点默认折叠，用户点击展开，避免一次性渲染万级 DOM 节点。

**搜索优化**：用 SQL `LIKE '%query%'` 子串匹配替代内存倒排索引，万级数据 < 5ms，移除 `CaseIndexManager`。

**仿真历史持久化**：`SimulationManager` 发出 `run:completed` 事件时，独立事件监听器将每次 run 的完整记录写入 `simulation_runs` 表。Dashboard 可直接用 SQL 聚合生成趋势图、热力图等视图。

**仿真阶段（Phase）**：扩展 `CaseParserPlugin` 返回可选 `phase` 字段（如 DVR1/DVR2/DVR3/DVS1/DVS2/POST），作为用例属性存储在 DB 中，Dashboard 可按阶段分组查询通过率。

架构决策详见 [ADR 0017](./adr/0017-case-database-architecture.md)。

## User Stories

### 后端 — 数据库与扫描

1. 作为 SoC 验证工程师，我希望打开项目后子系统页能秒开，这样我不需要每次等待数秒才能看到用例树。
2. 作为 SoC 验证工程师，我希望第二次打开同一项目时直接使用缓存数据，这样即使项目有上万用例也能即时响应。
3. 作为 SoC 验证工程师，我希望点击「刷新」按钮后系统能重新扫描用例配置文件并更新数据库，这样我修改了 case_cfg 后能获取最新数据。
4. 作为 SoC 验证工程师，我希望项目打开时后台自动增量扫描用例，这样即使数据库不是最新的也能在后台自动同步，无需我手动刷新。
5. 作为 SoC 验证工程师，我希望数据库文件跟随项目目录（`.socverify/cases.db`），这样换机器不丢失缓存数据。
6. 作为 SoC 验证工程师，我希望关闭项目时数据库连接也关闭，这样不会占用资源。

### 后端 — 用例查询与搜索

7. 作为 SoC 验证工程师，我希望子系统列表显示真实的用例数量，这样我能快速了解每个子系统的规模。
8. 作为 SoC 验证工程师，我希望展开子系统后能快速加载该子系统的全部用例，这样我能浏览用例树。
9. 作为 SoC 验证工程师，我希望搜索用例时输入部分名称就能匹配所有包含该子串的用例，这样我只记得大概名称时也能快速定位。
10. 作为 SoC 验证工程师，我希望搜索结果在万级用例下 5ms 内返回，这样搜索体验流畅无延迟。
11. 作为 SoC 验证工程师，我希望用例列表能显示每个用例最近一次仿真的状态（pass/fail/running/pending），这样我能直观看到哪些用例已跑过、结果如何。
12. 作为 SoC 验证工程师，我希望按状态过滤用例（全部/通过/失败/运行中/待运行），这样我能快速找到特定状态的用例。

### 后端 — 仿真历史持久化

13. 作为 SoC 验证工程师，我希望每次仿真运行的完整记录被持久化保存，这样即使重启应用也能查看历史运行结果。
14. 作为 SoC 验证工程师，我希望仿真历史包含时间戳、状态、耗时、corner、seed 等完整信息，这样我能从多个维度分析运行结果。
15. 作为 SoC 验证工程师，我希望仿真完成时自动写入数据库，这样我不需要手动操作。

### 后端 — 仿真阶段

16. 作为 SoC 验证工程师，我希望用例能标注仿真阶段（如 DVR1/DVR2/DVR3/DVS1/DVS2/POST），这样我能按阶段分组查看通过率。
17. 作为 SoC 验证工程师，我希望阶段信息由 case-parser 插件从配置文件自动解析，这样无需手动维护。
18. 作为 SoC 验证工程师，我希望阶段字段为可选（插件不返回时为空），这样不影响未配置阶段的项目的正常使用。

### 前端 — 子系统用例树渲染

19. 作为 SoC 验证工程师，我希望展开子系统后文件节点默认折叠，这样不会一次性渲染上万条用例导致卡顿。
20. 作为 SoC 验证工程师，我希望点击文件节点后展开该文件下的用例，这样我按需查看感兴趣的文件中的用例。
21. 作为 SoC 验证工程师，我希望保留「展开全部」和「折叠全部」按钮，这样我需要时仍能批量展开。
22. 作为 SoC 验证工程师，我希望用例树保留右键菜单功能（运行仿真、打开用例文件、复制路径），这样操作不变。

### AI Agent — HostTools 集成

23. 作为 AI Agent，我希望 `list_subsys` 从数据库读取子系统列表，这样响应更快且数据一致。
24. 作为 AI Agent，我希望 `list_cases` 从数据库读取用例列表（含实时 status），这样不需要等待插件扫描。
25. 作为 AI Agent，我希望 `get_case_stats` 从数据库聚合统计，这样 token 消耗更少、响应更快。
26. 作为 AI Agent，我希望 `get_project_overview` 从数据库聚合项目概览，这样一次调用即可获取全量信息。
27. 作为 AI Agent，我希望搜索用例时能从数据库快速查询，这样辅助用户定位用例更高效。

### 时序违例 — 数据共享

28. 作为时序违例模块，我希望从数据库获取 case_name → subsys 映射，这样不需要独立调用插件扫描。
29. 作为时序违例模块，我希望用例数据库和违例数据库各自独立但共享 case_name 作为关联键，这样数据模型清晰。

### Dashboard — 数据可视化（本期建立数据基础，视图后续迭代）

30. 作为 SoC 验证工程师，我希望看到每日/每周 pass/fail 数量的柱状图或折线图，这样能跟踪验证进度趋势。
31. 作为 SoC 验证工程师，我希望看到各子系统 pass/fail 分布的热力图或表格，这样能快速定位薄弱子系统。
32. 作为 SoC 验证工程师，我希望看到最近失败的用例列表（含错误类型、时间），这样能快速跟进失败用例。
33. 作为 SoC 验证工程师，我希望看到回归进度（总数/已跑/未跑/通过率），这样能掌握整体验证完成度。
34. 作为 SoC 验证工程师，我希望看到仿真耗时分布直方图，这样能识别耗时异常的慢用例。
35. 作为 SoC 验证工程师，我希望看到不稳定用例列表（有时 pass 有时 fail），这样能识别 flaky case 并优先处理。
36. 作为 SoC 验证工程师，我希望看到按仿真阶段分组的通过率，这样能了解各阶段（DVR1/DVR2/.../POST）的验证质量。

### 用户体验 — 刷新与数据一致性

37. 作为 SoC 验证工程师，我希望刷新单个子系统的用例缓存时只重新扫描该子系统，这样比全局刷新快很多。
38. 作为 SoC 验证工程师，我希望刷新后 UI 自动更新，这样不需要手动重新切换页面。
39. 作为 SoC 验证工程师，我希望刷新后概览页缓存也同步更新，这样概览数据不会过期。

## Implementation Decisions

### 架构决策（详见 ADR 0017）

- **数据库**：`better-sqlite3` + WAL 模式 + PRAGMA 优化（synchronous=NORMAL, cache_size=10000, temp_store=MEMORY, mmap_size=256MB），与 ADR 0012 时序违例模块一致。无需新增依赖。
- **DB 位置**：项目目录 `.socverify/cases.db`，跟随项目，自然隔离。
- **DB 与插件关系**：DB 成为主数据源。`SubsysDiscoveryPlugin` 和 `CaseParserPlugin` 变为「扫描器」，仅在项目打开（后台增量扫描）和用户点击「刷新」时调用。
- **扫描时机**：项目打开时检查 DB 是否已有数据。有则 UI 秒开，后台并行全量扫描增量更新。不加文件监听。
- **仿真历史**：每次 run 完整记录写入 `simulation_runs` 表。`SimulationManager` 发出 `run:completed` 事件时，独立事件监听器写 DB。`SimulationManager` 保持内存状态管理活跃运行，不耦合 DB。
- **搜索**：SQL `LIKE '%query%'` 子串匹配，万级数据 < 5ms。移除 `CaseIndexManager` 及内存倒排索引。
- **仿真阶段（Phase）**：用例属性，扩展 `CaseParserPlugin` 返回可选 `phase` 字段。`cases` 表含 `phase` 列。
- **前端渲染**：不自动展开文件节点，用户点击展开。

### DB Schema

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

PRAGMA 配置：
```sql
PRAGMA journal_mode = WAL;
PRAGMA synchronous = NORMAL;
PRAGMA cache_size = 10000;
PRAGMA temp_store = MEMORY;
PRAGMA mmap_size = 268435456;
```

### 模块变更

- **新增：Case Database 模块**（主进程）— 负责数据库初始化、连接管理、Schema 创建。镜像时序违例模块的 `tv-database.ts` 模式。按 projectRoot 缓存 DB 实例，关闭项目时关闭连接。
- **新增：Case Repository**（主进程）— 数据访问层。提供 CRUD、LIKE 搜索、聚合统计、仿真历史写入和查询。使用 `transaction()` + `prepare()` 保证批量操作性能和原子性。
- **新增：Case Scanner**（主进程）— 调用 `SubsysDiscoveryPlugin` + `CaseParserPlugin` 全量扫描并写入 DB。项目打开时后台增量扫描（对比 DB 差异，有变化才更新）。刷新按钮触发全量扫描。
- **新增：Simulation Run Listener**（主进程）— 监听 `SimulationManager` 的 `run:completed` 事件，将 run 记录写入 `simulation_runs` 表。写 DB 失败只记日志，不影响仿真流程。
- **重构：CaseStatsService** — 从「调用 PluginBackedDiscovery 实时扫描」改为「从 DB 读取」。保留对外的 API 形状（listCasesWithStatus, listSubsysWithCaseCount, getCaseStats, getProjectOverview），内部实现切换为 DB 查询。status 从 `simulation_runs` 表查最近一次记录。
- **移除：CaseIndexManager** — 搜索功能改为 DB LIKE 查询。`case-index-manager.ts` 和 `inverted-index.ts` 文件删除。
- **简化：CaseStatsRegistry** — 从管理 CaseStatsService 实例改为管理 DB 连接。
- **修改：project-router.ts** — getSubsystems / getCases / searchCases / refreshCases / getOverview 改为查 DB。新增 scanStatus procedure 供前端查询后台扫描进度。
- **修改：host/tools/sim-tools.ts** — list_subsys / list_cases 改为查 DB。
- **修改：host/tools/coverage-tools.ts** — get_case_stats / get_project_overview 改为查 DB。
- **扩展：CaseParserPlugin 接口** — `CaseInfo` 类型新增可选 `phase?: string` 字段。向后兼容，插件不返回时为 null。
- **修改：SubsysList.tsx** — 移除加载用例后自动展开文件节点的逻辑（`setExpandedFiles(filePaths)` 行）。文件节点默认折叠。
- **修改：SimulationManager** — 不改内部逻辑，仅确保 `run:completed` 事件被正确监听。

### API 契约变更

**tRPC project router**（渲染端调用方式不变，内部实现切换）：

- `project.getSubsystems` → 查 `subsystems` 表 + `SELECT COUNT(*) FROM cases WHERE subsys=?` 聚合
- `project.getCases` → 查 `cases` 表 + `LEFT JOIN simulation_runs` 获取最近一次 status
- `project.searchCases` → `SELECT * FROM cases WHERE name LIKE '%query%' [AND subsys=?] LIMIT ?`
- `project.refreshCases` → 调用 Case Scanner 全量扫描并更新 DB
- `project.getOverview` → SQL 聚合查询（`COUNT` + `GROUP BY subsys` + `GROUP BY status`）
- **新增** `project.scanStatus` → 返回后台扫描状态（idle/scanning/complete + 最后扫描时间）

**AI HostTools**（工具签名不变，内部实现切换）：

- `list_subsys` → 查 DB
- `list_cases` → 查 DB
- `get_case_stats` → 查 DB 聚合
- `get_project_overview` → 查 DB 聚合

### 时序违例模块集成

- 时序违例模块的 `getCaseToSubsysMap` 改为查 `cases` 表（`SELECT name, subsys FROM cases`），不再调用 CaseStatsService。
- 用例数据库和违例数据库各自独立（`.socverify/cases.db` vs `.socverify/timing-violation/tv.db`），通过 `case_name` 自然关联。

### Dashboard 数据查询（本期建表 + 数据积累，视图后续迭代）

- **趋势图**：`SELECT date(start_time) as date, status, COUNT(*) FROM simulation_runs GROUP BY date, status`
- **子系统热力图**：`SELECT subsys, status, COUNT(*) FROM simulation_runs WHERE status IN ('pass','fail') GROUP BY subsys, status`
- **最近失败**：`SELECT * FROM simulation_runs WHERE status='fail' ORDER BY start_time DESC LIMIT ?`
- **回归进度**：`SELECT COUNT(*) FROM cases` + `SELECT COUNT(DISTINCT case_name) FROM simulation_runs WHERE status IS NOT NULL` + `SELECT COUNT(*) FROM simulation_runs WHERE status='pass'`
- **耗时分布**：`SELECT duration_ms FROM simulation_runs WHERE duration_ms IS NOT NULL`
- **不稳定用例**：`SELECT case_name, SUM(CASE WHEN status='pass' THEN 1 ELSE 0 END) as pass_count, SUM(CASE WHEN status='fail' THEN 1 ELSE 0 END) as fail_count FROM simulation_runs GROUP BY case_name HAVING pass_count > 0 AND fail_count > 0`
- **按阶段通过率**：`SELECT c.phase, SUM(CASE WHEN r.status='pass' THEN 1 ELSE 0 END) as pass, COUNT(*) as total FROM cases c LEFT JOIN simulation_runs r ON c.name = r.case_name GROUP BY c.phase`

## Testing Decisions

### 测试原则

- 只测试外部行为，不验证内部实现细节（如 SQL 语句、DB 连接方式）。
- 使用真实 SQLite（`:memory:` 模式）而非 mock DB，确保 SQL 查询和聚合逻辑正确。
- Mock 插件接口（`SubsysDiscoveryPlugin` / `CaseParserPlugin`），因为插件是外部依赖。

### 测试缝

**缝 1（主缝）：tRPC API 集成缝**

测试 `project-router.ts` 的 getSubsystems / getCases / searchCases / refreshCases / getOverview / scanStatus procedure，使用真实内存 SQLite + mock 插件。验证外部行为（UI/AI 看到的数据）正确。这是最高缝，覆盖最多行为。

先例：`tests/timing-violation/violation-router.test.ts` 测试 violation router 对真实 DB 的端到端行为。

**缝 2：Case Database Repository 缝**

测试 DB 仓库层的 CRUD、LIKE 搜索、聚合查询、仿真历史写入。使用真实 SQLite（`:memory:`）。验证 SQL 正确性和边界条件（空表、万级数据、重复插入等）。

先例：时序违例模块的 `tv-repository.ts` 测试模式——使用 `createMemoryDatabase()` 创建内存 DB，测试批量插入、分页查询、统计聚合。

**缝 3：Case Scanner 缝**

测试扫描器调用插件并写入 DB 的行为。Mock 插件返回固定的子系统/用例数据，验证扫描器正确写入 DB，增量扫描能识别差异，刷新能全量更新。

先例：`tests/host/plugin-discovery.test.ts` 测试 PluginBackedDiscovery 与 mock 插件的交互。

**缝 4：UI 组件缝**

更新现有 `tests/ui/SubsysList.test.tsx`，验证：(1) 加载用例后文件节点默认折叠；(2) 点击文件节点后展开；(3) 「展开全部」按钮仍能展开所有文件节点。使用 `@testing-library/react` + mock tRPC。

先例：现有 `SubsysList.test.tsx` 已 mock tRPC 和 stores。

**缝 5：性能回归缝**

扩展 `tests/perf/`，新增测试验证：(1) 有 DB 缓存时 getSubsystems + getCases 总耗时 < 50ms；(2) 万级用例 LIKE 搜索 < 10ms。

先例：`tests/perf/project-loading-regression.test.ts` 测试文件树加载性能。

## Out of Scope

- **覆盖率数据入库**：覆盖率已有独立的数据模型（Coverage Tree，ADR 0007），暂不入 cases.db，避免范围蔓延。
- **Dashboard UI 实现**：本期只建立数据基础（`simulation_runs` 表 + 数据积累），Dashboard 视图的 React 组件实现属于后续迭代。
- **文件监听自动增量更新**：不加 chokidar 或 fs.watch 监听 case_cfg 变化。已有「刷新」按钮满足需求。
- **FTS5 全文搜索**：万级数据 LIKE 足够快，不引入 FTS5 虚拟表。
- **多项目数据库合并**：每个项目独立 DB，不做跨项目查询或合并。
- **仿真阶段手动配置 UI**：phase 由插件自动解析，不提供 UI 手动标注功能。
- **远程/云端数据库**：单用户桌面应用，不提供远程 DB 或多用户协作。
- **数据库迁移工具**：首次实现即终态 Schema，不需要从旧数据迁移。
- **现有 CaseIndexManager 的 fuzzyScore 逻辑保留**：LIKE 子串匹配替代后，subsequence 模糊匹配不再支持。如未来需要可再引入。

## Further Notes

- **better-sqlite3 原生模块**：已在 dependencies 中（ADR 0012），`electron.vite.config.ts` 已标记为 `external`，`electron-builder.yml` 已配置 unpack。无需额外构建配置。
- **.socverify/ 已在 .gitignore**：DB 文件不会被提交到版本控制。
- **CaseParserPlugin 向后兼容**：`phase` 字段为可选，现有插件不返回 phase 时 DB 中 phase 列为 NULL。插件升级是渐进式的。
- **SimulationManager 不改内部逻辑**：仅新增一个事件监听器写 DB。SimulationManager 仍保持内存 history 用于活跃运行管理，`CaseStatsService` 改为从 DB 读最近一次状态。
- **与时序违例模块的关系**：时序违例模块的 DB（`tv.db`）和用例 DB（`cases.db`）各自独立。时序违例模块改为从 `cases.db` 查 case→subsys 映射，不再调用 CaseStatsService。
- **实施顺序建议**：(1) Case Database + Repository → (2) Case Scanner → (3) 重构 CaseStatsService 查 DB → (4) project-router 切换到 DB → (5) 移除 CaseIndexManager，搜索改 DB LIKE → (6) 前端不自动展开 → (7) Simulation Run Listener → (8) HostTools 切换到 DB → (9) 时序违例模块集成。
