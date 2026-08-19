# PRD: Dashboard — 验证数据可视化面板

> **Parent ADR**: [ADR 0019: Dashboard 架构](../adr/0019-dashboard-architecture.md)
>
> **Glossary**: [术语表](./CONTEXT.md) → Dashboard 域
>
> **Prototype**: [docs/prototypes/dashboard.html](../prototypes/dashboard.html)
>
> **Triage label**: `ready-for-agent`

## Problem Statement

SoC 验证工程师在项目推进过程中，无法快速了解整体验证进度和质量状况。当前 Dashboard 是 M6 里程碑的占位实现——从 `.socverify/sim-history.json` 文件读取数据，仅展示 4 个指标卡片和简单的 pass/fail 分布条。ADR 0017 用例数据库化后，`simulation_runs` 表已积累了完整的仿真历史数据（包含 case_name、subsys、status、start_time、duration_ms、corner、seed 等字段），但 Dashboard 未跟进使用 DB 数据源，仍依赖过时的 JSON 文件。

具体痛点：

1. **数据源过时**：Dashboard 从 `sim-history.json` 读取数据，该文件是内存数组的序列化快照，不完整且不实时。ADR 0017 已将仿真历史持久化到 `simulation_runs` 表，Dashboard 未利用。

2. **视图单一**：仅展示 passRate、totalRuns、coverage、regressionCount 四个指标，无法展示时间趋势、子系统分布、失败详情、回归进度、耗时分布、不稳定用例、阶段通过率、调试难度等工程师关注的多维度数据。

3. **无子系统筛选**：工程师无法按子系统过滤查看数据。一个典型 SoC 项目有 10~20 个子系统，工程师经常需要聚焦某个子系统的验证状况，而不是看所有数据的汇总。

4. **无时间范围筛选**：工程师无法按时间范围（如最近 7 天、最近 30 天）过滤数据，无法观察短期趋势变化。

5. **左栏缺少概览**：LeftRail 概览页仅显示子系统数/用例数/通过率/失败数的静态统计行，缺少迷你回归进度条和 sparkline 趋势，工程师在左栏无法快速感知验证进展。

6. **无自动刷新**：仿真完成后 Dashboard 不会自动更新数据，需要手动关闭再重新打开。

## Solution

完全重写 Dashboard，数据源切换为 Case Database（ADR 0017）的 `simulation_runs` + `cases` 表，使用 Apache ECharts 渲染图表，tRPC router 按图表细粒度拆分 procedure，前端以标签页分区展示 9 种图表视图。顶部工具栏提供全局时间范围选择器和全局子系统筛选下拉菜单，所有图表共享筛选状态。

架构决策详见 [ADR 0019](../adr/0019-dashboard-architecture.md)。

HTML 原型见 [docs/prototypes/dashboard.html](../prototypes/dashboard.html)。

## User Stories

### 后端 — tRPC API

