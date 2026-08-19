/**
 * SoC Verify Agent Runner
 *
 * A lightweight Bun entry point that uses the pi-coding-agent SDK directly
 * (not the RPC mode). Communicates with the Electron main process via JSONL
 * on stdin/stdout.
 *
 * This file lives in the main repository (not inside the engine submodule).
 * It can be:
 *   1. Pre-compiled into a standalone binary via `bun build --compile`
 *   2. Run directly by Bun when the engine submodule is present
 *
 * Protocol:
 *   host → runner (stdin):  JSONL commands (init, prompt, abort, steer, ...)
 *   runner → host (stdout): JSONL responses + events + tool_call requests
 *
 * Supported commands:
 *   { id, type: 'init', config: InitConfig }
 *   { id, type: 'prompt', message, images? }
 *   { id, type: 'abort' }
 *   { id, type: 'steer', message }
 *   { id, type: 'setModel', provider, modelId }
 *   { id, type: 'getMessages' }
 *   { id, type: 'getState' }
 *   { id, type: 'destroy' }
 *
 * Tool call protocol (runner → host → runner):
 *   runner → host: { type: 'tool_call', id, toolName, args }
 *   host → runner: { type: 'tool_result', id, result, isError? }
 */

import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { createInterface } from "node:readline";

// The `Bun` global is provided by the bun-types package (installed in
// engine/oh-my-pi/node_modules) at compile time, and by the Bun runtime
// at execution time. No manual `declare global` is needed — adding one
// conflicts with bun-types' own declaration (TS2451).

// ─── stdout JSONL guard ─────────────────────────────────
// The omp engine's winston Console transport (enabled via setTransports
// below) writes structured JSON log entries to **stdout** by default.
// This corrupts the JSONL protocol between the runner and the Electron
// host: the host's readline handler tries to parse each log line as a
// JSONL frame, and lines without a `type` field surface as
// `[agent:rpc] unhandled frame type="undefined"`.
//
// Fix: intercept process.stdout.write. Lines that parse as JSON and
// contain a `type` field (the JSONL frame discriminator) pass through
// to stdout unchanged. Everything else (winston logs, console.log
// output from dependencies, etc.) is redirected to stderr, where the
// host captures it as [agent:stderr].
const _origStdoutWrite = process.stdout.write.bind(process.stdout);
process.stdout.write = ((data: unknown, ...args: unknown[]) => {
	const str = typeof data === "string" ? data : String(data);
	const line = str.trim();
	if (line) {
		try {
			const parsed = JSON.parse(line);
			if (typeof parsed === "object" && parsed !== null && "type" in parsed) {
				// Valid JSONL frame — pass through to stdout
				return _origStdoutWrite(data as string, ...(args as never[]));
			}
		} catch {
			// Not valid JSON — redirect to stderr
		}
	}
	// Non-JSONL output — redirect to stderr so it doesn't corrupt the protocol
	return process.stderr.write(str, ...(args as never[]));
}) as typeof process.stdout.write;

// ─── Types ──────────────────────────────────────────────

type ApprovalMode = "always-ask" | "write" | "yolo";

interface InitConfig {
	cwd: string;
	apiKey?: string;
	baseUrl?: string;
	provider?: string;
	model?: string;
	sessionDir?: string;
	env?: Record<string, string>;
	enableMCP?: boolean;
	resumeSessionId?: string;
	systemPrompt?: string;
	contextWindow: number;
	customToolDefinitions?: Array<{
		name: string;
		label?: string;
		description: string;
		parameters: Record<string, unknown>;
		approval?: string;
	}>;
	/** 额外的 extension 包路径（每个包的 skills/ 和 agents/ 子目录会被 omp 扫描） */
	additionalExtensionPaths?: string[];
	/** 工具审批模式：always-ask（总询问）、write（自动编辑）、yolo（完全信任） */
	approvalMode?: ApprovalMode;
}

