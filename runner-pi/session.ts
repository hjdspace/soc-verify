/**
 * pi 会话命令处理器 —— init / prompt / steer / abort / setModel / compact / destroy。
 *
 * init 通过 pi SDK 创建 AgentSession（原生用户级 session 根 + cwd bucket），
 * 注册 host 转发工具（含 `ask`），订阅 pi 原生事件并经 event-normalizer
 * 归一化后转发给 host；其余命令直接映射到 AgentSession 对应方法。
 *
 * pi 的 ToolDefinition 参数 schema 要求 TypeBox 类型，而 host 下发的是
 * JSON Schema 对象。运行时两者兼容（TypeBox 即 JSON Schema + 元数据符号，
 * omp runner 以同样方式透传），在 createAgentSession 边界做一次受控转换。
 */

import {
	createAgentSession,
	SessionManager,
	type AgentSession,
	type ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import {
	type Command,
	type HostToolDefinition,
	type PiRunnerContext,
	sendEvent,
	sendResponse,
} from "./protocol.ts";
import { normalizePiEvent } from "./event-normalizer.ts";

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

// ─── init ───────────────────────────────────────────────

export async function handleInit(
	cmd: Command & { type: "init" },
	ctx: PiRunnerContext,
): Promise<void> {
	const config = cmd.config;
	ctx.currentCwd = config.cwd;

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

	const result = await createAgentSession({
		cwd: config.cwd,
		// pi 原生用户级 session 根目录 + cwd bucket（spec：不新增项目级副本）
		sessionManager: SessionManager.create(config.cwd),
		customTools: buildCustomTools(
			config.customToolDefinitions ?? [],
			ctx,
		) as unknown as ToolDefinition[],
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

	sendResponse(cmd.id, true, { sessionId: session.sessionId });
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