1. 作为 SoC 验证工程师，我希望 Dashboard 的所有数据来自 Case Database 而非 JSON 文件，这样数据与仿真历史保持一致且实时。
2. 作为 SoC 验证工程师，我希望每个图表有独立的 API 接口，这样切换标签页时只加载需要的数据，不拉全量数据拖慢响应。
3. 作为 SoC 验证工程师，我希望 Dashboard 能查询每日 pass/fail/error 趋势，这样我能观察验证质量的日变化趋势。
4. 作为 SoC 验证工程师，我希望 Dashboard 能查询每周 pass/fail/error 趋势，这样我能以周为单位观察更长期的趋势变化。
5. 作为 SoC 验证工程师，我希望 Dashboard 能查询各子系统的 pass/fail/error 分布热力图，这样我能快速识别哪个子系统验证状况最差。
6. 作为 SoC 验证工程师，我希望 Dashboard 能查询最近失败的用例列表，这样我能快速定位最近的失败案例并查看失败时间、子系统和耗时。
7. 作为 SoC 验证工程师，我希望 Dashboard 能查询回归进度（总用例数/已跑用例数/通过率/未跑用例数），这样我能了解整体回归完成度。
8. 作为 SoC 验证工程师，我希望 Dashboard 能查询仿真耗时分布直方图，这样我能识别哪些用例耗时异常长。
9. 作为 SoC 验证工程师，我希望 Dashboard 能识别不稳定用例（有 pass 又有 fail 的用例），这样我能聚焦排查 flaky case。
10. 作为 SoC 验证工程师，我希望 Dashboard 能按仿真阶段（DVR1/DVR2/DVR3/DVS1/DVS2/POST）分组查询通过率，这样我能了解各阶段的验证完成情况。
11. 作为 SoC 验证工程师，我希望 Dashboard 能查询调试难度散点图（首次提交到首次 pass 的天数 vs fail 次数），这样我能识别调试难度最高的用例。
12. 作为 SoC 验证工程师，我希望 Dashboard 能查询概览汇总数据（子系统数/用例数/通过率/失败数/最近 7 天趋势），这样左栏可以展示缩略信息。

### 后端 — 子系统筛选与时间范围

13. 作为 SoC 验证工程师，我希望每个 Dashboard API 接口支持可选的子系统参数，这样选择某个子系统后所有图表数据自动过滤为该子系统。
14. 作为 SoC 验证工程师，我希望 Dashboard 能查询项目中有仿真记录的子系统列表，这样下拉筛选菜单可以动态填充选项。
15. 作为 SoC 验证工程师，我希望每个 Dashboard API 接口支持时间范围参数（全部/最近 7 天/最近 30 天/自定义），这样我能按时间窗口过滤数据观察短期趋势。
16. 作为 SoC 验证工程师，我希望子系统筛选和时间范围筛选可以叠加使用，这样我能查看「最近 7 天 CPU 子系统的失败趋势」这样的组合视图。
17. 作为 SoC 验证工程师，我希望回归进度在选定子系统时仅统计该子系统的用例，这样我能了解单个子系统的回归完成度。
18. 作为 SoC 验证工程师，我希望回归进度始终按全量统计（不受时间范围影响），这样回归进度衡量的是整体完成度而非时间窗口内的增量。

### 前端 — Dashboard 主面板

19. 作为 SoC 验证工程师，我希望 Dashboard 以标签页分区展示图表，这样我能聚焦关注某个维度的数据，不被 9 种图表平铺信息过载。
20. 作为 SoC 验证工程师，我希望 Dashboard 有「概览」标签页展示汇总指标卡片和子系统状态表，这样我能快速了解全局验证状况。
21. 作为 SoC 验证工程师，我希望 Dashboard 有「趋势」标签页展示每日/每周 pass/fail/error 趋势折线图，这样我能观察验证质量的时间变化。
22. 作为 SoC 验证工程师，我希望 Dashboard 有「子系统」标签页展示子系统热力图和子系统详细数据表，这样我能对比各子系统的验证状况。
23. 作为 SoC 验证工程师，我希望 Dashboard 有「失败」标签页展示最近失败用例列表，这样我能快速定位最近的失败案例。
24. 作为 SoC 验证工程师，我希望 Dashboard 有「回归」标签页展示回归进度环形图和统计数字，这样我能了解整体回归完成度。
25. 作为 SoC 验证工程师，我希望 Dashboard 有「耗时」标签页展示仿真耗时分布直方图，这样我能识别耗时异常的用例。
26. 作为 SoC 验证工程师，我希望 Dashboard 有「不稳定」标签页展示不稳定用例列表（按失败率降序），这样我能聚焦排查 flaky case。
27. 作为 SoC 验证工程师，我希望 Dashboard 有「阶段」标签页展示各仿真阶段的通过率柱状图，这样我能了解各阶段验证完成情况。
28. 作为 SoC 验证工程师，我希望 Dashboard 有「调试难度」标签页展示调试难度散点图，这样我能识别调试难度最高的用例。

