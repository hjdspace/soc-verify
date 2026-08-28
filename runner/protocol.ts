/**
 * JSONL protocol layer for the SoC Verify Agent Runner.
 *
 * This module owns:
 *   1. The stdout guard — intercepts process.stdout.write and redirects
 *      non-JSONL output (winston logs, console.log, etc.) to stderr so it
 *      doesn't corrupt the JSONL protocol between runner and Electron host.
 *   2. All protocol frame types (Command, InitConfig, ToolResultMessage, …).
 *   3. Low-level send helpers (send, sendResponse, sendEvent, …).
 *
 * Extracted from runner/index.ts to make the protocol layer independently
 * testable and to narrow the interface of each handler module.
 */

// ─── stdout JSONL guard ─────────────────────────────────
// The omp engine (and any other dependency) may write structured log
// entries to **stdout** via console.log and similar. This corrupts the
// JSONL protocol between the runner and the Electron
// host: the host's readline handler tries to parse each log line as a
// JSONL frame, and lines without a `type` field surface as
// `[agent:rpc] unhandled frame type="undefined"`.
//
// Lines that parse as JSON and contain a `type` field (the JSONL frame
// discriminator) pass through to stdout unchanged. Everything else is
// redirected to stderr, where the host captures it as [agent:stderr].
//
// Note: the omp engine's logger can also write to stdout via raw
// `fs.writeSync(1, ...)` when its console transport is enabled. Under Bun
// >= 1.3 the ESM namespace object is immutable (assigning to it crashes),
// and a CJS-require patch is invisible to the engine's ESM binding — so the
// fs.writeSync monkey-patch approach is impossible there. Instead, the
// runner keeps that transport disabled and forwards log events to stderr via
// the engine's public `registerLogSink` API (see handlers/init.ts).
function _shouldPassToStdout(str: string): boolean {
	const line = str.trim();
	if (!line) return false;
	try {
		const parsed = JSON.parse(line);
		return typeof parsed === "object" && parsed !== null && "type" in parsed;
	} catch {
		return false;
	}
}

const _origStdoutWrite = process.stdout.write.bind(process.stdout);
process.stdout.write = ((data: unknown, ...args: unknown[]) => {
	const str = typeof data === "string" ? data : String(data);
	if (_shouldPassToStdout(str)) {
		return _origStdoutWrite(data as string, ...(args as never[]));
	}
	return process.stderr.write(str, ...(args as never[]));
}) as typeof process.stdout.write;

// ─── Types ──────────────────────────────────────────────

/**
 * 思考强度设置。值域与主仓库 src/shared/types/thinking-level.ts 对齐
 * （runner 独立编译，不引 @shared，需手工保持同步）：
 *  - 'default' 哨兵值：不下发设置，跟随 omp 引擎默认行为
 *  - 其余值原样传给 AgentSession.setThinkingLevel / sessionOptions.thinkingLevel
 */
export type ThinkingLevelSetting =
	| "default"
	| "auto"
	| "off"
	| "minimal"
	| "low"
	| "medium"
	| "high"
	| "xhigh"
	| "max";

/**
 * Map a host-sent thinking level setting to the omp engine's selector value:
 * 'default'（或缺省）→ undefined（跟随引擎默认行为），其余值原样透传。
 */
export function toEngineThinkingLevel(level: ThinkingLevelSetting | undefined): string | undefined {
	return level && level !== "default" ? level : undefined;
}

export type InitConfig = {
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
	/** 被禁用的工具名列表（host 工具 + omp 内置工具），会话创建时不暴露给 LLM */
	disabledTools?: string[];
	/** 会话初始思考强度（'default'/缺省 = 跟随引擎默认） */
	thinkingLevel?: ThinkingLevelSetting;
	/**
	 * UI 存储的对话历史（user/assistant 文本），用于 omp 会话文件缺失或
	 * 只覆盖尾部时重建引擎上下文（失忆恢复种子）。
	 */
	seedHistory?: Array<{
		role: "user" | "assistant";
		content: string;
		timestamp: number;
	}>;
};

export type Command =
	| { id: string; type: "init"; config: InitConfig }
	| { id: string; type: "prompt"; message: string; images?: string[] }
	| { id: string; type: "abort" }
	| { id: string; type: "steer"; message: string }
	| { id: string; type: "regenerate" }
	| { id: string; type: "setModel"; provider: string; modelId: string }
	| { id: string; type: "setApprovalMode"; approvalMode: ApprovalMode }
	| { id: string; type: "setThinkingLevel"; level: ThinkingLevelSetting }
	| { id: string; type: "setToolFilter"; disabledTools: string[] }
	| { id: string; type: "listAgentTools" }
	| { id: string; type: "getMessages" }
	| { id: string; type: "getState" }
	| { id: string; type: "compact" }
	| { id: string; type: "getMcpStatus" }
	| { id: string; type: "getMcpServerTools"; serverName: string }
	| { id: string; type: "reloadMcp" }
	| { id: string; type: "destroy" };

export interface ToolResultMessage {
	type: "tool_result";
	id: string;
	result: unknown;
	isError?: boolean;
}

export interface ApprovalResponseMessage {
	type: "approval_response";
	id: string;
	approved: boolean;
}

// Import ApprovalMode for use in InitConfig and Command types below.
import type { ApprovalMode } from "./approval-logic";

// Re-export so consumers can import all protocol types from one place.
export type { ApprovalMode } from "./approval-logic";

// ─── JSONL Helpers ──────────────────────────────────────

export function send(frame: unknown): void {
	process.stdout.write(`${JSON.stringify(frame)}\n`);
}

export function sendResponse(id: string, success: boolean, data?: unknown, error?: string): void {
	send({ id, type: "response", success, data, error });
}

export function sendEvent(event: unknown): void {
	send({ type: "event", event });
}

export function sendContextUsage(session: unknown): void {
	if (!session) return;
	const s = session as {
		getContextUsage?: () => unknown;
		getContextBreakdown?: () => unknown;
		isCompacting?: boolean;
		autoCompactionEnabled?: boolean;
	};
	sendEvent({
		type: "context_usage",
		contextUsage: s.getContextUsage?.(),
		contextBreakdown: s.getContextBreakdown?.(),
		isCompacting: s.isCompacting === true,
		autoCompactionEnabled: s.autoCompactionEnabled !== false,
	});
}

export function sendToolCall(id: string, toolName: string, args: unknown): void {
	send({ type: "tool_call", id, toolName, args });
}
