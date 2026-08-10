# Dashboard 架构

Dashboard 完全基于 Case Database（ADR 0017）的 `simulation_runs` 表构建，使用 Apache ECharts 渲染图表，tRPC router 按图表细粒度拆分 procedure，前端以标签页分区展示。

## 背景

现有 `DashboardPanel` 和 `dashboard-router.ts` 是 M6 里程碑的占位实现——从 `.socverify/sim-history.json` 文件读取数据，仅展示 4 个指标卡片和简单的 pass/fail 分布条。ADR 0017 用例数据库化后，`simulation_runs` 表已积累了完整的仿真历史数据，但 Dashboard 未跟进使用 DB 数据源。

用户需求（见 PRD-case-database 用户故事 30-36 + 额外需求）要求 Dashboard 支持 8+ 种图表：每日/每周趋势、子系统热力图、失败列表、回归进度、耗时分布、不稳定用例、阶段通过率、调试难度。现有占位实现完全不满足。

## 决策

### 1. 完全重写 dashboard-router，数据源切换为 Case Database

废弃 `getMetrics` procedure（从 `sim-history.json` 读取），所有查询走 `CaseDatabase` 实例的 `simulation_runs` + `cases` 表 SQL 聚合。保留 `saveLayout`/`getLayout` 用于布局偏好持久化。

### 2. tRPC procedure 按图表细粒度拆分

每个图表一个独立 procedure，而非一个 `getDashboardData` 大查询：

| Procedure | 图表 | 核心 SQL |
|-----------|------|----------|
| `getSummary` | 左栏缩略数据 | `COUNT` + `GROUP BY status` + 7 天趋势 |
| `getTrend` | 每日/每周趋势 | `GROUP BY date(start_time), status` |
| `getSubsysHeatmap` | 子系统热力图 | `GROUP BY subsys, status` |
| `getRecentFailures` | 最近失败列表 | `WHERE status='fail' ORDER BY start_time DESC LIMIT ?` |
| `getRegressionProgress` | 回归进度 | `COUNT(cases)` + `COUNT(DISTINCT case_name FROM simulation_runs)` |
| `getDurationHistogram` | 耗时分布 | `SELECT duration_ms FROM simulation_runs WHERE duration_ms IS NOT NULL` |
| `getUnstableCases` | 不稳定用例 | `GROUP BY case_name HAVING pass_count > 0 AND fail_count > 0` |
| `getPhasePassRate` | 阶段通过率 | `GROUP BY phase` |
| `getDebugDifficulty` | 调试难度散点图 | 窗口函数查首次 run 和首次 pass |

理由：
- 前端按标签页独立加载，切换标签页只加载需要的数据
- 自动刷新时只刷新当前标签页，不拉全量数据
- 单个 procedure 查询快（< 10ms），前端体验流畅
- 替代方案（一个大查询）会导致首次加载慢且无法按需刷新

### 3. Apache ECharts 作为图表库

引入 `echarts` + `echarts-for-react` 依赖。选择理由：
- 原生支持全部所需图表类型（柱状图、折线图、热力图、直方图、散点图、饼图）
- 主题可通过 JS 对象自定义，读取 CSS 变量动态构建主题
- 桌面应用对包体积不敏感
- Recharts 热力图支持差需手写，Chart.js 散点图能力弱

ECharts 主题通过读取应用 CSS 变量（`--background`/`--foreground`/`--primary`/`--status-pass`/`--status-fail` 等）动态构建，主题切换时重新构建。

### 4. 标签页分区布局

Dashboard 顶部一排标签（概览/趋势/子系统/失败/回归/耗时/不稳定/阶段/调试难度），每个标签对应一个图表区域。标签页让用户聚焦关注点，避免 8+ 种图表平铺信息过载。

### 5. 左栏 Dashboard Summary

LeftRail 概览页在现有统计行基础上增加：
- 迷你回归进度条（已跑/总数）
- 7 天 pass/fail sparkline（迷你折线图）
- 「打开完整仪表盘」按钮（`workbench.open({ type: 'dashboard' })`）

### 6. 全局时间范围选择器

Dashboard 顶部提供时间范围选择器（全部/最近 7 天/最近 30 天/自定义），所有图表默认使用该范围过滤。回归进度始终按全量统计（衡量整体完成度，不受时间范围影响）。

### 7. 数据刷新策略

手动刷新按钮 + 监听 `simulation:event` 事件流。当有仿真完成（`run:completed`）时自动刷新当前标签页数据。不做定时轮询。

### 8. 全局子系统筛选

Dashboard 顶部工具栏提供全局子系统下拉筛选（默认「全部子系统」）。选择某个子系统后，所有图表数据自动过滤为该子系统。实现上每个 tRPC procedure 的 SQL 查询增加可选 `subsys` 参数，有值时追加 `WHERE subsys = ?` 条件。子系统列表从 `SELECT DISTINCT name FROM subsystems` 获取。

子系统筛选与时间范围筛选可叠加使用。回归进度标签页在选定子系统时，仅统计该子系统内的用例。

## 不在范围内

- **Corner 筛选**：暂不提供按 corner 筛选，后续可加
- **错误类型展示**：最近失败列表暂不展示 compile_error/sim_error 分类（需跨模块查询 ErrorAnalysis），也不展示 corner（corner 是 post sim 即后仿真阶段才有的概念），作为后续增强
- **覆盖率数据集成**：Dashboard 不集成覆盖率图表（覆盖率有独立的 Coverage Dashboard）
- **Dashboard 数据导出**：暂不支持导出 Dashboard 数据为 Excel/PDF
- **自定义图表布局**：标签页顺序固定，不支持用户拖拽重排

## 考量的替代方案

### 单个 `getDashboardData` 大查询

被否决。原因：(1) 首次加载慢（8 种图表数据一次拉取）；(2) 无法按需刷新当前标签页；(3) 任何一个查询变慢会拖累整体响应。

### Recharts

被否决。原因：热力图不支持（需手写 grid），散点图能力弱，调试难度图表无法良好展示。

### 单页滚动布局

被否决。原因：8+ 种图表平铺在一个页面中信息过载，用户难以快速定位关注的指标。

## 进一步说明

- **依赖关系**：Dashboard 完全依赖 ADR 0017 的 Case Database。`simulation_runs` 表有数据才能展示图表。
- **空状态**：项目无仿真记录时，每个图表显示引导提示（如「运行仿真后此处将展示 pass/fail 趋势」）。
- **性能**：所有 SQL 聚合查询走索引（`idx_runs_start_time`/`idx_runs_status`/`idx_runs_case_subsys`），万级数据下 < 10ms。
- **布局持久化**：`saveLayout`/`getLayout` 存储到 `.socverify/dashboard-layout.json`，用于记住用户上次查看的标签页和时间范围偏好。
