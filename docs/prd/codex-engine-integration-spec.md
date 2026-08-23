# Codex App Server 引擎集成

## Problem Statement

SoC Verify 平台的 AI Agent 能力目前仅由 oh-my-pi (omp) 引擎驱动。用户希望在项目中引入 OpenAI Codex App Server 作为第二个可选 AI 引擎，实现引擎切换。用户需要能够根据场景选择不同引擎——例如 Codex 在代码推理和文件编辑方面有独特优势，而 omp 在自定义工具集成和 SoC 验证场景深度方面更强。当前架构中 AgentClient 直接绑定 omp 的自定义 JSONL 协议，无法在不大规模重构的前提下接入使用完全不同协议（JSON-RPC 2.0、Thread/Turn/Item 三层原语）的 Codex 引擎。

## Solution

引入 `IAgentClient` 接口抽象层，将引擎通信协议差异封装在接口实现内部。现有 `AgentClient` 重命名为 `OmpAgentClient` 并实现该接口；新增 `CodexAgentClient` 通过 JSON-RPC 2.0 over stdio 与 Codex App Server 子进程通信。用户在全局设置中选择 AI 引擎（omp / codex），所有新创建的会话使用选定引擎，已存在的会话保持原引擎。

Codex 的 Thread/Turn/Item 事件模型和审批请求通过现有的 `session:event` IPC 通道原样转发到渲染进程——事件 payload 中携带 `_engine` 标识字段用于路由。渲染进程的 session store 增加对 Codex 事件类型的处理分支。Host Tools 通过 Codex 实验性 dynamicTools 机制在 `thread/start` 时注册。会话持久化双轨制保持，Codex threadId 映射到现有的 `ompSessionId` 字段。

## User Stories

### 引擎切换

1. As a SoC 验证工程师, I want 在设置页选择 AI 引擎（omp 或 codex）, so that 我可以根据场景使用不同引擎
2. As a SoC 验证工程师, I want 切换引擎后新创建的会话使用新引擎, so that 切换立即生效
3. As a SoC 验证工程师, I want 已存在的会话保持原引擎不被中断, so that 我不会丢失正在进行的 AI 对话
4. As a SoC 验证工程师, I want 在 AI 会话面板看到当前使用的引擎标识, so that 我知道当前对话由哪个引擎驱动

### Codex 会话创建与交互

5. As a SoC 验证工程师, I want 使用 Codex 引擎创建新的 AI 会话, so that 我可以利用 Codex 的代码推理能力
6. As a SoC 验证工程师, I want 向 Codex 会话发送消息并收到流式回复, so that 我可以与 AI 进行交互式对话
7. As a SoC 验证工程师, I want 中断正在运行的 Codex Turn, so that 我可以停止不需要的 AI 操作
8. As a SoC 验证工程师, I want 向正在运行的 Codex Turn 追加输入（steer）, so that 我可以在不中断的情况下补充指令

### Codex 事件渲染

9. As a SoC 验证工程师, I want 在 AI 会话面板看到 Codex 的 agentMessage 流式文本, so that 我可以实时阅读 AI 的回复
10. As a SoC 验证工程师, I want 在 AI 会话面板看到 Codex 的 reasoning（推理）事件, so that 我可以理解 AI 的思考过程
11. As a SoC 验证工程师, I want 在 AI 会话面板看到 Codex 的 commandExecution 事件及其流式输出, so that 我可以知道 AI 执行了哪些命令并实时查看输出
12. As a SoC 验证工程师, I want 在 AI 会话面板看到 Codex 的 fileChange 事件, so that 我可以知道 AI 修改了哪些文件
13. As a SoC 验证工程师, I want 看到 Turn 的开始和结束状态（含 cancelled / failed 终态）, so that 我知道 AI 何时完成一轮工作
14. As a SoC 验证工程师, I want 看到 Codex Thread 状态变更（idle / active / systemError）, so that 我知道会话的整体健康状态

### 审批

