# 0028 — Codex App Server 引擎集成与引擎切换

## 背景

SoC Verify 的核心 AI 能力由 oh-my-pi (omp) 引擎提供，通过 `socverify-runner` 子进程以自定义 JSONL 协议通信。随着 OpenAI 开源 Codex Harness（Apache-2.0），项目需要引入 Codex App Server 作为第二个可选 AI 引擎，支持引擎切换。

Codex App Server 是一个有状态的长生命周期进程，通过 JSON-RPC 2.0 over stdio 暴露 Codex 的 Agent 能力。与 omp 的自定义 JSONL 协议完全不同，Codex 使用 Thread / Turn / Item 三层原语模型。

## 关键决策

### 1. 引擎抽象层：抽象 AgentClient 接口（IAgentClient）

**选择**：提取 `IAgentClient` 接口，`OmpAgentClient` 和 `CodexAgentClient` 分别实现。SessionManager 依赖 `IAgentClient`，通过工厂函数根据全局引擎设置创建对应实现。

**理由**：
- `AgentClient` 当前的方法签名（`init` / `prompt` / `abort` / `steer` / `setModel` / `compact` / `destroy`）恰好是引擎能力的自然抽象。
- 引入第二层适配器（EngineAdapter 适配 AgentClient 适配 omp SDK）会造成不必要的间接层。
- SessionManager 不需要改动，保持对 `IAgentClient` 的依赖。

**被拒绝方案**：
- **EngineAdapter 层**：在 AgentClient 之上再引入适配层，间接层过多。
- **直接替换 AgentClient**：破坏现有 omp 路径的稳定性。

**风险**：`InitConfig` 带有 omp 特有概念（`customToolDefinitions`、`seedHistory`、`approvalMode`），Codex 的 `thread/start` 参数模型不同。需要设计引擎无关的 `AgentInitConfig` 联合类型，各引擎实现自行提取所需字段。

### 2. 事件模型：渲染进程感知引擎差异，处理原始 Codex 事件

**选择**：不做事件归一化。CodexAgentClient 将 Codex 的 Thread/Turn/Item 事件原样转发到渲染进程，渲染进程的 `handleSessionEvent` 增加对 Codex 事件类型（`item/started`、`item/completed`、`turn/started`、`turn/completed`、`item/agentMessage/delta` 等）的处理分支。

**理由**：
- 归一化会丢失 Codex 独有的能力（reasoning 事件结构、thread 级操作如 fork/rollback）。
- 与审批机制的选择一致（渲染进程感知引擎差异）。
- 保留未来扩展能力——Codex 的新事件类型可以直接在渲染层处理，无需修改适配层。

**被拒绝方案**：
- **事件归一化**：在 CodexAgentClient 内部将 Codex 三层事件翻译为 omp 扁平事件。虽然渲染进程零改动，但丢失 Codex 独有能力。

### 3. 事件路由：事件 payload 中携带引擎标识

**选择**：CodexAgentClient 转发 Codex 事件时，在每个事件中添加 `_engine: 'codex'` 字段。omp 事件不加此字段（默认视为 omp）。渲染进程的 `handleSessionEvent` 首先检查 `_engine` 字段，如果是 `codex` 则路由到 Codex 事件处理分支，否则走现有 omp 事件路径。

**理由**：
- 改动集中，不需要新增 IPC 通道。
- 事件处理逻辑在同一个 session store 内，共享消息状态。
- 隐式约定简单清晰：有 `_engine` 字段则按对应引擎处理，无则按 omp。

**被拒绝方案**：
- **独立 IPC 通道**：为 Codex 新增 `session:codex-event` 通道。物理隔离清晰但需要新增 preload 桥接、EventRelay 映射、渲染进程监听器，session store 需要合并两个事件源。

### 4. Host Tools 复用：使用 Codex 实验性 dynamicTools

**选择**：在 `thread/start` 时将 Host Tools 注册为 dynamicTools，需要 `capabilities.experimentalApi = true`。

**理由**：
- 不需要额外进程（如 MCP server 适配层）。
- 直接在 JSON-RPC 层面注册工具，与 omp 的 customTools 机制概念对齐。
- 避免了 MCP 适配层的额外复杂度。

**风险**：
- dynamicTools 是实验性 API，可能随 Codex 版本变化。
- 文档较少，schema 格式需要通过 `codex app-server generate-ts` 验证。
- dynamicTools 的审批不在 Codex 内置审批范围内——Host Tools 的审批需要在 CodexAgentClient 的工具回调中自行实现。

