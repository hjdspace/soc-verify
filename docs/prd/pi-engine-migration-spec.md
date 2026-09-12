# AI Agent 从 omp 迁移到 pi

> **Parent ADR**: [ADR 0033：AI Agent 引擎从 omp 迁移到上游 pi](../adr/0033-omp-to-pi-engine-migration.md)
>
> **Glossary**: [CONTEXT.md](../../CONTEXT.md) → AI 引擎域
>
> **Triage label**: `ready-for-agent`

## Problem Statement

SoC Verify 当前使用 oh-my-pi（omp）作为 AI Agent runner。omp 以 Bun 单文件 runner 和 native addon 分发，当前本机产物约 268 MiB；其中包含 LSP、DAP、browser、IRC/collab、memory 等当前产品没有使用的能力。构建链、submodule 和 native addon 也增加了升级、打包和故障排查成本。

用户需要一个更轻量、可由应用控制、适合 Electron 无 TTY 场景的 AI 引擎，同时不能丢失现有的 Agent 交互、Host Tools、MCP、skills、subagent、审批、模型配置和会话恢复能力。Codex 是独立引擎，本次迁移不能破坏其共存和路由。

## Solution

将 runner 内核从 omp 替换为上游 pi，并保留 SoC Verify 自有的 runner 进程边界、JSONL 命令/事件协议和 Electron UI。runner 通过 pi SDK 驱动会话，把 pi 事件映射到稳定的 Agent Event Contract；renderer 不依赖 pi 的原生事件形状。

runner 改为由应用分发的普通 Node 脚本和生产依赖，目标使用 `ELECTRON_RUN_AS_NODE=1` 复用 Electron 自带 Node。MCP 和 subagent 作为精确版本的受控 extension 加载；LSP 保持应用自有，其余未使用的 omp 能力不迁移。pi 使用其原生用户级 session 根目录和按 cwd 划分的 bucket；SoC Verify 只维护索引和 UI transcript，不复制一份 pi 原生 session 存储。

迁移完成后，产品只保留 pi 与 Codex 两种引擎。客户端、字段、事件标识和构建产物中的运行时命名统一使用 pi；旧 omp 数据仅按兼容和清理规则处理，不继续写入新的 omp 格式。

## User Stories

### 引擎与交互

1. As a SoC 验证工程师, I want 使用 pi 创建 AI 会话, so that 我能在更小的安装包中继续完成验证工作。
2. As a SoC 验证工程师, I want pi 会话通过现有 JSONL/IPC 协议流式返回消息、工具事件和审批请求, so that 我不需要学习第二套 UI 交互。
3. As a SoC 验证工程师, I want 中断、追加指令、切换模型和压缩上下文, so that 我能控制正在运行的工作。
4. As a SoC 验证工程师, I want `ask` 工具在 Electron UI 中请求补充信息, so that 无 TTY 时 Agent 仍能暂停并等待我的回答。
5. As a SoC 验证工程师, I want Codex 会话继续独立运行, so that pi 迁移不会改变 Codex 的既有行为。
6. As a SoC 验证工程师, I want 在会话和事件中看到正确的引擎标识, so that 我能区分 pi 与 Codex 的消息来源。

### Host Tools、MCP 与 subagent

7. As a SoC 验证工程师, I want pi 调用现有 Host Tools, so that 仿真、覆盖率、文档和知识库工作流无需重写。
8. As a SoC 验证工程师, I want 项目和用户 MCP 配置按确定性优先级被发现, so that 同时存在多个配置文件时不会产生隐式合并。
9. As a SoC 验证工程师, I want 查看 MCP server 状态和工具列表, so that 我能判断工具是否可用。
10. As a SoC 验证工程师, I want reload MCP 配置而不重放正在执行的 turn, so that 配置变更不会重复产生副作用。
11. As a SoC 验证工程师, I want subagent 具有父子关系、进度、取消、审批继承和 artifacts, so that 并行分析仍可追踪和控制。
12. As a SoC 验证工程师, I want subagent token 用量能归属到父子会话, so that Token Monitor 统计不会丢失上下文。

### Skills 与信任