### 前端 — 工具栏与筛选

29. 作为 SoC 验证工程师，我希望 Dashboard 顶部工具栏有时间范围选择器（全部/最近 7 天/最近 30 天/自定义），这样我能快速切换时间窗口。
30. 作为 SoC 验证工程师，我希望 Dashboard 顶部工具栏有子系统下拉筛选（默认「全部子系统」），这样选择某个子系统后所有图表自动过滤。
31. 作为 SoC 验证工程师，我希望 Dashboard 顶部工具栏有手动刷新按钮，这样我能随时手动刷新当前标签页数据。
32. 作为 SoC 验证工程师，我希望 Dashboard 的标签页切换时自动加载该标签页的数据（如果尚未加载），这样我不需要手动刷新。
33. 作为 SoC 验证工程师，我希望 Dashboard 记住我上次查看的标签页和时间范围偏好，这样重新打开 Dashboard 时恢复到我上次的状态。

### 前端 — 图表渲染与主题

34. 作为 SoC 验证工程师，我希望 Dashboard 图表使用 ECharts 渲染，这样图表交互流畅且支持丰富的图表类型。
35. 作为 SoC 验证工程师，我希望 Dashboard 图表的颜色与 UI 主题完全一致，这样切换主题时图表颜色自动同步。
36. 作为 SoC 验证工程师，我希望 Dashboard 图表支持悬停 tooltip，这样我能查看数据点的具体数值。
37. 作为 SoC 验证工程师，我希望 Dashboard 的子系统热力图颜色根据状态和强度动态混合，这样热力图对比度好、可读性强。
38. 作为 SoC 验证工程师，我希望 Dashboard 的失败列表不显示 Corner 列（Corner 是 post sim 即后仿真阶段才有的概念），这样避免在前仿真阶段展示不相关的信息。

### 前端 — 左栏 Dashboard Summary

39. 作为 SoC 验证工程师，我希望 LeftRail 概览页有迷你回归进度条（已跑/总数），这样我在左栏就能快速感知回归完成度。
40. 作为 SoC 验证工程师，我希望 LeftRail 概览页有 7 天 pass/fail sparkline 迷你折线图，这样我在左栏就能快速感知近期趋势。
41. 作为 SoC 验证工程师，我希望 LeftRail 概览页有「打开完整仪表盘」按钮，这样我能一键跳转到完整 Dashboard。

### 前端 — 数据刷新与空状态

42. 作为 SoC 验证工程师，我希望仿真完成后 Dashboard 当前标签页自动刷新数据，这样不需要手动刷新就能看到最新结果。
43. 作为 SoC 验证工程师，我希望项目无仿真记录时每个图表显示引导提示（如「运行仿真后此处将展示 pass/fail 趋势」），这样空状态不会显示空白或报错。
44. 作为 SoC 验证工程师，我希望 Dashboard 在加载中显示加载状态指示，这样我知道数据正在获取。
45. 作为 SoC 验证工程师，我希望 Dashboard 在数据加载失败时显示错误提示，这样我知道出了什么问题。

### 前端 — Workbench 集成

46. 作为 SoC 验证工程师，我希望通过 Workbench 打开 Dashboard 作为一个标签页，这样我可以在文件、终端、Dashboard 之间切换。
47. 作为 SoC 验证工程师，我希望 Dashboard 标签页标题显示为「仪表盘」，这样我能在 Workbench 标签栏中识别它。

## Implementation Decisions

### 架构决策（详见 ADR 0019）