**缓解**：通过 `generate-ts` 生成类型定义，升级 Codex 版本时重新生成，可以及时发现 API 变化。

### 5. 会话持久化：双轨制保持，Codex threadId 映射到 ompSessionId

**选择**：PersistedSession 结构新增 `engine?: 'omp' | 'codex'` 字段（默认 `'omp'` 以兼容旧数据）。对 Codex 引擎，`ompSessionId` 字段存储 Codex 的 threadId（字段含义从「omp session ID」扩展为「引擎 session ID」）。恢复时根据 `engine` 字段选择创建对应的 `IAgentClient` 实现，调用 `thread/resume(threadId)`。如果 thread/resume 失败（Codex sessions 目录被清理），回退到 UI 存储消息重建上下文。

**理由**：
- session-router 改动最小——`ompSessionId` 字段含义扩展，新增 `engine` 字段是可选字段不破坏旧数据。
- UI 消息存储引擎无关，不随引擎切换而失效。
- Codex 全局 sessions 目录（`~/.codex/sessions/`）不随项目迁移的问题，通过 UI 消息回退解决。
- `engine` 字段确保恢复时能正确选择 omp 或 Codex 引擎，避免恢复错误。

**待验证**：实施时需验证 Codex 是否支持 `CODEX_HOME` 环境变量。如果支持，考虑设置 `CODEX_HOME` 到项目级目录（`.socverify/codex/`）实现 session 隔离；如果不支持，接受全局 sessions 目录并通过 UI 消息回退缓解。

**被拒绝方案**：
- **项目级 Codex session 目录**：为 Codex 配置自定义 session 存储路径。需要验证 Codex 是否支持 `CODEX_HOME` 环境变量；如果支持则可作为优化项，如果不支持则通过 UI 消息回退兜底。

### 6. 审批机制：渲染进程感知引擎差异，分别处理

**选择**：渲染进程对 omp 审批请求和 Codex 审批请求分别处理。Codex 的 `execCommandApproval` / `applyPatchApproval` 请求通过 CodexAgentClient 转发到渲染进程，渲染进程的审批 UI 根据引擎类型展示不同选项（Codex 支持 `accept` / `decline` / `cancel` / `acceptForSession`）。

**理由**：
- 保留 Codex 审批的全部能力，包括 `acceptForSession` 粒度。
- 与事件模型的选择一致（渲染进程感知引擎差异）。

**审批模式映射**（CodexAgentClient 内部用于配置 thread/start 参数）：
| omp 审批模式 | Codex approvalPolicy | Codex sandbox |
|---|---|---|
| `always-ask` | `always` | `workspace-write` |
| `write` | `unlessTrusted` | `workspace-write` |
| `yolo` | `never` | `danger-full-access` |

### 7. 引擎切换粒度：全局设置级切换

**选择**：在设置页增加「AI 引擎」选择项（omp / codex），存入应用全局设置。所有新创建的会话使用选定引擎。已存在的会话保持原引擎。

**理由**：
- 实现最简单——只需要在 `createSessionContext` 中读取全局引擎设置，创建对应的 `IAgentClient` 实现。
- 用户认知负担低——只需在一个地方选择引擎。
- 切换引擎时不影响已存在的会话——旧会话保持原引擎直到被销毁。

**被拒绝方案**：
- **项目级切换**：更灵活但略复杂，切换时需要重建活跃会话。
- **会话级切换**：最灵活但 UI 复杂，会话恢复时需要记住引擎类型。

### 8. Codex 二进制管理：下载预编译二进制

**选择**：从 Codex GitHub Release 下载预编译的 codex CLI 二进制到 `resources/binaries/`，类似于 socverify-runner 的下载模式。在 `package.json` 中固定 Codex 版本。运行时在 `resources/binaries/` 或 `process.resourcesPath/binaries/` 查找。

**理由**：
- 零编译负担——用户开发时不需要 Rust toolchain。
- 与 socverify-runner、officecli、drawio 的二进制管理方式一致。
- 版本通过 package.json 中的 `codexVersion` 字段锁定。

**安装脚本**：新增 `scripts/download-codex.mjs`，在 postinstall 中自动下载。失败时不阻断构建，运行时报错提示用户。

### 9. 类型定义：postinstall 自动生成

**选择**：下载 Codex 二进制后，自动运行 `codex app-server generate-ts --out src/main/agent/codex-types/`，将生成的类型提交到仓库。升级 Codex 版本时重新生成。

**理由**：
- 类型安全——JSON-RPC 参数有编译期检查。
- IDE 自动补全——Codex 协议面复杂，类型定义极大提升开发体验。
- 升级流程清晰——改 package.json 版本 → 重新下载 → 重新生成类型 → 提交。

