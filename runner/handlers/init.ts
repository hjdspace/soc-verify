/**
 * handleInit — the largest command handler (~300 lines).
 *
 * Handles session creation, authentication, session resume, seed history,
 * custom tool registration, event subscription, and approval mode setup.
 *
 * Dynamic imports of the omp engine use string-literal relative paths
 * (../../engine/…) so that `bun build --compile` can statically analyze
 * and bundle them into the standalone binary.
 */

import { attachWriteSnapshotToStartEvent } from "../write-snapshot";
import { type Command, send, sendResponse, sendContextUsage, shouldSendContextUsage, sendEvent, toEngineThinkingLevel } from "../protocol";
import type { RunnerContext } from "../types";
import { applyApprovalMode } from "./tools";

/**
 * Extract the trimmed text of the first user message in an omp session's
 * entry tree. Used to detect omp files that only cover a tail of the stored
 * UI transcript (their first user message differs from the transcript's).
 * Structurally typed — SessionManager is only available via dynamic import.
 */
function firstUserMessageText(
	manager: { getEntries(): unknown[] },
): string | undefined {
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
 * Patch the engine's `desktop-adapter.js` to guard against a missing
 * `DesktopSession` export in the loaded native addon.
 *
 * When the on-disk `pi_natives.*.node` is from an older engine version that
 * doesn't export `DesktopSession`, the engine v18's `adaptDesktopSession()`
 * receives `undefined` and crashes on `WeakMap.set(undefined, …)` —
 * `TypeError: WeakMap keys must be objects or non-registered symbols`.
 *
 * This function registers a Bun plugin (idempotent — safe to call multiple
 * times) that intercepts the loading of `desktop-adapter.js` and injects a
 * guard clause: if `NativeDesktopSession` is falsy, a stub class is returned
 * instead of calling the original `WeakMap.set`.
 *
 * The plugin must be registered BEFORE the first `import("../../engine/…/sdk")`
 * because `native/index.js` calls `adaptDesktopSession()` at module-load time.
 *
 * The stub is only a fallback — it's never instantiated unless the user
 * invokes desktop-capture tools, which aren't used in SoC Verify.
 */
let nativeCompatPatched = false;
function patchNativeDesktopSessionCompat(): void {
	if (nativeCompatPatched) return;
	nativeCompatPatched = true;

	try {
		// Bun.plugin is available in Bun runtime and compiled binaries.
		// eslint-disable-next-line @typescript-eslint/no-explicit-any
		const Bun_ = (typeof Bun !== "undefined" ? Bun : undefined) as any;
		if (typeof Bun_?.plugin !== "function") return;

		Bun_.plugin({
			name: "native-desktop-session-compat",
			target: "bun",
			setup(build: { onLoad: (filter: unknown, callback: unknown) => void }) {
				build.onLoad({ filter: /desktop-adapter\.js$/ }, () => ({
					contents: `
const ADAPTED_SESSION_CLASSES = new WeakMap();

function desktopError(code, message) {
	return new Error(\`\${code}: \${message}\`);
}

function normalizeError(error, fallbackCode) {
	if (!(error instanceof Error)) return desktopError(fallbackCode, String(error));
	if (/^[A-Z][A-Za-z]+: /.test(error.message)) return error;
	const match = /^(DESKTOP_[A-Z_]+):\\s*(.*)$/.exec(error.message);
	if (match === null) return desktopError(fallbackCode, error.message);
	const code = { DESKTOP_INVALID_OPTIONS: "InvalidTarget", DESKTOP_INVALID_ACTION: "InvalidTarget", DESKTOP_BACKEND_UNAVAILABLE: null, DESKTOP_PERMISSION_DENIED: "PermissionDenied", DESKTOP_CAPTURE_FAILED: "CaptureFailed", DESKTOP_INPUT_FAILED: "InputFailed", DESKTOP_DEADLINE_EXCEEDED: "Timeout", DESKTOP_LAYOUT_CHANGED: "InvalidCoordinateFrame", DESKTOP_COORDINATE_OUT_OF_BOUNDS: "InvalidCoordinateFrame", DESKTOP_SESSION_CLOSED: "Closed", DESKTOP_WORKER_FAILED: "Internal" }[match[1]] ?? fallbackCode;
	return desktopError(code, match[2]);
}

function normalizeCapabilities(capabilities) {
	return { ...capabilities, ax: false, backgroundWindowInput: false, deliveryModes: ["foreground"], axPermission: "unavailable" };
}

function legacyPoint(point) {
	return { x: Math.round(point.x), y: Math.round(point.y) };
}

function captureCapsKey(caps) {
	return \`\${caps?.maxWidth ?? ""}:\${caps?.maxHeight ?? ""}\`;
}

function legacyButton(button) {
	return button === "middle" ? "wheel" : button;
}

function sourceDimensions(capture) {
	if (capture.sourceWidth !== undefined && capture.sourceHeight !== undefined) {
		return { sourceWidth: capture.sourceWidth, sourceHeight: capture.sourceHeight };
	}
	const displays = Array.isArray(capture.displays) ? capture.displays : [];
	if (displays.length === 0) {
		return { sourceWidth: capture.width, sourceHeight: capture.height };
	}
	const minX = Math.min(...displays.map(d => d.x));
	const minY = Math.min(...displays.map(d => d.y));
	const maxX = Math.max(...displays.map(d => d.x + d.width));
	const maxY = Math.max(...displays.map(d => d.y + d.height));
	const nativeScale = Math.max(1, ...displays.map(d => d.scale ?? 1));
	return {
		sourceWidth: Math.max(1, Math.round((maxX - minX) * nativeScale)),
		sourceHeight: Math.max(1, Math.round((maxY - minY) * nativeScale)),
	};
}

function frameSignature(capture) {
	return JSON.stringify({
		target: capture.target,
		displays: (capture.displays ?? []).map(d => ({ id: d.id, x: d.x, y: d.y, width: d.width, height: d.height, scale: d.scale, pixelX: d.pixelX, pixelY: d.pixelY, pixelWidth: d.pixelWidth, pixelHeight: d.pixelHeight })),
	});
}

export function adaptDesktopSession(NativeDesktopSession) {
	// Guard: if the native addon doesn't export DesktopSession (e.g. older
	// pi_natives version), return a stub instead of crashing on
	// WeakMap.set(undefined, ...)
	if (!NativeDesktopSession) {
		return class StubDesktopSession {
			constructor() {
				throw new Error("DesktopSession is not available in this pi_natives build. Please update the native addon to match the engine version.");
			}
		};
	}
	if (typeof NativeDesktopSession?.prototype?.click === "function") return NativeDesktopSession;
	const cached = ADAPTED_SESSION_CLASSES.get(NativeDesktopSession);
	if (cached) return cached;

	class DesktopSession {
		#native;
		#nativeDesktopSession;
		#options;
		#sessions;
		#closed = false;

		constructor(native, options) {
			this.#native = native;
			this.#nativeDesktopSession = new NativeDesktopSession(options);
			this.#options = options;
			this.#sessions = new Map();
		}

		async capture() {
			const capture = await this.#nativeDesktopSession.capture();
			return { ...capture, ...sourceDimensions(capture) };
		}

		async execute() {
			return this.#nativeDesktopSession.execute(...arguments);
		}

		async close() {
			if (this.#closed) return;
			this.#closed = true;
			try {
				await Promise.all([...this.#sessions.values()].map(n => n.close()));
			} catch (error) {
				throw normalizeError(error, "Internal");
			}
		}
	}

	ADAPTED_SESSION_CLASSES.set(NativeDesktopSession, DesktopSession);
	return DesktopSession;
}
`,
					loader: "js" as const,
				}));
			},
		});
	} catch {
		// Best-effort: if plugin registration fails, the engine's own error will surface.
	}
}

export async function handleInit(cmd: Command & { type: "init" }, ctx: RunnerContext): Promise<void> {
	const config = cmd.config;
	ctx.currentCwd = config.cwd;

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

	// Patch native addon compat BEFORE importing the engine SDK — the engine's
	// `native/index.js` calls `adaptDesktopSession()` at module load time, so
	// the stub must be in place before the first `import("../../engine/…/sdk")`.
	patchNativeDesktopSessionCompat();

	// Dynamic import of the SDK
	// Uses relative path to the engine's coding-agent package source.
	// This resolves both when running directly with Bun (engine present)
	// and when compiled with `bun build --compile` (resolved at compile time).
	//
	// Import paths MUST be string literals (not variables) so that Bun's
	// `--compile` mode can statically analyze them and bundle the engine code
	// into the standalone binary. TypeScript tracking into the engine submodule
	// is blocked via ambient module declarations in runner/engine-modules.d.ts
	// (the engine uses Bun-specific features like `.md` imports that produce
	// spurious TS errors from our project).
	// eslint-disable-next-line @typescript-eslint/no-explicit-any
	const { createAgentSession, discoverAuthStorage } = await import("../../engine/oh-my-pi/packages/coding-agent/src/sdk") as any;
	// eslint-disable-next-line @typescript-eslint/no-explicit-any
	const { ModelRegistry } = await import("../../engine/oh-my-pi/packages/coding-agent/src/config/model-registry") as any;
	// eslint-disable-next-line @typescript-eslint/no-explicit-any
	const { SessionManager } = await import("../../engine/oh-my-pi/packages/coding-agent/src/session/session-manager") as any;

	// Enable console logging for the omp engine so errors are visible on
	// stderr (captured by the Electron main process as [agent:stderr]).
	// By default the omp engine only writes to a rotating file inside the
	// temp runtime dir, which is deleted when the session ends — making
	// debugging impossible, especially in packaged AppImage/NSIS builds.
	try {
		// eslint-disable-next-line @typescript-eslint/no-explicit-any
		const { setTransports } = await import("../../engine/oh-my-pi/packages/utils/src/logger") as any;
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
	//
	// When the host provides a seed history (the stored UI transcript), we
	// validate that the omp file actually starts at the same first user
	// message. A mismatch means the omp file only covers a TAIL of the
	// conversation (e.g. it was minted by an earlier failed resume, or the
	// session predates sessionDir persistence) — resuming it would silently
	// drop the earlier turns, so we rebuild a fresh session seeded with the
	// full stored transcript instead.
	let resumed = false;
	if (config.resumeSessionId) {
		try {
			const sessions = await SessionManager.list(config.cwd, config.sessionDir);
			const target = sessions.find((s: { id: string }) => s.id === config.resumeSessionId);
			if (target) {
				const candidate = await SessionManager.open(target.path);
				const seedFirstUser = config.seedHistory
					?.find((m) => m.role === "user")
					?.content.trim();
				const ompFirstUser = firstUserMessageText(candidate);
				if (seedFirstUser === undefined || ompFirstUser === seedFirstUser) {
					sessionManager = candidate;
					resumed = true;
				} else {
					console.error(
						`[socverify-runner] omp session ${config.resumeSessionId} covers only a partial transcript (first user message mismatch) — rebuilding from stored UI history`,
					);
				}
			} else {
				console.error(
					`[socverify-runner] resume session not found in ${config.sessionDir ?? "(omp default dir)"}: ${config.resumeSessionId} — rebuilding from stored UI history`,
				);
			}
		} catch {
			// Fall through to creating a new session
		}
	}

	// Seed the fresh omp session with the stored UI transcript so the agent
	// remembers earlier turns that were never persisted to the omp JSONL.
	// Only runs when native resume did not happen (resumed omp files are the
	// authoritative history, including tool calls).
	if (!resumed && config.seedHistory && config.seedHistory.length > 0) {
		const seededProvider = config.provider ?? "socverify-openai-compatible";
		const seededModel = config.model ?? "unknown";
		for (const msg of config.seedHistory) {
			if (msg.role === "user") {
				sessionManager.appendMessage({
					role: "user",
					content: [{ type: "text", text: msg.content }],
					attribution: "user",
					timestamp: msg.timestamp,
				});
			} else {
				sessionManager.appendMessage({
					role: "assistant",
					content: [{ type: "text", text: msg.content }],
					// api/provider/model are persisted bookkeeping metadata;
					// the context builder only reads the content blocks.
					api: "openai-completions",
					provider: seededProvider,
					model: seededModel,
					stopReason: "stop",
					timestamp: msg.timestamp,
					// usage is required by the AssistantMessage type but the
					// context builder ignores it for seeded messages.
					usage: {
						input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0,
						cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
					},
				});
			}
		}
		console.error(
			`[socverify-runner] seeded ${config.seedHistory.length} messages from stored UI history into omp session`,
		);
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
				const result = await ctx.callHostTool(def.name, params);
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

	// Set initial thinking level. undefined defers to the engine's own default
	// (provider-native behavior); any concrete value (including 'auto' and
	// 'off') is forwarded verbatim to createAgentSession, which clamps it
	// against the model's declared thinking efforts.
	const engineThinkingLevel = toEngineThinkingLevel(config.thinkingLevel);
	if (engineThinkingLevel) {
		sessionOptions.thinkingLevel = engineThinkingLevel;
	}

	// Create the session
	const result = await createAgentSession(sessionOptions);
	ctx.session = result.session;

	// Forward subagent lifecycle/progress frames to the host.
	// The EventBus channels are emitted by the task executor for every
	// dispatched subagent; progress frames are already coalesced (~150ms) and
	// carry everything the UI needs (currentTool, recentOutput, tokens...).
	// The high-frequency `task:subagent:event` channel is intentionally NOT
	// forwarded — its message_update events would flood the JSONL pipe.
	//
	// Channel names are hardcoded (not dynamically imported from the engine)
	// because the runner may be compiled into a standalone binary via
	// `bun build --compile`, at which point the relative import path to the
	// engine submodule no longer resolves. The string values must stay in sync
	// with TASK_SUBAGENT_LIFECYCLE_CHANNEL / TASK_SUBAGENT_PROGRESS_CHANNEL in
	// engine/oh-my-pi/packages/coding-agent/src/task/types.ts.
	try {
		result.eventBus.on("task:subagent:lifecycle", (payload: unknown) => {
			console.error(`[socverify-runner] SUBAGENT_LIFECYCLE fired — sending frame`);
			send({ type: "subagent_lifecycle", payload });
		});
		result.eventBus.on("task:subagent:progress", (payload: unknown) => {
			console.error(`[socverify-runner] SUBAGENT_PROGRESS fired — sending frame`);
			send({ type: "subagent_progress", payload });
		});
		console.error("[socverify-runner] subagent EventBus subscriptions registered OK");
	} catch (err) {
		console.error("[socverify-runner] failed to subscribe subagent channels:", err);
	}

	// Wrap built-in tools with approval proxy when approvalMode is set,
	// and apply the tool-disable filter from settings.
	ctx.currentApprovalMode = config.approvalMode ?? "yolo";
	ctx.currentDisabledTools = new Set(config.disabledTools ?? []);
	ctx.currentDisabledTools.delete("ask");
	applyApprovalMode(ctx);

	// Subscribe to events and forward them to the host
	// eslint-disable-next-line @typescript-eslint/no-explicit-any
	const session = ctx.session as any;
	ctx.unsubscribe = session.subscribe((event: unknown) => {
		const eventType = typeof event === "object" && event !== null && "type" in event
			? String((event as { type: unknown }).type)
			: "";
		sendEvent(attachWriteSnapshotToStartEvent(event, ctx.currentCwd));
		if (shouldSendContextUsage(eventType)) {
			sendContextUsage(session);
		}
	});
	sendContextUsage(session);

	sendResponse(cmd.id, true, { sessionId: session.sessionId });
}