- **数据源完全切换**：废弃 `getMetrics` procedure（从 `sim-history.json` 读取），所有查询走 `CaseDatabase` 实例的 `simulation_runs` + `cases` 表 SQL 聚合。保留 `saveLayout`/`getLayout` 用于布局偏好持久化。
- **tRPC procedure 按图表细粒度拆分**：每个图表一个独立 procedure，而非一个大查询。前端按标签页独立加载，切换标签页只加载需要的数据，自动刷新只刷新当前标签页。
- **Apache ECharts**：引入 `echarts` + `echarts-for-react` 依赖。原生支持全部所需图表类型（柱状图、折线图、热力图、直方图、散点图、饼图）。桌面应用对包体积不敏感。
- **标签页分区布局**：9 个标签页（概览/趋势/子系统/失败/回归/耗时/不稳定/阶段/调试难度），每个标签对应一个图表区域。
- **全局子系统筛选**：顶部工具栏全局下拉，选择后所有图表数据过滤为该子系统。每个 procedure 的 SQL 查询增加可选 `subsys` 参数。
- **全局时间范围选择器**：全部/最近 7 天/最近 30 天/自定义。回归进度始终按全量统计。
- **数据刷新策略**：手动刷新按钮 + 监听 `simulation:event` 事件流中的 `run:completed` 事件，自动刷新当前标签页。不做定时轮询。

### tRPC Procedure 契约

每个 procedure 接受统一的筛选参数：

```typescript
// 筛选参数（来自原型，所有 procedure 共享）
type DashboardFilter = {
  projectId: string;
  subsys?: string;        // 子系统筛选，有值时追加 WHERE subsys = ?
  timeRange?: 'all' | '7d' | '30d' | { start: string; end: string };
  // timeRange 不影响 getRegressionProgress（始终全量统计）
};
```

Procedure 列表及核心 SQL（来自 ADR 0019 + 原型）：

| Procedure | 返回结构 | 核心 SQL 逻辑 |
|-----------|---------|-------------|
| `getSummary` | `{ subsysCount, caseCount, passRate, failCount, trend7d: {date,pass,fail,error}[] }` | `COUNT(DISTINCT subsys)` + `COUNT(cases)` + `GROUP BY status` + 7 天 `GROUP BY date(start_time), status` |
| `getTrend` | `{ date, pass, fail, error }[]` | `GROUP BY date(start_time), status`，weekly 时按 `strftime('%Y-%W', start_time)` 分组 |
| `getSubsysHeatmap` | `{ subsys, pass, fail, error, total, passRate }[]` | `GROUP BY subsys, status` |
| `getRecentFailures` | `{ caseName, subsys, startTime, durationMs }[]` | `WHERE status='fail' ORDER BY start_time DESC LIMIT 50` |
| `getRegressionProgress` | `{ totalCases, runCases, passedCases, failedCases, notRunCases, passRate }` | `COUNT(cases)` LEFT JOIN `COUNT(DISTINCT case_name FROM simulation_runs)` |
| `getDurationHistogram` | `{ bucket, count }[]` | `SELECT duration_ms FROM simulation_runs WHERE duration_ms IS NOT NULL`，前端分桶或 SQL CASE WHEN 分桶 |
| `getUnstableCases` | `{ caseName, subsys, passCount, failCount, totalCount, failRate, lastStatus }[]` | `GROUP BY case_name HAVING SUM(CASE WHEN status='pass' THEN 1 ELSE 0 END) > 0 AND SUM(CASE WHEN status='fail' THEN 1 ELSE 0 END) > 0` |
| `getPhasePassRate` | `{ phase, total, pass, fail, error, passRate }[]` | `GROUP BY phase`（phase 从 cases 表 JOIN） |
| `getDebugDifficulty` | `{ caseName, subsys, daysToFirstPass, failCountBeforePass }[]` | 窗口函数查首次 run 时间和首次 pass 时间 |
| `getSubsysList` | `string[]` | `SELECT DISTINCT name FROM subsystems`（用于下拉筛选） |
| `saveLayout` / `getLayout` | 保持不变 | 读写 `.socverify/dashboard-layout.json` |

### Case Repository 扩展

