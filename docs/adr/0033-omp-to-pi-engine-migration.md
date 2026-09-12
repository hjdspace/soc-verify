# 0033 — AI Agent 引擎从 omp 迁移到上游 pi

**状态**：Accepted

## 背景与目标

SoC Verify 当前将 oh-my-pi（omp）作为 git submodule，并通过 Bun `--compile` 打包 `socverify-runner.exe`，同时分发 native addon。本机当前产物中，runner 为 124,960,256 字节，`pi_natives.win32-x64-baseline.node` 为 155,966,464 字节，合计 280,926,720 字节（约 268 MiB）。现有 runner 只使用会话、模型、工具桥、MCP 和子代理等能力，omp 内置的 LSP、DAP、browser、IRC/collab、memory 等能力并未形成产品依赖。

本 ADR 决定以 npm 分发的上游 pi 替换 omp。目标是显著降低 AI 引擎载荷，同时保留 SoC Verify 已有的 Agent 交互、Host Tools、模型配置、审批、会话恢复、MCP、skills 和 subagent 能力。Codex 是独立引擎，继续与 pi 共存；本次迁移不是用 pi 替换 Codex。

## 决策

### 1. 保留 Agent Runner 边界，不采用 pi-tui 或原装 RPC

保留每个应用会话独占一个 `socverify-runner` 子进程的架构，以及 Electron 与 runner 之间现有的 JSONL 命令、事件、`tool_call` 和 `approval` 双向协议。runner 内部改用 pi SDK，并负责把 pi 事件归一化为现有 Agent Event Contract；renderer 不直接依赖 pi 的原生事件形状。

现有客户端重命名为 `PiAgentClient`，持久化字段和事件标识同步去除 omp 专属命名。迁移完成后不保留 omp/pi 双 runner 或设置开关。

不采用以下方案：

- 自建 pi-tui 前端：SoC Verify 已有完整 Electron UI、Host Tools、审批和 Diff Review 交互，复刻 TUI 会引入第二套界面状态模型。
- 原装 `pi --mode rpc`：当前 Host Tools 需要由 Electron 主进程动态注册并回调，现有 runner 边界可以直接承载；RPC 是否提供等价且稳定的宿主工具出口仍受 pi 版本影响。
- 将 pi 进程内嵌 Electron 主进程：会丢失当前每会话的崩溃隔离和独立生命周期。

`ask` 保留为 SoC Verify 自有工具，通过 JSONL/IPC 与 renderer 交互，不依赖 TTY 或 pi-tui。

### 2. runner 改为 Node 脚本随应用分发

runner 以普通 Node 脚本和 `extraResources` 中的生产依赖运行，不再编译为 Bun 单文件。目标方案使用 `ELECTRON_RUN_AS_NODE=1` 复用应用内 Electron 自带的 Node，不额外分发 Node runtime；该方案必须先通过打包 spike 验证 Node 版本、模块解析、子进程启动和所有目标平台行为。

验证通过后删除 omp submodule、Bun runner 编译链、native addon 下载、engine stubs 和仅为单文件构建存在的路径兼容代码。所有运行时命名从 omp 迁移到 pi，历史兼容读取点除外。

### 3. MCP 与 subagent 通过受控 extension 提供

MCP 选用 `pi-mcp-adapter`，subagent 选用 `nicobailon/pi-subagents`。二者与 pi 一同作为 runner 的精确版本 npm 依赖，由应用控制加载，不依赖用户预先执行 `pi install`。实际包名、兼容版本、许可证、完整性和 headless API 必须由实现 spike 与 lockfile 固定后才能进入发布构建。

subagent 必须保留以下应用契约：异步执行、父子关系、生命周期和进度事件、取消传播、工具审批继承、artifacts，以及可归属到父子会话的 Token 用量。若候选 extension 无法提供这些能力，迁移不得以静默降级方式发布，应重新选型或单独决策自研最小适配。

MCP 必须继续支持配置、server 状态、工具列表和 reload。若 extension 没有 headless status/tools/reload 出口，允许的显式降级为：状态显示“未知/未探测”，reload 通过重建 pi session 生效，且不得自动重放正在执行或可能产生副作用的 turn。

### 4. 只迁移产品实际依赖的能力

- LSP 继续由 SoC Verify 自有语言服务负责，不实现 pi LSP extension。
- DAP、Agent browser tool、IRC/collab、memory、auto-learn 和 managed-skills 不在本次迁移范围。
- provider、认证、API key/base URL、模型列表、context window、thinking level 和运行时模型切换不得回归。
- `context_usage` 优先采用 pi 原生值；无等价事件时由 runner 计算并标记为近似值。
- system prompt 由 pi 默认 prompt 与 SoC Verify 应用规则组合，应用规则不替换引擎基础约束；设置页展示最终 Effective System Prompt。

未来若重新引入学习能力，默认只允许项目级作用域；提升为用户级跨项目内容必须由用户明确批准。

### 5. skills 采用 pi canonical 来源并保留稳定 URI

