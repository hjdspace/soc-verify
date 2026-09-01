# 0031 — Token Monitor 内嵌视图架构

## 背景

SoC Verify 需要监控 AI Agent 的 token 使用量，支持 omp/oh-my-pi、claude-code、codex 三类引擎的统计，包括热力图、趋势图、引擎/模型分解和会话列表。参考项目 [token-monitor](https://github.com/Javis603/token-monitor) 是一个独立的 Electron widget，通过 tokscale（Rust 库）扫描本地 AI 工具日志文件。

SoC Verify 的关键差异：自身就是 omp/codex 引擎的宿主，`message_end` 事件实时携带 `usage` 数据，不需要事后扫描日志即可获取 SoC Verify 驱动的引擎数据。对于外部独立使用的 claude-code CLI，仍需扫描 `~/.claude/projects/` 下的 JSONL 日志。

## 决策

### 1. 内嵌视图而非独立 widget

Token Monitor 作为 SoC Verify 的第六个一级视图（NavRail 新增「Token」图标），复用现有 Dashboard 基础设施（ECharts 主题系统、时间范围选择器）。不引入独立 Electron 窗口/进程。

**理由**：SoC Verify 是单用户桌面应用，不需要 token-monitor 的多设备同步能力。内嵌视图与 AI Agent 工作流在同一应用内，用户体验连贯。现有 Dashboard 的 ECharts 主题（从 CSS 变量动态构建）可直接复用。

### 2. 混合数据源：实时事件 + 日志扫描（不引入 tokscale）

- **omp 引擎**：SessionManager 旁路拦截 `message_end` 事件的 `usage` 字段，实时写入 SQLite。不扫描 `~/.omp/agent/sessions/`（避免与实时事件重复计数）。
- **codex 引擎（SoC Verify 驱动）**：CodexAgentClient 事件拦截（ADR 0028 实现后）。
- **claude-code CLI**：定时轮询 `~/.claude/projects/**/*.jsonl`，自写 TS 解析器提取 assistant message 的 `usage` 字段。
- **codex CLI**：定时轮询 `~/.codex/sessions/**/*.jsonl`。
- 去重：`(engine, session_id, message_id)` 组合唯一键。

**不引入 tokscale Rust 依赖**：tokscale 是 Rust 库，引入到 TS/Electron 项目需要 native addon 或子进程调用，增加构建复杂度。JSONL 解析不复杂，用 TS 重写更可控。

**被拒绝方案**：
- **引入 tokscale 子进程**：增加 Rust 编译/二进制管理，与 SoC Verify 的 TS-native 架构不一致。
- **纯实时事件**：无法覆盖外部独立使用的 claude-code CLI。
- **纯日志扫描**：SoC Verify 自驱动的 omp 数据有延迟且可能重复计数。

### 3. 独立 SQLite 数据库

`.socverify/token-monitor.db`，使用 better-sqlite3（与 Case Database 和 Timing Violation DB 一致）。per-request 粒度存储，每次 API 交互一行记录。独立于 `.socverify/cases.db`，关注点分离。

**被拒绝方案**：
- **复用 cases.db**：token 数据与 case/simulation 数据耦合，未来独立化困难。
- **JSON 文件**：不支持 SQL 聚合查询，热力图和趋势图需要全量加载+内存计算。

### 4. SessionManager 旁路拦截

在 `SessionManager.attachEventForwarding` 中新增 `message_end` 事件处理，提取 assistant message 的 `usage` 字段后异步调用 `TokenUsageRecorder.recordUsage()` 写入 SQLite。旁路设计——不阻塞事件转发到渲染进程，写入失败仅记日志。

**被拒绝方案**：
- **渲染进程拦截 + tRPC mutation**：增加 IPC 往返，渲染进程无文件系统直接访问权限。
- **AgentClient 拦截**：AgentClient 是通用通信层，不应有 token 监控领域逻辑。

### 5. 定时轮询（5 分钟）+ 手动刷新

日志扫描由 `ScanScheduler` 驱动：主进程 5 分钟定时器 + Token 视图打开时触发 + 手动刷新按钮。通过文件 mtime + byte offset 实现增量解析。

**不引入 chokidar**：5 分钟延迟对 token 统计可接受，省去文件监听的复杂度和性能开销。

### 6. tRPC 独立 router

新建 `src/main/ipc/routers/token-router.ts`，procedures：summary / heatmap / trends / engineBreakdown / modelBreakdown / sessions / sessionDetail / scanExternalLogs。在 `router.ts` 中注册为 `token: tokenRouter`。

### 7. 成本仅用引擎返回值

omp 的 `usage.cost.total` 和 codex 事件携带的成本。不维护模型定价表，不做成本估算。为 0 或不可用时显示 "—"。

### 8. 五面板视图布局

1. 概览+热力图（统计行 + 365 天 GitHub 风格热力图 + sparkline）
2. 趋势图（按日+引擎/模型堆叠柱状图）
3. 引擎分解（omp/claude-code/codex 三列卡片 + cache 细节）
4. 模型分解（表格 + 柱状图）
5. 会话列表（分页表格 + per-request 明细展开）

## 不做的事

- 不引入 tokscale Rust 依赖
- 不做多设备同步（hub/agent/worker）
- 不做 AI Tool Limits 检测
- 不做独立浮窗模式
- 不替代 ContextUsageIndicator（上下文圈）
- 不维护模型定价表
- 不做多货币/汇率更新