在 `case-repository.ts` 中新增 Dashboard 专用聚合查询函数。每个函数接受 `Database` + 可选筛选参数（`subsys`、`timeRangeStart`、`timeRangeEnd`），返回结构化数据。使用已有索引（`idx_runs_start_time` / `idx_runs_status` / `idx_runs_case_subsys`）保证万级数据下 < 10ms。

### Dashboard Store 扩展

前端 Zustand store 从当前仅存储 `metrics` 扩展为：
- 按标签页存储数据（`summary`、`trend`、`subsysHeatmap`、`recentFailures`、`regressionProgress`、`durationHistogram`、`unstableCases`、`phasePassRate`、`debugDifficulty`）
- 全局筛选状态（`activeTab`、`selectedSubsys`、`timeRange`）
- 加载状态（`loadingTab: string | null`）
- 操作（`loadTabData(tab)`、`setSubsys(subsys)`、`setTimeRange(range)`、`refresh()`）
- 切换子系统/时间范围时清除所有标签页缓存数据并重新加载当前标签页

### ECharts 主题集成

通过 `getComputedStyle(document.documentElement)` 读取 CSS 变量（`--background` / `--foreground` / `--primary` / `--status-pass` / `--status-fail` / `--status-error` / `--chart-1` 到 `--chart-4` 等），动态构建 ECharts theme 对象。监听 `data-theme` 属性变化（通过 MutationObserver），主题切换时重新构建 theme 并刷新所有图表。

### LeftRail Dashboard Summary

在 LeftRail 概览页现有统计行下方增加：
- 迷你回归进度条（`已跑/总数`，使用 CSS 进度条组件，不引入额外图表库）
- 7 天 pass/fail sparkline（使用 ECharts mini 折线图，高度 40px，无轴线无 tooltip）
- 「打开完整仪表盘」按钮（调用 `workbench.open({ type: 'dashboard' })`）

数据来源为 `dashboard.getSummary` procedure。

### Workbench 集成

`WorkbenchDestination` 联合类型已包含 `{ type: 'dashboard' }`（现有代码），`describeDestination` 已返回 `{ id: 'dashboard', title: '仪表盘', closable: true }`。CenterArea 渲染分发已包含 dashboard 分支。无需修改 workbench store。

### 布局持久化

`saveLayout` / `getLayout` 存储到 `.socverify/dashboard-layout.json`，记录用户上次查看的标签页 ID 和时间范围偏好。Dashboard mount 时读取布局恢复状态。

## Testing Decisions

### 测试缝策略

复用项目已有的两条测试缝，不新建缝。

**主缝：tRPC API 集成缝**

- 端到端测试 `dashboard-router` 的每个 procedure
- 使用内存 SQLite 数据库（`createMemoryDatabase()`，与 `case-repository.test.ts` 相同模式）
- 插入模拟的 `subsystems`、`cases`、`simulation_runs` 数据
- 验证每个 procedure 的返回结构和筛选行为（subsys 过滤、timeRange 过滤）
- Mock 依赖：`requireProject` 返回固定项目路径，`caseDatabaseRegistry.getOrCreate` 返回内存 DB
- 先例：`tests/case/case-repository.test.ts`、`tests/timing-violation/violation-router.test.ts`

**辅助缝：UI 组件缝**

- 使用 `@testing-library/react` 测试 `DashboardPanel` 组件渲染
- Mock tRPC proxy 返回固定数据（与 `tv-dashboard.test.tsx` 相同模式）
- 验证标签页切换、空状态显示、子系统筛选下拉菜单交互、加载状态
- 先例：`tests/ui/tv-dashboard.test.tsx`、`tests/ui/coverage-dashboard.test.tsx`

### 测试质量标准

- 好测试只验证外部行为（输入→输出），不验证内部实现（私有方法、SQL 语句具体形式）
- 测试命名描述行为意图（"returns daily pass/fail trend grouped by date" 而非 "test getTrend"）
- 覆盖正常数据、空数据、筛选组合（subsys + timeRange 叠加）
- 覆盖率目标：后端 procedure > 80%，UI 组件 > 60%