13. As a SoC 验证工程师, I want 使用 pi canonical 来源的项目级和用户级 skills, so that skill 管理与 pi 生态一致。
14. As a SoC 验证工程师, I want 旧 `.omp/skills` 在一个版本周期内只读可用, so that 我能平滑迁移已有 skill。
15. As a SoC 验证工程师, I want skill URI 保持稳定并拒绝路径穿越, so that extension 不能借 skill 引用访问任意文件。
16. As a SoC 验证工程师, I want 首次加载项目 extension 和首次启动 MCP server 时分别确认信任, so that 我能控制可执行代码和本地进程暴露的边界。
17. As a SoC 验证工程师, I want `always-ask`、`write`、`yolo` 继续统一作用于 pi、Codex、MCP 和 extension tools, so that 我不需要维护引擎专属审批习惯。
18. As a SoC 验证工程师, I want `yolo` 不会绕过 extension/MCP 信任确认, so that 单次工具审批放宽不会变成任意代码执行授权。

### 会话持久化与迁移

19. As a SoC 验证工程师, I want pi 原生 session 保存完整消息树、工具结果、分支和 compaction, so that 关闭应用后能恢复同一上下文。
20. As a SoC 验证工程师, I want 应用索引记录引擎类型、engine session ID 和创建时 cwd, so that 恢复时能定位正确的原生 session。
21. As a SoC 验证工程师, I want 原生 session 恢复优先于 UI transcript, so that transcript 不会覆盖更完整的引擎状态。
22. As a SoC 验证工程师, I want 原生 session 缺失、损坏或首条 user message 不匹配时从 transcript 重建, so that UI 历史仍能作为可控降级入口。
23. As a SoC 验证工程师, I want cwd 不可用时只能查看 transcript, so that Agent 不会在错误目录执行工具。
24. As a SoC 验证工程师, I want 项目移动、重命名或 worktree 切换形成新的 cwd bucket, so that 旧路径 session 不会被静默重绑定。
25. As a SoC 验证工程师, I want 发现当前 cwd bucket 中外部创建的 pi session, so that 我可以选择把已有 pi 工作接入 SoC Verify。
26. As a SoC 验证工程师, I want 接管外部 session 前看到明确提示并确认, so that 外部数据不会被应用无意接管。
27. As a SoC 验证工程师, I want 删除新建或已接管的会话时清理索引、transcript、原生 JSONL 和 artifacts, so that 删除后的历史不会残留在应用管理范围内。
28. As a SoC 验证工程师, I want `regenerate` 创建新的分支和 engine session ID, so that 旧分支仍可回看。
29. As a SoC 验证工程师, I want runner 崩溃后会话进入 error 并可显式重启, so that 未确认完成的 turn 不会被自动重放。
30. As a SoC 验证工程师, I want 旧 omp 原生 session 在切换完成后立即清理, so that 应用不再保留不可维护的旧引擎运行数据。
31. As a SoC 验证工程师, I want 旧 UI transcript 保留并可按需重建 pi session, so that 清理 omp 原生文件后仍能查看历史文本。

### 模型、上下文与发布质量

32. As a SoC 验证工程师, I want provider、认证、API key、base URL、模型列表和运行时模型切换继续有效, so that 自定义模型服务不受迁移影响。
33. As a SoC 验证工程师, I want context window、thinking level 和 context usage 继续显示, so that 我能判断当前会话还能容纳多少内容。
34. As a SoC 验证工程师, I want 最终 Effective System Prompt 可见, so that 我能确认 pi 默认约束与 SoC Verify 应用规则如何组合。
35. As a 开发者, I want runner 不再依赖 Bun compile、omp submodule 或旧 native addon, so that 构建链更简单且安装包更小。
36. As a 开发者, I want pi、MCP extension 和 subagent extension 使用精确版本和 lockfile, so that 发布构建可复现。
37. As a 发布负责人, I want 安装包记录引擎载荷、启动时间、首 token 延迟和稳态内存, so that 减重不会以明显性能回退为代价。

## Implementation Decisions

以下结论来自 ADR 0033；实现不得在未更新 ADR 的情况下改变这些边界。

### Runner 与客户端边界

- 保留每个应用会话独占一个 `socverify-runner` 子进程的崩溃隔离和生命周期。
- runner 内部使用 pi SDK，输出现有 JSONL 命令、事件、`tool_call` 和 `approval` 协议；pi 原生事件只能在 runner 内部适配。
- 现有客户端重命名为 `PiAgentClient`，并与 `CodexAgentClient` 共同实现 `IAgentClient`。SessionManager 只依赖接口。
- 不采用 pi-tui、自建第二套 TUI 前端、pi 原装 `--mode rpc` 或把 pi 进程嵌入 Electron 主进程。`ask` 是应用自有 JSONL/IPC 工具。

### 打包与依赖

