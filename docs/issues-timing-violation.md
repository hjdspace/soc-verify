# Issues: 时序违例功能复刻 — Tracer Bullet Vertical Slices

> **Parent PRD**: [docs/prd-timing-violation.md](./prd-timing-violation.md)
>
> 10 个垂直切片（tracer bullet），每个切片贯穿所有集成层（DB → tRPC API → 渲染端 UI → 测试），完成后可独立演示。
>
> Issues 按依赖顺序排列（blocker 在前）。

---

## Issue #1: DB 基础 + 单文件解析 + 违例列表（最小闭环） ✅ 已完成

### Parent

[PRD: 后仿时序违例处理](./prd-timing-violation.md)

### What to build

建立时序违例功能的数据库基础和最小可用闭环。用户选择单个 `vio_summary.log` 文件，平台在 Worker Thread 中流式解析日志（`----` 分隔的 key-value 对，提取 NUM/Hier/Time/Check 四字段，时间单位自动转换为飞秒），解析结果通过 `better-sqlite3` 批量插入到 SQLite 数据库（3 张表：timing_violations / confirmation_records / violation_patterns，启用 WAL 模式 + PRAGMA 优化）。解析时自动从文件路径推断 case_name 和 corner 信息（参考 Python `parser.py` 中 `CaseInfoParser` 的逻辑），自动提取 seed，重复文件自动去重（INSERT OR IGNORE）。前端在 CenterArea 中注册新的 Workbench Destination（`timing-violation`），展示统计概览行 + 虚拟滚动违例列表表格，表格中每行显示 NUM、Hier、Time、Check 摘要、确认状态（颜色标记）。解析过程不冻结 UI，用户可看到解析进度和结果摘要（总数、新增数、跳过数）。

端到端路径：渲染端"选择文件"按钮 → tRPC `violation.parseLog` → 主进程启动 Worker Thread 流式解析 → 分批回传结果 → 主进程 `better-sqlite3` 批量插入 → tRPC `violation.queryViolations` 分页返回 → 渲染端虚拟滚动表格渲染。

### Acceptance criteria

- [x] 点击"选择文件"弹出文件选择对话框，选择 vio_summary.log 后自动解析
- [x] 解析过程不冻结 UI（采用 readline 流式解析替代 Worker Thread，详见 ADR-0013）
- [x] 解析时自动从文件路径推断 case_name、corner、seed 信息
- [x] 支持 FS/PS/NS 时间单位自动转换为飞秒（time_fs）
- [x] 重复文件解析时自动去重（INSERT OR IGNORE）
- [x] 解析完成后显示结果摘要（总数、新增数、跳过数）
- [ ] 解析进度实时反馈（已处理违例数 / 预估总数）— Phase 2 补充
- [x] 数据库使用 better-sqlite3 + WAL 模式 + PRAGMA 优化，3 张表结构正确
- [x] 数据库文件路径默认 `.socverify/timing-violation/tv.db`，可配置
- [x] CenterArea 中可打开 timing-violation Dashboard
- [x] Dashboard 展示统计概览行（总数、已确认、待确认）
- [x] 违例列表表格使用虚拟滚动（@tanstack/react-virtual），支持几十万条数据流畅滚动
- [x] 表格每行显示 NUM、Hier、Time、Check 摘要、确认状态（颜色标记）
- [x] tRPC API 有 `violation.parseLog` / `violation.queryViolations` / `violation.getStatistics` / `violation.getMetadata` procedure
- [x] tRPC router 在主 router 中注册
- [x] 解析器单测覆盖：标准日志格式、多行 Check、无效条目跳过、时间单位转换、空文件
- [x] tRPC 集成测试覆盖：单文件解析 → 查询验证 → 去重验证
- [x] UI 组件测试覆盖：Dashboard 渲染、表格虚拟滚动交互
- [x] `npm run build && npm run typecheck && npm run test` 全部通过

### Blocked by

None — can start immediately.

---

## Issue #2: 筛选 + 排序 + 搜索 + 详情展开 ✅ 已完成