**注意**：生成的类型文件可能较大，加入 `.gitignore` 或提交到仓库需要在实施时决定。建议提交到仓库以避免所有开发者都需要安装 Codex 二进制。

### 10. Codex 进程模型：单 Thread/进程

**选择**：每个 SoC Verify 会话独占一个 Codex App Server 子进程（单 Thread/进程模型）。`destroy()` 时直接杀进程，不使用 `thread/end` / `thread/unsubscribe` 等 Thread 级清理 API。

**理由**：
- 与 omp 模型对齐——每个 omp 会话也是一个独占子进程，SessionManager 的 idle retirement 和 destroy 逻辑无需改动。
- 避免多 Thread/进程的管理复杂度——不需要维护 Thread 列表、订阅状态、自动卸载计时器。
- Codex App Server 设计为单用户进程，单 Thread/进程是最简单可靠的模式。
- `thread/resume` 在新进程中恢复历史会话——Codex sessions 全局持久化，新进程可以 resume 之前创建的 Thread。

**被拒绝方案**：
- **多 Thread/进程**：一个 App Server 进程管理多个 Thread。需要维护 Thread 列表、`thread/unsubscribe` 管理、30 分钟自动卸载等逻辑。复杂度高且与 omp 模型不对齐。
- **共享 App Server 进程**：所有 SoC Verify 会话共享一个 App Server 进程。节省资源但一个进程崩溃会影响所有会话，且 Codex 设计为单用户进程，不适合多会话并发。

## 架构影响

### 新增文件

| 文件 | 用途 |
|------|------|
| `src/main/agent/agent-client-interface.ts` | `IAgentClient` 接口定义 |
| `src/main/agent/codex-agent-client.ts` | Codex App Server JSON-RPC 客户端实现 |
| `src/main/agent/codex-paths.ts` | Codex 二进制路径解析 |
| `src/main/agent/codex-types/` | `generate-ts` 生成的 TypeScript 类型 |
| `scripts/download-codex.mjs` | Codex CLI 预编译二进制下载脚本 |

### 修改文件

| 文件 | 改动 |
|------|------|
| `src/main/agent/agent-client.ts` | 实现 `IAgentClient` 接口（重命名为 `OmpAgentClient`） |
| `src/main/agent/session-manager.ts` | `createSession` 改为通过工厂函数创建 `IAgentClient` |
| `src/main/agent/session-context-factory.ts` | 读取全局引擎设置，选择创建 omp 或 codex 客户端 |
| `src/renderer/src/stores/session.ts` | `handleSessionEvent` 增加 Codex 事件类型处理分支 |
| `src/renderer/src/stores/settings.ts` | 增加 AI 引擎选择项 |
| `src/preload/index.ts` | 无需改动（事件仍走 `session:event` 通道） |
| `src/main/ipc/event-relay.ts` | 无需改动（事件仍走 `sessionEvent` → `session:event`） |
| `package.json` | 新增 `codexVersion` 字段、download:codex 脚本 |

### 不受影响

| 模块 | 理由 |
|------|------|
| `runner/index.ts` | omp runner 脚本不变，仍通过 AgentClient JSONL 通信 |
| `HostToolsRegistry` | 工具定义不变，由各引擎的 AgentClient 实现负责注册到对应引擎 |
| `EventRelay` | 事件仍走 `sessionEvent` → `session:event` 通道，无需新增映射 |
| `session-router.ts` | tRPC procedure 签名不变，仍调用 `sessionManager` 方法 |
| 会话持久化结构 | `PersistedSession` 新增可选 `engine` 字段，`ompSessionId` 字段含义扩展 |

## 实施路线

1. **Phase 1：基础设施** — 提取 `IAgentClient` 接口，现有 `AgentClient` 实现它（重命名为 `OmpAgentClient`），确保现有功能不回归。
2. **Phase 2：Codex 客户端** — 下载脚本、路径解析、JSON-RPC 客户端、initialize 握手、thread/start、turn/start、事件转发、审批请求处理。
3. **Phase 3：引擎选择** — 全局设置项、session-context-factory 工厂逻辑。
4. **Phase 4：渲染进程适配** — `handleSessionEvent` 增加 Codex 事件分支、审批 UI 差异化。
5. **Phase 5：Host Tools 注册** — dynamicTools 格式适配、工具回调桥接。
6. **Phase 6：会话恢复** — thread/resume 集成、UI 消息回退逻辑。
7. **Phase 7：类型生成** — postinstall 集成 `generate-ts`。
