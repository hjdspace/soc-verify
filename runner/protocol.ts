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
	| { id: string; type: "setModel"; provider: string; modelId: string }
	| { id: string; type: "setApprovalMode"; approvalMode: ApprovalMode }
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