### Parent

[PRD: 后仿时序违例处理](./prd-timing-violation.md)

### What to build

在 Issue #1 的违例列表表格基础上，添加筛选、排序、搜索和详情展开功能。用户可以按用例名、corner、状态（pending/confirmed/ignored）、子系统筛选违例列表；按时间戳、NUM、Hier 等字段排序（升序/降序）；在搜索框中输入关键字模糊搜索 Hier 或 Check 信息；点击表格行展开查看违例详情（完整 Hier、完整 Check 信息、时间显示、文件路径、确认信息）。筛选条件通过 tRPC 查询参数传递到后端，后端使用 SQL WHERE/ORDER BY 实现，避免前端全量过滤。

端到端路径：渲染端筛选栏交互 → tRPC `violation.queryViolations` 携带筛选/排序/搜索参数 → 主进程 SQL 查询 → 返回分页结果 → 渲染端表格更新。点击行展开 → 渲染端展示详情面板。

### Acceptance criteria

- [x] 筛选栏包含用例名下拉、corner 下拉、状态下拉、子系统下拉
- [x] 下拉选项从 `violation.getMetadata` API 动态获取
- [x] 支持按时间戳、NUM、Hier 字段排序，点击列头切换升序/降序
- [x] 搜索框输入关键字可模糊搜索 Hier 和 Check 信息（SQL LIKE）
- [x] 筛选/排序/搜索条件组合使用
- [x] 点击表格行展开显示完整违例详情（Hier、Check、时间、文件路径、确认状态/确认人/结果/理由）
- [x] 筛选状态通过 Zustand store 管理，切换 Destination 后恢复
- [x] tRPC `violation.queryViolations` 支持 caseName/corner/status/subsys/searchText/sortField/sortOrder 参数
- [x] tRPC 集成测试覆盖：筛选、排序、搜索组合查询
- [x] UI 组件测试覆盖：筛选栏交互、行展开
- [x] `npm run build && npm run typecheck && npm run test` 全部通过

### Blocked by

- Issue #1

---

## Issue #3: 统计卡片 + 元数据 API ✅ 已完成

### Parent

[PRD: 后仿时序违例处理](./prd-timing-violation.md)

### What to build

在 Dashboard 顶部添加统计卡片区域，展示总数、已确认数、待确认数、已忽略数四个卡片，每个卡片用不同颜色区分。统计信息通过 tRPC `violation.getStatistics` API 获取，支持按筛选条件（caseName/corner）聚合。同时完善 `violation.getMetadata` API，返回所有 corners、cases、subsys 列表用于筛选栏。数据库统计信息（总违例数、已确认数、待确认数、Pattern 数、用例数）通过 `violation.getDatabaseStats` API 暴露。

端到端路径：Dashboard 加载 → tRPC `violation.getStatistics` → 主进程 SQL COUNT 查询 → 返回统计 → 渲染端卡片渲染。筛选条件变化时统计卡片同步更新。

### Acceptance criteria

- [x] Dashboard 顶部展示 4 个统计卡片：总数、已确认、待确认、已忽略
- [x] 每个卡片用不同颜色区分（如绿色已确认、黄色待确认、灰色已忽略）
- [x] 统计数据支持按 caseName/corner 筛选聚合
- [x] 筛选条件变化时统计卡片同步更新
- [x] `violation.getMetadata` 返回 corners/cases/subsys 列表
- [x] `violation.getDatabaseStats` 返回数据库整体统计（总违例数、确认数、Pattern 数、用例数）
- [x] tRPC 集成测试覆盖：统计查询、元数据查询
- [x] UI 组件测试覆盖：卡片渲染、筛选联动
- [x] `npm run build && npm run typecheck && npm run test` 全部通过

### Blocked by

- Issue #1

---

## Issue #4: 自动确认（复位时间 + 复位区间） ✅ 已完成

### Parent

[PRD: 后仿时序违例处理](./prd-timing-violation.md)

### What to build