15. As a SoC 验证工程师, I want 当 Codex 要执行 shell 命令时收到审批请求, so that 我可以控制 AI 的命令执行权限
16. As a SoC 验证工程师, I want 当 Codex 要修改文件时收到审批请求, so that 我可以审查 AI 的文件改动
17. As a SoC 验证工程师, I want 在审批 UI 中选择 accept / decline / cancel / acceptForSession, so that 我可以灵活控制审批粒度
18. As a SoC 验证工程师, I want acceptForSession 后整个 Thread 期间同类操作自动批准, so that 我不需要反复审批同类操作
19. As a SoC 验证工程师, I want 使用现有的审批模式（always-ask / write / yolo）控制 Codex 引擎的审批行为, so that 我不需要学习新的审批配置

### Host Tools 集成

20. As a SoC 验证工程师, I want Codex 引擎也能调用 get_subsystems 工具, so that AI 能发现项目子系统
21. As a SoC 验证工程师, I want Codex 引擎也能调用 run_simulation 工具, so that AI 能执行仿真
22. As a SoC 验证工程师, I want Codex 引擎也能调用 get_coverage 工具, so that AI 能分析覆盖率
23. As a SoC 验证工程师, I want Codex 引擎也能调用 create_docx / create_xlsx 等文档工具, so that AI 能创建验证文档
24. As a SoC 验证工程师, I want Codex 引擎也能调用 kb_search 工具, so that AI 能检索知识库
25. As a SoC 验证工程师, I want Codex 引擎也能使用 ask 工具向我提问, so that AI 可以在需要时请求澄清

### 会话持久化与恢复

26. As a SoC 验证工程师, I want Codex 会话历史被持久化, so that 关闭应用后可以恢复对话
27. As a SoC 验证工程师, I want 恢复 Codex 会话时使用 thread/resume, so that AI 记住之前的对话上下文
28. As a SoC 验证工程师, I want 当 Codex thread 恢复失败时回退到 UI 存储的消息历史, so that 不会因为 Codex sessions 目录被清理而丢失对话
29. As a SoC 验证工程师, I want 持久化会话记录引擎类型, so that 恢复时能正确选择 omp 或 Codex 引擎

### 二进制管理

30. As a 开发者, I want Codex CLI 二进制通过 postinstall 脚本自动下载（支持 Windows/macOS/Linux 多平台）, so that 我不需要手动安装
31. As a 开发者, I want Codex 版本通过 package.json 锁定, so that 所有开发者使用相同版本
32. As a 开发者, I want Codex 类型定义通过 generate-ts 自动生成, so that 我有类型安全的 JSON-RPC 调用
33. As a 开发者, I want 升级 Codex 版本时只需改 package.json 并重新下载, so that 升级流程简单清晰

### 错误处理

34. As a SoC 验证工程师, I want 当 Codex 二进制未安装时报错提示, so that 我知道需要安装 Codex
35. As a SoC 验证工程师, I want 当 Codex App Server 启动失败时有明确错误信息（含 stderr 诊断）, so that 我可以排查问题
36. As a SoC 验证工程师, I want Codex 会话出错时不会影响其他 omp 会话, so that 引擎故障是隔离的
37. As a SoC 验证工程师, I want 当 Codex 服务器过载（JSON-RPC -32001）时自动重试, so that 瞬时过载不会导致会话失败

## Implementation Decisions

### 架构决策（ADR 0028）

详见 `docs/adr/0028-codex-engine-integration.md`。以下为关键要点摘要。

### 1. 引擎抽象层：IAgentClient 接口

提取 `IAgentClient` 接口，定义引擎客户端的统一契约。接口方法包括 `start()` / `stop()` / `init(config)` / `prompt(message, images?)` / `steer(message)` / `abort()` / `setModel(provider, modelId)` / `setApprovalMode(mode)` / `setToolFilter(disabledTools)` / `listAgentTools()` / `getMessages()` / `getState()` / `compact()` / `getMcpStatus()` / `getMcpServerTools(serverName)` / `reloadMcp()` / `destroy()` / `onEvent(listener)` / `setToolCallHandler(handler)` / `setApprovalHandler(handler)` / `sendApprovalResponse(requestId, approved)` / `isRunning()` / `getStderr()`。