type Command =
	| { id: string; type: "init"; config: InitConfig }
	| { id: string; type: "prompt"; message: string; images?: string[] }
	| { id: string; type: "abort" }
	| { id: string; type: "steer"; message: string }
	| { id: string; type: "setModel"; provider: string; modelId: string }
	| { id: string; type: "setApprovalMode"; approvalMode: ApprovalMode }
	| { id: string; type: "getMessages" }
	| { id: string; type: "getState" }
	| { id: string; type: "compact" }
	| { id: string; type: "getMcpStatus" }
	| { id: string; type: "getMcpServerTools"; serverName: string }
	| { id: string; type: "reloadMcp" }
	| { id: string; type: "destroy" };

interface ToolResultMessage {
	type: "tool_result";
	id: string;
	result: unknown;
	isError?: boolean;
}

// ─── 审批请求/响应 ──────────────────────────────────────

interface ApprovalResponseMessage {
	type: "approval_response";
	id: string;
	approved: boolean;
}

const pendingApprovalRequests = new Map<
	string,
	{ resolve: (approved: boolean) => void; reject: (error: Error) => void }
>();

function handleApprovalResponse(msg: ApprovalResponseMessage): void {
	const pending = pendingApprovalRequests.get(msg.id);
	if (!pending) return;
	pendingApprovalRequests.delete(msg.id);
	pending.resolve(msg.approved);
}

