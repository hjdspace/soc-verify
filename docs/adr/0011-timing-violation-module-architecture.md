# Timing Violation 模块架构

时序违例功能作为主进程新模块 `src/main/timing-violation/` 实现，通过 tRPC router 暴露 API，而非作为插件系统的新 PluginKind。理由：日志解析格式（`vio_summary.log`）是通用的，不因 EDA 工具不同而变化；Corner 列表和目录结构约定是项目相关的，通过配置文件而非插件解决。

模块内按职责分层：`db/`（数据库）、`parser/`（解析器+Worker Thread）、`scanner/`（回归扫描）、`confirm/`（确认逻辑+Pattern 匹配）、`export/`（导出导入）。tRPC router 拆分为 `violation-router`、`confirmation-router`、`pattern-router`、`scan-router` 四个子 router。

前端在 CenterArea 中添加新的 Workbench Destination（`timing-violation`），组件按功能拆分 + 独立 Zustand store。

## 实现状态

### Issue #1 + #2（Phase 1）已实现

**主进程**：
- `src/main/timing-violation/types.ts` — 类型定义（ParsedViolation, ViolationWithConfirmation, QueryViolationsInput 等）
- `src/main/timing-violation/tv-config.ts` — 配置管理（Corner 列表、DB 路径、子系统识别规则）
- `src/main/timing-violation/db/tv-schema.ts` — Schema 定义（3 张表 + 索引）
- `src/main/timing-violation/db/tv-database.ts` — DB 初始化（WAL + PRAGMA 优化）
- `src/main/timing-violation/db/tv-repository.ts` — CRUD 操作（批量插入、分页查询、统计、元数据、清除）
- `src/main/timing-violation/parser/time-utils.ts` — 时间单位转换（FS/PS/NS → 飞秒）
- `src/main/timing-violation/parser/case-info-parser.ts` — 路径推断 case_name/corner/seed/subsys
- `src/main/timing-violation/parser/vio-parser.ts` — 流式日志解析器（readline + createReadStream）
- `src/main/timing-violation/parser/parser-worker.ts` — Worker Thread 入口（分批发送结果）
- `src/main/ipc/routers/violation-router.ts` — tRPC API（parseLog/queryViolations/getStatistics/getMetadata/getDatabaseStats/clearCaseData/pickFile）
- 在 `src/main/ipc/router.ts` 注册 `violation` 子 router

**渲染进程**：
- `src/renderer/src/stores/timing-violation.ts` — Zustand store（筛选/排序/搜索状态、数据加载、分页）
- `src/renderer/src/components/timing-violation/TVDashboard.tsx` — 主容器（文件选择 + 统计 + 表格）
- `src/renderer/src/components/timing-violation/TVStatsCards.tsx` — 统计卡片（总数/已确认/待确认/已忽略）
- `src/renderer/src/components/timing-violation/TVViolationTable.tsx` — 虚拟滚动表格（@tanstack/react-virtual + 排序 + 行展开）
- `src/renderer/src/components/timing-violation/TVFilterBar.tsx` — 筛选栏（用例/Corner/状态/子系统 + 搜索）
- `src/renderer/src/lib/tv-utils.ts` — 渲染端时间格式化工具
- 在 `src/renderer/src/stores/workbench.ts` 注册 `timing-violation` Destination
- 在 `src/renderer/src/components/layout/CenterArea.tsx` 集成 TVDashboard

**测试**：
- `tests/timing-violation/vio-parser.test.ts` — 32 个解析器单测（时间转换、路径推断、日志解析、多行 Check、去重）
- `tests/timing-violation/violation-router.test.ts` — 27 个 DB 集成测试（插入、去重、查询、筛选、排序、搜索、统计、元数据、清除、端到端）
- `tests/ui/tv-dashboard.test.tsx` — 11 个 UI 组件测试（统计卡片、筛选栏交互）
- `tests/ui/workbench-timing-violation.test.ts` — 3 个 workbench store 测试

### Issue #3 + #4 + #5（Phase 2 部分）已实现