`OmpAgentClient`（现有 AgentClient 重命名）和 `CodexAgentClient` 分别实现此接口。SessionManager 依赖 `IAgentClient` 而非具体实现。

### 2. AgentClient 工厂

`SessionManager.createSession()` 中根据全局引擎设置创建对应的 `IAgentClient` 实现。工厂逻辑封装在 `createAgentClient(options)` 函数中，读取引擎设置后选择创建 `OmpAgentClient` 或 `CodexAgentClient`。

### 3. Codex JSON-RPC 客户端

`CodexAgentClient` 内部实现 JSON-RPC 2.0 over stdio 协议：
- spawn `codex app-server --stdio` 子进程（单进程单 Thread 模型——每个 Codex 会话独占一个 App Server 进程，与 omp 模型对齐）
- `initialize` 握手（含 `clientInfo` 和 `capabilities.experimentalApi = true`）
- `initialized` 确认通知
- `thread/start` 创建会话（映射到 `init()`）
- `turn/start` 发送用户输入（映射到 `prompt()`）
- `turn/steer` 追加输入（映射到 `steer()`）
- `turn/interrupt` 中断（映射到 `abort()`）
- `thread/resume` 恢复会话
- 事件转发：将 Codex 的 `turn/*`、`item/*` 通知原样转发到 `onEvent` 监听器，并添加 `_engine: 'codex'` 标识字段
- 审批请求：将 `execCommandApproval` / `applyPatchApproval` 等 server-to-client 请求转发到 `approvalHandler`，等待用户响应后回复 JSON-RPC result
- `serverRequest/resolved` 通知：Codex 确认审批请求已关闭的通知，CodexAgentClient 吸收此事件（log + 清理内部 pending 审批状态），不转发到渲染进程
- JSON-RPC 错误处理：`-32001`（服务器过载）指数退避重试（最多 3 次，间隔 1s/2s/4s）；其他错误码（`-32600` / `-32601` / `-32602`）直接抛出给调用方
- stderr 缓冲：与 omp AgentClient 一致，缓冲最后 10KB stderr 输出，实时输出到 console
- `acceptForSession` 状态管理：CodexAgentClient 维护一个 `Set<string>` 记录已 acceptForSession 的审批类型，后续同类审批请求自动批准

### 4. 事件路由：引擎标识

CodexAgentClient 转发的每个事件 payload 中携带 `_engine: 'codex'` 字段。omp 事件不添加此字段（渲染进程默认视为 omp）。渲染进程的 `handleSessionEvent` 首先检查 `_engine` 字段，如果是 `'codex'` 则路由到 Codex 事件处理分支（处理 `item/started`、`item/completed`、`item/agentMessage/delta`、`item/reasoning/*`、`item/commandExecution/outputDelta`、`turn/started`、`turn/completed`、`turn/cancelled`、`turn/failed`、`thread/status/changed` 等），否则走现有 omp 事件路径。

Codex 事件类型完整清单：

| 事件 | 处理方式 |
|------|----------|
| `thread/started` | 会话创建确认，更新 session store 状态 |
| `thread/status/changed` | Thread 状态变更（idle/active/systemError），更新 session store status |
| `turn/started` | Turn 开始，标记会话为 streaming |
| `turn/completed` | Turn 正常完成，标记会话为 idle |
| `turn/cancelled` | Turn 被用户中断，标记会话为 idle 并显示中断提示 |
| `turn/failed` | Turn 执行失败，标记会话为 error 并显示错误信息 |
| `item/started` | 新 Item 开始（userMessage/agentMessage/commandExecution/fileChange/reasoning），创建对应消息条目 |
| `item/completed` | Item 完成，标记消息完成（含 exitCode / error 等终态信息） |
| `item/agentMessage/delta` | 流式文本追加到当前 assistant 消息（走节流路径，同 omp message_update） |
| `item/reasoning/summaryTextDelta` | 推理文本流式追加，渲染为 thinking block |
| `item/commandExecution/outputDelta` | 命令流式输出（stdout/stderr），实时更新 tool card 输出区域 |
| `item/fileChange/requestApproval` | 文件修改审批请求，转发到审批 UI |
| `item/commandExecution/requestApproval` | 命令执行审批请求，转发到审批 UI |
| `serverRequest/resolved` | 审批请求已关闭确认，CodexAgentClient 吸收（不转发到渲染进程） |