function requestApproval(toolName: string, args: unknown): Promise<boolean> {
	const id = `approval_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
	return new Promise((resolve, reject) => {
		pendingApprovalRequests.set(id, { resolve, reject });
		send({ type: "approval_request", id, toolName, args });
		// Timeout after 5 minutes — user might be away
		const timeout = setTimeout(() => {
			if (pendingApprovalRequests.has(id)) {
				pendingApprovalRequests.delete(id);
				reject(new Error("Approval request timed out"));
			}
		}, 300_000);
		timeout.unref?.();
	});
}

// ─── 工具审批逻辑 ──────────────────────────────────────

/** 工具能力层级 */
const READ_TOOLS = new Set(["read", "grep", "glob", "ast_grep", "todo", "web_search", "ask", "inspect_image"]);
const WRITE_TOOLS = new Set(["edit", "write", "ast_edit"]);

function getToolTier(toolName: string): "read" | "write" | "exec" {
	if (READ_TOOLS.has(toolName)) return "read";
	if (WRITE_TOOLS.has(toolName)) return "write";
	return "exec";
}

function needsApproval(toolName: string, mode: ApprovalMode): boolean {
	if (mode === "yolo") return false;
	const tier = getToolTier(toolName);
	if (mode === "always-ask") return tier !== "read";
	if (mode === "write") return tier === "exec";
	return false;
}

/** 当前生效的审批模式（init 时设置，setApprovalMode 时动态更新） */
let currentApprovalMode: ApprovalMode = "yolo";
let currentCwd = process.cwd();

/** 原始工具的快照——包装前保存，以便切换模式时从原始工具重新包装 */
let originalTools: unknown[] | null = null;

type WriteSnapshot = {
	fileExistedBefore: boolean;
	beforeContent?: string;
};

function captureWriteSnapshot(args: unknown): WriteSnapshot | null {
	if (typeof args !== "object" || args === null) return null;
	const path = (args as Record<string, unknown>).path;
	if (typeof path !== "string" || !path) return null;
	const filePath = resolve(currentCwd, path);
	if (!existsSync(filePath)) return { fileExistedBefore: false };
	try {
		return { fileExistedBefore: true, beforeContent: readFileSync(filePath, "utf-8") };
	} catch {
		return { fileExistedBefore: true };
	}
}

function attachWriteSnapshot(result: unknown, snapshot: WriteSnapshot | null): unknown {
	if (!snapshot || typeof result !== "object" || result === null || Array.isArray(result)) return result;
	const record = result as Record<string, unknown>;
	const details = typeof record.details === "object" && record.details !== null && !Array.isArray(record.details)
		? record.details as Record<string, unknown>
		: {};
	return { ...record, details: { ...details, ...snapshot } };
}

/**
 * 用当前审批模式包装工具并设置到 agent 上。
 * - yolo 模式下恢复原始工具（无包装）
 * - 其他模式下对需要审批的工具插入 requestApproval 代理
 *
 * 使用 Proxy 包装而非对象展开（{ ...tool }），以保留原型链上的方法和属性。
 * omp 引擎的工具 execute 签名为 (toolCallId, args, signal, onUpdate, ctx)，
 * wrapper 必须匹配此签名并透传所有参数。
 */
function applyApprovalMode(): void {
	if (!session) return;
	try {
		// 首次调用时保存原始工具快照
		if (!originalTools) {
			const activeNames = session.getActiveToolNames();
			originalTools = activeNames
				.map((name) => session.getToolByName(name))
				.filter((tool): tool is NonNullable<typeof tool> => tool != null);
		}

		// eslint-disable-next-line @typescript-eslint/no-explicit-any
		const wrappedTools = (originalTools as any[]).map((tool: any) => {
			const toolName: string = tool.name;
			const requiresApproval = needsApproval(toolName, currentApprovalMode);
			const capturesWriteSnapshot = toolName === "write";
			if (!requiresApproval && !capturesWriteSnapshot) return tool;

			// 使用 Proxy 保留原型链，仅拦截 execute 方法
			return new Proxy(tool, {
				get(target, prop, receiver) {
					if (prop !== "execute") return Reflect.get(target, prop, receiver);
					return async (
						toolCallId: string,
						args: unknown,
						signal: unknown,
						onUpdate: unknown,
						ctx: unknown,
					) => {
						if (requiresApproval && !await requestApproval(toolName, args)) {
							return {
								content: [{ type: "text" as const, text: `[已拒绝] 用户拒绝了此工具调用的执行。` }],
							};
						}
						const snapshot = capturesWriteSnapshot ? captureWriteSnapshot(args) : null;
						// eslint-disable-next-line @typescript-eslint/no-explicit-any
						const result = await target.execute(toolCallId, args, signal as any, onUpdate as any, ctx as any);
						return attachWriteSnapshot(result, snapshot);
					};
				},
			});
		});
		// eslint-disable-next-line @typescript-eslint/no-explicit-any
		session.agent.setTools(wrappedTools as any);
	} catch (wrapErr) {
		console.error("[socverify-runner] failed to apply approval mode:", wrapErr);
	}
}

// ─── JSONL Helpers ──────────────────────────────────────

function send(frame: unknown): void {
	process.stdout.write(`${JSON.stringify(frame)}\n`);
}

function sendResponse(id: string, success: boolean, data?: unknown, error?: string): void {
	send({ id, type: "response", success, data, error });
}

function sendEvent(event: unknown): void {
	send({ type: "event", event });
}

function sendContextUsage(): void {
	if (!session) return;
	sendEvent({
		type: "context_usage",
		contextUsage: session.getContextUsage?.(),
		contextBreakdown: session.getContextBreakdown?.(),
		isCompacting: session.isCompacting === true,
		autoCompactionEnabled: session.autoCompactionEnabled !== false,
	});
}

function sendToolCall(id: string, toolName: string, args: unknown): void {
	send({ type: "tool_call", id, toolName, args });
}

// ─── Pending Tool Calls ─────────────────────────────────

const pendingToolCalls = new Map<
	string,
	{ resolve: (result: unknown) => void; reject: (error: Error) => void }
>();

function handleToolResult(msg: ToolResultMessage): void {
	const pending = pendingToolCalls.get(msg.id);
	if (!pending) return;
	pendingToolCalls.delete(msg.id);
	if (msg.isError) {
		pending.reject(new Error(typeof msg.result === "string" ? msg.result : "Tool error"));
	} else {
		pending.resolve(msg.result);
	}
}

function callHostTool(toolName: string, args: unknown): Promise<unknown> {
	const id = `tool_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
	return new Promise((resolve, reject) => {
		pendingToolCalls.set(id, { resolve, reject });
		sendToolCall(id, toolName, args);
		// Timeout after 120s
		const timeout = setTimeout(() => {
			if (pendingToolCalls.has(id)) {
				pendingToolCalls.delete(id);
				reject(new Error(`Tool "${toolName}" timed out`));
			}
		}, 120_000);
		timeout.unref?.();
	});
}

