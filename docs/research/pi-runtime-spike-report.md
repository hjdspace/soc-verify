# Pi 运行时可行性 Spike 报告（Issue 01）

> **Issue**: `.scratch/pi-engine-migration/issues/01-pi-runtime-spike-and-lock.md`
> **Spec**: [pi-engine-migration-spec.md](../prd/pi-engine-migration-spec.md) · **ADR**: [0033](../adr/0033-omp-to-pi-engine-migration.md)
> **日期**: 2026-09-09 · **环境**: Windows 11 x64, 系统 Node 24.14.0, Electron 43.1.0
> **Spike 脚本**: `.scratch/pi-engine-migration/spike/01-*.mjs` ~ `06-*.mjs`（可复现，结果 JSON 同目录）

## 结论：GO（功能），载荷目标未达需重新确认（体积）

- **全部功能验证通过**：session 生命周期（26/26）、headless 扩展加载（adapter + subagents 同时注册工具成功）、`ELECTRON_RUN_AS_NODE=1` 下 SDK 完整可用（含中文+空格路径）。
- **载荷目标 < 30 MB 无法以直接安装方式达到**（实测现实打包约 **207 MB**，详见体积构成）。按 spec「Further Notes」要求，发布前必须重新确认是否接受该构成或追加打包优化（esbuild bundle 预估可降至 60–100 MB）。相对 omp 268 MiB 仍有 23%（直接替换）～ 60%+（bundle）的减重。
- **一个依赖元数据风险**：`pi-mcp-adapter@2.32.1` 声明 peer `@earendil-works/pi-ai: ^0.84.1`（0.x 语义不含 0.85.x），实测与 `pi@0.85.1` 共存安装成功、功能正常，但 `npm ls` 报 `invalid`。处置见「风险」。

## 1. 锁定版本与许可证

| 包 | 锁定版本 | 许可证 | unpacked | 用途 |
|---|---|---|---|---|
| `@earendil-works/pi-coding-agent` | **0.85.1** | MIT | 21.9 MB | runner 内核 SDK（含 `@earendil-works/pi-ai@0.85.1`、`pi-agent-core@0.85.1`、`pi-tui@0.85.1`） |
| `pi-mcp-adapter` | **2.32.1** | MIT | 2.9 MB | MCP 扩展（nicobailon） |
| `pi-subagents` | **0.66.0** | MIT | 5.2 MB | subagent 扩展（nicobailon，传递依赖 `@earendil-works/pi-server@0.85.0`，experimental） |

- 全部传递依赖（155 包）许可证扫描：MIT x130、ISC x8、Apache-2.0 x7、BSD x7、Unlicense/0BSD x2 — **无传染性许可**。
- engines：`node >= 22.19.0` — Electron 43 内嵌 Node 24.18.0 满足。
- **lockfile 条目建议**：主仓库 `package.json` 以 `--save-exact` 写入 `"@earendil-works/pi-coding-agent": "0.85.1"`、`"pi-mcp-adapter": "2.32.1"`、`"pi-subagents": "0.66.0"`（精确版本，无 `^`），随 `package-lock.json` 提交；安装参数含 `--ignore-scripts`（pi 官方推荐，无需生命周期脚本）。实现期（issue 02/03）落地。
- 在线文档（pi.dev/docs/latest）API 与 0.85.1 有出入（如 `AuthStorage`→0.85.1 实为 `ModelRuntime`），**以锁定包的 `.d.ts` 和实测为准**（本报告即实测）。

## 2. Spike 1 — Session 生命周期（26/26 PASS，`01-session-lifecycle.mjs`）