### 5. Host Tools 注册：dynamicTools

在 `thread/start` 时将 HostToolsRegistry 的工具定义转换为 Codex dynamicTools 格式并注册。需要 `capabilities.experimentalApi = true`。工具回调的确切 JSON-RPC 方法名需在实施时通过 `generate-ts` 生成的类型确认——优先使用 dynamicTools 的回调机制。CodexAgentClient 将工具调用请求转发到 `HostToolsRegistry.handleToolCall()` 执行，结果转换回 Codex 格式返回。Host Tools 的审批在工具回调中自行实现（不在 Codex 内置审批范围内）。

**前置验证步骤**：在实施前，通过 `generate-ts` 生成的类型确认 dynamicTools 的 schema 格式和回调方法名，避免基于猜测实现。

### 6. 会话持久化

PersistedSession 结构新增 `engine?: 'omp' | 'codex'` 字段（默认 `'omp'` 以兼容旧数据）。Codex 的 threadId 存储在 `ompSessionId` 字段（字段含义从「omp session ID」扩展为「引擎 session ID」）。恢复时根据 `engine` 字段选择创建对应的 `IAgentClient` 实现，优先调用 `thread/resume(threadId)`，失败时回退到 UI 存储消息重建上下文（通过 `turn/start` 带初始消息）。

### 7. 审批模式映射

| omp 审批模式 | Codex approvalPolicy | Codex sandbox |
|---|---|---|
| `always-ask` | `always` | `workspace-write` |
| `write` | `unlessTrusted` | `workspace-write` |
| `yolo` | `never` | `danger-full-access` |

`acceptForSession` 作用域为 **Thread 级别**（整个会话期间同类操作自动批准），而非 Turn 级别。CodexAgentClient 维护一个 `Set<string>` 记录已 acceptForSession 的审批类型，后续同类审批请求自动批准，无需再次转发到渲染进程。

### 8. Codex 二进制管理

新增 `scripts/download-codex.mjs` 下载脚本，从 Codex GitHub Release 下载预编译二进制到 `resources/binaries/`。支持目标平台：Windows x64（`codex-x86_64-pc-windows-msvc.exe`）、macOS ARM/Intel、Linux x64。`package.json` 新增 `codexVersion` 字段。postinstall 中调用下载脚本。下载失败不阻断构建，运行时报错提示。路径解析逻辑在 `codex-paths.ts` 中实现，模式与 `paths.ts` 一致（packaged binaries → dev resources/binaries）。

### 9. 类型定义生成

postinstall 下载 Codex 二进制后，运行 `codex app-server generate-ts --out src/main/agent/codex-types/` 生成 TypeScript 类型。生成的类型提交到仓库。升级 Codex 版本时重新生成。

### 10. 全局引擎设置

在设置页新增「AI 引擎」选择项，存储到应用全局设置（localStorage 或 settings 文件）。`session-context-factory` 的 `createSessionContext()` 读取此设置，通过工厂函数创建对应的 `IAgentClient` 实现。

## Testing Decisions

### 测试接缝

**最高接缝：`IAgentClient` 接口**——一个接缝覆盖整个引擎层。

现有 `tests/session/session-manager.test.ts` 已经使用 `MockAgentClient`（继承 EventEmitter，模拟 AgentClient 的所有方法）来测试 SessionManager。引入 `IAgentClient` 后，`MockAgentClient` 自然实现该接口，现有测试不需要改动即可验证重构无回归。新增的 `CodexAgentClient` 可以用同样的 mock 模式测试。

