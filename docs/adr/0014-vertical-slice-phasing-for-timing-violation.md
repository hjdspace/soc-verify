# 时序违例功能垂直切片实现阶段

时序违例功能按垂直切片方式分 3 个阶段实现，每个阶段都产生可运行的功能，而非"后端完成但看不到结果"。这样每个 Agent session 都有明确的交付物。

**Phase 1 — 最小闭环**：单文件解析 → DB 存储 → 基本列表展示。包含数据库管理、单一解析器（Worker Thread）、单文件 tRPC API、前端 Dashboard 基本框架（统计卡片 + 虚拟滚动表格 + 分页查询）。

**Phase 2 — 完整确认流程**：自动确认（复位时间/区间）+ 手动确认（单条/批量）+ Pattern 匹配（精确/模糊）+ Pattern CRUD。包含确认 tRPC API、Pattern 管理 API、前端确认对话框、自动确认 UI。

**Phase 3 — 高级功能**：回归扫描 + 批量处理 + Dashboard 图表（Recharts 分布图）+ 导出（Excel/CSV/DB）+ AI 接口预留。包含回归扫描器、批量处理 API、图表组件、导出逻辑。

Considered options:
- 3 阶段按技术层分（DB+解析 → 确认+Pattern → Dashboard+导出）——Phase 1 结束后无可见结果。
- 2 阶段（后端全量 → 前端全量）——后端阶段太长，无法验证。

## 实现状态

### Phase 1 — 最小闭环 ✅ 已完成

Issue #1（DB 基础 + 单文件解析 + 违例列表）和 Issue #2（筛选 + 排序 + 搜索 + 详情展开）已完整实现：

**端到端路径**：渲染端"选择文件"按钮 → tRPC `violation.pickFile` → 文件对话框 → tRPC `violation.parseLog` → 主进程 `readline` 流式解析 → `better-sqlite3` 批量插入 → `ensureConfirmationRecords` → tRPC `violation.queryViolations` 分页返回 → 渲染端虚拟滚动表格渲染。

**已交付功能**：
- 单文件解析（vio_summary.log 格式）
- 自动从文件路径推断 case_name / corner / seed / subsys
- FS/PS/NS 时间单位自动转换为飞秒
- 重复文件解析自动去重（INSERT OR IGNORE）
- 解析结果摘要（总数、新增数、跳过数）
- 统计卡片（总数/已确认/待确认/已忽略 + 按子系统/Corner/用例分布）
- 虚拟滚动违例列表表格（@tanstack/react-virtual）
- 表格列排序（time_fs / num / hier / created_at，升序/降序切换）
- 筛选栏（用例名/Corner/状态/子系统下拉 + 搜索框）
- 搜索防抖（300ms）
- 行展开查看违例详情（完整 Hier/Check/时间/文件路径/确认信息）
- 分页查询（默认 200 条/页）
- CenterArea "更多"菜单中注册"时序违例"入口
- 筛选/排序状态通过 Zustand store 管理，切换 Destination 后恢复

**验证**：`npm run build && npm run typecheck && npm run test` 全部通过。

### Phase 2 — 完整确认流程 ✅ 已完成

Issue #4（自动确认：复位时间 + 复位区间）、Issue #5（手动确认 + 批量确认 + Pattern 自动保存）和 Issue #6（Pattern 匹配 + Pattern CRUD）已完整实现：

**Issue #4 + #5 已交付功能**：
- 自动确认对话框（TVAutoConfirmDialog）：输入复位时间（纳秒）和/或复位区间（起止时间），支持 OR 关系
- 手动确认对话框（TVConfirmationDialog）：填写确认人、确认结果（pass/issue）、确认理由，支持单条和批量
- 违例表格行选择（checkbox）：支持多选、全选、清除选择
- 每行确认按钮：快速打开确认对话框
- 批量操作工具栏：批量确认、清除选择
- 确认后自动刷新表格和统计卡片
- Pattern 自动保存：每次手动确认后自动将 hier + check_info → confirmer + result + reason 保存到 violation_patterns 表
- Pattern match_count 累加：已存在的 Pattern 自动累加使用次数
- Corner 回退：指定 corner 未找到记录时回退到 default corner
- AI 预留接口：`confirmation.suggestConfirmation` 返回空结果骨架