实现时序违例的自动确认功能。用户输入复位时间（纳秒），平台自动确认所有 time_fs ≤ reset_time_ns × 1000000 且 status='pending' 的违例。支持输入复位区间（起止时间），自动确认区间内的违例。支持同时使用复位时间和复位区间条件（OR 关系）。自动确认时如果指定 corner 未找到记录，回退到 `default` corner。自动确认的记录标记确认人为"系统自动"，附带原因说明（如"复位期间时序违例（<= 1000ns），可以忽略"）。确认后表格实时更新状态颜色。参考 Python `models.py` 中 `auto_confirm_by_reset_time` 和 `auto_confirm_by_reset_time_and_interval` 的逻辑。

端到端路径：渲染端输入复位时间/区间 → tRPC `confirmation.autoConfirmByResetTime` 或 `confirmation.autoConfirmByInterval` → 主进程 SQL UPDATE → 返回确认数量 → 渲染端刷新表格和统计。

### Acceptance criteria

- [x] 输入复位时间（纳秒）可自动确认该时间之前的 pending 违例
- [x] 输入复位区间（起止时间）可自动确认区间内的 pending 违例
- [x] 支持同时使用复位时间和复位区间（OR 关系）
- [x] 指定 corner 未找到记录时回退到 default corner
- [x] 自动确认记录的确认人标记为"系统自动"
- [x] 自动确认记录附带原因说明（含时间条件描述）
- [x] 自动确认后表格状态颜色实时更新
- [x] 自动确认后统计卡片同步更新
- [x] 返回确认数量供用户确认
- [x] tRPC API 有 `confirmation.autoConfirmByResetTime` / `confirmation.autoConfirmByInterval` procedure
- [x] tRPC 集成测试覆盖：复位时间确认、复位区间确认、corner 回退、已确认记录不重复确认
- [x] `npm run build && npm run typecheck && npm run test` 全部通过

### Blocked by

- Issue #1

---

## Issue #5: 手动确认 + 批量确认 ✅ 已完成

### Parent

[PRD: 后仿时序违例处理](./prd-timing-violation.md)

### What to build

实现时序违例的手动确认和批量确认功能。用户选中一条违例点击确认，弹出确认对话框填写确认人、确认结果（pass/issue）、确认理由。支持多选违例后批量确认（相同的确认人/结果/理由应用到所有选中违例）。支持编辑已确认的记录（修改确认人/结果/理由）。支持将违例标记为"忽略"（ignored 状态）。确认操作后表格实时更新状态颜色。每次手动确认后自动保存 Pattern（hier + check_info → confirmer + result + reason）到 violation_patterns 表，为 Issue #6 的 Pattern 匹配做准备。参考 Python `models.py` 中 `update_confirmation` / `batch_update_confirmations` / `save_pattern` 的逻辑。

端到端路径：渲染端选中违例 → 点击确认 → 确认对话框 → tRPC `confirmation.updateConfirmation` 或 `confirmation.batchUpdateConfirmations` → 主进程 SQL UPDATE + Pattern 保存 → 渲染端刷新表格。

### Acceptance criteria

- [x] 选中一条违例可弹出确认对话框
- [x] 确认对话框包含确认人、确认结果（pass/issue 下拉）、确认理由（文本框）
- [x] 支持多选违例后批量确认（相同确认人/结果/理由）
- [x] 支持编辑已确认记录的确认人/结果/理由
- [x] 支持将违例标记为"忽略"（ignored 状态）
- [x] 每次手动确认后自动保存 Pattern 到 violation_patterns 表
- [x] Pattern 保存时如果已存在相同 (hier_pattern, check_pattern) 则累加 match_count
- [x] 确认后表格状态颜色实时更新
- [x] 确认后统计卡片同步更新
- [x] tRPC API 有 `confirmation.updateConfirmation` / `confirmation.batchUpdateConfirmations` procedure
- [x] tRPC 集成测试覆盖：单条确认、批量确认、编辑确认、忽略、Pattern 自动保存
- [x] UI 组件测试覆盖：确认对话框交互、批量选择
- [x] `npm run build && npm run typecheck && npm run test` 全部通过

