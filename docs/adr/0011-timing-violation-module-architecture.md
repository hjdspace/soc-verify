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

### 待实现（Phase 2 剩余 + Phase 3）

- `confirm/pattern-normalizer.ts` — Check 信息标准化（Issue #6）
- `confirm/pattern-matcher.ts` — 精确 + 模糊匹配（Issue #6）
- `pattern-router.ts` — Pattern CRUD + 导出导入 API（Issue #6, #9）
- `scanner/` — 回归目录扫描器（Issue #7）
- `export/` — 导出导入（Issue #9）
- `scan-router.ts` — 回归扫描 API（Issue #7）