**主进程**：
- `src/main/timing-violation/confirm/confirmation-manager.ts` — 确认逻辑（`autoConfirmByResetTime` / `autoConfirmByInterval` / `updateConfirmation` / `batchUpdateConfirmations` / `savePattern`）
- `src/main/ipc/routers/confirmation-router.ts` — tRPC API（autoConfirmByResetTime / autoConfirmByInterval / updateConfirmation / batchUpdateConfirmations / suggestConfirmation）
- `src/main/timing-violation/db/tv-repository.ts` — 新增 `getPatterns` / `clearAllPatterns` 函数
- 在 `src/main/ipc/router.ts` 注册 `confirmation` 子 router

**渲染进程**：
- `src/renderer/src/components/timing-violation/TVAutoConfirmDialog.tsx` — 自动确认对话框（复位时间 + 复位区间，OR 关系）
- `src/renderer/src/components/timing-violation/TVConfirmationDialog.tsx` — 手动确认对话框（确认人/结果/理由，支持单条和批量）
- `src/renderer/src/stores/timing-violation.ts` — 新增确认相关状态和 action（confirming / selectedViolationIds / showConfirmDialog / autoConfirmByResetTime / autoConfirmByInterval / updateConfirmation / batchUpdateConfirmations / toggleViolationSelection / selectAllViolations / clearSelection / openConfirmDialog / closeConfirmDialog）
- `src/renderer/src/components/timing-violation/TVDashboard.tsx` — 集成自动确认按钮、批量操作按钮
- `src/renderer/src/components/timing-violation/TVViolationTable.tsx` — 新增行选择 checkbox + 每行确认按钮

**测试**：
- `tests/timing-violation/confirmation-manager.test.ts` — 26 个确认逻辑单测（复位时间、复位区间、OR 条件、corner 回退、手动确认、批量确认、Pattern 保存、match_count 累加）
- `tests/timing-violation/violation-router.test.ts` — 新增 Pattern 管理测试（getPatterns / clearAllPatterns）
- `tests/ui/tv-dashboard.test.tsx` — 新增确认对话框和批量操作 UI 测试

### Issue #6（Phase 2 完成）已实现

**主进程**：
- `src/main/timing-violation/confirm/pattern-normalizer.ts` — Check 信息标准化（`normalizeCheckInfo`），完全复刻 Python `_normalize_check_info` 逻辑
- `src/main/timing-violation/confirm/pattern-matcher.ts` — 精确匹配（hier + check_info 完全相同）+ 模糊匹配（标准化后比较），Corner 无关
- `src/main/timing-violation/confirm/confirmation-manager.ts` — 新增 `applyHistoricalConfirmations`（一键应用历史确认，精确优先模糊其次）
- `src/main/ipc/routers/pattern-router.ts` — tRPC API（getPatterns / getPatternSuggestion / savePattern / clearAllPatterns）
- `src/main/ipc/routers/confirmation-router.ts` — 新增 `applyHistoricalConfirmations` procedure
- 在 `src/main/ipc/router.ts` 注册 `pattern` 子 router

**渲染进程**：
- `src/renderer/src/components/timing-violation/TVPatternManager.tsx` — Pattern 管理面板（列表展示 + 搜索 + 清除）
- `src/renderer/src/stores/timing-violation.ts` — 新增 Pattern 管理状态和 action（patterns / loadingPatterns / loadPatterns / clearAllPatterns / applyHistoricalConfirmations）
- `src/renderer/src/components/timing-violation/TVDashboard.tsx` — 集成"应用历史确认"按钮和"Pattern 管理"入口

**测试**：
- `tests/timing-violation/pattern-normalizer.test.ts` — 14 个标准化单测（标准格式、hold、前缀匹配、第三部分忽略、模糊匹配、无括号、少逗号、空串、无冒号、混合、多逗号、嵌套括号、Python 参考示例）
- `tests/timing-violation/pattern-matcher.test.ts` — 18 个匹配测试（精确匹配、模糊匹配、优先级、无匹配、前缀差异、hier 差异、corner 无关、建议、历史确认应用、fuzzy 应用、无 Pattern、无匹配违例、不重复确认、match_count 递增、last_used 更新、全 corner 应用、指定 corner 应用）

### Issue #7（Phase 3 部分）已实现

