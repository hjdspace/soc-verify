# PRD: 覆盖率分析 — 层级树 + 三视图 + AI 全流程覆盖收敛

## Problem Statement

SoC 验证工程师在覆盖率分析阶段面临三个核心痛点：

1. **EDA 覆盖率数据无法直接消费**：Cadence IMC / Synopsys VCS urg 生成的覆盖率数据是二进制数据库格式，需要通过 EDA 工具命令（如 `imc -load . -execcmd "report -summary -out..."`）转换为文本报告后才能分析。工程师需要记住不同 EDA 工具的命令语法、手动执行、指定输出路径——流程繁琐且容易出错。

2. **覆盖率数据展示缺乏层次感**：当前 `CoverageData` 是扁平结构（只有 overall/line/toggle/functional/assertion 百分比 + bySubsys 扁平数组），但真实 IMC 报告有层级模块树（`tb_top → chip_top → dut → u_block_wrap → u_analog_mipi`）和 covered/total 计数对。扁平结构丢失了模块间的父子关系和覆盖计数，工程师无法快速定位覆盖盲区所在的模块层级。

3. **AI 辅助覆盖率分析与验证流程割裂**：AI Agent（omp）的 `get_coverage` Host Tool 返回扁平 JSON，`cov://` URI handler 返回空壳 `{}`。AI 无法理解覆盖率层级结构，无法按模块下钻分析覆盖 gap，更无法执行覆盖收敛闭环（识别 gap → 生成定向测试 → 运行仿真 → 检查 delta → 迭代）。coverage-closure 技能虽然定义了完整的覆盖收敛工作流，但无法通过平台 Host Tools 获取结构化覆盖率数据。

## Solution

在现有覆盖率骨架上，重构数据模型、预处理流水线、UI 展示和 AI 集成，实现端到端的覆盖率分析能力：

**预处理流水线**：平台根据项目级 EDA Tool Configuration 运行 EDA 命令生成三种文本报告（summary/detail/metrics），CoverageParserPlugin 只负责解析文本报告为层级树结构化数据。两步分离使 EDA 工具命令执行和文本解析可独立演化。

**层级树数据模型**：CoverageData 从扁平结构扩展为层级模块树，每个节点有 8 种 Coverage Metric 的 Coverage Triplet（`{ percentage, covered, total }`）。内置行业默认 Coverage Target，可配置。

**三种 UI 视图**：覆盖率页面提供三种布局——树表格（详细分析）、旭日图（概览演示）、仪表盘+下钻（日常使用）。用户可在视图间切换。

**AI 全流程覆盖收敛**：`get_coverage` Host Tool 返回摘要+最差模块（摘要优先），新增 `get_coverage_detail` Host Tool 支持按需下钻。`cov://` URI 实现分层 URI scheme。coverage-closure 技能通过 Host Tools 获取结构化数据，执行完整覆盖收敛工作流。

覆盖率数据以 Coverage Merge Session 为生命周期单位——用户手动指定 cov_merge 目录，平台生成报告并创建 session，不与单个 Simulation Run 绑定。

## User Stories

### 覆盖率导入与预处理

1. 作为 SoC 验证工程师，我 want 在项目设置中配置 EDA 工具类型（Cadence IMC / Synopsys VCS urg / Mentor Questa vcover），so that 平台知道用哪个命令生成覆盖率报告
2. 作为 SoC 验证工程师，我 want 在项目设置中配置 cov_merge 默认路径，so that 不需要每次导入覆盖率时手动指定
3. 作为 SoC 验证工程师，I want 在项目设置中查看和编辑 EDA 命令模板，so that 高级用户可以自定义 imc/urg 命令参数
4. 作为 SoC 验证工程师，I want 点击"导入覆盖率"按钮并选择 cov_merge 目录，so that 平台自动运行 EDA 命令生成文本报告
5. 作为 SoC 验证工程师，I want 看到覆盖率报告生成进度（正在运行 imc 命令...），so that 知道平台在工作
6. 作为 SoC 验证工程师，I want 平台自动生成三种报告（summary/detail/metrics），so that 一次导入就有全部数据
7. 作为 SoC 验证工程师，I want 导入失败时看到明确的错误信息（如 imc 命令未找到、cov_merge 目录无效），so that 能自行排查问题
8. 作为 SoC 验证工程师，I want 查看 merge session 列表（按时间排序），so that 在不同时间点的覆盖率快照间切换
9. 作为 SoC 验证工程师，I want 删除旧的 merge session，so that 清理不再需要的覆盖率缓存
10. 作为 SoC 验证工程师，I want 在 session 列表中看到每个 session 的元信息（cov_merge 路径、EDA 工具、生成时间），so that 确认数据来源

