/**
 * pi 会话命令处理器 —— init / prompt / regenerate / steer / abort / setModel /
 * setApprovalMode / getMcpStatus / getMcpServerTools / reloadMcp / compact / destroy。
 *
 * init 通过 pi SDK 创建 AgentSession（原生用户级 session 根 + cwd bucket）：
 *   - 注册 host 转发工具（含 `ask`）作为 customTools；
 *   - DefaultResourceLoader 装配内联扩展：单次工具审批门（tool_call 拦截）、
 *     MCP 状态快照转发（pi.events 订阅）、pi-mcp-adapter（jiti 加载 TS 源码，
 *     显式注入单一来源配置绕开其多源合并）；
 *   - loader.reload({ resolveProjectTrust }) 走 host 信任存储 + 用户确认的
 *     项目信任决策，替代 SDK 默认的 ~/.pi trust.json 流程；
 * - 订阅 pi 原生事件并经 event-normalizer 归一化后转发给 host。
 *
 * pi 的 ToolDefinition 参数 schema 要求 TypeBox 类型，而 host 下发的是
 * JSON Schema 对象。运行时两者兼容（TypeBox 即 JSON Schema + 元数据符号，
 * omp runner 以同样方式透传），在 createAgentSession 边界做一次受控转换。
 */

import {
	createAgentSession,
	DefaultResourceLoader,
	getAgentDir,
	hasTrustRequiringProjectResources,
	ModelRuntime,
	SessionManager,
	SettingsManager,
	type AgentSession,
	type InlineExtension,
	type ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import { classifyContentBlock } from "./message-blocks.ts";
import { join } from "node:path";
import { createJiti } from "jiti";
import type { ApprovalMode } from "./approval-logic";
import {
	type Command,
	type HostToolDefinition,
	type InitConfig,
	type PiRunnerContext,
	type SeedHistoryMessage,
	type SessionRecoveryMode,
	sendEvent,
	sendResponse,
} from "./protocol.ts";
import { normalizePiEvent } from "./event-normalizer.ts";
import { mapPiContextUsage, sendContextUsage, shouldSendContextUsage } from "./context-usage.ts";
import { toPiThinkingLevel } from "./thinking-level.ts";
import { buildAppendSystemPrompt } from "./system-prompt.ts";
import { resolveMcpConfigSource } from "./mcp-config.ts";
import {
	createMcpRuntimeState,
	mapSnapshotToHostStatus,
	MCP_STATUS_CHANNEL,
	selectServerToolsFromSession,
	type AdapterStatusSnapshot,
	type McpRuntimeState,
} from "./mcp-runtime.ts";
import {
	buildTrustedMcpServers,
	resolveProjectTrustDecision,
	resolveToolCallGate,
} from "./extensions.ts";
import {
	buildRpcStopRequest,
	normalizeSubagentFrame,
	resolveSubagentCeiling,
	RPC_REQUEST_CHANNEL,
	SUBAGENT_CHANNELS,
	SUBAGENT_ASYNC_COMPLETE_CHANNEL,
	SUBAGENT_CHILD_STATUS_CHANNEL,
	SUBAGENT_DELEGATION_RESPONSE_CHANNEL,
	trackSubagentRun,
	type SubagentEventBus,
	type SubagentRuntime,
} from "./subagents.ts";

// ─── 自定义工具注册（ask 等 host 转发工具） ─────────────

type ForwardedToolDefinition = {
	name: string;
	label: string;
	description: string;
	parameters: Record<string, unknown>;
	execute(
		toolCallId: string,
		params: unknown,
		signal: AbortSignal | undefined,
		onUpdate: unknown,
		extensionCtx: unknown,
	): Promise<unknown>;
};

function buildCustomTools(
	defs: HostToolDefinition[],
	ctx: PiRunnerContext,
): ForwardedToolDefinition[] {
	return defs.map((def) => ({
		name: def.name,
		label: def.label ?? def.name,
		description: def.description,
		parameters: def.parameters,
		async execute(
			_toolCallId: string,
			params: unknown,
			_signal: AbortSignal | undefined,
			_onUpdate: unknown,
			_extensionCtx: unknown,
		): Promise<unknown> {
			try {
				const result = await ctx.callHostTool(def.name, params);
				if (typeof result === "string") {
					return { content: [{ type: "text", text: result }] };
				}
				return result;
			} catch (err) {
				return {
					content: [{ type: "text", text: err instanceof Error ? err.message : String(err) }],
					isError: true,
				};
			}
		},
	}));
}

// ─── pi-mcp-adapter 加载（jiti，TS 源码入口） ───────────

/**
 * pi-mcp-adapter 的 package.json "." 出口是 TypeScript 源码（index.ts），
 * Node 无法直接导入（node_modules 内不做 type stripping）。runner 以 jiti
 * 加载；模块缓存一次，随进程生命周期复用。
 */
interface McpAdapterModule {
	createMcpAdapter(options?: {
		config?: { mcpServers: Record<string, unknown> };
		configPath?: string;
	}): (pi: unknown) => void;
}

let mcpAdapterModulePromise: Promise<McpAdapterModule> | null = null;

function loadMcpAdapter(): Promise<McpAdapterModule> {
	mcpAdapterModulePromise ??= createJiti(import.meta.url)
		.import("pi-mcp-adapter")
		.then((mod) => {
			const resolved = mod as McpAdapterModule | { default?: McpAdapterModule };
			const adapter =
				"createMcpAdapter" in resolved ? resolved : (resolved.default ?? null);
			if (!adapter || typeof adapter.createMcpAdapter !== "function") {
				throw new Error("pi-mcp-adapter loaded but createMcpAdapter export missing");
			}
			return adapter;
		});
	return mcpAdapterModulePromise;
}

// ─── pi-subagents 加载（jiti，TS 源码入口）──────────────

interface SubagentsModule {
	default: (pi: unknown) => void;
}

interface CapabilityCeilingModule {
	registerSubagentCapabilityCeiling(options: {
		sessionId: string;
		source: string;
		ceiling: { denyExtensions: true };
	}): { update(ceiling: { denyExtensions: true }): void; dispose(): void };
}

/**
 * pi-subagents 的 package.json "." 出口是 TypeScript 源码（index.ts），
 * 与 pi-mcp-adapter 同理由 jiti 加载（模块缓存随进程复用）。
 */
function loadSubagentsModule(): Promise<SubagentsModule> {
	return createJiti(import.meta.url)
		.import("pi-subagents")
		.then((mod) => {
			const resolved = mod as { default?: unknown };
			const factory = resolved.default;
			if (typeof factory !== "function") {
				throw new Error("pi-subagents loaded but default extension factory missing");
			}
			return { default: factory as (pi: unknown) => void };
		});
}

function loadCapabilityCeilingModule(): Promise<CapabilityCeilingModule> {
	return createJiti(import.meta.url).import("pi-subagents/capability-ceiling") as Promise<CapabilityCeilingModule>;
}

// ─── 内联扩展装配（审批 / trust / MCP） ─────────────────

/**
 * 单次工具审批扩展：拦截所有工具调用（pi 内置、host 工具、MCP、extension），
 * 按当前审批模式决定是否请求用户审批。审批模式运行时可变（setApprovalMode），
 * 因此 getMode 闭包读取 ctx 而非快照。
 */
function buildApprovalExtension(ctx: PiRunnerContext): InlineExtension {
	return {
		name: "socverify-approval",
		hidden: true,
		factory: (pi) => {
			pi.on("tool_call", async (event) =>
				resolveToolCallGate(
					event.toolName,
					event.input,
					() => ctx.currentApprovalMode,
					ctx.requestApproval,
				),
			);
		},
	};
}

/**
 * MCP 状态转发扩展：pi-mcp-adapter 在共享事件总线上发布状态快照
 * （channel pi-mcp-adapter/status/v1），此扩展订阅并写入 runner 侧运行时
 * 状态，供 getMcpStatus 查询 —— 无 TUI 场景下 adapter 唯一的 headless 出口。
 */
function buildMcpStatusExtension(runtime: McpRuntimeState): InlineExtension {
	return {
		name: "socverify-mcp-status",
		hidden: true,
		factory: (pi) => {
			pi.events.on(MCP_STATUS_CHANNEL, (data: unknown) => {
				runtime.applyStatusSnapshot(data as AdapterStatusSnapshot);
			});
		},
	};
}

interface McpAssembly {
	factories: InlineExtension[];
	/** 冲突/回退报告（host 展示用） */
	ignored: Awaited<ReturnType<typeof resolveMcpConfigSource>>["ignored"];
}

/**
 * MCP 装配：解析单一来源配置 → 信任过滤（未信任 server 逐个请求用户确认）
 * → adapter 工厂显式注入 server 集。无可用 server 时 adapter 不加载。
 */
async function assembleMcp(config: InitConfig, ctx: PiRunnerContext): Promise<McpAssembly> {
	if (config.enableMCP === false) {
		return { factories: [], ignored: [] };
	}

	const resolution = await resolveMcpConfigSource(config.cwd);
	const plan = await buildTrustedMcpServers(resolution, {
		enableMCP: true,
		trustedMcpServers: config.trustedMcpServers ?? [],
		requestTrust: ctx.requestTrust,
	});

	const runtime = createMcpRuntimeState(Object.keys(plan.mcpServers));
	runtime.configSourcePath = resolution.selected?.path ?? null;
	ctx.mcpRuntime = runtime;

	if (Object.keys(plan.mcpServers).length === 0) {
		return { factories: [], ignored: plan.ignored };
	}

	const adapter = await loadMcpAdapter();
	const mcpAdapterFactory = adapter.createMcpAdapter({
		config: { mcpServers: plan.mcpServers },
	});

	return {
		factories: [
			buildMcpStatusExtension(runtime),
			{
				name: "socverify-mcp-adapter",
				hidden: true,
				// adapter 工厂经 jiti 以 unknown 类型载入；pi 侧实参由 SDK 保证
				factory: (pi) => {
					(mcpAdapterFactory as (p: unknown) => void)(pi);
				},
			},
		],
		ignored: plan.ignored,
	};
}

// ─── subagent 装配（issue 05）───────────────────────────

/**
 * subagent 事件桥：订阅 pi-subagents 在 pi.events 发布的通道，归一化为
 * host SubagentFrame 契约后转发；同时跟踪活动 run（取消传播/清理用）并
 * 注入 pi.events 引用供 cancelSubagent 命令使用。
 */
function buildSubagentBridgeExtension(ctx: PiRunnerContext, runtime: SubagentRuntime): InlineExtension {
	return {
		name: "socverify-subagent-bridge",
		hidden: true,
		factory: (pi) => {
			const events = (pi as { events?: SubagentEventBus }).events ?? null;
			runtime.events = events;
			if (!events) return;

			for (const channel of SUBAGENT_CHANNELS) {
				events.on(channel, (payload: unknown) => {
					// 活动 run 登记（async-started）：destroy 时据此下发 stop
					trackSubagentRun.onStart(runtime.registry, { channel, payload });
					for (const frame of normalizeSubagentFrame(channel, payload, {
						parentSessionId:
							ctx.session != null
								? ((ctx.session as { sessionId?: string }).sessionId ?? null)
								: null,
					})) {
						if (
							frame.type === "subagent_lifecycle" &&
							(channel === SUBAGENT_DELEGATION_RESPONSE_CHANNEL ||
								channel === SUBAGENT_ASYNC_COMPLETE_CHANNEL ||
								channel === SUBAGENT_CHILD_STATUS_CHANNEL)
						) {
							trackSubagentRun.onTerminal(runtime.registry, String(frame.payload.id));
						}
						sendEvent(frame);
					}
				});
			}
		},
	};
}

type SubagentsAssembly = {
	factories: InlineExtension[];
};

/**
 * subagent 装配：加载 pi-subagents 扩展 + 事件桥。
 *
 * 能力不足不静默降级：加载失败时 runtime.enabled=false 且携带显式
 * blockedReason（init response 透出 + notice 事件），host/UI 必须展示。
 */
async function assembleSubagents(config: InitConfig, ctx: PiRunnerContext): Promise<SubagentsAssembly> {
	const runtime: SubagentRuntime = {
		enabled: false,
		blockedReason: null,
		registry: trackSubagentRun.create(),
		events: null,
		ceilingHandle: null,
	};
	ctx.subagentRuntime = runtime;

	if (config.enableSubagents === false) {
		return { factories: [] };
	}

	let extensionFactory: (pi: unknown) => void;
	try {
		const mod = await loadSubagentsModule();
		extensionFactory = (pi: unknown) => {
			mod.default(pi);
		};
	} catch (err) {
		const reason = err instanceof Error ? err.message : String(err);
		runtime.blockedReason = `Subagent extension unavailable: ${reason}`;
		return { factories: [] };
	}

	runtime.enabled = true;
	return {
		factories: [
			buildSubagentBridgeExtension(ctx, runtime),
			{
				name: "socverify-subagents",
				hidden: true,
				factory: (pi) => {
					extensionFactory(pi);
				},
			},
		],
	};
}

/**
 * 注册审批继承 ceiling（session 创建后调用，需要 sessionId）。
 * yolo 不注册（单次审批放宽；extension/MCP 信任边界独立于审批模式）。
 */
async function registerApprovalInheritance(runtime: SubagentRuntime | null, sessionId: string, mode: ApprovalMode): Promise<void> {
	if (!runtime?.enabled) return;
	const ceiling = resolveSubagentCeiling(mode);
	if (!ceiling) return;
	try {
		const mod = await loadCapabilityCeilingModule();
		runtime.ceilingHandle = mod.registerSubagentCapabilityCeiling({
			sessionId,
			source: "socverify-approval-inheritance",
			ceiling,
		});
	} catch (err) {
		const reason = err instanceof Error ? err.message : String(err);
		runtime.blockedReason = `Subagent approval inheritance unavailable: ${reason}`;
	}
}

// ─── 原生 session 恢复与 transcript 重建（issue 07）──────

/**
 * 提取 session entry 树中首条 user message 的纯文本。用于检测原生文件是否
 * 与 UI transcript 对齐：不匹配说明该文件只覆盖对话尾部（半覆盖），恢复它会
 * 静默丢失更早的 turn —— 必须改走 transcript 全量重建。
 */
function firstUserMessageText(manager: { getEntries(): unknown[] }): string | undefined {
	for (const entry of manager.getEntries()) {
		const e = entry as { type?: string; message?: { role?: string; content?: unknown } };
		if (e.type !== "message") continue;
		const msg = e.message;
		if (msg?.role !== "user") continue;
		const content = msg.content;
		if (typeof content === "string") return content.trim();
		if (Array.isArray(content)) {
			return content
				.filter(
					(b): b is { type: "text"; text: string } =>
						typeof b === "object" && b !== null && (b as { type?: string }).type === "text",
				)
				.map((b) => b.text)
				.join("\n")
				.trim();
		}
		return undefined;
	}
	return undefined;
}

/**
 * 原生恢复：在持久化 cwd 的 canonical bucket 中查找 resumeSessionId 对应的
 * pi 原生 session 并打开。不传 sessionDir —— pi 默认用户级根目录 + cwd bucket
 * （不新增项目级副本）。首条 user message 与 seedHistory 不一致时不恢复。
 * 任何失败（缺失 / 损坏 / 不匹配）返回 null，由调用方降级重建。
 */
async function openNativeSession(config: InitConfig): Promise<SessionManager | null> {
	if (!config.resumeSessionId) return null;
	try {
		const sessions: Array<{ id: string; path: string }> = await SessionManager.list(config.cwd);
		const target = sessions.find((s) => s.id === config.resumeSessionId);
		if (!target) {
			console.error(
				`[socverify-runner] native pi session ${config.resumeSessionId} not found in cwd bucket — rebuilding from transcript`,
			);
			return null;
		}
		const candidate = SessionManager.open(target.path);
		const seedFirstUser = config.seedHistory?.find((m) => m.role === "user")?.content.trim();
		if (seedFirstUser === undefined) return candidate;
		const nativeFirstUser = firstUserMessageText(candidate);
		if (nativeFirstUser === seedFirstUser) return candidate;
		console.error(
			`[socverify-runner] native pi session ${config.resumeSessionId} covers only a partial transcript (first user message mismatch) — rebuilding from stored UI history`,
		);
		return null;
	} catch (err) {
		console.error(
			`[socverify-runner] native pi session ${config.resumeSessionId} unavailable (${err instanceof Error ? err.message : String(err)}) — rebuilding from stored UI history`,
		);
		return null;
	}
}

/**
 * 把 UI transcript 写入新 session（重建路径）。种子消息使用零 usage 的占位
 * AssistantMessage（context builder 只读 content blocks，bookkeeping 字段不参与）。
 */
function seedTranscript(manager: SessionManager, seedHistory: SeedHistoryMessage[], config: InitConfig): void {
	const seededProvider = config.provider ?? "socverify-openai-compatible";
	const seededModel = config.model ?? "unknown";
	for (const msg of seedHistory) {
		if (msg.role === "user") {
			manager.appendMessage({
				role: "user",
				content: msg.content,
				timestamp: msg.timestamp,
			});
		} else {
			manager.appendMessage({
				role: "assistant",
				content: [{ type: "text", text: msg.content }],
				api: "openai-completions",
				provider: seededProvider,
				model: seededModel,
				stopReason: "stop",
				timestamp: msg.timestamp,
				usage: {
					input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0,
					cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
				},
			});
		}
	}
	console.error(`[socverify-runner] seeded ${seedHistory.length} messages from stored UI history into new pi session`);
}

/**
 * 解析 init 使用的 SessionManager 与恢复模式（issue 07）：
 *   native  —— 原生 session 命中且校验通过（权威历史，含工具结果/分支/compaction）
 *   rebuilt —— 原生不可用，create(cwd) 重建并写入 transcript（新 bucket、新 sessionId）
 *   new     —— 全新会话（无可恢复历史）
 */
async function resolveSessionManager(
	config: InitConfig,
): Promise<{ manager: SessionManager; recovery: SessionRecoveryMode }> {
	const resumed = await openNativeSession(config);
	if (resumed) return { manager: resumed, recovery: "native" };

	const manager = SessionManager.create(config.cwd);
	if (config.seedHistory && config.seedHistory.length > 0) {
		seedTranscript(manager, config.seedHistory, config);
		return { manager, recovery: "rebuilt" };
	}
	return { manager, recovery: "new" };
}

// ─── init ───────────────────────────────────────────────

export async function handleInit(
	cmd: Command & { type: "init" },
	ctx: PiRunnerContext,
): Promise<void> {
	const config = cmd.config;
	ctx.currentCwd = config.cwd;
	ctx.currentApprovalMode = config.approvalMode ?? "always-ask";

	// 应用环境变量（provider 认证等）
	if (config.env) {
		for (const [key, value] of Object.entries(config.env)) {
			process.env[key] = value;
		}
	}

	// OpenAI 兼容 provider：把 apiKey/baseUrl 同步到标准环境变量，
	// 供 pi-ai 的 openai-compatible provider 解析（与 omp runner 行为一致）。
	if (config.apiKey && config.provider) {
		const provider = config.provider.toLowerCase();
		const isOpenAiCompat =
			provider === "openai" || provider === "openai-compatible" || provider.includes("openai-compat");
		if (isOpenAiCompat) {
			process.env.OPENAI_API_KEY = config.apiKey;
			if (config.baseUrl) {
				process.env.OPENAI_BASE_URL = config.baseUrl;
			}
		}
	}

	// 资源装载器：内联扩展（审批门 + MCP + subagent）+ host 信任存储驱动的项目信任决策
	// appendSystemPrompt：Effective System Prompt = pi 基础提示词（base prompt）→ 用户自定义
	// 提示词 → SoC Verify 应用规则（issue 06，不做整体替换）。
	const mcp = await assembleMcp(config, ctx);
	const subagents = await assembleSubagents(config, ctx);
	const agentDir = getAgentDir();
	const loader = new DefaultResourceLoader({
		cwd: config.cwd,
		agentDir,
		settingsManager: SettingsManager.create(config.cwd, agentDir),
		extensionFactories: [buildApprovalExtension(ctx), ...mcp.factories, ...subagents.factories],
		appendSystemPrompt: buildAppendSystemPrompt(config.systemPrompt),
	});
	await loader.reload({
		// 项目信任：host 信任存储（trustedProjectDirs）命中直接放行；否则请求
		// 用户确认。拒绝时 pi 以 untrusted 设置装载（项目 extension 不加载）。
		resolveProjectTrust: async () =>
			resolveProjectTrustDecision(
				config.cwd,
				config.trustedProjectDirs ?? [],
				hasTrustRequiringProjectResources(config.cwd),
				ctx.requestTrust,
			),
	});

	// 初始思考强度：'default'/'auto' 不下发（跟随引擎默认，pi 会按模型能力 clamp）
	const initialThinkingLevel = toPiThinkingLevel(config.thinkingLevel);

	// 原生 session 恢复优先，缺失/损坏/不匹配时 transcript 重建（issue 07）。
	// SessionManager.list/open 不传 sessionDir —— pi 原生用户级根目录 + cwd bucket。
	const { manager, recovery } = await resolveSessionManager(config);

	// modelsPath 解耦（issue 07）：host 为 pi 引擎提供独立 models.json（临时目录），
	// agentDir 保持用户级 —— session 与模型配置不共用目录，原生 session 不随
	// 临时 runtimeDir 销毁而丢失。
	const modelRuntime = config.modelsPath
		? await ModelRuntime.create({
				authPath: join(getAgentDir(), "auth.json"),
				modelsPath: config.modelsPath,
			})
		: undefined;

	const result = await createAgentSession({
		cwd: config.cwd,
		sessionManager: manager,
		...(modelRuntime ? { modelRuntime } : {}),
		resourceLoader: loader,
		customTools: buildCustomTools(
			config.customToolDefinitions ?? [],
			ctx,
		) as unknown as ToolDefinition[],
		excludeTools: config.disabledTools,
		...(initialThinkingLevel ? { thinkingLevel: initialThinkingLevel } : {}),
	});
	const session = result.session;
	ctx.session = session;

	// 运行时 API key（优先于 auth.json 的凭证）
	if (config.apiKey && config.provider) {
		await session.modelRuntime.setRuntimeApiKey(config.provider, config.apiKey);
	}

	// 初始模型选择：注册表命中时切换；未命中保持引擎默认模型。
	// contextWindow 覆盖（issue 06）：host 配置窗口与模型声明窗口取 min
	// （与 omp runner 语义一致），以浅拷贝应用、不改写注册表对象。
	if (config.provider && config.model) {
		const model = session.modelRuntime.getModel(config.provider, config.model);
		if (model) {
			await session.setModel(applyContextWindowOverride(model, config.contextWindow));
		}
	}

	// 订阅 pi 原生事件 → 归一化为 Agent Event Contract → 转发 host。
	// pi 原生事件名不越出 runner 进程（issue 03 验收标准）。
	// 上下文增长边界（message_end / agent_end / compaction）额外推送
	// context_usage（pi 原生值优先，issue 06）。
	ctx.unsubscribe = session.subscribe((event) => {
		for (const normalized of normalizePiEvent(event)) {
			sendEvent(normalized);
		}
		if (
			typeof event === "object" &&
			event !== null &&
			typeof (event as { type?: unknown }).type === "string" &&
			shouldSendContextUsage((event as { type: string }).type)
		) {
			sendContextUsage(session);
		}
	});
	sendContextUsage(session);

	// 审批继承：按父会话 sessionId 注册 subagent capability ceiling（yolo 不收紧）
	await registerApprovalInheritance(ctx.subagentRuntime, session.sessionId, ctx.currentApprovalMode);

	// subagent 能力状态透出（能力不足时 host 显式展示阻断原因，不静默降级）
	const subagentStatus = ctx.subagentRuntime
		? { enabled: ctx.subagentRuntime.enabled, blockedReason: ctx.subagentRuntime.blockedReason }
		: { enabled: false, blockedReason: "Subagent runtime not assembled" };
	if (subagentStatus.blockedReason) {
		sendEvent({ type: "notice", text: subagentStatus.blockedReason, message: subagentStatus.blockedReason });
	}

	// recovered 标记（issue 07）：host 据此在重建后更新 engineSessionId
	// （重建 = 新 pi session id；原生恢复时 id 与持久化记录一致）。
	sendResponse(cmd.id, true, {
		sessionId: session.sessionId,
		recovered: recovery,
		subagent: subagentStatus,
	});
}

// ─── 图片解析 ───────────────────────────────────────────

/** data URL（data:image/png;base64,...）解析 MIME；裸 base64 回退 image/png。 */
function parseImage(img: string): { type: "image"; data: string; mimeType: string } {
	const match = /^data:([^;]+);base64,(.+)$/.exec(img);
	if (match) {
		return { type: "image", data: match[2], mimeType: match[1] };
	}
	return { type: "image", data: img, mimeType: "image/png" };
}

// ─── prompt / steer / abort ─────────────────────────────

export async function handlePrompt(
	cmd: Command & { type: "prompt" },
	ctx: PiRunnerContext,
): Promise<void> {
	if (!ctx.session) throw new Error("Session not initialized");
	const session = ctx.session as AgentSession;
	let images: Array<{ type: "image"; data: string; mimeType: string }> | undefined;
	if (cmd.images?.length) {
		images = cmd.images.map(parseImage);
	}
	await session.prompt(cmd.message, images ? { images } : undefined);
	sendResponse(cmd.id, true, { ok: true });
}

export async function handleSteer(
	cmd: Command & { type: "steer" },
	ctx: PiRunnerContext,
): Promise<void> {
	if (!ctx.session) throw new Error("Session not initialized");
	await (ctx.session as AgentSession).steer(cmd.message);
	sendResponse(cmd.id, true, { ok: true });
}

export async function handleAbort(
	cmd: Command & { type: "abort" },
	ctx: PiRunnerContext,
): Promise<void> {
	if (!ctx.session) throw new Error("Session not initialized");
	await (ctx.session as AgentSession).abort();
	sendResponse(cmd.id, true, { ok: true });
}

// ─── regenerate（issue 08：真实分支 + 新 engineSessionId）─

/**
 * 提取 user message 内容中的纯文本与图片块。文本块以换行拼接；
 * 图片块原样透传给 prompt（PromptOptions.images）。
 */
function extractUserContent(content: unknown): {
	text: string;
	images: Array<{ type: "image"; data: string; mimeType: string }> | undefined;
} {
	if (typeof content === "string") {
		return { text: content, images: undefined };
	}
	if (!Array.isArray(content)) {
		return { text: "", images: undefined };
	}
	const textParts: string[] = [];
	const images: Array<{ type: "image"; data: string; mimeType: string }> = [];
	for (const block of content) {
		const b = classifyContentBlock(block);
		if (!b) continue;
		if (b.kind === "text") {
			textParts.push(b.text);
		} else {
			images.push({ type: "image", data: b.data, mimeType: b.mimeType });
		}
	}
	return { text: textParts.join("\n"), images: images.length > 0 ? images : undefined };
}

/**
 * Regenerate 最后一个回合（issue 08）：创建真实新分支并产生新的
 * engineSessionId，旧分支的文件不被修改或删除（parentSession 链保留回看入口）。
 *
 * 分支点 = 最后一条 user message 的 parent（Regenerate Branch 语义：新分支在
 * user message 之前分叉，re-prompt 以同一文本重新追加 user turn）。
 *   - 持久化 manager：createBranchedSession(parentId) 在同一 bucket 创建新
 *     文件并原地切换（新 sessionId，header 记录 parentSession 链）；最后一条
 *     user message 是根（parentId null）时用 newSession() 开新文件。
 *   - 非持久化 manager（in-memory）：退化为同文件 branch()/resetLeaf()，
 *     sessionId 不变。
 * 分支后按 SDK navigateTree 的模式重置 agent 内存状态，再以原文本
 * fire-and-forget re-prompt —— response 先行（host 拿到新 engineSessionId
 * 持久化），turn 结果经正常事件通道流回。
 */
export async function handleRegenerate(
	cmd: Command & { type: "regenerate" },
	ctx: PiRunnerContext,
): Promise<void> {
	if (!ctx.session) {
		sendResponse(cmd.id, false, undefined, "Session not initialized");
		return;
	}
	const session = ctx.session as AgentSession;
	if (session.isStreaming) {
		sendResponse(cmd.id, false, undefined, "Session is streaming — wait until idle before regenerating");
		return;
	}

	const manager = session.sessionManager;
	let lastUser: { parentId: string | null; content: unknown } | null = null;
	for (const entry of manager.getBranch()) {
		const e = entry as {
			parentId: string | null;
			type?: string;
			message?: { role?: string; content?: unknown };
		};
		if (e.type === "message" && e.message?.role === "user") {
			lastUser = { parentId: e.parentId, content: e.message.content };
		}
	}
	if (!lastUser) {
		sendResponse(cmd.id, false, undefined, "No user message to regenerate");
		return;
	}

	const { text, images } = extractUserContent(lastUser.content);

	if (lastUser.parentId === null) {
		// 分支点在根之前：开全新 session 文件（同样产生新 id）
		if (manager.newSession() === undefined) {
			manager.resetLeaf();
		}
	} else if (manager.createBranchedSession(lastUser.parentId) === undefined) {
		// 非持久化 manager：退化为同文件分支（不产生新 id）
		manager.branch(lastUser.parentId);
	}

	// 分支后重置 agent 内存状态（与 SDK navigateTree 相同的模式），
	// 丢弃被重新生成的旧回合。
	session.agent.state.messages = manager.buildSessionContext().messages;

	sendResponse(cmd.id, true, { engineSessionId: manager.getSessionId() });

	// fire-and-forget：response 已发出，turn 结果经事件通道流回；
	// re-prompt 失败不影响已发出的 response。
	void session.prompt(text, images ? { images } : undefined).catch((err: unknown) => {
		const reason = err instanceof Error ? err.message : String(err);
		console.error(`[socverify-runner] regenerate re-prompt failed: ${reason}`);
		sendEvent({ type: "error", error: reason, message: reason });
	});
}

// ─── setModel ───────────────────────────────────────────

/**
 * contextWindow 覆盖（issue 06）：host 配置窗口与模型声明窗口取 min，
 * 以浅拷贝应用（不改写注册表对象）。init 与运行时 setModel 共用，
 * 保证运行时切换模型不丢 host 配置窗口。
 */
function applyContextWindowOverride<T extends { contextWindow?: number }>(
	model: T,
	configuredWindow: number | undefined,
): T {
	const advertisedWindow = model.contextWindow ?? 0;
	const configWindow = configuredWindow ?? 0;
	const effectiveWindow =
		advertisedWindow > 0
			? configWindow > 0
				? Math.min(configWindow, advertisedWindow)
				: advertisedWindow
			: configWindow;
	return effectiveWindow > 0 && effectiveWindow !== advertisedWindow
		? { ...model, contextWindow: effectiveWindow }
		: model;
}

export async function handleSetModel(
	cmd: Command & { type: "setModel" },
	ctx: PiRunnerContext,
): Promise<void> {
	if (!ctx.session) throw new Error("Session not initialized");
	const session = ctx.session as AgentSession;
	const model = session.modelRuntime.getModel(cmd.provider, cmd.modelId);
	if (!model) {
		throw new Error(`Model not found: ${cmd.provider}/${cmd.modelId}`);
	}
	await session.setModel(applyContextWindowOverride(model, ctx.configuredContextWindow));
	sendResponse(cmd.id, true, { ok: true });
}

// ─── setThinkingLevel（issue 06）────────────────────────

/**
 * 动态设置会话思考强度。
 * 'default'/'auto'：交还引擎默认 —— 按 pi SDK 的默认解析顺序重置
 * （模型级覆盖 → 全局默认值 → 兜底 'medium'），而不是保持上次设置的值。
 * 具体强度原样透传，pi 会按模型能力 clamp；变更写入 session transcript。
 */
export function handleSetThinkingLevel(
	cmd: Command & { type: "setThinkingLevel" },
	ctx: PiRunnerContext,
): void {
	if (!ctx.session) throw new Error("Session not initialized");
	const session = ctx.session as AgentSession;
	if (cmd.level === "default" || cmd.level === "auto") {
		const settings = (session as { settingsManager?: { getModelThinkingLevel?(p: string, m: string): unknown; getDefaultThinkingLevel?(): unknown } }).settingsManager;
		const model = session.model;
		const perModel =
			model && settings?.getModelThinkingLevel
				? (settings.getModelThinkingLevel(model.provider, model.id) as string | undefined)
				: undefined;
		const globalDefault = settings?.getDefaultThinkingLevel
			? (settings.getDefaultThinkingLevel() as string | undefined)
			: undefined;
		const resolved = (perModel ?? globalDefault ?? "medium") as Parameters<
			typeof session.setThinkingLevel
		>[0];
		session.setThinkingLevel(resolved);
	} else {
		session.setThinkingLevel(cmd.level);
	}
	sendResponse(cmd.id, true, { ok: true });
}

// ─── setToolFilter / listAgentTools（issue 06）──────────

/** 动态更新禁用工具列表：从当前活动工具集中移除（`ask` 强制保留）。 */
export function handleSetToolFilter(
	cmd: Command & { type: "setToolFilter" },
	ctx: PiRunnerContext,
): void {
	if (!ctx.session) throw new Error("Session not initialized");
	const session = ctx.session as AgentSession;
	const disabled = new Set(cmd.disabledTools ?? []);
	// `ask` 是 host 问答通道，禁用会阻断 Agent 向用户提问 —— 强制保留。
	disabled.delete("ask");
	const enabled = session.getActiveToolNames().filter((name) => !disabled.has(name));
	if (!enabled.includes("ask")) enabled.push("ask");
	session.setActiveToolsByName(enabled);
	sendResponse(cmd.id, true, { ok: true, disabledCount: disabled.size });
}

/** 枚举会话当前注册的全部工具（设置页工具面板展示用）。 */
export function handleListAgentTools(cmd: Command & { type: "listAgentTools" }, ctx: PiRunnerContext): void {
	if (!ctx.session) throw new Error("Session not initialized");
	const tools = (ctx.session as AgentSession)
		.getAllTools()
		.map((t) => ({
			name: t.name,
			description: typeof t.description === "string" ? t.description : "",
		}));
	sendResponse(cmd.id, true, { tools });
}

// ─── getState / getMessages / getSystemPrompt（issue 06）─

export function handleGetMessages(cmd: Command & { type: "getMessages" }, ctx: PiRunnerContext): void {
	if (!ctx.session) throw new Error("Session not initialized");
	const messages = (ctx.session as AgentSession).messages;
	sendResponse(cmd.id, true, { messages });
}

/**
 * 返回会话状态快照：模型、思考强度、context_usage（pi 原生值优先，
 * 未知时近似估算并带 approximate 标记）、压缩状态与当前 provider 认证状态。
 */
export function handleGetState(cmd: Command & { type: "getState" }, ctx: PiRunnerContext): void {
	if (!ctx.session) throw new Error("Session not initialized");
	const session = ctx.session as AgentSession & {
		autoCompactionEnabled: boolean;
		modelRuntime: { getProviderAuthStatus(providerId: string): unknown };
	};
	const model = session.model
		? { provider: session.model.provider, id: session.model.id }
		: undefined;
	const nativeUsage = session.getContextUsage?.();
	// 认证状态查询 provider：优先当前模型，未选模型时回退 init 的 provider
	const authProvider = model?.provider ?? ctx.currentProvider;
	const state = {
		model,
		thinkingLevel: session.thinkingLevel,
		contextUsage: mapPiContextUsage(nativeUsage, { messages: session.messages }),
		isCompacting: session.isCompacting === true,
		autoCompactionEnabled: session.autoCompactionEnabled !== false,
		authStatus:
			authProvider != null
				? session.modelRuntime.getProviderAuthStatus(authProvider)
				: undefined,
	};
	sendResponse(cmd.id, true, { state });
}

/**
 * 返回会话当前生效的系统提示词（AgentSession.systemPrompt getter =
 * pi 基础提示词 + 附加内容经扩展修改后的最终值），供设置/会话 UI 查看。
 */
export function handleGetSystemPrompt(cmd: Command & { type: "getSystemPrompt" }, ctx: PiRunnerContext): void {
	if (!ctx.session) throw new Error("Session not initialized");
	const systemPrompt = (ctx.session as AgentSession).systemPrompt;
	sendResponse(cmd.id, true, { systemPrompt });
}

// ─── setApprovalMode ────────────────────────────────────

/** 动态切换审批模式；对进行中的下一次工具调用立即生效，并同步 subagent 审批继承 ceiling。 */
export function handleSetApprovalMode(
	cmd: Command & { type: "setApprovalMode" },
	ctx: PiRunnerContext,
): void {
	ctx.currentApprovalMode = cmd.approvalMode;
	const handle = ctx.subagentRuntime?.ceilingHandle ?? null;
	if (handle) {
		const ceiling = resolveSubagentCeiling(cmd.approvalMode);
		if (ceiling) {
			handle.update(ceiling);
		} else {
			handle.dispose();
			ctx.subagentRuntime!.ceilingHandle = null;
		}
	}
	sendResponse(cmd.id, true, { approvalMode: ctx.currentApprovalMode });
}

// ─── cancelSubagent（取消传播 host 出口，issue 05）──────

/**
 * 显式取消一个 subagent run（async runs 不随父会话 turn 中止而取消，
 * 这是异步委派的语义；host 侧用户显式取消经此命令下发）。
 *
 * 通过 pi-subagents RPC 桥（subagents:rpc:v1:request → stop）下发，
 * 回复经 subagents:rpc:v1:reply:<requestId> 通道返回。
 */
export async function handleCancelSubagent(
	cmd: Command & { type: "cancelSubagent" },
	ctx: PiRunnerContext,
): Promise<void> {
	const runtime = ctx.subagentRuntime;
	if (!runtime?.enabled || !runtime.events) {
		throw new Error(`Subagent runtime not available${runtime?.blockedReason ? `: ${runtime.blockedReason}` : ""}`);
	}

	const requestId = `socverify-stop-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
	const { envelope, replyChannel } = buildRpcStopRequest(requestId, cmd.target);

	const reply = await new Promise<Record<string, unknown>>((resolve, reject) => {
		const timeout = setTimeout(() => {
			unsubscribe();
			reject(new Error(`Subagent stop request timed out (${requestId})`));
		}, 15_000);
		timeout.unref?.();
		const unsubscribe = runtime.events!.on(replyChannel, (data: unknown) => {
			clearTimeout(timeout);
			unsubscribe();
			if (typeof data === "object" && data !== null) {
				resolve(data as Record<string, unknown>);
			} else {
				reject(new Error("Malformed subagent stop reply"));
			}
		});
		runtime.events!.emit(RPC_REQUEST_CHANNEL, envelope);
	});

	if (reply.success === false) {
		const error = reply.error as { message?: string } | undefined;
		throw new Error(error?.message ?? "Subagent stop request failed");
	}
	sendResponse(cmd.id, true, reply.data ?? { stopped: true });
}

// ─── MCP 查询命令 ───────────────────────────────────────

export function handleGetMcpStatus(cmd: Command & { type: "getMcpStatus" }, ctx: PiRunnerContext): void {
	if (!ctx.mcpRuntime) {
		sendResponse(cmd.id, true, { enabled: false, adapterLoaded: false, configSourcePath: null, servers: {} });
		return;
	}
	sendResponse(cmd.id, true, {
		enabled: true,
		adapterLoaded: ctx.mcpRuntime.adapterLoaded,
		configSourcePath: ctx.mcpRuntime.configSourcePath,
		servers: mapSnapshotToHostStatus(ctx.mcpRuntime),
	});
}

export function handleGetMcpServerTools(
	cmd: Command & { type: "getMcpServerTools" },
	ctx: PiRunnerContext,
): void {
	if (!ctx.session) throw new Error("Session not initialized");
	const session = ctx.session as AgentSession;
	const allTools = session.getAllTools().map((t) => ({
		name: t.name,
		description: t.description,
		inputSchema: t.parameters,
	}));
	sendResponse(cmd.id, true, {
		serverName: cmd.serverName,
		tools: selectServerToolsFromSession(allTools, cmd.serverName),
	});
}

export function handleReloadMcp(cmd: Command & { type: "reloadMcp" }, ctx: PiRunnerContext): void {
	// adapter 无 in-place reload 出口：显式报告需要重建会话生效（不自动重放 turn）
	void ctx;
	sendResponse(cmd.id, true, { requiresSessionRestart: true });
}

// ─── compact ────────────────────────────────────────────

export async function handleCompact(
	cmd: Command & { type: "compact" },
	ctx: PiRunnerContext,
): Promise<void> {
	if (!ctx.session) throw new Error("Session not initialized");
	const result = await (ctx.session as AgentSession).compact();
	sendResponse(cmd.id, true, { result });
}

// ─── destroy ────────────────────────────────────────────

export async function handleDestroy(
	cmd: Command & { type: "destroy" },
	ctx: PiRunnerContext,
): Promise<void> {
	// 活动 async runs 随会话销毁显式取消（fire-and-forget；销毁路径不等待）
	const runtime = ctx.subagentRuntime;
	if (runtime?.enabled && runtime.events) {
		for (const runId of trackSubagentRun.activeRunIds(runtime.registry)) {
			const { envelope } = buildRpcStopRequest(`socverify-destroy-${runId}`, { runId });
			try {
				runtime.events.emit(RPC_REQUEST_CHANNEL, envelope);
			} catch (err) {
				console.error(`[socverify-runner] subagent stop on destroy failed: ${String(err)}`);
			}
		}
	}
	if (ctx.unsubscribe) {
		ctx.unsubscribe();
		ctx.unsubscribe = null;
	}
	if (ctx.session) {
		(ctx.session as AgentSession).dispose();
		ctx.session = null;
	}
	sendResponse(cmd.id, true, { ok: true });
}