- runner 以普通 Node 脚本和 `extraResources` 生产依赖分发，目标通过 `ELECTRON_RUN_AS_NODE=1` 复用 Electron Node。
- 在打包 spike 通过前不得删除旧构建链；通过后移除 Bun compile、native addon、omp submodule、engine stubs 及只为单文件构建存在的兼容代码。
- pi、`pi-mcp-adapter`、`nicobailon/pi-subagents` 使用精确版本、lockfile 和应用控制加载；不要求用户预装 pi 或执行 `pi install`。
- 升级依赖必须重新检查 changelog、许可证、完整性、协议契约、会话恢复、信任边界、体积和性能。

### 能力边界

- LSP 继续由 SoC Verify 自有语言服务提供。
- DAP、browser tool、IRC/collab、memory、auto-learn 和 managed-skills 不迁移。未来重新引入学习能力时，默认仅允许项目级作用域；用户级跨项目作用域需要明确批准。
- provider、认证、API key/base URL、模型发现、context window、thinking level、运行时模型切换和 Effective System Prompt 必须保持可用。
- `context_usage` 优先采用 pi 原生值；无等价事件时由 runner 计算并标记为近似。

### MCP、subagent、skills 与信任

- MCP 配置选择一个来源，优先级为 `.pi/mcp.json`、`.mcp.json`、`mcp.json`、`.socverify/mcp-config.json`；不自动合并，未选文件保持不动并报告冲突。
- MCP 需要支持配置、server 状态、工具列表和 reload。extension 缺少 headless 出口时只能显式显示“未知/未探测”，reload 可通过重建 session 生效，不能自动重放 turn。
- subagent 必须支持异步父子生命周期、进度事件、取消传播、工具审批继承、artifacts 和父子 Token 归属；候选 extension 不满足时不得静默降级发布。
- skills 使用 pi canonical 项目级/用户级来源；旧 `.omp/skills` 只读兼容一个版本周期。URI 只允许 `skill://<name>` 或带相对路径的形式，解析拒绝绝对路径和 `..`。同名 skill 按 `project > builtin > user` 解析，canonical 来源优先。
- 项目 extension、MCP server 启动信任和单次工具审批分别管理。`yolo` 只跳过单次工具调用审批。write 工具继续保留前置快照和 Diff Review。

### 会话数据与生命周期

- 原生 pi/Codex session 是完整消息树、工具调用结果、分支、compaction 和引擎元数据的恢复权威；应用索引只负责路由；UI transcript 只用于展示和受控重建。
- 持久化记录包含 `engine`、`engineSessionId` 和创建时 `cwd`。历史 `ompSessionId` 只读兼容一次，不再写入。
- pi 使用其原生用户级 session 根目录和 cwd bucket，不新增项目级 pi session 副本。恢复、模型切换、分支和删除使用持久化 cwd。
- cwd 不存在或不可访问时允许查看 transcript，但必须由用户明确选择新 cwd 后才能重建 session。
- 当前 cwd bucket 中未登记的外部 pi session 只读发现；首次打开时必须确认接管，接管后进入统一应用管理和删除语义。
- 删除是物理删除：索引、transcript、原生 session JSONL 和 artifacts 均需处理；失败时报告残留状态。旧 omp 原生 session 仅清理 SoC Verify 明确拥有的数据，不递归删除用户全局 `~/.omp`。
- `regenerate` 保留真实分支语义并生成新的 engine session ID。runner 异常后进入 error，由用户显式重启，不自动重放可能产生副作用的 turn。完整回滚只能回到旧 release，不承诺旧 release 读取 pi session。

### 实现前技术 spike

以下是发布前必须验证的事实，不是可由实现假设替代的决策：

1. 锁定 pi 版本的 SDK/session 创建、默认持久化、按 cwd 列举、恢复、fork、删除、artifacts、Windows 路径编码和不可访问 cwd 行为。
2. `pi-mcp-adapter` 的 canonical 配置路径/schema、headless status/tools/reload、OAuth 和工具命名空间。
3. `nicobailon/pi-subagents` 的事件、取消、审批、artifacts、session sharing 和 Token 归属。
4. `ELECTRON_RUN_AS_NODE=1` 下的 Node 版本、ESM/CJS 加载、extraResources、asar/unpack、路径含空格或非 ASCII 字符以及所有支持平台的 runner 启动。
5. provider、认证、base URL、模型发现、context window、thinking level、模型切换、Effective System Prompt 和 context usage。
6. 外部 session 只读扫描、metadata 提取、去重、接管确认、信任边界和物理删除。