新建和管理的 skill 使用 pi canonical 项目级和用户级目录。旧 `.omp/skills` 只读兼容一个版本周期，之后移除；旧 managed-skills 只读兼容，不创建或修改。

应用继续暴露 `skill://<name>` 和 `skill://<name>/<relative-path>`，拒绝绝对路径和 `..` 穿越。同名 skill 按 `project > builtin > user` 解析；同一作用域内优先 canonical pi 来源，再考虑兼容来源，最终只暴露一个确定结果。

### 6. extension、MCP 和工具调用采用三层信任边界

- 项目 extension 首次加载前需要用户确认；应用内置且 lockfile 锁定的 extension 可自动加载。
- MCP server 首次启动前按 server 确认；应用内置或用户明确批准的 server 可自动启动。
- 单次工具审批模式保持 `always-ask`、`write`、`yolo`，统一应用于 pi、Codex、MCP 和 extension tools，并按 read/write/exec 分级。write 工具继续保留前置快照和 Diff Review。

`yolo` 只跳过单次工具调用审批，不能绕过 extension 加载信任或 MCP server 启动信任。

### 7. MCP 配置确定性迁移，不合并多个来源

项目级配置按以下优先级选择一个来源：

1. `.pi/mcp.json`
2. `.mcp.json`
3. `mcp.json`
4. `.socverify/mcp-config.json`

选中的旧配置迁移到 extension 的 canonical pi 配置位置；用户级配置也迁移到 pi 官方用户级位置。多个来源不自动合并，未选中的文件保持不动并向用户报告冲突。TraceWeave 的生成和设置 UI 同步改写 canonical 路径。

用户级 canonical 路径以及 `pi-mcp-adapter` 的最终配置 schema 属于版本相关事实，必须在 spike 中依据官方文档和锁定版本源码确认，不能由 ADR 猜测。

### 8. 区分三层会话数据并以原生 session 为权威

会话持久化分为三层：

- pi/Codex 原生 session：保存完整消息树、工具调用及结果、分支、compaction 和引擎元数据，是同引擎恢复的权威数据。
- `.socverify/sessions.json`：保存 SoC Verify 会话索引和路由信息。
- `.socverify/chat-messages/<sessionId>.json`：保存 UI transcript，用于界面展示和原生 session 不可用时的降级重建，不能替代原生 session。

`PersistedSession` 新增或规范以下字段：

- `engine: 'pi' | 'codex'`
- `engineSessionId`
- 创建该会话时的 `cwd`

历史 `ompSessionId` 只读一次，不再写入。旧记录缺少 `engine` 时进入旧 omp 兼容路径并以 pi 重建；缺少 `cwd` 时以项目根目录作为兼容值。`sessions.json` 采用按需回填，不做启动时批量改写。

同一引擎恢复时优先原生 session。只有原生 session 缺失、损坏，或首条 user message 与 UI transcript 不匹配时，才显式从 transcript 创建新的原生 session，并更新 `engineSessionId`。

### 9. pi 使用原生用户级 session 根目录和 cwd bucket

pi session 使用其原生用户级根目录，并按 canonical `cwd` 编码后的子目录隔离项目，例如 `~/.pi/agent/sessions/--<编码后的 cwd>--/<timestamp>_<uuid>.jsonl`。SoC Verify 不另建 `.socverify/pi-sessions/`。runner 必须明确选择 pi 的默认持久化模式，不能把“未传自定义 sessionDir”解释为内存 session。

恢复、模型切换、分支和删除均使用会话持久化的 cwd，当前界面 cwd 只用于创建新会话。项目目录移动、重命名或切换 worktree 后，路径变化视为新的 cwd bucket；应用不自动搬运或重绑定旧原生 session。

持久化 cwd 不存在或不可访问时，会话标记为“工作目录不可用”，仍允许查看 UI transcript。只有用户明确选择新 cwd 后，才从 transcript 创建新的 pi session；应用不得自动在当前目录执行工具。

### 10. 发现并显式接管外部 pi session

SoC Verify 扫描当前 canonical cwd 对应的 pi session bucket，并在历史列表中展示尚未登记到 `.socverify/sessions.json` 的外部 pi session。后台发现只读，不自动改写应用索引或原生文件。

用户首次打开外部 session 时，应用明确提示该 session 将由 SoC Verify 管理。用户确认后才写入应用索引，并在当前应用的 extension、MCP 和工具信任边界下恢复；原 session 中记录的历史工具调用不会被自动重放。接管后，该 session 使用与应用创建会话一致的删除语义。

### 11. 会话删除是物理删除

用户确认删除新建或已接管的 pi/Codex 会话后，同时删除：

- `.socverify/sessions.json` 中的索引项；
- UI transcript；
- 对应的原生 session JSONL；
- 该 session 的 artifacts。

删除必须通过引擎支持的定位/删除能力或经校验的精确文件路径完成，不能根据未经验证的路径拼接删除文件。任一步骤失败都要向用户报告残留状态，不能显示为完全删除。

### 12. 旧 omp session 不转换并在切换后立即清理

