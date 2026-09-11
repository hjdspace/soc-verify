/**
 * pi 会话命令处理器 —— init / prompt / steer / abort / setModel /
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
	SessionManager,
	SettingsManager,
	type AgentSession,
	type InlineExtension,
	type ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import { createJiti } from "jiti";
import type { ApprovalMode } from "./approval-logic";
import {
	type Command,
	type HostToolDefinition,
	type InitConfig,
	type PiRunnerContext,
	sendEvent,
	sendResponse,
} from "./protocol.ts";
import { normalizePiEvent } from "./event-normalizer.ts";
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
	const mcp = await assembleMcp(config, ctx);
	const subagents = await assembleSubagents(config, ctx);
	const agentDir = getAgentDir();
	const loader = new DefaultResourceLoader({
		cwd: config.cwd,
		agentDir,
		settingsManager: SettingsManager.create(config.cwd, agentDir),
		extensionFactories: [buildApprovalExtension(ctx), ...mcp.factories, ...subagents.factories],
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

	const result = await createAgentSession({
		cwd: config.cwd,
		// pi 原生用户级 session 根目录 + cwd bucket（spec：不新增项目级副本）
		sessionManager: SessionManager.create(config.cwd),
		resourceLoader: loader,
		customTools: buildCustomTools(
			config.customToolDefinitions ?? [],
			ctx,
		) as unknown as ToolDefinition[],
		excludeTools: config.disabledTools,
	});
	const session = result.session;
	ctx.session = session;

	// 运行时 API key（优先于 auth.json 的凭证）
	if (config.apiKey && config.provider) {
		await session.modelRuntime.setRuntimeApiKey(config.provider, config.apiKey);
	}

	// 初始模型选择：注册表命中时切换；未命中保持引擎默认模型
	if (config.provider && config.model) {
		const model = session.modelRuntime.getModel(config.provider, config.model);
		if (model) {
			await session.setModel(model);
		}
	}

	// 订阅 pi 原生事件 → 归一化为 Agent Event Contract → 转发 host。
	// pi 原生事件名不越出 runner 进程（issue 03 验收标准）。
	ctx.unsubscribe = session.subscribe((event) => {
		for (const normalized of normalizePiEvent(event)) {
			sendEvent(normalized);
		}
	});

	// 审批继承：按父会话 sessionId 注册 subagent capability ceiling（yolo 不收紧）
	await registerApprovalInheritance(ctx.subagentRuntime, session.sessionId, ctx.currentApprovalMode);

	// subagent 能力状态透出（能力不足时 host 显式展示阻断原因，不静默降级）
	const subagentStatus = ctx.subagentRuntime
		? { enabled: ctx.subagentRuntime.enabled, blockedReason: ctx.subagentRuntime.blockedReason }
		: { enabled: false, blockedReason: "Subagent runtime not assembled" };
	if (subagentStatus.blockedReason) {
		sendEvent({ type: "notice", text: subagentStatus.blockedReason, message: subagentStatus.blockedReason });
	}

	sendResponse(cmd.id, true, { sessionId: session.sessionId, subagent: subagentStatus });
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

// ─── setModel ───────────────────────────────────────────

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
	await session.setModel(model);
	sendResponse(cmd.id, true, { ok: true });
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
