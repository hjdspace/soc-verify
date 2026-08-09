# OMP 上下文管理能力研究

> 调研日期：2026-08-09  
> 本地子模块：`oh-my-pi` v16.4.0，commit `a0f7266fbc623817fdf11354f99bb0afd0d7bb6c`  
> 上游仓库：<https://github.com/can1357/oh-my-pi>

## 结论摘要

OMP 已原生提供上下文用量、手动压缩和自动压缩能力，不需要为 SoC Verify 的上下文圈和“手动压缩”按钮另写上下文插件。

- `get_state` 返回当前模型、压缩状态、自动压缩开关和聚合上下文用量。
- `message_end` 中的 assistant message 带单次请求的 input、output、cache read/write 和 total token 用量。
- `get_session_stats` 返回会话累计 token 用量及当前上下文用量。
- `compact` 支持手动压缩；`set_auto_compaction` 可控制自动压缩。
- RPC 会转发 `auto_compaction_start` / `auto_compaction_end` 生命周期事件。
- OMP extension API 也支持读取上下文、触发压缩和替换压缩结果，但本需求没有使用插件的必要。

需要注意两个集成事实：

1. OMP 没有运行时 `set_context_window` RPC。`contextWindow` 本质上是模型元数据，而不是可随意扩大的模型能力。
2. SoC Verify 当前并未直接运行 `omp --mode rpc`，而是通过 [`runner/index.ts`](../../runner/index.ts#L176) 调用 OMP SDK，再使用自定义 JSONL 协议连接 Electron 主进程。因此实现时应扩展现有 runner 命令，不应另建一套原生 RPC 客户端。

## 1. 模型 context window 如何配置

### 1.1 原生 RPC 能做什么

原生 RPC 的 `set_model` 只接收 `provider` 和 `modelId`，没有 context window 参数：

```json
{ "id": "model-1", "type": "set_model", "provider": "anthropic", "modelId": "claude-sonnet-4-5" }
```

证据：[`rpc-types.ts`](../../engine/oh-my-pi/packages/coding-agent/src/modes/rpc/rpc-types.ts#L46)；[官方 RPC 文档](https://github.com/can1357/oh-my-pi/blob/a0f7266fbc623817fdf11354f99bb0afd0d7bb6c/docs/rpc.md#L99-L104)。

模型的 `contextWindow` 位于模型对象本身，是 catalog / discovery 提供的能力元数据。模型类型允许 `number | null`，见 [`catalog/src/types.ts`](../../engine/oh-my-pi/packages/catalog/src/types.ts#L721)。

### 1.2 OMP 的持久化覆盖方式

OMP 支持在 `~/.omp/agent/models.yml` 中按模型覆盖 `contextWindow`：

```yaml
providers:
  anthropic:
    modelOverrides:
      claude-sonnet-4-5:
        contextWindow: 200000
```

配置位置和模型字段见 [官方模型配置文档](https://github.com/can1357/oh-my-pi/blob/a0f7266fbc623817fdf11354f99bb0afd0d7bb6c/docs/models.md#L15-L24) 与 [modelOverrides 文档](https://github.com/can1357/oh-my-pi/blob/a0f7266fbc623817fdf11354f99bb0afd0d7bb6c/docs/models.md#L246-L251)。schema 明确接受 `contextWindow`，见 [`models-config-schema.ts`](../../engine/oh-my-pi/packages/coding-agent/src/config/models-config-schema.ts#L206)；registry 会把它应用到模型对象，见 [`model-registry.ts`](../../engine/oh-my-pi/packages/coding-agent/src/config/model-registry.ts#L514)。

这类覆盖只应修正错误的模型元数据，不能让上游模型获得超过实际能力的窗口。写成 200K 并不会让一个真实 128K 模型支持 200K。

### 1.3 对 SoC Verify 的建议

将用户设置定义为“本应用使用的上下文上限”，默认 `200_000`，而不是篡改模型真实能力：

```text
effectiveWindow = min(configuredWindow, advertisedModelWindow)
```

当模型没有有效的 `contextWindow` 时，可以退回用户配置值，但 UI 应标注这是应用配置上限，而非已确认的模型能力。

若希望 OMP 在这个应用上限之前自动维护上下文，可在 runner 的 session settings 中设置固定压缩阈值，而不必写全局 `models.yml`：

```text
reserve = max(floor(effectiveWindow * 0.15), 16_384)
thresholdTokens = effectiveWindow - reserve
```

200K 配置对应默认阈值约 170K。该做法既保留模型真实 window，又让 SoC Verify 在自身上限内主动压缩。

## 2. Token 和 context usage 暴露情况

### 2.1 当前上下文用量

原生 RPC `get_state` 返回：

```json
{
  "model": { "provider": "...", "id": "...", "contextWindow": 200000 },
  "isCompacting": false,
  "autoCompactionEnabled": true,
  "contextUsage": {
    "tokens": 1100,
    "contextWindow": 200000,
    "percent": 0.55
  }
}
```

协议类型见 [`rpc-types.ts`](../../engine/oh-my-pi/packages/coding-agent/src/modes/rpc/rpc-types.ts#L93)，handler 直接调用 `session.getContextUsage()`，见 [`rpc-mode.ts`](../../engine/oh-my-pi/packages/coding-agent/src/modes/rpc/rpc-mode.ts#L938)。官方示例见 [RPC get_state payload](https://github.com/can1357/oh-my-pi/blob/a0f7266fbc623817fdf11354f99bb0afd0d7bb6c/docs/rpc.md#L190-L233)。

`tokens` 不是简单累计历史中所有请求的 token。OMP 优先使用最近一次 provider 报告的 prompt token 作为锚点，再估算锚点后的消息；拿不到有效用量时才估算全部消息。实现见 [`agent-session.ts`](../../engine/oh-my-pi/packages/coding-agent/src/session/agent-session.ts#L15503)。这正适合作为上下文圈的 used / window 数值。

### 2.2 单次请求用量

RPC 原样转发 `message_start`、`message_update`、`message_end` 等 `AgentSessionEvent`，见 [`rpc-mode.ts`](../../engine/oh-my-pi/packages/coding-agent/src/modes/rpc/rpc-mode.ts#L820) 和 [官方事件文档](https://github.com/can1357/oh-my-pi/blob/a0f7266fbc623817fdf11354f99bb0afd0d7bb6c/docs/rpc.md#L337-L348)。

最终 `message_end.message` 若为 assistant message，会包含：

| 字段 | 含义 |
|---|---|
| `usage.input` | 未命中缓存的新输入 token |
| `usage.output` | 本次输出总 token，包含 thinking、文本和 tool-call arguments |
| `usage.cacheRead` | 从 prompt cache 读取的 token |
| `usage.cacheWrite` | 写入 prompt cache 的 token |
| `usage.totalTokens` | 上述 token 加 provider orchestration token 的总量 |
| `usage.reasoningTokens?` | provider 能报告时的 reasoning token，是 output 的子集 |

类型定义见 [`catalog/src/types.ts`](../../engine/oh-my-pi/packages/catalog/src/types.ts#L95)，assistant message 持有 `usage`，见 [`ai/src/types.ts`](../../engine/oh-my-pi/packages/ai/src/types.ts#L723)。应以 `message_end` 的最终值为准，不要把流式 `message_update` 的 partial usage 当最终统计。

### 2.3 会话累计用量

`get_session_stats` 返回：

```ts
tokens: {
  input: number;
  output: number;
  reasoning: number;
  cacheRead: number;
  cacheWrite: number;
  total: number;
};
contextUsage?: { tokens: number; contextWindow: number; percent: number };
```

类型和累计实现见 [`agent-session.ts`](../../engine/oh-my-pi/packages/coding-agent/src/session/agent-session.ts#L951) 与 [`agent-session.ts`](../../engine/oh-my-pi/packages/coding-agent/src/session/agent-session.ts#L15476)。

不要把累计 `tokens.total` 当成当前上下文占用。多轮 prompt cache 会使累计 cache read 很大，而当前上下文仍只占一个窗口。上下文圈必须使用 `contextUsage.tokens`。

### 2.4 详细构成的限制

OMP 内部的 `getContextBreakdown()` 能拆出：

- system prompt
- system tools
- system context
- skills
- messages

见 [`agent-session.ts`](../../engine/oh-my-pi/packages/coding-agent/src/session/agent-session.ts#L940) 和 [`agent-session.ts`](../../engine/oh-my-pi/packages/coding-agent/src/session/agent-session.ts#L15632)。

原生 RPC 当前只公开聚合的 `contextUsage`，没有 `get_context_breakdown` 命令，也没有 `context_usage_changed` 推送事件。直接使用原生 RPC 的宿主需在 `message_end` / `agent_end`、模型切换、`auto_compaction_end` 和手动 compact 返回后重新调用 `get_state`。

SoC Verify 使用 SDK runner，可以直接调用 `session.getContextBreakdown({ contextWindow: effectiveWindow })` 并通过自定义 runner 命令返回，无需修改 OMP 子模块。这是悬停详情最合适的数据源。

## 3. 手动 compact / 压缩

### 3.1 RPC 命令

请求：

```json
{ "id": "compact-1", "type": "compact" }
```

可附加面向摘要器的关注指令：

```json
{
  "id": "compact-2",
  "type": "compact",
  "customInstructions": "保留当前验证失败、待办和已修改文件"
}
```

命令定义及响应见 [`rpc-types.ts`](../../engine/oh-my-pi/packages/coding-agent/src/modes/rpc/rpc-types.ts#L60) 和 [官方 RPC 文档](https://github.com/can1357/oh-my-pi/blob/a0f7266fbc623817fdf11354f99bb0afd0d7bb6c/docs/rpc.md#L115-L118)。handler 直接等待 `session.compact()`，见 [`rpc-mode.ts`](../../engine/oh-my-pi/packages/coding-agent/src/modes/rpc/rpc-mode.ts#L1096)。

成功响应的 `data` 为：

```ts
type CompactionResult = {
  summary: string;
  shortSummary?: string;
  firstKeptEntryId: string;
  tokensBefore: number;
  details?: unknown;
  preserveData?: Record<string, unknown>;
};
```

定义见 [`compaction.ts`](../../engine/oh-my-pi/packages/agent/src/compaction/compaction.ts#L144)。响应没有 `tokensAfter`，完成后应再读取 context usage。

### 3.2 行为与 UI 约束

`AgentSession.compact()` 会先中止当前 agent operation，然后执行压缩；无模型、没有足够历史、正在压缩都会返回错误。实现见 [`agent-session.ts`](../../engine/oh-my-pi/packages/coding-agent/src/session/agent-session.ts#L9700)。

因此产品侧应：

- agent streaming 时禁用手动压缩按钮，避免用户无意中中断当前回答；
- 压缩期间显示进行中状态并阻止重复点击；
- 使用长超时，压缩可能包含一次额外 LLM 调用；
- 成功后立即刷新 breakdown；
- 将 “Nothing to compact (session too small)” 转成正常的用户提示。

`isCompacting` 可从 state 读取。手动 `compact` 不会发出名为 `manual_compaction_start/end` 的专用 RPC 事件；调用方应以 pending command 和最终 response 管理按钮状态。`auto_compaction_start/end` 只描述自动维护路径。

## 4. 自动压缩行为和阈值

### 4.1 默认配置

coding-agent 当前默认值：

| 设置 | 默认值 |
|---|---:|
| `compaction.enabled` | `true` |
| `compaction.strategy` | `snapcompact` |
| `compaction.midTurnEnabled` | `true` |
| `compaction.thresholdPercent` | `-1` |
| `compaction.thresholdTokens` | `-1` |
| 有效 reserve floor | `16_384` |
| `compaction.keepRecentTokens` | `20_000` |
| `compaction.autoContinue` | `true` |
| `compaction.idleEnabled` | `false` |

证据：[`settings-schema.ts`](../../engine/oh-my-pi/packages/coding-agent/src/config/settings-schema.ts#L1885)、[`settings-schema.ts`](../../engine/oh-my-pi/packages/coding-agent/src/config/settings-schema.ts#L1943)、[`settings-schema.ts`](../../engine/oh-my-pi/packages/coding-agent/src/config/settings-schema.ts#L2022) 和 [官方 compaction 默认值](https://github.com/can1357/oh-my-pi/blob/a0f7266fbc623817fdf11354f99bb0afd0d7bb6c/docs/compaction.md#L404-L419)。

### 4.2 阈值优先级

阈值解析优先级：

1. 正数 `thresholdTokens`，并 clamp 到 `1 .. contextWindow - 1`。
2. 正数 `thresholdPercent`，并 clamp 到 `1% .. 99%`。
3. 都未设置时：`contextWindow - max(15% * contextWindow, reserveTokens ?? 16_384)`。

实现见 [`compaction.ts`](../../engine/oh-my-pi/packages/agent/src/compaction/compaction.ts#L259) 和 [`compaction.ts`](../../engine/oh-my-pi/packages/agent/src/compaction/compaction.ts#L318)。只有 `contextTokens > thresholdTokens` 才触发，不是大于等于。

默认计算示例：

| Window | Reserve | 自动压缩阈值 | 占比 |
|---:|---:|---:|---:|
| 128,000 | 19,200 | 108,800 | 85% |
| 200,000 | 30,000 | 170,000 | 85% |
| 272,000 | 40,800 | 231,200 | 85% |

### 4.3 触发路径

OMP 有六类上下文维护入口，见 [官方 compaction 文档](https://github.com/can1357/oh-my-pi/blob/a0f7266fbc623817fdf11354f99bb0afd0d7bb6c/docs/compaction.md#L54-L65)：

1. 手动 compact。
2. provider 报 context overflow 后恢复。
3. assistant 以 `stopReason === "length"` 结束后的 incomplete-output 恢复。
4. 成功 turn 后超过阈值。
5. tool loop 中下一次 provider request 前，在安全边界进行 mid-turn 检查。
6. 显式 idle maintenance；默认 idle auto-compaction 关闭。

自动路径会发：

```ts
{ type: "auto_compaction_start", reason, action }
{
  type: "auto_compaction_end",
  action,
  result?: CompactionResult,
  aborted: boolean,
  willRetry: boolean,
  errorMessage?: string,
  skipped?: boolean
}
```

其中 `reason` 是 `threshold | overflow | idle | incomplete`，`action` 是 `context-full | handoff | shake | snapcompact`。定义见 [`shared-events.ts`](../../engine/oh-my-pi/packages/coding-agent/src/extensibility/shared-events.ts#L215)。

### 4.4 strategy 选择

默认 `snapcompact` 把旧历史渲染成图片帧并让视觉模型读取。它不是传统的文本摘要，而且对纯文本模型和包含无法安全渲染字符的会话有限制。

SoC Verify 若要提供稳定、易解释的“手动压缩”体验，建议在专用 runner settings 中明确使用 `context-full`，除非产品明确决定展示并支持 snapcompact。这样所有当前文本/视觉模型都走摘要式压缩，避免按钮行为随模型视觉能力改变。

## 5. 是否支持上下文插件

支持，但不是此需求的前置条件。

OMP extension context 暴露：

```ts
getContextUsage(): ContextUsage | undefined;
compact(instructionsOrOptions?: string | CompactOptions): Promise<void>;
```

见 [`extensions/types.ts`](../../engine/oh-my-pi/packages/coding-agent/src/extensibility/extensions/types.ts#L362)。

插件还可以：

- 用 `session_before_compact` 取消压缩或直接提供自定义 `CompactionResult`；
- 用 `session.compacting` 增加摘要上下文或替换 prompt；
- 用 `session_compact` 观察保存后的压缩 entry；
- 监听 `auto_compaction_start/end`。

事件和返回类型见 [`shared-events.ts`](../../engine/oh-my-pi/packages/coding-agent/src/extensibility/shared-events.ts#L63) 与 [`shared-events.ts`](../../engine/oh-my-pi/packages/coding-agent/src/extensibility/shared-events.ts#L334)。

只有在未来需要自定义 SoC 验证专用摘要格式、保留特定结构化验证状态，或替换 OMP 默认 compaction result 时，才值得写 extension。上下文圈、详情弹层和手动按钮直接走会话 API 即可。

## 6. SoC Verify 集成建议

### 6.1 现有架构差异

SoC Verify 的 runner 使用 `createAgentSession()`，见 [`runner/index.ts`](../../runner/index.ts#L192)，并把 `session.subscribe()` 事件包成自己的 `event` frame，见 [`runner/index.ts`](../../runner/index.ts#L332)。现有自定义命令仅有 `getState`，且当前返回 `session.state`，没有 OMP RPC 的 `contextUsage`，见 [`runner/index.ts`](../../runner/index.ts#L391)。

主进程协议也没有 compact / stats / breakdown 命令，见 [`src/main/agent/types.ts`](../../src/main/agent/types.ts#L40)。因此不能直接照搬 OMP RPC 命令名后假设 runner 已支持。

### 6.2 建议的数据流

在现有 runner JSONL 协议中增加两个最小命令：

```ts
type Command =
  | { id: string; type: "getContextUsage"; contextWindow?: number }
  | { id: string; type: "compact"; customInstructions?: string };
```

runner 侧：

```ts
session.getContextBreakdown({ contextWindow: effectiveWindow });
await session.compact(customInstructions);
```

建议返回的产品 DTO：

```ts
type ContextDetails = {
  usedTokens: number;
  contextWindow: number;
  percent: number;
  remainingTokens: number;
  systemPromptTokens: number;
  systemToolsTokens: number;
  systemContextTokens: number;
  skillsTokens: number;
  messagesTokens: number;
  autoCompactionEnabled: boolean;
  isCompacting: boolean;
};
```

主进程 SessionManager 缓存最新 `ContextDetails` 并随现有 `session:event` 转发；renderer session store 负责圈圈显示。刷新时机：

- session 初始化完成；
- `message_end` 或 `agent_end`；
- `auto_compaction_end`；
- 手动 compact response；
- 模型或用户 context 设置变化。

不需要在每个 `message_update` token delta 后查询。provider 通常只在响应结束时给出权威 usage，逐 delta 查询既不准确又产生协议噪声。

### 6.3 设置语义

- 默认配置值：`200_000`。
- 校验为正整数，并设置合理产品范围。
- session 启动时计算 `effectiveWindow`，绝不超过已知模型 window。
- 该值影响上下文圈的 denominator 和应用自动压缩阈值。
- 不应静默写用户全局 `~/.omp/agent/models.yml`；那会影响 SoC Verify 之外的 omp 会话。
- 设置变更后，对新 session 必须生效；若要对当前 session 立即生效，应同步更新 session settings 的 threshold，并刷新 context DTO。

### 6.4 悬停详情建议

基础区：当前 `used / effectiveWindow`、百分比、剩余 token。

构成区：system prompt、tools、project/context files、skills、messages。上述五项来自 `getContextBreakdown()`，数值中 provider 报告的总 prompt usage 是权威锚点，各分类包含本地估算，因此 UI 文案宜写“估算构成”。

可选统计区：最近一轮 input/output/cache read/cache write。这些是“本轮用量”，不要混入当前上下文占用圆环。

操作区：手动压缩按钮；streaming 或 compacting 时禁用。

## 最终建议

采用“Omp SDK 原生会话能力 + 现有 runner 协议扩展”的实现：

1. 不创建 context extension，不修改 `engine/oh-my-pi`。
2. 设置页保存默认 200K 的应用上下文上限，并按模型真实 window clamp。
3. runner 直接返回 `getContextBreakdown()`，满足圆环和悬停详情。
4. runner 直接调用 `session.compact()`，完成手动压缩。
5. 明确配置 `context-full` strategy，并用 effective window 推导自动压缩阈值。
6. 以 `message_end` / compact 生命周期刷新状态，避免把累计 token 当当前上下文。