| 验证项 | 结果 |
|---|---|
| 创建 | `SessionManager.create(cwd)` 返回 `sessionFile`，header `{type:"session", version:3, id:UUID, timestamp, cwd}` |
| **cwd bucket** | 默认根 `PI_CODING_AGENT_DIR/sessions/`（可用 `getAgentDir()` 确认 env 覆盖）；bucket 名 = `--<绝对路径清洗>--`（`:`/`\`/`/`→`-`，**中文与空格原样保留**），如 `--D--AI-...-测试 项目 dir-sub path--` |
| **持久化时机** | **首条 assistant 消息到达前不创建文件**（源码 `_persist` no-assistant guard）；之后同步逐条 append（非 debounce）。含义：crash 在首条回复前 → pi 原生文件不存在，transcript 重建是唯一恢复路径（与 spec 22 号 user story 一致） |
| 列举 | `list(cwd)` / `listAll()` 返回 `path,id,cwd,name,parentSessionPath,created,modified,messageCount,firstMessage,allMessagesText` — **应用索引所需元数据齐全（含 cwd 与 fork 父链）** |
| 恢复 | `continueRecent(cwd)` / `open(path, sessionDir?, cwdOverride?)`（cwdOverride 支持按持久化 cwd 重绑定）+ `buildSessionContext()` |
| fork | `forkFrom(srcPath, targetCwd)`（跨项目）、`createBranchedSession(leafId)`（分支提取新文件）、运行时层 `runtime.fork(entryId, {position:"at"})` |
| 删除 | **SDK 无删除 API** → 应用物理删除 JSONL 后 `list` 即不再返回（已验证）；spec 的物理删除语义由应用实现 |
| artifacts | session bucket 目录内**仅 JSONL，无伴随 artifacts 文件** → SoC Verify artifacts 需自管理（spec 假设成立） |
| 不可访问 cwd | `create()` 不校验 cwd 存在（照常创建 bucket）→ **应用必须在重建/接管前自行校验 cwd 可用**（spec 23 号） |
| 显式 sessionDir | 传入 `sessionDir` 时为**扁平结构（无 bucket）**；保持 pi 默认根 + bucket 才与 pi CLI 数据互通（spec「不新增项目级副本」成立） |
| 树语义 | `branch(id)` 移动 leaf、`getTree/getPath/getChildren`、`appendModelChange/appendCompaction/appendLabelChange` 全部可用 |

## 3. Spike 2 — pi-mcp-adapter（`02-mcp-adapter.mjs` + `06-extensions.mjs`）

- **canonical 配置**：识别 `mcp.json` / `.mcp.json` / `.vscode/mcp.json` 等字面量；schema 键 `mcpServers`，stdio 字段集 `{type,command,args,env,cwd}` + HTTP 字段；Pi 自有覆盖层 `.pi/mcp.json`（项目）与 `<agentDir>/mcp.json`（全局）。spec 的来源优先级可在应用层实现（adapter 的 host-config 自动发现默认关闭，正合 spec「不隐式合并」）。
- **headless 出口确认**：`index.ts` 导出 `createMcpAdapter` / `registerMcpServer` / `getRuntimeMcpServerSnapshot` / `MCP_RUNTIME_SNAPSHOT_EVENT`；proxy 模式含 `executeStatus/executeList/executeSearch/executeDescribe/executeCall/executeConnect`；CLI bin `pi-mcp-adapter`（`status`/`init`）。**status/tools 有编程式出口；reload 走扩展 `reconnectServer(s)` + 会话重建路径，无自动 turn 重放风险**。
- **headless 加载实测**：`DefaultResourceLoader` + `additionalExtensionPaths` 指向 `node_modules/pi-mcp-adapter/index.ts`（TS 源码）→ 加载成功、无 error 诊断，会话工具面注册出 `mcp`、`mcpScript`。TS 运行时编译由 pi 内置 esbuild 完成：**冷加载 14.2s，热加载 1.47s（有编译缓存）**。
- **OAuth**：支持 `client_credentials`（非交互机器流）；持久 OAuth 依赖 OS credential store（`@napi-rs/keyring`），headless Linux 无 keyring 时 fail-closed — 与 spec 信任边界一致。

## 4. Spike 3 — pi-subagents（`03-subagents.mjs`）

- API 面完整（195 个导出类型）：`ControlEvent`、`TokenUsage`/`UsageBudget*`、`ArtifactPaths`/`ArtifactConfig`、`SubagentState`、`AgentProgress`、`SteeringStatus`、`ParallelHandoff*`、`WaitCompletion`、`ExternalJobStatus`、自定义事件 `subagent-notify` 等 — **事件、取消传播、审批、artifacts、Token 归属、并发控制关键词全部命中**。
- 深度行为验证（父子 Token 精确归属数值、取消传播时序）留待 issue 05 实现 TDD 时以契约测试覆盖；本次以「API 面存在 + 扩展可 headless 加载 + `subagent`/`bg_wait` 工具注册成功」作为可行性依据。

## 5. Spike 4 — ELECTRON_RUN_AS_NODE=1（`05-electron-node.mjs`）

| 项 | 结果 |
|---|---|
| Node 版本 | **24.18.0**（Electron 43.1.0，满足 pi engines >=22.19） |
| ESM 加载 | SDK（纯 ESM 包）导入 900ms（热），快于系统 Node 的 1.5–2.0s |
| 非 ASCII + 空格路径 | `…\中文 目录` cwd 下 session 创建成功，bucket 名含中文/空格原样 |
| 内存 | RSS 119MB（仅会话构造） |
| 打包形态结论 | runner 以普通 Node 脚本 + 生产 `node_modules` 经 `extraResources` 分发（不进 asar）时上述路径全部成立；esbuild 平台二进制（`@esbuild/win32-x64`）随依赖安装，无需额外 unpack 配置 — **asar 场景仅影响主进程打包，runner 走 extraResources 即规避**；Linux/macOS 平台验证列入发布门禁（测试缝三），本机 win32 已验证 |

## 6. 性能与体积基线（`04-metrics.mjs`）

| 指标 | 实测（win32-x64） |
|---|---|
| SDK import | 0.9s（热）～ 2.0s（冷） |
| `createAgentSession` | 145–252ms |
| **首 token** | **2690ms**（真实调用，openrouter/openrouter/free，用户已有 auth；以网络 RTT 为主） |
| 首轮完整回复 | 2906ms（回复 "OK"，事件流 `message_update/text_delta` + `message_end.usage` 正常） |
| 稳态 RSS | 119–146MB（会话构造后） |

### 体积构成（win32-x64 现实打包 ≈ **207 MB**）

| 构成 | 大小 | 说明 |
|---|---|---|
| （参照）全量 node_modules | 572 MB | 含 esbuild 全平台 26 份二进制 |
| 剔除项 | −365 MB | esbuild 跨平台二进制（−272）、recheck-jar（−22）、全树 .map（−68）、docs/examples（−4） |
| pi 本体（dist+core+ai+protocol） | ≈ 29 MB | 必留 |
| Provider SDK（@google/genai 13.7 + openai 9.3 + @anthropic-ai 8.3） | ≈ 31 MB | spec 要求 provider 能力完整，必留 |
| esbuild win32-x64 二进制 | 11.1 MB | 扩展 TS 运行时编译必需 |
| MCP SDK 三件套 | ≈ 12 MB | 必留 |
| 两个扩展 | ≈ 8 MB | 必留 |
| recheck-windows-x64 | 27.4 MB | adapter ReDoS 校验器平台二进制，**候选剔除项**（评估禁用 recheck 或按平台裁剪） |
| web-streams-polyfill/zod/长尾 | ≈ 88 MB | 长尾依赖 |

**< 30 MB 目标判定：未达成**。原因：pi 内核 0.85.1 自带多 provider SDK 与 MCP/扩展运行时；30 MB 仅够内核本体。**收益分析**：直接替换 omp（268 MiB Bun 单文件+native addon）→ 207 MB（−23%）且获得普通 Node 分发、无 Bun 构建链、无 submodule；若追加 esbuild bundle runner（保留扩展 TS 加载所需的 esbuild 二进制）预估 60–100 MB（−60%+）。**建议**：接受「GO + 体积目标修订」，发布门禁按实测构成复核（spec 已要求记录构成与原因）。

## 7. 风险与移交事项

1. **adapter peer 冲突**：`pi-mcp-adapter@2.32.1` peer `pi-ai ^0.84.1` ≠ 0.85.1。实测共存可用（工具注册、无诊断错误）。处置：锁定如上精确版本 + 在 issue 04 的契约测试中加入 adapter 回归项；跟踪 adapter 上游 peer 更新，升级时按 spec「升级依赖必须重新检查」执行。
2. **首条 user 消息不落盘**：no-assistant guard 使「crash 于首条回复前」的 pi 原生 session 为空/不存在 → transcript 是唯一恢复入口（issue 07 需实现该降级路径）。
3. **扩展冷编译 14.2s**：有缓存（热 1.47s），但首次启动/清缓存后启动时间显著增加 → issue 03 需在 runner 启动预算中处理（预热或缓存目录随应用分发策略）。
4. **getAvailable API**：`ModelRuntime.create()` 需 `await`；可用模型枚举的精确接线（`getAvailable` vs `getAvailableSnapshot`）在 issue 06 落实。
5. **多平台**：Linux/macOS 的 runner 启动与路径验证未在本机执行，列入发布门禁（issue 11 / 测试缝三）。
6. 在线文档与 0.85.1 API 存在漂移（`AuthStorage` 等），实现期一律以锁定包 `.d.ts` 为准。