// ─── Session Management ─────────────────────────────────

// We use dynamic import to avoid loading the SDK until init is called.
// This allows the runner to start quickly and respond to the ready signal.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let session: any = null;
 
let unsubscribe: (() => void) | null = null;

async function handleInit(cmd: Command & { type: "init" }): Promise<void> {
	const config = cmd.config;
	currentCwd = config.cwd;

	// Apply environment variables
	if (config.env) {
		for (const [key, value] of Object.entries(config.env)) {
			// Set both process.env and Bun.env (if available)
			process.env[key] = value;
			// Bun.env is available when running under Bun or as a compiled binary
			if (typeof Bun !== "undefined") {
				// eslint-disable-next-line @typescript-eslint/no-explicit-any
				(Bun.env as any)[key] = value;
			}
		}
	}

	// Dynamic import of the SDK
	// Uses relative path to the engine's coding-agent package source.
	// This resolves both when running directly with Bun (engine present)
	// and when compiled with `bun build --compile` (resolved at compile time).
	const { createAgentSession, discoverAuthStorage } = await import(
		"../engine/oh-my-pi/packages/coding-agent/src/sdk"
	);
	const { ModelRegistry } = await import(
		"../engine/oh-my-pi/packages/coding-agent/src/config/model-registry"
	);
	const { SessionManager } = await import(
		"../engine/oh-my-pi/packages/coding-agent/src/session/session-manager"
	);

	// Enable console logging for the omp engine so errors are visible on
	// stderr (captured by the Electron main process as [agent:stderr]).
	// By default the omp engine only writes to a rotating file inside the
	// temp runtime dir, which is deleted when the session ends — making
	// debugging impossible, especially in packaged AppImage/NSIS builds.
	try {
		const { setTransports } = await import(
			"../engine/oh-my-pi/packages/utils/src/logger"
		);
		setTransports({ console: true, file: true });
	} catch {
		// Best-effort: if the logger module path changes, don't block init.
	}

	// Set up auth storage
	const authStorage = await discoverAuthStorage();
	const modelRegistry = new ModelRegistry(authStorage);

	// Set runtime API key if provided
	if (config.apiKey && config.provider) {
		const provider = config.provider.toLowerCase();
		authStorage.setRuntimeApiKey(provider, config.apiKey);

		// Also set env vars for providers that read them.
		// Include "socverify-openai-compatible" (the custom provider used by
		// this app) so that OPENAI_API_KEY / OPENAI_BASE_URL are propagated
		// for all OpenAI-compatible provider variants.
		const isOpenAiCompat =
			provider === "openai" ||
			provider === "openai-compatible" ||
			provider.startsWith("socverify-openai") ||
			provider.includes("openai-compat");
		if (isOpenAiCompat) {
			process.env.OPENAI_API_KEY = config.apiKey;
			if (typeof Bun !== "undefined") {
				(Bun.env as { OPENAI_API_KEY?: string }).OPENAI_API_KEY = config.apiKey;
			}
			if (config.baseUrl) {
				process.env.OPENAI_BASE_URL = config.baseUrl;
				if (typeof Bun !== "undefined") {
					(Bun.env as { OPENAI_BASE_URL?: string }).OPENAI_BASE_URL = config.baseUrl;
				}
			}
		}
	}

	// Build session manager
	let sessionManager;
	if (config.sessionDir) {
		sessionManager = SessionManager.create(config.cwd, config.sessionDir);
	} else {
		sessionManager = SessionManager.inMemory();
	}

	// Resume an existing session if requested. List from the same sessionDir
	// the host configures at creation time (<project>/.socverify/omp-sessions)
	// so resume actually finds the persisted session file.
	if (config.resumeSessionId) {
		try {
			const sessions = await SessionManager.list(config.cwd, config.sessionDir);
			const target = sessions.find((s: { id: string }) => s.id === config.resumeSessionId);
			if (target) {
				sessionManager = await SessionManager.open(target.path);
			} else {
				console.error(
					`[socverify-runner] resume session not found in ${config.sessionDir ?? "(omp default dir)"}: ${config.resumeSessionId} — starting a fresh session (history lost)`,
				);
			}
		} catch {
			// Fall through to creating a new session
		}
	}

	// Build custom tools that forward calls to the Electron host
	const customTools = (config.customToolDefinitions ?? []).map((def) => ({
		name: def.name,
		label: def.label ?? def.name,
		description: def.description,
		parameters: def.parameters,
		approval: (def.approval ?? "read") as "read" | "write" | "exec",
		async execute(
			_toolCallId: string,
			params: unknown,
			_onUpdate: unknown,
			_ctx: unknown,
			signal?: AbortSignal,
		): Promise<unknown> {
			if (signal?.aborted) {
				return {
					content: [{ type: "text", text: "Tool call was aborted" }],
					isError: true,
				};
			}
			try {
				const result = await callHostTool(def.name, params);
				if (typeof result === "string") {
					return { content: [{ type: "text", text: result }] };
				}
				return result;
			} catch (err) {
				return {
					content: [
						{ type: "text", text: err instanceof Error ? err.message : String(err) },
					],
					isError: true,
				};
			}
		},
	}));

	// Build createAgentSession options
	// The SDK internally creates a ModelRegistry from authStorage if not provided.
	// eslint-disable-next-line @typescript-eslint/no-explicit-any
	const sessionOptions: any = {
		cwd: config.cwd,
		authStorage,
		modelRegistry,
		sessionManager,
		customTools,
		enableMCP: config.enableMCP ?? true,
		autoApprove: true,
		hasUI: false,
		// Inject built-in extension packages (skills/ and agents/ subdirectories
		// are auto-discovered by the omp-plugins provider).
		additionalExtensionPaths: config.additionalExtensionPaths ?? [],
		// 追加到默认系统提示词末尾，引导 AI 优先使用 edit 工具修改已有文件
		appendSystemPrompt: [
			"## 文件编辑规则",
			"- 修改已有文件时，**必须**优先使用 `edit` 工具（而非 `write`），以便用户可以逐一审查修改差异",
			"- 仅在创建全新文件时才使用 `write` 工具",
			"- `write` 会覆盖整个文件，导致 diff 全部显示为新增（绿色），无法逐项确认修改",
		].join("\n"),
	};

	// Set model pattern if provided
	if (config.provider && config.model) {
		const advertisedModel = modelRegistry.find(config.provider, config.model);
		if (advertisedModel) {
			const advertisedWindow = advertisedModel.contextWindow ?? 0;
			const effectiveWindow = advertisedWindow > 0
				? Math.min(config.contextWindow, advertisedWindow)
				: config.contextWindow;
			sessionOptions.model = { ...advertisedModel, contextWindow: effectiveWindow };
		} else {
			sessionOptions.modelPattern = `${config.provider}/${config.model}`;
		}
	}

	// Set system prompt if provided
	if (config.systemPrompt) {
		sessionOptions.systemPrompt = config.systemPrompt;
	}

	// Create the session
	const result = await createAgentSession(sessionOptions);
	session = result.session;

	// Forward subagent lifecycle/progress frames to the host.
	// The EventBus channels are emitted by the task executor for every
	// dispatched subagent; progress frames are already coalesced (~150ms) and
	// carry everything the UI needs (currentTool, recentOutput, tokens...).
	// The high-frequency `task:subagent:event` channel is intentionally NOT
	// forwarded — its message_update events would flood the JSONL pipe.
	try {
		const { TASK_SUBAGENT_LIFECYCLE_CHANNEL, TASK_SUBAGENT_PROGRESS_CHANNEL } = await import(
			"../engine/oh-my-pi/packages/coding-agent/src/task/types"
		);
		result.eventBus.on(TASK_SUBAGENT_LIFECYCLE_CHANNEL, (payload: unknown) => {
			send({ type: "subagent_lifecycle", payload });
		});
		result.eventBus.on(TASK_SUBAGENT_PROGRESS_CHANNEL, (payload: unknown) => {
			send({ type: "subagent_progress", payload });
		});
	} catch (err) {
		console.error("[socverify-runner] failed to subscribe subagent channels:", err);
	}

	// Wrap built-in tools with approval proxy when approvalMode is set
	currentApprovalMode = config.approvalMode ?? "yolo";
	applyApprovalMode();

	// Subscribe to events and forward them to the host
	unsubscribe = session.subscribe((event: unknown) => {
		const eventType = typeof event === "object" && event !== null && "type" in event
			? String((event as { type: unknown }).type)
			: "";
		const eventRecord = typeof event === "object" && event !== null
			? event as Record<string, unknown>
			: null;
		const snapshot = eventType === "tool_execution_start" && eventRecord?.toolName === "write"
			? captureWriteSnapshot(eventRecord.args)
			: null;
		sendEvent(snapshot && eventRecord ? { ...eventRecord, ...snapshot } : event);
		if (eventType === "agent_end" || eventType === "compaction_end" || eventType === "auto_compaction_end") {
			sendContextUsage();
		}
	});
	sendContextUsage();

	sendResponse(cmd.id, true, { sessionId: session.sessionId });
}