**Issue #6 已交付功能**：
- Pattern 精确匹配（hier + check_info 完全相同）
- Pattern 模糊匹配（标准化 check_info 后比较，括号前必须匹配，括号内前两部分去冒号后内容匹配，第三部分忽略）
- 模糊匹配优先级低于精确匹配（先尝试精确，未命中再尝试模糊）
- 一键应用历史确认模式（`applyHistoricalConfirmations`）：自动匹配 Pattern 并应用确认结论
- Pattern 匹配 Corner 无关
- 匹配成功后 match_count 递增、last_used 更新
- Pattern 管理面板（TVPatternManager）：列表展示所有 Pattern（hier/check/确认人/结果/理由/使用次数/最后使用时间），支持搜索和清除
- tRPC API：`pattern.getPatterns` / `pattern.getPatternSuggestion` / `pattern.savePattern` / `pattern.clearAllPatterns` / `confirmation.applyHistoricalConfirmations`

**验证**：`npm run build && npm run typecheck && npm run test` 全部通过。

### Phase 3 — 高级功能 🔨 进行中（Issue #7 已完成）

Issue #7（回归扫描 + 批量处理）已完整实现：

**Issue #7 已交付功能**：
- 递归扫描回归目录，发现所有 vio_summary.log 文件
- 标准模式解析：`<case>_<corner>/<case>_<seed>/log/vio_summary.log` 提取完整元信息
- 通用模式解析：任意层级目录/<case>_<seed>/log/vio_summary.log
- 从路径中提取 subsys/corner/case/seed 元信息
- 检测用例 PASS/FAIL 状态（检查 sprd_log_pass.log 文件存在）
- 扫描结果按子系统、corner、用例、状态分组展示
- 分组视图中可勾选/取消勾选文件
- 一键选中/取消某子系统/corner 下的所有文件
- 显示每个文件的元信息（路径、大小、修改时间、用例状态）
- 批量处理选中的文件，逐个解析导入数据库
- 批量处理显示实时进度（当前文件/总文件数、当前违例数）
- Corner 列表和子系统识别规则从配置文件读取（`.socverify/timing-violation/config.json`）
- tRPC API：`scan.scanRegression` / `scan.batchProcess` / `scan.pickDirectory`

**验证**：`npm run build && npm run typecheck && npm run test` 全部通过。

### Issue #8 + #9 已实现（Phase 3 继续）

**Issue #8 已交付功能**：
- Recharts 分布图表组件（`TVDistributionCharts.tsx`）
- 按子系统分布的违例数量横向柱状图
- 按 Corner 分布的违例数量纵向柱状图
- 按用例分布的违例数量 Top 10 横向柱状图
- 状态分布饼图（已确认/待确认/已忽略）
- 图表可折叠（点击标题切换展开/折叠）
- 图表点击交互（点击柱/饼图扇区触发筛选）
- 图表在亮色和暗色主题下均可正常显示（使用 CSS 变量 + Tailwind 语义类名）

**Issue #9 已交付功能**：
- 违例数据导出为 Excel 文件（exceljs，含所有字段 + 确认信息）
- 违例数据导出为 CSV 文件（BOM + 逗号转义）
- 违例数据导出支持按 caseName/corner 筛选
- Pattern 导出为 Excel 文件
- Pattern 导出为 CSV 文件
- Pattern 导出为独立数据库文件（只含 violation_patterns 表）
- 从数据库文件导入 Pattern（合并模式，相同 Pattern 累加 match_count）
- 完整数据库合并（多 DB 合并 violations + confirmations + patterns）
- 数据库合并前自动备份
- 导出/导入下拉菜单集成在 TVDashboard 工具栏
- tRPC API：`violation.exportViolations` / `pattern.exportPatterns` / `pattern.importPatterns` / `pattern.mergeDatabases`

**验证**：`npm run build && npm run typecheck && npm run test` 全部通过。

### 待实现（Phase 3 剩余）

- 数据管理 + 配置 UI + AI 预留（Issue #10）
