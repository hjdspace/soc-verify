# 时序违例功能垂直切片实现阶段

时序违例功能按垂直切片方式分 3 个阶段实现，每个阶段都产生可运行的功能，而非"后端完成但看不到结果"。这样每个 Agent session 都有明确的交付物。

**Phase 1 — 最小闭环**：单文件解析 → DB 存储 → 基本列表展示。包含数据库管理、单一解析器（Worker Thread）、单文件 tRPC API、前端 Dashboard 基本框架（统计卡片 + 虚拟滚动表格 + 分页查询）。

**Phase 2 — 完整确认流程**：自动确认（复位时间/区间）+ 手动确认（单条/批量）+ Pattern 匹配（精确/模糊）+ Pattern CRUD。包含确认 tRPC API、Pattern 管理 API、前端确认对话框、自动确认 UI。

**Phase 3 — 高级功能**：回归扫描 + 批量处理 + Dashboard 图表（Recharts 分布图）+ 导出（Excel/CSV/DB）+ AI 接口预留。包含回归扫描器、批量处理 API、图表组件、导出逻辑。

Considered options:
- 3 阶段按技术层分（DB+解析 → 确认+Pattern → Dashboard+导出）——Phase 1 结束后无可见结果。
- 2 阶段（后端全量 → 前端全量）——后端阶段太长，无法验证。