对于渲染进程，`tests/session/session-store.test.ts` 已经 mock 了 tRPC 层并直接测试 `handleSessionEvent` 的行为。这个接缝可以直接用于测试 Codex 事件处理分支——通过 dispatch 带有 `_engine: 'codex'` 的事件，验证 session store 正确处理 Codex 的 Thread/Turn/Item 事件。

### 测试策略

- **IAgentClient 接口**：纯类型，无需独立测试
- **CodexAgentClient**：mock Codex 子进程的 stdin/stdout，测试 JSON-RPC 握手、thread/start、turn/start、事件转发、审批请求转发
- **SessionManager 引擎选择**：mock `IAgentClient` 工厂函数，验证根据引擎设置创建正确的客户端实现
- **渲染进程 Codex 事件处理**：dispatch 带 `_engine: 'codex'` 的事件到 session store，验证消息状态正确更新
- **Codex 路径解析**：与 `paths.ts` 相同的测试模式（mock 文件系统）
- **审批模式映射**：纯函数测试，验证 omp 审批模式正确映射到 Codex approvalPolicy + sandbox

### Prior Art

- `tests/session/session-manager.test.ts` — MockAgentClient 模式
- `tests/session/session-store.test.ts` — handleSessionEvent 测试
- `tests/runner/approval-logic.test.ts` — 纯函数测试模式
- `tests/agent/openai-compatible-session.test.ts` — 集成测试（条件跳过当 runtime 不可用）
- `tests/host/host-tools.test.ts` — HostToolsRegistry 测试

## Out of Scope

- Codex 的 thread/fork（会话分叉）功能——未来迭代
- Codex 的 thread/rollback（回滚 Turn）功能——未来迭代
- Codex 的 review/start（代码审查）功能——未来迭代
- Codex 的 backgroundTerminals（后台终端）功能——实验性，不集成
- Codex 的 subagents（子代理）功能——omp 已有类似能力
- Codex 的 hooks（生命周期钩子）功能——omp 已有类似能力
- Codex 的 skills（技能系统）——omp 已有技能系统，不交叉
- Codex Web Runtime 集成——仅集成本地 App Server
- WebSocket 传输——仅使用 stdio 传输
- Codex 的 AGENTS.md 文件——由项目现有 AGENTS.md 处理
- 引擎级 MCP 配置差异——Codex 的 MCP 配置由 config.toml 管理，与 omp 的 MCP 配置独立。SoC Verify 不写 `config.toml`，所有配置通过 JSON-RPC 参数传递
- Codex 的 `personality` 参数——不使用自定义 personality
- Codex 的 `thread/list` / `thread/loaded/list` API——SoC Verify 自行管理会话列表
- Codex 的 `thread/unsubscribe` / 30 分钟自动卸载——每个会话独占进程，销毁时直接杀进程
- omp 引擎自身的功能变更——不修改 omp 源码

## Further Notes

- ADR 0028（`docs/adr/0028-codex-engine-integration.md`）记录了完整的 10 个关键决策和被拒绝方案
- CONTEXT.md 已更新「AI 引擎域」术语表，包含 10 个核心术语
- Codex App Server 官方文档：https://developers.openai.com/codex/app-server
- 官方博客：https://openai.com/index/unlocking-the-codex-harness/
- 开发者指南 Gist：https://gist.github.com/oneryalcin/ee2c27e2d8aa040da8fbe7eebcc2ecea
- dynamicTools 是实验性 API，需关注 Codex 版本升级时的 API 变化——通过 `generate-ts` 生成的类型可以及时发现
- Codex sessions 存储在全局 `~/.codex/sessions/`，不随项目迁移——通过 UI 消息回退机制缓解。实施时需验证 Codex 是否支持 `CODEX_HOME` 环境变量以实现项目级 session 隔离
- Codex App Server 设计为单用户进程——每个 SoC Verify 会话独占一个 App Server 进程（单 Thread/进程模型），避免多 Thread 管理复杂度