### 数据模型与指标

11. 作为 SoC 验证工程师，I want 覆盖率数据以层级模块树展示（tb_top → chip_top → dut → u_block_wrap → u_analog_mipi），so that 看到模块间的父子层次关系
12. 作为 SoC 验证工程师，I want 每个模块节点显示 8 种覆盖率指标（line/branch/toggle/condition/fsm_state/fsm_transition/functional/assertion），so that 全面评估覆盖情况
13. 作为 SoC 验证工程师，I want 每种指标显示 percentage + covered/total 计数对（如 87.50% (13/15)），so that 知道是"少量代码未覆盖"还是"大量代码未覆盖"
14. 作为 SoC 验证工程师，I want 不适用的指标显示 n/a（如纯组合逻辑模块没有 fsm coverage），so that 不被无意义的 0% 误导
15. 作为 SoC 验证工程师，I want 配置覆盖率目标/阈值（如 line ≥ 95%、fsm_state = 100%），so that 平台能自动标记达标/未达标
16. 作为 SoC 验证工程师，I want 使用平台内置的行业默认目标，so that 不需要从头配置
17. 作为 SoC 验证工程师，I want 在项目设置中覆盖默认目标，so that 某些项目可以有更严格或更宽松的标准

### UI 视图 — 树表格

18. 作为 SoC 验证工程师，I want 在树表格视图中展开/折叠模块树的节点，so that 按需查看子模块覆盖率
19. 作为 SoC 验证工程师，I want 树表格中每列指标用颜色标记达标（绿）/接近（黄）/未达标（红）/N/A（灰），so that 一眼定位覆盖盲区
20. 作为 SoC 验证工程师，I want 在树表格中过滤模块名，so that 快速找到特定模块
21. 作为 SoC 验证工程师，I want 一键展开/全部折叠树表格，so that 在概览和详细视图间切换
22. 作为 SoC 验证工程师，I want "仅看未达标"过滤，so that 只关注有覆盖 gap 的模块
23. 作为 SoC 验证工程师，I want 树表格顶部显示 8 个概览卡片（总体覆盖率 + 达标状态），so that 先看全局再看细节

### UI 视图 — 旭日图

24. 作为 SoC 验证工程师，I want 在旭日图视图中看到同心环表示模块层级深度，so that 直观理解设计层次
25. 作为 SoC 验证工程师，I want 旭日图弧段颜色表示覆盖率达标状态，so that 视觉化识别覆盖盲区
26. 作为 SoC 验证工程师，I want 在旭日图中切换 8 种指标查看，so that 分别分析不同覆盖率类型
27. 作为 SoC 验证工程师，I want 点击旭日图中的模块弧段后右侧显示详情面板，so that 查看该模块的完整覆盖率和未覆盖项
28. 作为 SoC 验证工程师，I want 旭日图中心显示当前选中指标的总体覆盖率，so that 概览全局

### UI 视图 — 仪表盘 + 下钻

29. 作为 SoC 验证工程师，I want 在仪表盘视图中看到 8 个概览卡片（含达标状态徽章），so that 一览所有覆盖率类型的达标情况
30. 作为 SoC 验证工程师，I want 在仪表盘中看到覆盖率趋势折线图（最近 N 个 merge session），so that 跟踪覆盖率进展
31. 作为 SoC 验证工程师，I want 仪表盘中包含紧凑树表格，so that 在同一页面看全局和模块详情
32. 作为 SoC 验证工程师，I want 仪表盘底部展示未覆盖项列表（按指标切换 tab），so that 精确定位未覆盖的文件/行号/信号
33. 作为 SoC 验证工程师，I want 仪表盘中有 AI 分析建议面板，so that 看到 AI 对覆盖 gap 的分析和建议
34. 作为 SoC 验证工程师，I want 在三个视图间自由切换（树表格/旭日图/仪表盘），so that 不同场景用不同视图

### AI 辅助覆盖率分析

