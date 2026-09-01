# Issues: Token Monitor — Tracer Bullet Vertical Slices

> **Parent PRD**: [docs/prd/prd-token-monitor.md](../prd/prd-token-monitor.md)
>
> 6 个垂直切片（tracer bullet），每个切片贯穿所有集成层（DB → tRPC API → 渲染端 UI → 测试），完成后可独立演示。
>
> Issues 按依赖顺序排列（blocker 在前）。

---

## Issue #1: DB 基础 + omp 实时事件拦截 + 概览面板（最小闭环）

### Parent

[PRD: Token Monitor](../prd/prd-token-monitor.md)

### What to build

建立 Token Monitor 的数据库基础和最小可用闭环。新建 Token Monitor DB（`.socverify/token-monitor.db`，better-sqlite3 + WAL 模式），`token_usage` 表以 `(engine, session_id, message_id)` 组合唯一索引去重。在 SessionManager 的 `attachEventForwarding` 中旁路拦截 `message_end` 事件，提取 assistant message 的 `usage` 字段（input/output/cacheRead/cacheWrite/reasoningTokens/totalTokens/cost.total），异步写入 Token Monitor DB。不阻塞事件转发到渲染进程，写入失败仅记日志。

在 NavRail 中新增「Token」图标按钮（第六个一级视图），ViewContainer 新增 `'token'` 视图分支，`ui.ts` store 的 `ActiveView` 类型新增 `'token'`。Token 视图顶部展示时间范围选择器（全部/最近 7 天/最近 30 天）。

概览面板展示四个统计行（今日 token / 本月 token / 总 token / 今日 cost），通过 tRPC `token.summary` procedure 查询。统计行数据来自 SQL 聚合（`SELECT SUM(total_tokens), SUM(cost_usd) FROM token_usage WHERE ...`）。

端到端路径：omp runner → AgentClient → SessionManager.attachEventForwarding 旁路拦截 message_end → TokenUsageRecorder.recordUsage() → SQLite 写入 → tRPC token.summary → 渲染端 TokenOverviewPanel 渲染统计行。NavRail 点击 Token → ViewContainer 渲染 TokenView → 加载概览面板。

### Acceptance criteria

- [ ] Token Monitor DB 在项目打开时自动初始化（`.socverify/token-monitor.db`），使用 better-sqlite3 + WAL 模式
- [ ] `token_usage` 表结构正确：包含 engine/session_id/message_id/model/provider/input_tokens/output_tokens/cache_read_tokens/cache_write_tokens/reasoning_tokens/total_tokens/cost_usd/timestamp/project_id/cwd 字段
- [ ] `(engine, session_id, message_id)` 组合唯一索引存在
- [ ] timestamp/engine/session_id/model 字段有索引
- [ ] SessionManager 的 `attachEventForwarding` 中旁路拦截 `message_end` 事件
- [ ] 正确提取 assistant message 的 `usage` 字段（input/output/cacheRead/cacheWrite/reasoningTokens/totalTokens/cost.total）
- [ ] 旁路写入不阻塞事件转发到渲染进程
- [ ] 写入失败仅记 console.warn 日志，不抛出异常
- [ ] 重复的 `(engine, session_id, message_id)` 记录通过 INSERT OR IGNORE 去重
- [ ] NavRail 新增「Token」图标按钮（lucide-react Activity 或 Gauge 图标）
- [ ] 点击 Token 图标切换到 Token 视图
- [ ] Token 视图顶部有时间范围选择器（全部/最近 7 天/最近 30 天）
- [ ] 概览面板展示四个统计行（今日 token / 本月 token / 总 token / 今日 cost）
- [ ] tRPC `token.summary` procedure 返回正确的聚合数据
- [ ] token-router 在主 router 中注册为 `token: tokenRouter`
- [ ] tRPC router 测试覆盖 summary 查询（内存 DB + 固定数据）
- [ ] Token Usage Recorder 模块测试覆盖 message_end 事件提取 + 去重
- [ ] UI 组件测试覆盖 NavRail Token 按钮 + 视图切换 + 概览面板渲染
- [ ] `npm run typecheck && npm run lint` 通过
- [ ] 相关测试目录通过 `npx vitest run`

### Blocked by

None — can start immediately.

---

## Issue #2: 趋势图 + 引擎分解面板

### Parent

[PRD: Token Monitor](../prd/prd-token-monitor.md)

### What to build

在 Issue #1 的基础上新增趋势图面板和引擎分解面板。趋势图面板展示按日堆叠柱状图（ECharts），支持按引擎分色（omp/claude-code/codex 三色）和按模型分色切换。引擎分解面板展示三列卡片（omp / claude-code / codex），每列显示今日/本月/总 token 和 cost、占比饼图。点击某列卡片展开 cache hit/miss 细节（cacheRead / cacheWrite / output token 拆分 + cache 命中率百分比）。