### Blocked by

- Issue #1

---

## Issue #6: Pattern 匹配 + Pattern CRUD ✅ 已完成

### Parent

[PRD: 后仿时序违例处理](./prd-timing-violation.md)

### What to build

实现历史 Violation Pattern 的匹配和管理功能。Pattern 匹配支持精确匹配（hier + check_info 完全相同）和模糊匹配（标准化 check_info 后比较）。模糊匹配的 Normalization 规则完全复刻 Python `models.py` 中 `_normalize_check_info` 的逻辑：括号前内容必须完全匹配；括号内按逗号分三部分，前两部分去除冒号后时间信息只匹配冒号前内容，第三部分完全忽略。用户可对新导入的违例一键应用历史确认模式，自动匹配 Pattern 并应用确认结论。Pattern 匹配时不依赖 corner（corner 无关）。前端提供 Pattern 管理面板，展示所有 Pattern 列表（hier/check/确认人/结果/理由/使用次数/最后使用时间），支持清除所有 Pattern。

端到端路径：渲染端"应用历史确认"按钮 → tRPC `confirmation.applyHistoricalConfirmations` → 主进程查询 Pattern → 精确匹配 → 模糊匹配 → SQL UPDATE → 返回应用数量 → 渲染端刷新。Pattern 管理 → tRPC `pattern.getPatterns` / `pattern.clearAllPatterns` → 渲染端列表展示。

### Acceptance criteria

- [x] Pattern 精确匹配：hier + check_info 完全相同
- [x] Pattern 模糊匹配：标准化 check_info 后比较（括号前匹配，括号内前两部分去冒号后内容匹配，第三部分忽略）
- [x] 模糊匹配优先级低于精确匹配（先尝试精确，未命中再尝试模糊）
- [x] 一键应用历史确认模式，自动匹配并应用确认结论
- [x] Pattern 匹配不依赖 corner（corner 无关）
- [x] 匹配成功后 Pattern 的 match_count 递增、last_used 更新
- [x] Pattern 管理面板展示所有 Pattern 列表
- [x] 支持清除所有 Pattern
- [x] tRPC API 有 `confirmation.applyHistoricalConfirmations` / `pattern.getPatterns` / `pattern.clearAllPatterns` / `pattern.getPatternSuggestion` procedure
- [x] Pattern Normalizer 单测覆盖：精确匹配、模糊匹配、各种 Check 格式、括号嵌套、无括号、多逗号
- [x] tRPC 集成测试覆盖：应用历史确认、Pattern 列表、清除
- [x] `npm run build && npm run typecheck && npm run test` 全部通过

### Blocked by

- Issue #5

---

## Issue #7: 回归扫描 + 批量处理 ✅ 已完成

### Parent

[PRD: 后仿时序违例处理](./prd-timing-violation.md)

### What to build

实现回归目录的递归扫描和批量处理功能。用户选择回归根目录，平台递归扫描目录树发现所有 `vio_summary.log` 文件。支持标准模式（`<case>_<corner>/<case>_<seed>/log/vio_summary.log`）和通用模式（任意层级目录/<case>_<seed>/log/vio_summary.log）两种目录结构解析。从路径中提取 subsys/corner/case/seed 元信息，检测用例 PASS/FAIL 状态（检查 `sprd_log_pass.log` 文件存在）。扫描结果按子系统、corner、用例、状态分组展示，用户可在分组视图中勾选/取消勾选文件，一键选中/取消某子系统/corner 下的所有文件。批量处理选中的文件，逐个解析并导入数据库，显示实时进度。Corner 列表和子系统识别规则从配置文件读取（`.socverify/timing-violation/config.json`），不硬编码。参考 Python `regression_scanner.py` 和 `regression_batch_manager.py` 的逻辑。

端到端路径：渲染端"扫描回归目录" → tRPC `scan.scanRegression` → 主进程递归扫描 → 解析路径 → 分组返回 → 渲染端分组展示 → 用户选择文件 → tRPC `scan.batchProcess` → 逐个解析导入 → 进度推送 → 渲染端进度展示。