35. 作为 SoC 验证工程师，I want AI Agent 调用 `get_coverage` 获取覆盖率摘要（总体 + 最差 N 个模块），so that AI 快速了解覆盖全局
36. 作为 SoC 验证工程师，I want AI Agent 调用 `get_coverage_detail(module)` 下钻到特定模块的详细覆盖率，so that AI 深入分析某个模块的覆盖 gap
37. 作为 SoC 验证工程师，I want AI Agent 通过 `cov://<session_id>` URI 读取覆盖率摘要树，so that AI 通过 URI scheme 也能获取覆盖率
38. 作为 SoC 验证工程师，I want AI Agent 通过 `cov://<session_id>/<module>` URI 读取模块详情，so that AI 能下钻到任意模块
39. 作为 SoC 验证工程师，I want AI Agent 通过 `cov://<session_id>/<module>/uncovered` URI 读取未覆盖项，so that AI 精确定位需要补测试的代码
40. 作为 SoC 验证工程师，I want AI Agent 识别覆盖 gap（哪些模块的哪些指标低于目标），so that AI 知道哪些地方需要补测试
41. 作为 SoC 验证工程师，I want AI Agent 对覆盖 gap 进行根因分类（missing_scenario/wrong_config/dead_code/sampling_issue/encoding_mismatch），so that AI 能给出针对性的修复建议
42. 作为 SoC 验证工程师，I want AI Agent 生成定向测试代码（SystemVerilog test + virtual sequence），so that AI 帮我补覆盖率
43. 作为 SoC 验证工程师，I want AI Agent 调用 `run_simulation` Host Tool 运行新生成的测试，so that AI 能验证测试是否有效
44. 作为 SoC 验证工程师，I want AI Agent 检查覆盖率 delta（运行前后对比），so that AI 知道测试是否真的提升了覆盖率
45. 作为 SoC 验证工程师，I want AI Agent 迭代覆盖收敛（每个 gap 最多 5 轮），so that 自动化地关闭覆盖 gap
46. 作为 SoC 验证工程师，I want AI Agent 在连续 2 轮 delta < 1% 时触发升级（转人工审查），so that 不在无法关闭的 gap 上浪费时间
47. 作为 SoC 验证工程师，I want AI Agent 识别 dead code 并标记为需要人工确认的 Coverage Exclusion，so that 不可达代码不会被错误地计入覆盖 gap
48. 作为 SoC 验证工程师，I want Coverage Exclusion 必须经过人工审批后才能排除，so that 不会错误地排除有效代码
49. 作为 SoC 验证工程师，I want 在 UI 中看到 AI 覆盖收敛的进度（当前处理哪个 gap、第几轮、delta 值），so that 了解 AI 的工作进展
50. 作为 SoC 验证工程师，I want 中止 AI 覆盖收敛过程，so that 打断无效的 AI 迭代

### 报告导出

51. 作为 SoC 验证工程师，I want 导出覆盖率报告为 HTML 格式（含树表格 + 图表），so that 与团队共享
52. 作为 SoC 验证工程师，I want 导出覆盖率报告为 JSON 格式（含原始结构化数据），so that 供其他工具消费
53. 作为 SoC 验证工程师，I want 选择导出路径，so that 报告保存到我需要的位置
54. 作为 SoC 验证工程师，I want 导出的报告包含覆盖率目标对比（达标/未达标标记），so that 团队能看到哪些指标不达标

### Coverage Closure 集成

55. 作为 SoC 验证工程师，I want coverage-closure 技能通过平台 Host Tools 获取覆盖率数据（而非自己运行 parse_coverage.py），so that 数据来源统一
56. 作为 SoC 验证工程师，I want coverage-closure 技能的 Sub-stage B（覆盖率结果分析）使用 `get_coverage` + `get_coverage_detail` 获取数据，so that AI 能识别 gap 并分类根因
57. 作为 SoC 验证工程师，I want coverage-closure 技能的 Sub-stage C（覆盖驱动测试生成）调用 `run_simulation` 执行测试并检查 delta，so that 全流程自动化
58. 作为 SoC 验证工程师，I want 在 AI 会话中触发 coverage-closure 工作流，so that 让 AI 帮我做覆盖收敛
59. 作为 SoC 验证工程师，I want coverage-closure 的输出（coverage_triage.json）保存到项目目录，so that 覆盖分析结果可追溯
60. 作为 SoC 验证工程师，I want 查看 coverage-closure 的迭代历史（每轮生成的测试、delta 值），so that 评估 AI 的覆盖收敛效果

## Implementation Decisions

### 数据模型重构