async function handlePrompt(cmd: Command & { type: "prompt" }): Promise<void> {
	if (!session) throw new Error("Session not initialized");

	// Convert image strings to ImageContent objects expected by the SDK.
	// Images arrive as full data URLs (data:image/png;base64,...) so we can
	// recover the MIME type.  Raw base64 strings fall back to image/png.
	let images: Array<{ type: "image"; data: string; mimeType: string }> | undefined;
	if (cmd.images?.length) {
		images = cmd.images.map((img) => {
			const match = img.match(/^data:([^;]+);base64,(.+)$/);
			if (match) {
				return { type: "image" as const, data: match[2], mimeType: match[1] };
			}
			return { type: "image" as const, data: img, mimeType: "image/png" };
		});
	}

	await session.prompt(cmd.message, images ? { images } : undefined);
	sendResponse(cmd.id, true, { ok: true });
}

async function handleAbort(cmd: Command & { type: "abort" }): Promise<void> {
	if (!session) throw new Error("Session not initialized");
	await session.abort();
	sendResponse(cmd.id, true, { ok: true });
}

async function handleSteer(cmd: Command & { type: "steer" }): Promise<void> {
	if (!session) throw new Error("Session not initialized");
	await session.steer(cmd.message);
	sendResponse(cmd.id, true, { ok: true });
}