### Acceptance criteria

- [x] 选择回归根目录后递归扫描发现所有 vio_summary.log 文件
- [x] 标准模式解析：`<case>_<corner>/<case>_<seed>/log/vio_summary.log` 提取完整元信息
- [x] 通用模式解析：任意层级目录/<case>_<seed>/log/vio_summary.log
- [x] 从路径中提取 subsys/corner/case/seed 元信息
- [x] 检测用例 PASS/FAIL 状态（检查 sprd_log_pass.log 文件存在）
- [x] 扫描结果按子系统、corner、用例、状态分组展示
- [x] 分组视图中可勾选/取消勾选文件
- [x] 一键选中/取消某子系统/corner 下的所有文件
- [x] 显示每个文件的元信息（路径、大小、修改时间、用例状态）
- [x] 批量处理选中的文件，逐个解析导入数据库
- [x] 批量处理显示实时进度（当前文件/总文件数、当前违例数）
- [x] Corner 列表从配置文件读取，不硬编码
- [x] 子系统识别规则从配置文件读取（如以 _sys 结尾或为 top）
- [x] tRPC API 有 `scan.scanRegression` / `scan.batchProcess` procedure
- [x] 扫描器单测覆盖：标准模式解析、通用模式解析、PASS/FAIL 检测、分组逻辑
- [x] tRPC 集成测试覆盖：扫描 → 选择 → 批量处理
- [x] `npm run build && npm run typecheck && npm run test` 全部通过

### Blocked by

- Issue #1

---

## Issue #8: 分布图表 Dashboard

### Parent

[PRD: 后仿时序违例处理](./prd-timing-violation.md)

### What to build

在 Dashboard 中添加分布图表区域，使用 Recharts 实现可视化展示。包含：按子系统分布的违例数量柱状图、按 corner 分布的违例数量图、按用例分布的违例数量图、状态分布饼图（已确认/待确认/已忽略）。图表数据通过 tRPC `violation.getStatistics` API 获取（扩展返回 bySubsys/byCorner/byCase 分布数据）。图表支持点击交互（如点击某个子系统柱状图筛选该子系统的违例）。参考 Python `summary_web/chart_data_converter.py` 的数据转换逻辑，但用 Recharts 替代 Chart.js。

端到端路径：Dashboard 加载 → tRPC `violation.getStatistics` 返回分布数据 → 渲染端 Recharts 图表渲染 → 用户点击图表 → 触发筛选 → 表格更新。

### Acceptance criteria

- [ ] 按子系统分布的违例数量柱状图（横向或纵向）
- [ ] 按 corner 分布的违例数量图
- [ ] 按用例分布的违例数量图（Top N 用例）
- [ ] 状态分布饼图（已确认/待确认/已忽略）
- [ ] 图表数据通过 tRPC `violation.getStatistics` 获取（扩展返回分布数据）
- [ ] 图表支持点击交互（点击柱/饼图扇区触发筛选）
- [ ] 图表使用 Recharts 实现，样式与 SoC Verify 主题一致
- [ ] 图表在亮色和暗色主题下均可正常显示
- [ ] tRPC 集成测试覆盖：分布数据查询
- [ ] UI 组件测试覆盖：图表渲染、点击交互
- [ ] `npm run build && npm run typecheck && npm run test` 全部通过

### Blocked by

- Issue #3

---

## Issue #9: 导出导入（Excel/CSV/DB）

### Parent

[PRD: 后仿时序违例处理](./prd-timing-violation.md)

### What to build

实现时序违例数据和 Pattern 的导出导入功能。违例数据导出为 Excel（使用 exceljs）和 CSV 文件，支持按 caseName/corner 筛选导出。Pattern 导出为 Excel、CSV 和独立数据库文件（只含 violation_patterns 表）。从导出的数据库文件导入 Pattern（合并模式，相同 Pattern 累加使用次数）。完整数据库合并（多 DB 合并为一个），合并前自动备份。导出导入过程显示进度。参考 Python `models.py` 中 `export_patterns_to_excel` / `export_patterns_to_csv` / `export_patterns_to_database` / `import_patterns_from_database` / `merge_databases` 的逻辑。