任一关键 spike 失败时，停止实现并重新评估选型；不能用本地 omp fork 的行为冒充上游 pi 官方事实。

## Testing Decisions

测试只验证外部行为和跨模块契约，不断言 pi 内部实现细节。优先使用现有测试缝，必要时新增的测试缝应位于最高层。

### 测试缝一：IAgentClient/Agent Runner 契约

- 使用可控的 mock pi SDK 或子进程，验证 `PiAgentClient` 能完成初始化、prompt、steer、abort、setModel、compact、destroy、工具回调和审批回调。
- 验证 pi 事件被归一化为现有 Agent Event Contract，renderer 不需要理解 pi 原生事件名。
- 验证 MCP、subagent、`ask`、tool_call、approval、context_usage、错误和取消事件的 payload 及生命周期。
- 同一组契约测试应由 Codex 客户端复用，确保引擎共存不改变 SessionManager 行为。

### 测试缝二：SessionManager 与持久化边界

- 通过 mock `IAgentClient` 和临时 session 存储验证按引擎路由、原生 session 优先、transcript fallback、首条 user message 校验和 `engineSessionId` 更新。
- 验证 cwd 不可用时只读 transcript、用户选择新 cwd 后才能重建，以及项目移动/重命名不会自动重绑定。
- 验证外部 pi session 的只读发现、接管确认、去重和接管后的统一删除语义。
- 验证删除同时处理应用索引、UI transcript、原生 JSONL 和 artifacts，并在部分失败时报告残留。
- 验证旧 omp 记录只读兼容一次、旧 omp 原生数据按拥有权清理、UI transcript 可用于按需重建。
- 验证 regenerate 创建新分支和新 engine session ID，runner 崩溃进入 error 且不会自动重放 turn。

### 测试缝三：打包与发布门禁

- 在每个支持平台验证 runner 子进程启动、路径解析、依赖加载、asar/unpack、路径含空格和非 ASCII 字符。
- 记录迁移前后 AI 引擎载荷、最终安装包大小、安装后占用、启动时间、首 token 延迟和稳态内存。
- 发布构建必须确认不包含 omp submodule 产物、Bun runner、旧 native addon 或旧 runner。

### Prior Art

- SessionManager 现有 MockAgentClient 测试模式，用于验证接口契约和事件转发。
- Agent runner/approval 相关测试，用于验证 JSONL 命令、工具调用和审批生命周期。
- Codex 客户端的 JSON-RPC stdio mock 测试，用于复用子进程握手、通知、server-to-client 请求和 stderr 诊断模式。
- 现有 UI session store 测试，用于验证归一化事件在 renderer 中的外部表现。

## Out of Scope

- 不采用 pi-tui，不重做 Electron UI，不把 pi 原生 RPC CLI 直接暴露给 renderer。
- 不迁移或重新实现 DAP、Agent browser tool、IRC/collab、memory、auto-learn、managed-skills。
- 不编写 omp 到 pi 原生 JSONL 的格式转换器，不批量自动重建所有旧会话。
- 不保留 omp/pi 双 runner、运行时切换开关或新版本中的旧 omp runner。
- 不新增 `.socverify/pi-sessions/` 项目级原生 session 副本。
- 不自动合并多个 MCP 配置来源，不自动接管外部 pi session，不在错误 cwd 中隐式执行工具。
- 不自动重放崩溃或 reload 时未确认完成的 turn。
- 不递归删除用户全局 `~/.omp`，不保证回滚旧 release 能读取 pi session。
- 不在本 spec 中修改 Codex 引擎协议或实现新的 Codex 功能。

## Further Notes

- 本 spec 是 ADR 0033 的实现规格，不替代 ADR 中的 spike、验收门禁和清理边界。
- pi 官方文档或最新版本事实必须以锁定 npm 包的源码、类型声明和可复现实验确认；网络文档不可访问时不得猜测。
- 规格中的“原生 session”“UI transcript”“应用索引”“cwd bucket”“外部 pi session”“接管”“物理删除”等术语均以 CONTEXT.md 为准。
- 迁移完成后应同步更新产品内可见命名、构建脚本、依赖清单、日志和诊断文案，搜索并清理仅属于 omp 运行时的命名；历史兼容读取点应有明确注释和移除期限。
- 目标 AI 引擎载荷低于 30 MB；若 spike 后无法达到，发布前必须给出构成、原因和收益分析，并重新确认是否继续。