async function handleSetModel(cmd: Command & { type: "setModel" }): Promise<void> {
	if (!session) throw new Error("Session not initialized");
	// The SDK's AgentSession doesn't have a direct setModel method like the RPC mode.
	// Model switching requires recreating the session or using the agent's internal API.
	// For now, we just acknowledge the request.
	sendResponse(cmd.id, true, { ok: true, note: "Model switching via SDK is not yet supported" });
}

async function handleSetApprovalMode(cmd: Command & { type: "setApprovalMode" }): Promise<void> {
	if (!session) throw new Error("Session not initialized");
	currentApprovalMode = cmd.approvalMode;
	applyApprovalMode();
	sendResponse(cmd.id, true, { ok: true, approvalMode: currentApprovalMode });
}

async function handleGetMessages(cmd: Command & { type: "getMessages" }): Promise<void> {
	if (!session) throw new Error("Session not initialized");
	const messages = session.messages;
	sendResponse(cmd.id, true, { messages });
}

async function handleGetState(cmd: Command & { type: "getState" }): Promise<void> {
	if (!session) throw new Error("Session not initialized");
	const state = {
		...session.state,
		model: session.model,
		contextUsage: session.getContextUsage?.(),
		contextBreakdown: session.getContextBreakdown?.(),
		isCompacting: session.isCompacting === true,
		autoCompactionEnabled: session.autoCompactionEnabled !== false,
	};
	sendResponse(cmd.id, true, { state });
}