CoverageData 从扁平结构重构为层级树模型。以下类型定义来自 ADR 0007 原型：

```typescript
type CoverageMetric = 'line' | 'branch' | 'toggle' | 'condition' 
  | 'fsm_state' | 'fsm_transition' | 'functional' | 'assertion';

type CoverageTriplet = {
  percentage: number | null;
  covered: number | null;
  total: number | null;
};

type CoverageNode = {
  name: string;
  path: string;
  depth: number;
  metrics: Record<CoverageMetric, CoverageTriplet>;
  children: CoverageNode[];
};

type CoverageData = {
  sessionId: string;
  source: { covMergeDir: string; edaTool: string; reportGeneratedAt: number };
  root: CoverageNode;
  targets: Partial<Record<CoverageMetric, number>>;
  uncovered?: Record<CoverageMetric, Array<{ module: string; file?: string; line?: number; signal?: string; description: string }>>;
  metrics?: Record<string, number>;
};
```

- `CoverageMetric` 从 4 种扩展到 8 种，与 coverage-closure 技能的 7 种对齐，额外增加 assertion
- `CoverageTriplet` 替代单一百分比，支持 null 表示 N/A
- `CoverageNode` 替代扁平 bySubsys 数组，建模 parent/children 层级关系
- `CoverageData.sessionId` 替代 `runId`，反映 per-merge-session 生命周期
- `CoverageData.source` 记录数据来源（cov_merge 路径 + EDA 工具类型 + 生成时间）
- `CoverageData.targets` 存储配置的覆盖率目标
- `CoverageData.uncovered` 存储详细报告中的未覆盖项
- `CoverageData.metrics` 存储指标报告中的额外维度

### 插件接口变更

CoverageParserPlugin 接口从 `parse(projectRoot, runId)` 改为 `parse(projectRoot, sessionId, reportDir)`：
- 不再接收 runId，改为接收 sessionId 和文本报告目录路径
- 不再负责运行 EDA 命令，只负责解析已生成的文本报告
- 返回新的层级树 CoverageData

PluginBackedCoverage 适配器同步修改，`parse(runId)` 改为 `parse(sessionId, reportDir)`。

### 覆盖率报告生成器（新增模块）

新增"覆盖率报告生成器"模块（CoverageReportGenerator），负责 Coverage Preprocessing 第一步：
- 根据 EDA Tool Configuration 选择命令模板（imc/urg/vcover）
- 运行 EDA 命令生成三种文本报告（summary/detail/metrics）
- 报告输出到 `.socverify/coverage/<sessionId>/reports/` 目录
- 支持进度事件推送（正在运行 EDA 命令...）

### CoverageManager 重构

CoverageManager 从 per-runId 改为 per-sessionId：
- `getOrParse(sessionId)` 替代 `getOrParse(runId)`
- `listCachedRuns()` 改为 `listSessions()`
- `getTrend()` 从 session 序列加载趋势
- 新增 `importSession(covMergeDir)` — 触发报告生成 + 解析 + 缓存
- 新增 `getCoverageSummary(sessionId)` — 返回摘要 + 最差 N 模块（供 AI 消费）
- 新增 `getCoverageDetail(sessionId, modulePath)` — 返回指定模块及其子模块的覆盖率
- session 元信息存储在 `.socverify/coverage/sessions.json`
- 缓存的 CoverageData 存储在 `.socverify/coverage/<sessionId>.json`

### tRPC Router 变更

coverageRouter 重构：
- `getOverview` → `getSummary`：返回 8 种指标的总体 Coverage Triplet + 达标状态
- `getBySubsys` → `getTree`：返回完整 Coverage Tree
- `getDetail` → `getModuleDetail`：参数增加 `modulePath`，返回指定模块的详细覆盖率
- `listCachedRuns` → `listSessions`：返回 session 列表（含元信息）
- `getTrend`：改为基于 session 序列
- `getUncovered`：参数从 `type` 扩展为 `CoverageMetric`（8 种）
- `exportReport`：参数从 `runId` 改为 `sessionId`
- 新增 `importSession`：mutation，参数为 `{ projectId, covMergeDir }`，触发报告生成 + 解析 + 缓存
- 新增 `deleteSession`：mutation，删除指定 session 的缓存
- 新增 `getTargets` / `setTargets`：查询/设置项目覆盖率目标
- 新增 `getCoverageConfig` / `setCoverageConfig`：查询/设置 EDA Tool Configuration

