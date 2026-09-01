# PRD: Token Monitor — AI Agent Token 用量监控视图

> **Parent ADR**: [ADR 0031: Token Monitor 内嵌视图架构](../adr/0031-token-monitor-design.md)
>
> **Glossary**: [CONTEXT.md](../../CONTEXT.md) → Token 监控域
>
> **Reference Project**: [token-monitor](https://github.com/Javis603/token-monitor) — 代码复用参考，不引入 tokscale Rust 依赖
>
> **Triage label**: `ready-for-agent`

## Problem Statement

SoC Verify 的 AI Agent（omp/oh-my-pi 引擎）在验证工作中消耗大量 LLM token，但用户无法看到：

1. **无法了解 token 消耗全貌**：用户在 SoC Verify 中频繁使用 AI Agent 进行错误分析、覆盖率闭环、知识库索引等操作，每次 `message_end` 事件都携带 `usage` 数据（input/output/cacheRead/cacheWrite/totalTokens），但这些数据只在当前会话的 ContextUsageIndicator 中以"上下文窗口占用百分比"形式呈现。用户无法看到历史消耗趋势、按引擎/模型分解、或跨会话汇总。

2. **无法监控外部 AI 工具**：SoC 验证工程师在同一台机器上也使用 claude-code CLI 和 codex CLI 进行代码工作，这些工具的 token 消耗记录在各自的本地 JSONL 日志文件中（`~/.claude/projects/`、`~/.codex/sessions/`），但没有统一的面板查看汇总。

3. **缺乏成本可观测性**：用户不知道每天/每月在 AI 工具上花费了多少 token 和成本，无法判断是否需要优化 prompt 策略、调整模型选择或控制使用频率。

4. **缺乏使用习惯洞察**：用户无法看到 365 天的活动热力图、连续使用 streak、哪天用量最高、哪个模型用得最多等使用习惯洞察，无法发现优化空间。

5. **无会话级明细下钻**：用户无法查看某个 AI 会话的 per-request token 明细（每轮 LLM 调用的 input/output/cache 拆分），无法定位哪些请求消耗了最多 token。

## Solution

在 SoC Verify 中新增第六个一级视图「Token」（NavRail 图标），作为内嵌的 Token Monitor 面板，以混合数据源模式实时统计三类引擎的 token 用量，通过独立 SQLite 数据库存储 per-request 粒度记录，用 SQL 聚合查询驱动热力图、趋势图、引擎/模型分解和会话列表五个面板。

### 数据流概览

**实时事件流（omp / codex 引擎，SoC Verify 自驱动）**：
SessionManager 在事件转发路径中旁路拦截 `message_end` 事件，提取 assistant message 的 `usage` 字段（input/output/cacheRead/cacheWrite/totalTokens/cost），异步写入 Token Monitor DB。不阻塞事件转发到渲染进程。

**日志扫描流（claude-code CLI / codex CLI，外部独立使用）**：
ScanScheduler 以 5 分钟间隔定时扫描 `~/.claude/projects/**/*.jsonl` 和 `~/.codex/sessions/**/*.jsonl`，用 TypeScript 编写的 JSONL 解析器提取 assistant message 的 `usage` 字段。通过文件 mtime + byte offset 实现增量解析，`(engine, session_id, message_id)` 组合去重。

### 面板布局

Token 视图包含顶部时间范围选择器（全部/最近 7 天/最近 30 天）+ 五个标签页面板：

1. **概览 + 热力图**：统计行（今日 token / 本月 token / 总 token / 今日 cost）+ 365 天 GitHub 风格热力图 + 7 天趋势 sparkline
2. **趋势图**：按日堆叠柱状图（按引擎或模型分色），支持切换分色维度
3. **引擎分解**：三列卡片（omp / claude-code / codex），每列显示今日/本月/总 token、cost、占比饼图、cache hit/miss 细节
4. **模型分解**：表格（模型名 | 总 token | input/output/cache 拆分 | cost | 占比）+ 柱状图
5. **会话列表**：分页表格（会话 ID | 引擎 | 模型 | 开始时间 | 总 token | cost），点击展开 per-request 明细

## User Stories

### 后端 — 数据采集（实时事件拦截）

1. 作为 SoC 验证工程师，我希望 SoC Verify 在 AI Agent 每次完成 LLM 调用时自动记录 token 用量，这样我不需要手动操作就能积累统计数据。
2. 作为 SoC 验证工程师，我希望 token 用量记录包含引擎标识、会话 ID、模型名、input/output/cacheRead/cacheWrite/reasoning/totalTokens、成本和时间戳，这样我能从多个维度分析消耗。
3. 作为 SoC 验证工程师，我希望 token 用量记录包含工作目录信息，这样我能按项目/工作目录分组查看消耗。
4. 作为 SoC 验证工程师，我希望 token 拦截是旁路操作，不阻塞 AI 会话的事件流，这样 AI 交互延迟不受影响。
5. 作为 SoC 验证工程师，我希望 token 写入失败时只记录日志而不影响 AI 会话，这样监控功能不会成为系统的故障点。

### 后端 — 数据采集（外部日志扫描）

6. 作为 SoC 验证工程师，我希望 SoC Verify 能自动扫描我在同一台机器上使用 claude-code CLI 产生的 token 用量日志，这样我不需要在多个工具间手动汇总。
7. 作为 SoC 验证工程师，我希望 SoC Verify 能自动扫描我在同一台机器上使用 codex CLI 产生的 token 用量日志，这样 codex 的消耗也纳入统一统计。
8. 作为 SoC 验证工程师，我希望日志扫描以 5 分钟间隔定时执行，这样数据有少量延迟但基本实时。
9. 作为 SoC 验证工程师，我希望日志扫描通过文件 mtime 和 byte offset 实现增量解析，这样不会重复扫描已解析过的文件内容。
10. 作为 SoC 验证工程师，我希望同一条 LLM 调用记录不会被重复计数（通过 engine + session_id + message_id 组合去重），这样统计数据准确。
11. 作为 SoC 验证工程师，我希望日志扫描路径支持环境变量覆盖（`$CLAUDE_CONFIG_DIR`、`$CODEX_HOME`），这样自定义安装路径的 claude-code / codex 也能被发现。
12. 作为 SoC 验证工程师，我希望日志扫描器能在项目打开时触发一次即时扫描（如果距上次扫描超过 1 分钟），这样切换到 Token 视图时能看到最新数据。
13. 作为 SoC 验证工程师，我希望 Token 视图有手动刷新按钮，这样我可以随时触发一次日志扫描而不等待定时器。

### 后端 — tRPC API

14. 作为 SoC 验证工程师，我希望有 API 查询概览汇总（今日/本月/总 token + cost），这样概览面板能展示核心统计数字。
15. 作为 SoC 验证工程师，我希望有 API 查询 365 天热力图数据（按日聚合的 token 总量），这样热力图能以色深展示日用量。
16. 作为 SoC 验证工程师，我希望有 API 查询趋势图数据（按日聚合 + 按引擎/模型分组的 token 量），这样趋势图能展示堆叠柱状图。
17. 作为 SoC 验证工程师，我希望有 API 查询引擎分解数据（omp/claude-code/codex 三类的 token/cost/cache 细节），这样引擎分解面板能展示三列卡片。
18. 作为 SoC 验证工程师，我希望有 API 查询模型分解数据（按模型聚合的 token/cost），这样模型分解面板能展示表格和图表。
19. 作为 SoC 验证工程师，我希望有 API 分页查询会话列表（支持按引擎筛选 + 按时间/token/cost 排序），这样会话列表面板能高效浏览大量会话。
20. 作为 SoC 验证工程师，我希望有 API 查询单个会话的 per-request 明细，这样点击会话能展开看到每轮 LLM 调用的 token 拆分。
21. 作为 SoC 验证工程师，我希望所有查询 API 支持时间范围参数（全部/最近 7 天/最近 30 天），这样我能按时间窗口过滤数据。
22. 作为 SoC 验证工程师，我希望有 API 手动触发外部日志扫描，这样点击刷新按钮时后端能立即执行一次扫描。

### 前端 — 视图容器

23. 作为 SoC 验证工程师，我希望在 NavRail 中看到「Token」图标按钮，点击后切换到 Token 视图，这样我能从主导航快速进入 token 监控面板。
24. 作为 SoC 验证工程师，我希望 Token 视图顶部有时间范围选择器（全部/最近 7 天/最近 30 天），这样所有面板共享时间筛选。
25. 作为 SoC 验证工程师，我希望 Token 视图以标签页分区展示五个面板，这样我能聚焦关注某个维度而不被信息过载。
26. 作为 SoC 验证工程师，我希望 Token 视图有手动刷新按钮，这样我能随时触发日志扫描和数据刷新。

### 前端 — 概览 + 热力图面板

27. 作为 SoC 验证工程师，我希望概览面板展示今日 token、本月 token、总 token、今日 cost 四个统计行，这样我能快速了解核心数字。
28. 作为 SoC 验证工程师，我希望概览面板展示 365 天活动热力图（GitHub 风格，色深 = token 量），这样我能直观看到一年的使用频率。
29. 作为 SoC 验证工程师，我希望热力图鼠标悬停某天时显示该日的 token 数和 cost，这样我能看到具体数值。
30. 作为 SoC 验证工程师，我希望概览面板展示最近 7 天趋势 sparkline，这样我能快速感知近期变化趋势。
31. 作为 SoC 验证工程师，我希望概览面板展示连续使用天数（streak）和最长连续天数，这样我能了解自己的使用习惯。

### 前端 — 趋势图面板

32. 作为 SoC 验证工程师，我希望趋势图面板展示按日堆叠柱状图（按引擎分色：omp/claude-code/codex），这样我能看到三类引擎的日用量对比。
33. 作为 SoC 验证工程师，我希望趋势图面板支持切换为按模型分色，这样我能看到不同模型的用量分布。
34. 作为 SoC 验证工程师，我希望趋势图面板的时间轴与顶部时间范围选择器联动，这样选择 7 天就只看最近 7 天的趋势。

### 前端 — 引擎分解面板

35. 作为 SoC 验证工程师，我希望引擎分解面板展示三列卡片（omp / claude-code / codex），每列显示今日/本月/总 token 和 cost，这样我能对比三类引擎的消耗。
36. 作为 SoC 验证工程师，我希望每列卡片展示占比饼图，这样我能直观看到各引擎的消耗比例。
37. 作为 SoC 验证工程师，我希望点击某列卡片展开 cache hit/miss 细节（cacheRead / cacheWrite / output token 拆分 + cache 命中率），这样我能评估 prompt cache 效果。

### 前端 — 模型分解面板

38. 作为 SoC 验证工程师，我希望模型分解面板展示表格（模型名 | 总 token | input | output | cacheRead | cacheWrite | cost | 占比），这样我能精确看到每个模型的消耗。
39. 作为 SoC 验证工程师，我希望模型分解面板展示柱状图（按 token 量排序），这样我能直观看到哪个模型用得最多。
40. 作为 SoC 验证工程师，我希望模型分解表格支持按列排序，这样我能按 cost 或 token 降序排列找到最贵的模型。

### 前端 — 会话列表面板

41. 作为 SoC 验证工程师，我希望会话列表面板展示分页表格（会话 ID | 引擎 | 模型 | 开始时间 | 持续时间 | 总 token | cost），这样我能浏览所有 AI 会话的消耗。
42. 作为 SoC 验证工程师，我希望会话列表支持按引擎筛选，这样我能只看 omp 或只看 claude-code 的会话。
43. 作为 SoC 验证工程师，我希望会话列表支持按列排序（时间/token/cost），这样我能找到消耗最大的会话。
44. 作为 SoC 验证工程师，我希望点击某行会话展开 per-request 明细（每轮 LLM 调用的时间、模型、input/output/cache 拆分），这样我能下钻定位消耗最重的请求。
45. 作为 SoC 验证工程师，我希望会话列表分页加载（每页 50 条），这样大量会话时不卡顿。

### 前端 — 图表主题与样式

46. 作为 SoC 验证工程师，我希望 Token 视图的所有图表颜色与 SoC Verify UI 主题一致（从 CSS 变量动态构建 ECharts theme），这样切换主题时图表自动联动。
47. 作为 SoC 验证工程师，我希望三引擎在所有图表中有固定语义色（omp / claude-code / codex 各一种颜色），这样跨面板对比时颜色一致。

## Implementation Decisions

### 架构决策（详见 ADR 0031）

- **内嵌视图**：Token Monitor 作为 SoC Verify 第六个一级视图，NavRail 新增「Token」图标。不引入独立 Electron 窗口/进程。
- **混合数据源**：omp/codex 引擎通过 SessionManager 实时事件拦截获取 usage；claude-code CLI / codex CLI 通过定时日志扫描获取 usage。不引入 tokscale Rust 依赖，JSONL 解析用 TypeScript 重写。
- **独立 SQLite**：`.socverify/token-monitor.db`，使用 better-sqlite3（与 Case Database 和 Timing Violation DB 一致），per-request 粒度存储。
- **SessionManager 旁路拦截**：在 `attachEventForwarding` 中旁路处理 `message_end` 事件，不阻塞事件转发。
- **定时轮询 5 分钟 + 手动刷新**：不引入 chokidar 文件监听。
- **成本仅用引擎返回值**：使用 omp 的 `usage.cost.total` 和 codex 事件携带的成本，不维护定价表。

### 模块划分

**主进程新增模块（`src/main/token-monitor/`）：**

- `Token Usage Recorder`：从 SessionManager 旁路拦截 `message_end` 事件，提取 `usage` 字段写入 Token Monitor DB。不阻塞事件转发。写入失败仅记日志。
- `Token Monitor DB`：SQLite 连接管理 + 表初始化 + 聚合查询。WAL 模式。表 `token_usage` 以 `(engine, session_id, message_id)` 组合唯一索引去重。
- `Log Scanner`：定时扫描外部 AI 工具 JSONL 日志。5 分钟间隔。通过文件 mtime + byte offset 增量解析。
- `Claude Log Parser`：解析 `~/.claude/projects/**/*.jsonl`，提取 `role === 'assistant'` 行的 `message.usage` 字段。
- `Codex Log Parser`：解析 `~/.codex/sessions/**/*.jsonl`，提取 token 相关事件项。
- `Scan Scheduler`：5 分钟定时器 + 视图打开触发 + 手动刷新触发。

**主进程修改模块：**

- `SessionManager`：`attachEventForwarding` 中新增 `message_end` 旁路拦截，调用 `TokenUsageRecorder.recordUsage()`。
- `router.ts`：注册 `token: tokenRouter`。

**tRPC 新增模块（`src/main/ipc/routers/token-router.ts`）：**

procedures：
- `summary` — 概览汇总（今日/本月/总 token + cost）
- `heatmap` — 365 天按日聚合
- `trends` — 按日+引擎/模型聚合
- `engineBreakdown` — 引擎分解
- `modelBreakdown` — 模型分解
- `sessions` — 会话列表分页
- `sessionDetail` — 单会话 per-request 明细
- `scanExternalLogs` — 手动触发日志扫描（mutation）

**渲染进程新增模块（`src/renderer/src/components/views/token/`）：**

- `TokenView`：视图容器，标签页路由
- `TokenOverviewPanel`：概览 + 热力图
- `TokenTrendsPanel`：趋势图
- `TokenEnginePanel`：引擎分解
- `TokenModelPanel`：模型分解
- `TokenSessionListPanel`：会话列表

**渲染进程修改模块：**

- `ui.ts` store：`ActiveView` 类型新增 `'token'`。`VIEW_ITEMS` 数组新增 Token 导航项。
- `NavRail.tsx`：VIEW_ITEMS 新增 Token 按钮（图标：`Activity` 或 `Gauge`）。
- `ViewContainer.tsx`：`renderActiveView` 新增 `'token'` 分支。
- `CommandPalette.tsx`：导航组新增 Token 视图。

### Token Usage Record 统一数据格式

```typescript
type TokenUsageRecord = {
  engine: 'omp' | 'claude-code' | 'codex';
  sessionId: string;
  messageId: string;          // 去重键
  model: string;
  provider: string;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  reasoningTokens: number;
  totalTokens: number;
  costUsd: number;
  timestamp: number;           // ms epoch
  projectId: string;
  cwd: string;
}
```

### SQLite 表结构

```sql
CREATE TABLE IF NOT EXISTS token_usage (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  engine TEXT NOT NULL,
  session_id TEXT NOT NULL,
  message_id TEXT NOT NULL,
  model TEXT,
  provider TEXT,
  input_tokens INTEGER NOT NULL DEFAULT 0,
  output_tokens INTEGER NOT NULL DEFAULT 0,
  cache_read_tokens INTEGER NOT NULL DEFAULT 0,
  cache_write_tokens INTEGER NOT NULL DEFAULT 0,
  reasoning_tokens INTEGER NOT NULL DEFAULT 0,
  total_tokens INTEGER NOT NULL DEFAULT 0,
  cost_usd REAL NOT NULL DEFAULT 0,
  timestamp INTEGER NOT NULL,
  project_id TEXT,
  cwd TEXT,
  UNIQUE(engine, session_id, message_id)
);
CREATE INDEX IF NOT EXISTS idx_token_usage_timestamp ON token_usage(timestamp);
CREATE INDEX IF NOT EXISTS idx_token_usage_engine ON token_usage(engine);
CREATE INDEX IF NOT EXISTS idx_token_usage_session ON token_usage(session_id);
CREATE INDEX IF NOT EXISTS idx_token_usage_model ON token_usage(model);
```

### omp message_end 事件 usage 字段映射

omp 引擎的 `message_end` 事件 payload 中 `message.usage` 字段：

| omp usage 字段 | TokenUsageRecord 字段 |
|----------------|----------------------|
| `usage.input` | `inputTokens` |
| `usage.output` | `outputTokens` |
| `usage.cacheRead` | `cacheReadTokens` |
| `usage.cacheWrite` | `cacheWriteTokens` |
| `usage.reasoningTokens` | `reasoningTokens` |
| `usage.totalTokens` | `totalTokens` |
| `usage.cost.total` | `costUsd` |

### 日志扫描增量解析策略

对每个扫描过的 JSONL 文件，在 `scan_state` 表中记录 `{ file_path, last_mtime, byte_offset }`。下次扫描时：
1. 检查文件 mtime 是否变化，未变化则跳过。
2. mtime 变化则从 `byte_offset` 处开始读取新增内容。
3. 更新 `byte_offset` 为文件当前大小。
4. 文件不存在或大小缩小（截断）则重置 `byte_offset` 为 0。

### NavRail 快捷键调整

现有 Ctrl+1..4 覆盖四个视图（总览/仿真/回归/覆盖率），workspace 不占数字键位。Token 视图新增后，可分配 Ctrl+5 或不分配数字快捷键（与 workspace 一致）。

### 语义色定义

三引擎固定语义色（在 CSS 变量中定义，ECharts theme 引用）：
- omp → `--chart-omp`（primary 色系）
- claude-code → `--chart-claude`（orange 色系）
- codex → `--chart-codex`（teal 色系）

### 参考项目代码复用清单

以下 token-monitor 参考项目模块的逻辑可参考但不直接复制（JS→TS 迁移 + SoC Verify 适配）：

| 参考模块 | 复用价值 | 迁移目标 |
|---------|---------|---------|
| `src/shared/claudePaths.js` | claude-code 日志路径探测逻辑（`CLAUDE_CONFIG_DIR` 环境变量覆盖） | Claude Log Parser 路径解析 |
| `src/shared/sessionFiles.js` | 文件查找逻辑（递归 walk + session ID 匹配） | Log Scanner 文件发现 |
| `src/shared/history.js` | 热力图 intensity 计算、streak 计算、monthly rollup | 概览面板数据计算 |
| `src/shared/usage.js` | client name normalization（omp→pi 映射）、token field extraction | Token Usage Recorder 字段映射 |
| `src/shared/collector.js` | per-session/per-model/per-client 聚合逻辑 | tRPC 聚合查询参考 |

## Testing Decisions

### 测试原则

只测试外部行为，不测试实现细节。优先使用已有测试缝（seam），不新增不必要的测试基础设施。

### 测试缝

**缝 1：tRPC router 测试（最高缝）**

- 范围：`token-router.ts` 的所有 procedures
- 方式：`router.createCaller({})` server-side caller，Mock `requireProject` 返回固定项目路径，使用内存 SQLite 数据库
- 先例：`tests/dashboard-router.test.ts`
- 验证：
  - `summary` 返回正确的今日/本月/总聚合
  - `heatmap` 返回 365 天按日聚合
  - `trends` 返回按日+引擎/模型分组
  - `engineBreakdown` 返回三引擎分解
  - `modelBreakdown` 返回按模型聚合
  - `sessions` 返回分页列表
  - `sessionDetail` 返回 per-request 明细
  - `scanExternalLogs` mutation 可触发扫描

**缝 2：Token Usage Recorder 模块测试**

- 范围：`TokenUsageRecorder` 的 `message_end` 事件提取 + SQLite 写入
- 方式：Mock SessionManager 事件转发路径，构造 `message_end` 事件 payload，验证写入 DB 的记录正确
- 先例：`tests/session/session-manager.test.ts` 的 MockAgentClient 模式
- 验证：
  - 正确提取 assistant message 的 usage 字段
  - 旁路写入不阻塞事件转发
  - 写入失败不抛出异常
  - `(engine, session_id, message_id)` 去重

**缝 3：Log Scanner 模块测试**

- 范围：`ClaudeLogParser` 和 `CodexLogParser` 的 JSONL 解析
- 方式：使用 fixture JSONL 文件（模拟 claude-code 和 codex 的日志格式），验证解析出的 TokenUsageRecord 正确
- 先例：`tests/timing-violation/` 的日志解析测试模式
- 验证：
  - 正确解析 assistant message 的 usage 字段
  - 增量解析（byte offset 续读）
  - 去重逻辑
  - 环境变量路径覆盖

**缝 4：UI 组件测试**

- 范围：Token 视图的五个面板组件
- 方式：`@testing-library/react` + Mock tRPC proxy
- 先例：`tests/ui/` 目录下的组件测试模式
- 验证：
  - 概览面板展示统计行和热力图
  - 趋势图面板展示 ECharts 图表
  - 引擎分解面板展示三列卡片
  - 模型分解面板展示表格
  - 会话列表面板展示分页表格和展开明细

### 测试数据

- 使用内存 SQLite 数据库（`createMemoryDatabase()` 模式，与 dashboard-router.test.ts 一致）
- 构造 fixture JSONL 文件模拟 claude-code / codex 日志
- 构造 `message_end` 事件 payload 模拟 omp 事件

## Out of Scope

- **不引入 tokscale Rust 依赖**：JSONL 解析用 TypeScript 重写，不引入 native addon 或子进程调用。
- **不做多设备同步**：不实现 hub/agent/worker 模式，SoC Verify 是单用户桌面应用。
- **不做 AI Tool Limits 检测**：不检测 provider 的 session/daily/weekly/billing limits。
- **不做独立浮窗模式**：Token Monitor 仅作为内嵌视图，不提供独立窗口/浮窗。
- **不替代 ContextUsageIndicator**：上下文圈（当前会话上下文窗口占用）继续由 ContextUsageIndicator 负责，与 Token Monitor（历史消耗统计）职责分离。
- **不维护模型定价表**：成本仅使用引擎返回的 `usage.cost.total`，不自行估算。
- **不做多货币/汇率更新**：仅显示 USD。
- **不做数据导出**：本期不实现 CSV/JSON 导出功能。
- **不做 macOS 原生 Widget**：不实现桌面通知栏 widget。
- **不做 Discord Rich Presence**：不集成 Discord。
- **不做 WSL 使用量检测**：不实现 Windows WSL distro 的文件使用量合并。
- **不做 Codex 引擎实时事件**：CodexAgentClient 尚未实现（ADR 0028 待实施），本期仅支持 omp 实时事件 + claude-code/codex 日志扫描。待 ADR 0028 实现后再增加 codex 实时事件。

## Further Notes

### 与 ADR 0028（Codex 引擎集成）的关系

ADR 0028 计划引入 CodexAgentClient（IAgentClient 接口实现），实现后 Codex 引擎的 `message_end` 事件同样可通过 SessionManager 旁路拦截获取 usage。本期 Token Monitor 的 Token Usage Recorder 在设计上预留 codex 引擎的事件处理分支，但实际实现等 ADR 0028 完成后补充。在此之前，外部 codex CLI 的日志扫描已可覆盖 codex 引擎的 token 统计。

### 与 token-monitor 参考项目的代码复用策略

token-monitor 是 MIT 协议的开源项目，代码可合法复用。但由于以下原因不直接复制代码：

1. **语言差异**：token-monitor 是纯 JavaScript（CommonJS），SoC Verify 是 TypeScript strict（ESM 源码 → CJS 输出），需要迁移并加类型。
2. **架构差异**：token-monitor 是独立 Electron widget（主进程 + 渲染进程 + chokidar + tokscale），SoC Verify 是三进程模型（tRPC router + preload + React SPA），需要适配。
3. **tokscale 依赖**：token-monitor 依赖 tokscale（Rust 库），SoC Verify 不引入此依赖。
4. **功能范围**：token-monitor 支持 33+ 工具和多设备同步，SoC Verify 只需三类引擎且单设备。

复用策略：参考其解析逻辑和数据聚合算法，用 TypeScript 重写到 SoC Verify 架构中。

### NavRail 视图顺序

新增 Token 视图后的 NavRail 顺序：

| 位置 | 视图 | 快捷键 |
|------|------|--------|
| 1 | 总览 (dashboard) | Ctrl+1 |
| 2 | 仿真 (simulation) | Ctrl+2 |
| 3 | 回归 (regression) | Ctrl+3 |
| 4 | 覆盖率 (coverage) | Ctrl+4 |
| 5 | Token (token) | — |
| 6 | 工作区 (workspace) | — |

Token 视图不分配数字快捷键（与 workspace 一致），避免改动现有 Ctrl+1..4 的肌肉记忆。如需快捷键，可考虑 Ctrl+5。