端到端路径：渲染端"导出"按钮 → 选择格式和路径 → tRPC `pattern.exportPatterns` 或 `violation.exportViolations` → 主进程生成文件 → 返回结果。渲染端"导入"按钮 → 选择文件 → tRPC `pattern.importPatterns` → 主进程读取并合并 → 返回导入数量。

### Acceptance criteria

- [ ] 违例数据导出为 Excel 文件（含所有字段 + 确认信息）
- [ ] 违例数据导出为 CSV 文件
- [ ] 违例数据导出支持按 caseName/corner 筛选
- [ ] Pattern 导出为 Excel 文件
- [ ] Pattern 导出为 CSV 文件
- [ ] Pattern 导出为独立数据库文件（只含 violation_patterns 表）
- [ ] 从数据库文件导入 Pattern（合并模式，相同 Pattern 累加 match_count）
- [ ] 完整数据库合并（多 DB 合并 violations + confirmations + patterns）
- [ ] 数据库合并前自动备份
- [ ] 导出导入过程显示进度
- [ ] tRPC API 有 `violation.exportViolations` / `pattern.exportPatterns` / `pattern.importPatterns` procedure
- [ ] tRPC 集成测试覆盖：各格式导出、Pattern 导入合并、DB 合并
- [ ] `npm run build && npm run typecheck && npm run test` 全部通过

### Blocked by

- Issue #1, Issue #6

---

## Issue #10: 数据管理 + 配置 + AI 预留

### Parent

[PRD: 后仿时序违例处理](./prd-timing-violation.md)

### What to build

实现数据管理操作、配置管理 UI 和 AI 辅助确认接口预留。数据管理：清除指定用例（可选指定 corner）的违例数据、批量更新用例 corner 信息。配置管理：在设置面板中提供时序违例配置 UI，包括数据库路径配置、Corner 列表编辑、子系统识别规则编辑、默认复位时间配置、自动备份开关。配置持久化到 `.socverify/timing-violation/config.json`。AI 预留：实现 `confirmation.suggestConfirmation` tRPC procedure 的接口骨架，接收 violationId 参数，当前返回空结果（`{ confirmer: undefined, result: undefined, reason: undefined, confidence: 0 }`），后续可接入 omp AI Agent 实现智能建议。参考 Python `configuration_manager.py` 的配置管理和 `auto_backup.py` 的备份逻辑。

端到端路径：设置面板 → 时序违例配置 → tRPC `settings.updateTvConfig` → 持久化到 config.json。数据管理 → tRPC `violation.clearCaseData` / `violation.updateCorner` → SQL DELETE/UPDATE → 刷新。AI 预留 → tRPC `confirmation.suggestConfirmation` → 返回空结果骨架。

### Acceptance criteria

- [ ] 清除指定用例的违例数据（含确认记录）
- [ ] 清除指定用例指定 corner 的数据
- [ ] 批量更新用例的 corner 信息
- [ ] 设置面板中有时序违例配置区域
- [ ] 可配置数据库路径
- [ ] 可编辑 Corner 列表（添加/删除/排序）
- [ ] 可编辑子系统识别规则
- [ ] 可配置默认复位时间
- [ ] 可启用/禁用自动备份
- [ ] 配置持久化到 `.socverify/timing-violation/config.json`
- [ ] `confirmation.suggestConfirmation` 接口存在且可调用，当前返回空结果骨架
- [ ] tRPC API 有 `violation.clearCaseData` / `violation.updateCorner` / `settings.updateTvConfig` / `settings.getTvConfig` / `confirmation.suggestConfirmation` procedure
- [ ] tRPC 集成测试覆盖：清除数据、更新 corner、配置读写、AI 接口骨架
- [ ] `npm run build && npm run typecheck && npm run test` 全部通过

### Blocked by

- Issue #1