### Host Tools 变更

- `get_coverage`：从返回全量 CoverageData 改为返回摘要 `{ sessionId, summary, worstModules, targets }`，worstModules 为覆盖率最低的 N 个模块
- 新增 `get_coverage_detail`：参数 `{ module: string }`，返回指定模块及其直接子模块的 Coverage Triplet
- `get_coverage` 的 `type` enum 从 4 种扩展为 8 种
- `runId` 参数改为 `sessionId`

### Host URI 变更

`cov://` URI handler 从空壳改为分层 URI scheme：
- `cov://<sessionId>` — 返回 Coverage Tree 摘要
- `cov://<sessionId>/<module>` — 返回模块详情
- `cov://<sessionId>/<module>/uncovered` — 返回未覆盖项

### UI 组件

现有 `CoveragePanel` 重构为三视图可切换布局：
- 新增 `CoverageTreeTable` 组件 — 可展开/折叠的模块树 + 8 列 Coverage Triplet + 颜色编码
- 新增 `CoverageSunburst` 组件 — SVG 旭日图 + 指标切换 tab + 详情面板
- 新增 `CoverageDashboard` 组件 — 概览卡片 + 趋势图 + 紧凑树表格 + 未覆盖项 + AI 建议面板
- 新增 `CoverageImportDialog` 组件 — 选择 cov_merge 目录 + EDA 工具 + 导入进度
- 新增 `CoverageSessionSelector` 组件 — session 下拉列表
- 新增 `CoverageTargetConfig` 组件 — 覆盖率目标配置表单
- `CoveragePanel` 改为容器组件，管理视图切换和 session 状态
- workbench destination `{ type: 'coverage' }` 保持不变

### Zustand Store 重构

coverage store 从扁平状态重构：
- `overview: CoverageSummary` → `summary: Record<CoverageMetric, CoverageTriplet>`
- `subsysCoverage: CoverageBySubsys[]` → `tree: CoverageNode`
- `currentRunId` → `currentSessionId`
- `cachedRuns` → `sessions: CoverageSessionInfo[]`
- 新增 `view: 'tree-table' | 'sunburst' | 'dashboard'`
- 新增 `targets: Partial<Record<CoverageMetric, number>>`
- 新增 `importSession`、`deleteSession`、`setView`、`loadTargets`、`saveTargets`

### EDA Tool Configuration

项目级配置存储在 `.socverify/coverage-config.json`：
- `edaTool`: 'imc' | 'vcs-urg' | 'vcover' | 'unknown'
- `covMergeDir`: 默认 cov_merge 路径
- `commandTemplates`: 各报告类型的命令模板（可自定义）
- 通过 settings router 的 `getCoverageConfig` / `setCoverageConfig` 读写

### Coverage Target 配置

内置行业默认目标（与 coverage-closure 技能对齐）：
- line: 95%, branch: 90%, toggle: 85%, condition: 85%
- fsm_state: 100%, fsm_transition: 90%, functional: 100%
- assertion: 无默认目标（null）

用户可在项目设置中覆盖。存储在 `.socverify/coverage-config.json` 的 `targets` 字段。

### coverage-closure 技能适配

coverage-closure 技能不再自己运行 `parse_coverage.py`，改为通过 Host Tools 获取结构化覆盖率数据：
- Sub-stage B（覆盖率结果分析）：AI 调用 `get_coverage` 获取摘要，调用 `get_coverage_detail(module)` 下钻，识别 gap 并分类根因
- Sub-stage C（覆盖驱动测试生成）：AI 生成测试代码，调用 `run_simulation` 执行，调用 `get_coverage` 检查 delta，迭代
- 输出的 `coverage_triage.json` 保存到项目 `docs/` 目录

## Testing Decisions

### 测试缝策略

采用 3 个测试缝，与现有项目测试模式对齐：

**缝 1：CoverageManager 级别（最高缝）**
- 测试 CoverageManager 配合 mock 覆盖率适配器，使用临时目录做缓存
- Mock 策略：mock CoverageParserPlugin（不实际解析文本报告）、mock 文件系统（临时目录）、mock EDA 命令执行
- 测试范围：session 管理、树解析、缓存、趋势、未覆盖项、导出、摘要生成、模块下钻
- 先例：`tests/simulation/simulation-manager.test.ts` 的 mock adapter + temp dir 模式