### 测试范围

**后端 procedure 测试**（`tests/dashboard-router.test.ts`）：
- `getSummary` — 返回汇总数据 + 7 天趋势
- `getTrend` — 每日/每周趋势，subsys 过滤，timeRange 过滤
- `getSubsysHeatmap` — 各子系统 pass/fail/error 分布，subsys 过滤
- `getRecentFailures` — 最近失败列表，不包含 Corner 列，subsys 过滤
- `getRegressionProgress` — 回归进度，subsys 过滤，不受 timeRange 影响
- `getDurationHistogram` — 耗时分桶分布
- `getUnstableCases` — 不稳定用例识别（有 pass 又有 fail）
- `getPhasePassRate` — 按阶段分组通过率
- `getDebugDifficulty` — 调试难度散点图数据
- `getSubsysList` — 子系统列表（用于下拉筛选）
- 空数据库时所有 procedure 返回空数组/零值

**Case Repository 聚合查询测试**（扩展 `tests/case/case-repository.test.ts`）：
- 新增的 Dashboard 专用聚合查询函数
- 使用已有 helper（`makeSubsys`、`makeCase`、`insertSimulationRun`）
- 验证多条件筛选组合

**UI 组件测试**（`tests/ui/dashboard-panel.test.tsx`）：
- DashboardPanel 渲染 9 个标签页
- 标签页切换触发对应数据加载
- 空状态显示引导提示
- 子系统筛选下拉菜单交互
- 时间范围选择器交互
- 加载中状态显示
- 左栏 Dashboard Summary 渲染（迷你进度条 + sparkline + 打开按钮）

## Out of Scope

- **Corner 筛选**：暂不提供按 corner 筛选 Dashboard 数据，后续可加。
- **错误类型展示**：最近失败列表暂不展示 compile_error / sim_error 分类（需跨模块查询 ErrorAnalysis），也不展示 Corner（Corner 是 post sim 即后仿真阶段才有的概念），作为后续增强。
- **覆盖率数据集成**：Dashboard 不集成覆盖率图表（覆盖率有独立的 Coverage Dashboard）。
- **Dashboard 数据导出**：暂不支持导出 Dashboard 数据为 Excel / PDF。
- **自定义图表布局**：标签页顺序固定，不支持用户拖拽重排。
- **跨项目 Dashboard**：Dashboard 只展示当前打开项目的数据，不支持跨项目聚合。
- **实时推送更新**：不做 WebSocket 式实时推送，仿真完成后通过事件监听触发当前标签页刷新即可。
- **图表交互高级功能**：暂不支持图表数据钻取（如点击子系统热力图某格跳转到该子系统的用例列表），作为后续增强。

## Further Notes

- **依赖关系**：Dashboard 完全依赖 ADR 0017 的 Case Database。`simulation_runs` 表有数据才能展示图表。项目无仿真记录时所有图表显示空状态引导提示。
- **性能**：所有 SQL 聚合查询走已有索引（`idx_runs_start_time` / `idx_runs_status` / `idx_runs_case_subsys`），万级数据下 < 10ms。前端按标签页按需加载，避免一次拉全量数据。
- **HTML 原型**：`docs/prototypes/dashboard.html` 包含完整的 Dashboard UI 原型，含 4 套主题 CSS 变量、ECharts 图表渲染、标签页切换、子系统筛选、时间范围选择器、热力图动态颜色混合等交互逻辑。实现时应参考原型的视觉设计和交互行为。
- **现有代码废弃**：`dashboard-router.ts` 中的 `getMetrics` procedure 废弃，`sim-history.json` 不再作为 Dashboard 数据源。`DashboardPanel.tsx` 和 `dashboard.ts` store 完全重写。
- **ECharts 依赖**：需在 `package.json` 中新增 `echarts` 和 `echarts-for-react` 依赖。