**主进程**：
- `src/main/timing-violation/scanner/path-parser.ts` — 路径解析器（`parseStandardStructure` / `parseFlexibleStructure`），提取 subsys/corner/case/seed
- `src/main/timing-violation/scanner/violation-scanner.ts` — 回归目录扫描器（`scanRegressionDirectory` 递归扫描 + 分组）+ 批量处理（`batchProcessFiles` 逐个解析导入 + 进度回调）
- `src/main/ipc/routers/scan-router.ts` — tRPC API（scanRegression / batchProcess / pickDirectory）
- 在 `src/main/ipc/router.ts` 注册 `scan` 子 router

**渲染进程**：
- `src/renderer/src/components/timing-violation/TVScanDialog.tsx` — 回归扫描对话框（目录选择 + 模式切换 + 分组列表 + 勾选 + 批量处理 + 进度展示）
- `src/renderer/src/stores/timing-violation.ts` — 新增扫描相关状态和 action（scanResult / scanning / batchProcessing / batchProgress / scanRegression / batchProcess）

**测试**：
- `tests/timing-violation/violation-scanner.test.ts` — 23 个扫描器测试（标准模式解析、通用模式解析、PASS/FAIL 检测、分组逻辑、批量处理、Corner 配置读取、子系统识别规则）

### Issue #10 已实现（Phase 3 完成）

**主进程**：
- `src/main/timing-violation/db/tv-repository.ts` — `updateCorner`（支持唯一键冲突自动去重）、`clearAllData`
- `src/main/ipc/routers/violation-router.ts` — `clearCaseData` / `clearAllData` / `updateCorner` / `parseLog`（使用 `parseLogStream` + IPC 进度推送）
- `src/main/ipc/routers/settings-router.ts` — `getTvConfig` / `updateTvConfig`（dbPath 变更时 `evictTvDb`）
- `src/main/ipc/routers/confirmation-router.ts` — `suggestConfirmation` AI 预留接口骨架
- `src/main/timing-violation/db/tv-db-cache.ts` — `evictTvDb` DB 连接缓存失效

**渲染进程**：
- `src/renderer/src/components/settings/SettingsPanel.tsx` — 时序违例配置 Tab（Corner 列表编辑、子系统规则、DB 路径、默认复位时间、自动备份开关）
- `src/renderer/src/components/timing-violation/TVDashboard.tsx` — 数据管理下拉菜单 + Corner 编辑对话框 + 解析进度指示器
- `src/renderer/src/stores/timing-violation.ts` — 配置/数据管理/进度状态和 Actions
- `src/preload/index.ts` — `onViolationParseProgress` IPC 事件监听

**测试**：
- `tests/timing-violation/tv-config.test.ts` — 12 个配置测试 + AI 接口骨架测试
- `tests/timing-violation/violation-router.test.ts` — `updateCorner` 测试（含唯一键冲突去重）

### 全部 10 个 Issue 已完成 ✅

### Issue #8 + #9 已实现

**主进程**：
- `src/main/timing-violation/export/tv-exporter.ts` — Excel/CSV 导出（违例数据 + Pattern）
- `src/main/timing-violation/export/tv-db-transfer.ts` — Pattern DB 导出导入 + 完整数据库合并
- `src/main/ipc/routers/violation-router.ts` — 新增 `exportViolations` procedure
- `src/main/ipc/routers/pattern-router.ts` — 新增 `exportPatterns` / `importPatterns` / `mergeDatabases` procedure

**渲染进程**：
- `src/renderer/src/components/timing-violation/TVDistributionCharts.tsx` — Recharts 分布图表（子系统柱状图 + Corner 柱状图 + 用例 Top10 + 状态饼图，可折叠，点击交互触发筛选）
- `src/renderer/src/components/timing-violation/TVDashboard.tsx` — 集成分布图表区域 + 导出/导入下拉菜单
- `src/renderer/src/stores/timing-violation.ts` — 新增导出/导入状态和 action（exporting / importing / exportViolations / exportPatterns / importPatterns / mergeDatabases）

**测试**：
- `tests/timing-violation/tv-exporter.test.ts` — 16 个导出导入测试（CSV 导出、Pattern CSV 导出、Pattern DB 导出、Pattern 导入合并、数据库合并、备份）