不编写 omp 到 pi 原生 JSONL 的格式转换器，也不在启动时批量重建。旧应用会话首次打开时，从 UI transcript 创建新的 pi session；这会保留 user/assistant 文本，但不会恢复旧工具调用、工具结果、分支和 omp 内部元数据。

引擎切换完成后立即删除 SoC Verify 明确拥有的旧 omp 原生 session 文件及其 artifacts（包括各项目的 `.socverify/omp-sessions`），不保留版本周期或原生文件备份。不得递归删除用户全局 `~/.omp`；无法证明由 SoC Verify 创建的全局文件只报告为遗留项。UI transcript 按应用会话生命周期保留，用于上述按需重建。该清理不可逆，发布说明必须明确：回滚旧应用版本也不能恢复已清理的 omp 会话上下文。

此处“立即清理”只针对 omp 原生 session 和引擎运行数据；旧 `.omp/skills` 仍遵循第 5 节确定的一个版本周期只读兼容。

### 13. regenerate、故障恢复与回滚

`regenerate` 保留分叉语义：从最后一条 user message 之前创建新分支，旧分支保留，新分支取得新的 `engineSessionId`。不得以覆盖最后一条 assistant 文本模拟分支。

runner 异常退出时，会话进入 error 并保留已落盘数据。用户显式重启后优先恢复有效的 pi 原生 session；必要时才从 transcript 重建。不得自动重放未确认完成、可能产生副作用的 turn。

发布后不在新版本中携带旧 runner。代码回滚只能回到完整旧 release；由于旧 omp 原生 session 会被删除，应用版本回滚不提供会话数据回滚。pi session 文件本身继续保留，但旧 release 不承诺能够读取或恢复它们。

### 14. 依赖和升级策略

pi、MCP extension 和 subagent extension 使用精确版本并提交 lockfile，不 fork、不使用 submodule。升级必须检查 changelog、许可证和包完整性，并重新通过 runner 协议、模型兼容、信任边界、会话恢复、体积和性能门禁。

只有当锁定版本缺少不可替代的核心出口，且 extension 无法解决时，才另行决策是否 fork；不能在本迁移中隐式维护私有补丁。

## 实现前必须完成的 spike

以下是技术事实验证，不是待产品决策项；任一关键项失败都应停止实现并重新评估选型：

1. **pi SDK/session**：用锁定版本确认创建、默认持久化、按 cwd 列举、按 ID 恢复、fork、删除 JSONL 和 artifacts 的准确 API，并验证 Windows 路径编码、symlink/canonical cwd 和不可访问 cwd 行为。
2. **MCP extension**：确认 canonical 用户/项目配置路径和 schema，以及 headless status、tools、reload、OAuth 和 tool namespace 行为；验证缺失 API 时的显式降级。
3. **subagent extension**：确认异步委派、事件结构、取消、审批继承、artifacts、session sharing 和 Token 归属是否满足 Agent Event Contract。
4. **runner 打包**：验证 `ELECTRON_RUN_AS_NODE=1`、Node 版本、ESM/CJS 加载、extraResources、asar/unpack、路径含空格和非 ASCII 字符，以及所有发布平台的子进程启动。
5. **模型和 prompt**：验证 provider/认证/base URL、模型发现、context window、thinking level、模型切换、有效 system prompt 和 context usage 计算无回归。
6. **外部 session**：验证只读扫描、metadata 提取、重复去重、接管确认、信任边界和物理删除不会影响同一 cwd bucket 中未接管的 session。

官方站点或最新文档无法访问时，不以旧 omp fork 的实现替代上游 pi 的最新事实；应以锁定 npm 包的源码、类型声明和可复现实验作为发布依据。

## 验收门禁

- 现有 JSONL 命令、Agent Event Contract、Host Tools、审批、Diff Review、MCP、skills、subagent、session 恢复和 regenerate 的契约测试通过。
- provider、认证、自定义 endpoint、模型发现/切换、thinking level 和 context usage 无功能回归。
- 新旧会话、原生 session 缺失/损坏、cwd 不可用、外部 session 接管和删除均有集成测试。
- AI 引擎资源、最终安装包和安装后占用分别记录迁移前后数据；目标 AI 引擎载荷低于 30MB，若未达到则必须解释构成和收益。
- 按支持平台记录 runner 启动时间、首 token 延迟和稳态内存，不接受因减重导致的明显性能回退。
- 发布构建不再包含 omp submodule 产物、Bun runner、旧 native addon 或旧 runner。

## 后果

迁移保留 SoC Verify 自己控制的进程、协议、UI 和工具边界，主要替换 runner 内核和打包方式。代价是应用继续维护一层稳定的 JSONL 适配协议，并承担社区 extension 的兼容性验证。

会话模型更明确，但数据生命周期也更严格：原生 session 是恢复权威，UI transcript 只是降级输入；外部 session 经确认后进入应用管理；删除是物理删除；旧 omp 原生 session 的清理不可逆。

## 参考

- pi 官方文档：<https://pi.dev/docs/latest>
- ADR 0028：Codex 引擎集成
- `CONTEXT.md`：AI 引擎域术语