端到端路径：tRPC `token.trends` → SQL 按日+引擎/模型 GROUP BY 聚合 → ECharts 堆叠柱状图渲染。tRPC `token.engineBreakdown` → SQL 按引擎 GROUP BY 聚合 → 三列卡片渲染。

### Acceptance criteria

- [ ] 趋势图面板展示按日堆叠柱状图（ECharts）
- [ ] 支持按引擎分色（omp/claude-code/codex 三色）
- [ ] 支持切换为按模型分色
- [ ] 时间轴与顶部时间范围选择器联动
- [ ] 引擎分解面板展示三列卡片（omp / claude-code / codex）
- [ ] 每列显示今日/本月/总 token 和 cost
- [ ] 每列展示占比饼图
- [ ] 点击某列卡片展开 cache hit/miss 细节（cacheRead / cacheWrite / output + 命中率%）
- [ ] tRPC `token.trends` procedure 返回按日+引擎/模型聚合数据
- [ ] tRPC `token.engineBreakdown` procedure 返回三引擎分解数据
- [ ] ECharts 图表颜色从 CSS 变量动态构建（复用 Dashboard Theme 逻辑）
- [ ] tRPC router 测试覆盖 trends 和 engineBreakdown 查询
- [ ] UI 组件测试覆盖趋势图和引擎分解面板渲染
- [ ] `npm run typecheck && npm run lint` 通过
- [ ] 相关测试目录通过 `npx vitest run`

### Blocked by

- Issue #1

---

## Issue #3: 模型分解面板

### Parent

[PRD: Token Monitor](../prd/prd-token-monitor.md)

### What to build

新增模型分解面板，展示按模型聚合的 token 用量。表格列：模型名 | 总 token | input | output | cacheRead | cacheWrite | cost | 占比%。表格支持按列排序（点击列头切换升序/降序）。表格下方展示柱状图（按 token 量降序排列）。

端到端路径：tRPC `token.modelBreakdown` → SQL 按模型 GROUP BY 聚合 → 表格 + 柱状图渲染。

### Acceptance criteria

- [ ] 模型分解面板展示表格（模型名 | 总 token | input | output | cacheRead | cacheWrite | cost | 占比%）
- [ ] 表格支持按列排序（点击列头切换升序/降序）
- [ ] 表格下方展示柱状图（按 token 量降序）
- [ ] tRPC `token.modelBreakdown` procedure 返回按模型聚合数据
- [ ] tRPC router 测试覆盖 modelBreakdown 查询
- [ ] UI 组件测试覆盖模型分解面板渲染和排序交互
- [ ] `npm run typecheck && npm run lint` 通过
- [ ] 相关测试目录通过 `npx vitest run`

### Blocked by

- Issue #1

---

## Issue #4: 会话列表 + per-request 明细

### Parent

[PRD: Token Monitor](../prd/prd-token-monitor.md)

### What to build

新增会话列表面板。分页表格列：会话 ID | 引擎 | 模型 | 开始时间 | 持续时间 | 总 token | cost。支持按引擎筛选（下拉选择 omp/claude-code/codex/全部）。支持按列排序（时间/token/cost）。每页 50 条。点击某行会话展开 per-request 明细（每轮 LLM 调用的时间、模型、input/output/cacheRead/cacheWrite/totalTokens/cost 拆分行）。

端到端路径：tRPC `token.sessions` → SQL 分页 + 筛选 + 排序 → 表格渲染。点击行展开 → tRPC `token.sessionDetail` → SQL 按 session_id 查询所有 per-request 记录 → 明细行渲染。

### Acceptance criteria

- [ ] 会话列表面板展示分页表格（会话 ID | 引擎 | 模型 | 开始时间 | 持续时间 | 总 token | cost）
- [ ] 支持按引擎筛选（下拉选择 omp/claude-code/codex/全部）
- [ ] 支持按列排序（时间/token/cost，升序/降序）
- [ ] 每页 50 条，有分页控件
- [ ] 点击某行展开 per-request 明细（每轮 LLM 调用的时间、模型、input/output/cacheRead/cacheWrite/totalTokens/cost）
- [ ] tRPC `token.sessions` procedure 支持分页 + 引擎筛选 + 排序参数
- [ ] tRPC `token.sessionDetail` procedure 返回单会话所有 per-request 记录
- [ ] tRPC router 测试覆盖 sessions 和 sessionDetail 查询
- [ ] UI 组件测试覆盖会话列表渲染、分页、筛选、排序、展开明细
- [ ] `npm run typecheck && npm run lint` 通过
- [ ] 相关测试目录通过 `npx vitest run`

### Blocked by

- Issue #1

---

## Issue #5: 外部日志扫描（claude-code + codex CLI）

### Parent

[PRD: Token Monitor](../prd/prd-token-monitor.md)

### What to build