async function handleCompact(cmd: Command & { type: "compact" }): Promise<void> {
	if (!session) throw new Error("Session not initialized");
	const result = await session.compact();
	const contextUsage = session.getContextUsage?.();
	const contextBreakdown = session.getContextBreakdown?.();
	sendResponse(cmd.id, true, { result, contextUsage, contextBreakdown });
	sendContextUsage();
}

async function handleGetMcpStatus(cmd: Command & { type: "getMcpStatus" }): Promise<void> {
	if (!session) throw new Error("Session not initialized");

	try {
		// Access the MCPManager from the session. The SDK creates a singleton
		// MCPManager.instance() that manages all MCP connections. We query it
		// for all known servers and their connection status.
		const { MCPManager } = await import(
			"../engine/oh-my-pi/packages/coding-agent/src/mcp/manager"
		);
		const manager = MCPManager.instance();
		if (!manager) {
			sendResponse(cmd.id, true, { servers: {} });
			return;
		}
		const allNames = manager.getAllServerNames();

		const statusMap: Record<string, { status: string; toolCount: number }> = {};
		for (const name of allNames) {
			const status = manager.getConnectionStatus(name);
			let toolCount = 0;
			if (status === "connected") {
				try {
					const conn = manager.getConnection(name);
					toolCount = conn?.tools?.length ?? 0;
				} catch {
					// best-effort
				}
			}
			statusMap[name] = { status, toolCount };
		}

		sendResponse(cmd.id, true, { servers: statusMap });
	} catch (_err) {
		// If MCPManager is not available (e.g. enableMCP was false), return empty.
		sendResponse(cmd.id, true, { servers: {} });
	}
}

async function handleGetMcpServerTools(cmd: Command & { type: "getMcpServerTools"; serverName: string }): Promise<void> {
	if (!session) throw new Error("Session not initialized");

	try {
		const { MCPManager } = await import(
			"../engine/oh-my-pi/packages/coding-agent/src/mcp/manager"
		);
		const manager = MCPManager.instance();
		if (!manager) {
			sendResponse(cmd.id, true, { tools: [] });
			return;
		}

		const connection = manager.getConnection(cmd.serverName);
		if (!connection) {
			sendResponse(cmd.id, true, { tools: [] });
			return;
		}

		// Use cached tools if available; otherwise call listTools to fetch.
		let tools = connection.tools;
		if (!tools) {
			const { listTools } = await import(
				"../engine/oh-my-pi/packages/coding-agent/src/mcp/client"
			);
			tools = await listTools(connection);
		}

		const toolList = (tools ?? []).map((t) => ({
			name: t.name,
			description: t.description,
			inputSchema: t.inputSchema,
		}));

		sendResponse(cmd.id, true, { tools: toolList });
	} catch (err) {
		// On any error, return empty tool list rather than failing the RPC.
		const msg = err instanceof Error ? err.message : String(err);
		console.error(`[socverify-runner] getMcpServerTools error: ${msg}`);
		sendResponse(cmd.id, true, { tools: [] });
	}
}

