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
	customToolDefinitions?: Array<{
		name: string;
		label?: string;
		description: string;
		parameters: Record<string, unknown>;
		approval?: string;
	}>;
	/** 额外的 extension 包路径（每个包的 skills/ 和 agents/ 子目录会被 omp 扫描） */
	additionalExtensionPaths?: string[];
}

type Command =
	| { id: string; type: "init"; config: InitConfig }
	| { id: string; type: "prompt"; message: string; images?: string[] }
	| { id: string; type: "abort" }
	| { id: string; type: "steer"; message: string }
	| { id: string; type: "setModel"; provider: string; modelId: string }
	| { id: string; type: "getMessages" }
	| { id: string; type: "getState" }
	| { id: string; type: "getMcpStatus" }
	| { id: string; type: "destroy" };

interface ToolResultMessage {
	type: "tool_result";
	id: string;
	result: unknown;
	isError?: boolean;
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
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let unsubscribe: (() => void) | null = null;

async function handleInit(cmd: Command & { type: "init" }): Promise<void> {
	const config = cmd.config;

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

	// Resume an existing session if requested
	if (config.resumeSessionId) {
		try {
			const sessions = await SessionManager.list(config.cwd);
			const target = sessions.find((s: { id: string }) => s.id === config.resumeSessionId);
			if (target) {
				sessionManager = await SessionManager.open(target.path);
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
		sessionManager,
		customTools,
		enableMCP: config.enableMCP ?? true,
		autoApprove: true,
		hasUI: false,
		// Inject built-in extension packages (skills/ and agents/ subdirectories
		// are auto-discovered by the omp-plugins provider).
		additionalExtensionPaths: config.additionalExtensionPaths ?? [],
	};

	// Set model pattern if provided
	if (config.provider && config.model) {
		sessionOptions.modelPattern = `${config.provider}/${config.model}`;
	}

	// Set system prompt if provided
	if (config.systemPrompt) {
		sessionOptions.systemPrompt = config.systemPrompt;
	}

	// Create the session
	const result = await createAgentSession(sessionOptions);
	session = result.session;

	// Subscribe to events and forward them to the host
	unsubscribe = session.subscribe((event: unknown) => {
		sendEvent(event);
	});

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

async function handleGetMessages(cmd: Command & { type: "getMessages" }): Promise<void> {
	if (!session) throw new Error("Session not initialized");
	const messages = session.messages;
	sendResponse(cmd.id, true, { messages });
}

async function handleGetState(cmd: Command & { type: "getState" }): Promise<void> {
	if (!session) throw new Error("Session not initialized");
	const state = session.state;
	sendResponse(cmd.id, true, { state });
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
	} catch (err) {
		// If MCPManager is not available (e.g. enableMCP was false), return empty.
		sendResponse(cmd.id, true, { servers: {} });
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
			case "getMessages":
				await handleGetMessages(cmd);
				break;
			case "getState":
				await handleGetState(cmd);
				break;
			case "getMcpStatus":
				await handleGetMcpStatus(cmd);
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

	// Handle commands
	void handleCommand(parsed as Command);
});

// Keep the process alive
process.stdin.on("end", () => {
	process.exit(0);
});