新增外部日志扫描能力，覆盖用户在本机独立使用的 claude-code CLI 和 codex CLI 的 token 用量。ScanScheduler 以 5 分钟间隔定时扫描 `~/.claude/projects/**/*.jsonl`（可通过 `$CLAUDE_CONFIG_DIR` 覆盖路径）和 `~/.codex/sessions/**/*.jsonl`（可通过 `$CODEX_HOME` 覆盖路径）。ClaudeLogParser 解析 JSONL，过滤 `role === 'assistant'` 行，提取 `message.usage` 字段。CodexLogParser 解析 codex 的 JSONL 日志格式。通过文件 mtime + byte offset 实现增量解析，`scan_state` 表记录每个文件的最后解析位置。`(engine, session_id, message_id)` 组合去重。

Token 视图新增手动刷新按钮，点击触发 tRPC `token.scanExternalLogs` mutation → ScanScheduler 立即执行一次扫描。视图打开时如距上次扫描超过 1 分钟也触发即时扫描。

端到端路径：ScanScheduler 5 分钟定时器 → ClaudeLogParser/CodexLogParser 解析 JSONL → TokenUsageRecorder 写入 DB（去重） → 下次查询时新增数据自动出现在所有面板中。手动刷新 → tRPC mutation → 即时扫描。

### Acceptance criteria

- [ ] ScanScheduler 以 5 分钟间隔定时扫描 claude-code 和 codex CLI 日志
- [ ] ClaudeLogParser 正确解析 `~/.claude/projects/**/*.jsonl` 的 assistant message usage 字段
- [ ] CodexLogParser 正确解析 `~/.codex/sessions/**/*.jsonl` 的 token 相关数据
- [ ] 路径探测支持环境变量覆盖（`$CLAUDE_CONFIG_DIR`、`$CODEX_HOME`）
- [ ] 增量解析：通过文件 mtime + byte offset 续读，`scan_state` 表记录每个文件位置
- [ ] 文件 mtime 未变化则跳过
- [ ] 文件不存在或大小缩小（截断）则重置 byte_offset 为 0
- [ ] `(engine, session_id, message_id)` 组合去重，不重复计数
- [ ] Token 视图有手动刷新按钮，点击触发即时扫描
- [ ] 视图打开时如距上次扫描超过 1 分钟，自动触发即时扫描
- [ ] tRPC `token.scanExternalLogs` mutation 可触发扫描
- [ ] 扫描结果自动出现在所有面板中（概览/趋势/引擎/模型/会话列表）
- [ ] Log Scanner 模块测试覆盖 claude-code 和 codex JSONL 解析（fixture 文件）
- [ ] Log Scanner 模块测试覆盖增量解析和去重
- [ ] Log Scanner 模块测试覆盖环境变量路径覆盖
- [ ] tRPC router 测试覆盖 scanExternalLogs mutation
- [ ] UI 组件测试覆盖刷新按钮交互
- [ ] `npm run typecheck && npm run lint` 通过
- [ ] 相关测试目录通过 `npx vitest run`

### Blocked by

- Issue #1

---

## Issue #6: 热力图完整化 + 刷新机制 + 主题色

### Parent

[PRD: Token Monitor](../prd/prd-token-monitor.md)

### What to build

完善概览面板的 365 天热力图（GitHub 风格，色深 = token 量），鼠标悬停某天显示该日 token 数和 cost。新增 7 天趋势 sparkline 和连续使用天数（streak）+ 最长连续天数。定义三引擎固定语义色 CSS 变量（`--chart-omp` / `--chart-claude` / `--chart-codex`），ECharts theme 引用这些变量。CommandPalette 导航组新增 Token 视图。

端到端路径：tRPC `token.heatmap` → SQL 365 天按日聚合 → 热力图渲染。tRPC `token.summary` 扩展返回 streak 数据。CSS 变量定义 → globals.css → ECharts theme 构建引用。

### Acceptance criteria

- [ ] 概览面板展示 365 天 GitHub 风格热力图（色深 = token 量）
- [ ] 热力图鼠标悬停某天显示该日 token 数和 cost tooltip
- [ ] 概览面板展示最近 7 天趋势 sparkline
- [ ] 概览面板展示连续使用天数（current streak）和最长连续天数（longest streak）
- [ ] tRPC `token.heatmap` procedure 返回 365 天按日聚合数据
- [ ] tRPC `token.summary` procedure 扩展返回 streak 数据
- [ ] 三引擎语义色 CSS 变量定义在 globals.css（`--chart-omp` / `--chart-claude` / `--chart-codex`）
- [ ] ECharts theme 构建逻辑引用三引擎语义色变量
- [ ] 三引擎在所有图表中有固定颜色（跨面板一致）
- [ ] CommandPalette 导航组新增 Token 视图项
- [ ] tRPC router 测试覆盖 heatmap 查询
- [ ] UI 组件测试覆盖热力图渲染、sparkline、tooltip
- [ ] `npm run typecheck && npm run lint` 通过
- [ ] 相关测试目录通过 `npx vitest run`

### Blocked by

- Issue #2
- Issue #5