async function handleReloadMcp(cmd: Command & { type: "reloadMcp" }): Promise<void> {
	if (!session) throw new Error("Session not initialized");

	try {
		const { MCPManager } = await import(
			"../engine/oh-my-pi/packages/coding-agent/src/mcp/manager"
		);
		const manager = MCPManager.instance();
		if (!manager) {
			sendResponse(cmd.id, true, { ok: true, servers: {} });
			return;
		}

		// Disconnect all existing connections, then re-discover and connect.
		// This picks up changes made to .mcp.json since the session started.
		manager.disconnectAll();
		await manager.discoverAndConnect();

		// Refresh the agent's tool list so newly connected MCP tools are
		// immediately available to the LLM.
		const mcpTools = manager.getTools();
		if (typeof session.refreshMCPTools === "function") {
			await session.refreshMCPTools(mcpTools, { activateAll: true });
		}

		// Build status map to return
		const allNames = manager.getAllServerNames();
		const statusMap: Record<string, { status: string; toolCount: number }> = {};
		for (const name of allNames) {
			const status = manager.getConnectionStatus(name);
			let toolCount = 0;
			if (status === "connected") {
				try {
					const conn = manager.getConnection(name);
					toolCount = conn?.tools?.length ?? 0;
				} catch {
					// best-effort
				}
			}
			statusMap[name] = { status, toolCount };
		}

		sendResponse(cmd.id, true, { ok: true, servers: statusMap });
	} catch (err) {
		const msg = err instanceof Error ? err.message : String(err);
		console.error(`[socverify-runner] reloadMcp error: ${msg}`);
		sendResponse(cmd.id, false, undefined, `Failed to reload MCP: ${msg}`);
	}
}

async function handleDestroy(cmd: Command & { type: "destroy" }): Promise<void> {
	if (unsubscribe) {
		unsubscribe();
		unsubscribe = null;
	}
	if (session) {
		// eslint-disable-next-line @typescript-eslint/no-explicit-any
		await (session as any).dispose?.();
		session = null;
	}
	sendResponse(cmd.id, true, { ok: true });
}

// ─── Main Loop ──────────────────────────────────────────

async function handleCommand(cmd: Command): Promise<void> {
	try {
		switch (cmd.type) {
			case "init":
				await handleInit(cmd);
				break;
			case "prompt":
				await handlePrompt(cmd);
				break;
			case "abort":
				await handleAbort(cmd);
				break;
			case "steer":
				await handleSteer(cmd);
				break;
			case "setModel":
				await handleSetModel(cmd);
				break;
			case "setApprovalMode":
				await handleSetApprovalMode(cmd);
				break;
			case "getMessages":
				await handleGetMessages(cmd);
				break;
			case "getState":
				await handleGetState(cmd);
				break;
			case "compact":
				await handleCompact(cmd);
				break;
			case "getMcpStatus":
				await handleGetMcpStatus(cmd);
				break;
			case "getMcpServerTools":
				await handleGetMcpServerTools(cmd);
				break;
			case "reloadMcp":
				await handleReloadMcp(cmd);
				break;
			case "destroy":
				await handleDestroy(cmd);
				break;
			default:
				sendResponse((cmd as { id: string }).id, false, undefined, `Unknown command type: ${(cmd as { type: string }).type}`);
		}
	} catch (err) {
		const message = err instanceof Error ? err.message : String(err);
		console.error(`[socverify-runner] error handling ${cmd.type}: ${message}`);
		sendResponse(cmd.id, false, undefined, message);
	}
}

// Send ready signal
send({ type: "ready" });

// Read JSONL from stdin
const rl = createInterface({ input: process.stdin, crlfDelay: Infinity });

rl.on("line", (line: string) => {
	if (!line.trim()) return;
	let parsed: unknown;
	try {
		parsed = JSON.parse(line);
	} catch {
		console.error(`[socverify-runner] failed to parse JSONL: ${line.slice(0, 100)}`);
		return;
	}

	// Handle tool_result messages (these don't have a regular command type)
	if (typeof parsed === "object" && parsed !== null && (parsed as Record<string, unknown>).type === "tool_result") {
		handleToolResult(parsed as ToolResultMessage);
		return;
	}

	// Handle approval_response messages from the host
	if (typeof parsed === "object" && parsed !== null && (parsed as Record<string, unknown>).type === "approval_response") {
		handleApprovalResponse(parsed as ApprovalResponseMessage);
		return;
	}

	// Handle commands
	void handleCommand(parsed as Command);
});

// Keep the process alive
process.stdin.on("end", () => {
	process.exit(0);
});