**缝 2：插件契约缝**
- 测试 CoverageParserPlugin 新接口合规性：`parse(projectRoot, sessionId, reportDir)` → 层级树 CoverageData
- 测试范围：接口合规性、错误处理、边界条件（空报告、格式错误的报告、N/A 值处理）
- 先例：`tests/host/host-tools-plugin.test.ts` 的 mock plugin 模式

**缝 3：UI 组件缝**
- React 组件测试，mock tRPC proxy
- 测试范围：树表格展开/折叠、旭日图点击交互、仪表盘视图切换、导入对话框交互、目标配置表单
- 先例：`tests/ui/simulation-run-store.test.ts` 的 mock store 模式

### 测试质量标准

- 好测试只验证外部行为（输入→输出），不验证内部实现
- 测试命名描述行为意图（"returns hierarchical tree when parsing IMC summary report" 而非 "test parse"）
- CoverageManager 覆盖率 > 80%
- UI 组件覆盖率 > 60%

## Out of Scope

- **coverage-closure 技能本身的修改**：技能文件在 `D:\doc\AI\SKILLS\coverage-closure`，不属于本仓库。平台只提供 Host Tools，技能适配由技能维护者完成
- **EDA 工具本身的功能开发**：imc/urg/vcover 是外部工具，平台只调用其命令行接口
- **覆盖率数据库 merge 操作**：merge 多个仿真运行的覆盖率数据库由用户在 EDA 工具中完成，平台只消费已 merge 的 cov_merge 目录
- **实时覆盖率监控**：不支持仿真过程中实时查看覆盖率变化（覆盖率只在仿真完成后通过 merge + report 生成）
- **多用户协作**：平台是单用户桌面应用，覆盖率配置和 session 不支持多用户共享
- **覆盖率 waiver 管理**：Coverage Exclusion 只做标记和人工审批，不做完整的 waiver 数据库管理

## Further Notes

### 架构决策记录

详细架构决策见以下 ADR：
- [ADR 0006](docs/adr/0006-coverage-preprocessing-pipeline.md) — Coverage Preprocessing Pipeline：平台生成 + 插件解析
- [ADR 0007](docs/adr/0007-coverage-data-model-hierarchical-tree.md) — Coverage Data Model：层级树 + Coverage Triplet
- [ADR 0008](docs/adr/0008-coverage-lifecycle-per-merge-session.md) — Coverage Lifecycle：per-merge-session
- [ADR 0009](docs/adr/0009-ai-coverage-full-closure.md) — AI Coverage Analysis：Full Closure + Summary-First

### 领域模型

覆盖率域术语定义见 [CONTEXT.md](CONTEXT.md) 的"覆盖率域"章节，包括：Coverage Merge Session、Coverage Report、Coverage Tree、Coverage Metric、Coverage Triplet、Coverage Target、Coverage Gap、Coverage Delta、Coverage Triage、Coverage Closure、Coverage Exclusion、Coverage Preprocessing、EDA Tool Configuration。

### HTML 原型

三视图 UI 原型见 `docs/prototypes/`：
- `coverage-index.html` — 索引页，三方案对比
- `coverage-tree-table.html` — 方案 A：树表格
- `coverage-sunburst.html` — 方案 B：旭日图 + 详情
- `coverage-dashboard.html` — 方案 C：仪表盘 + 下钻

### 与现有 PRD 的关系

本 PRD 是 [PRD: SoC Verify M2-M7](docs/prd-m2-m7.md) 中 Issue #15（覆盖率分析）和 Issue #16（覆盖率可视化与导出）的扩展和深化。原 PRD 的 acceptance criteria 在本 PRD 中被用户故事覆盖，但粒度更细、范围更广（增加了预处理流水线、EDA 工具配置、AI 全流程覆盖收敛）。

### 实现优先级建议

1. **Phase 1：数据模型 + 预处理** — CoverageData 重构、CoverageReportGenerator、CoverageManager 重构、CoverageParserPlugin 接口变更
2. **Phase 2：tRPC Router + Store** — coverage router 重构、coverage store 重构、EDA Tool Configuration API
3. **Phase 3：UI 视图** — 三视图组件、导入对话框、session 选择器、目标配置
4. **Phase 4：AI 集成** — Host Tools 重构、cov:// URI 实现、coverage-closure 技能适配
5. **Phase 5：报告导出 + 打磨** — HTML/JSON 导出、趋势图、AI 建议面板
