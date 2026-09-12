/**
 * SoC Verify pi Runner — main loop
 *
 * 普通 Node 进程入口（生产环境经 ELECTRON_RUN_AS_NODE=1 复用 Electron 自带
 * Node，开发环境直接 node 运行）。通过 pi SDK 驱动 Agent 会话，与 Electron
 * 主进程之间以 stdin/stdout JSONL 通信。
 *
 * 本文件只负责进程级装配：
 *   1. 安装 stdout JSONL guard（必须在任何协议输出之前）
 *   2. ready 握手（进程启动即发送，host 以此判断 runner 就绪）
 *   3. readline 主循环（stdin → JSONL 解析 → 命令分发）
 *   4. tool_call / tool_result 桥（runner ↔ host 工具往返，含 `ask`）
 *   5. approval_request / trust_request 桥（issue 04：单次审批与信任确认）
 *
 * 命令处理在 runner-pi/session.ts，协议层在 runner-pi/protocol.ts，
 * pi 事件归一化在 runner-pi/event-normalizer.ts。
 */

import { createInterface } from "node:readline";
import {
	installStdoutJsonlGuard,
	type ApprovalResponseMessage,
	type Command,
	type PiRunnerContext,
	type ToolResultMessage,
	type TrustResponseMessage,
	send,
	sendResponse,
	sendToolCall,
} from "./protocol.ts";
import {
	handleAbort,
	handleCompact,
	handleDestroy,
	handleGetMcpServerTools,
	handleGetMcpStatus,
	handleGetMessages,
	handleGetState,
	handleGetSystemPrompt,
	handleInit,
	handleListAgentTools,
	handlePrompt,
	handleRegenerate,
	handleReloadMcp,
	handleCancelSubagent,
	handleSetApprovalMode,
	handleSetModel,
	handleSetThinkingLevel,
	handleSetToolFilter,
	handleSteer,
} from "./session.ts";

// Guard 必须先于任何输出安装（包括底部的 ready 帧）
installStdoutJsonlGuard();

// ─── Pending 桥（runner ↔ host 往返）────────────────────

interface PendingEntry {
	resolve: (result: unknown) => void;
	reject: (error: Error) => void;
	timeout?: ReturnType<typeof setTimeout>;
}

const pendingToolCalls = new Map<string, PendingEntry>();
const pendingApprovals = new Map<string, PendingEntry>();
const pendingTrusts = new Map<string, PendingEntry>();

function settlePending(
	map: Map<string, PendingEntry>,
	id: string,
	resolveValue: unknown,
	rejectError?: Error,
): void {
	const pending = map.get(id);
	if (!pending) return;
	map.delete(id);
	if (pending.timeout) clearTimeout(pending.timeout);
	if (rejectError) {
		pending.reject(rejectError);
	} else {
		pending.resolve(resolveValue);
	}
}

function handleToolResult(msg: ToolResultMessage): void {
	settlePending(
		pendingToolCalls,
		msg.id,
		msg.result,
		msg.isError ? new Error(typeof msg.result === "string" ? msg.result : "Tool error") : undefined,
	);
}

function handleApprovalResponse(msg: ApprovalResponseMessage): void {
	settlePending(pendingApprovals, msg.id, msg.approved);
}

function handleTrustResponse(msg: TrustResponseMessage): void {
	settlePending(pendingTrusts, msg.id, msg.approved);
}

/** 发起一次带超时的 host 往返请求（工具调用 / 审批 / 信任） */
function requestHost(
	map: Map<string, PendingEntry>,
	prefix: string,
	sendFrame: (id: string) => void,
	describe: (id: string) => string,
	timeoutMs: number,
): Promise<unknown> {
	const id = `${prefix}_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
	return new Promise((resolve, reject) => {
		const timeout = setTimeout(() => {
			if (map.has(id)) {
				map.delete(id);
				reject(new Error(describe(id)));
			}
		}, timeoutMs);
		timeout.unref?.();
		map.set(id, { resolve, reject, timeout });
		sendFrame(id);
	});
}

function callHostTool(toolName: string, args: unknown): Promise<unknown> {
	return requestHost(
		pendingToolCalls,
		"tool",
		(id) => sendToolCall(id, toolName, args),
		(id) => `Tool "${toolName}" timed out (${id})`,
		120_000,
	);
}

/** 请求用户审批一次工具调用；无响应按拒绝处理（fail closed） */
function requestApproval(toolName: string, args: unknown): Promise<boolean> {
	return requestHost(
		pendingApprovals,
		"approval",
		(id) => send({ type: "approval_request", id, toolName, args }),
		(id) => `Approval request for "${toolName}" timed out (${id})`,
		300_000,
	) as Promise<boolean>;
}

/** 请求用户信任确认（project-extension / mcp-server）；无响应按拒绝处理 */
function requestTrust(
	kind: "project-extension" | "mcp-server",
	name: string,
	path?: string,
): Promise<boolean> {
	return requestHost(
		pendingTrusts,
		"trust",
		(id) => send({ type: "trust_request", id, kind, name, path }),
		(id) => `Trust request for ${kind} "${name}" timed out (${id})`,
		300_000,
	) as Promise<boolean>;
}

// ─── Runner Context ─────────────────────────────────────

const ctx: PiRunnerContext = {
	session: null,
	unsubscribe: null,
	currentCwd: process.cwd(),
	currentApprovalMode: "always-ask",
	callHostTool,
	requestApproval,
	requestTrust,
	mcpRuntime: null,
	subagentRuntime: null,
};

// ─── Command Router ─────────────────────────────────────

async function handleCommand(cmd: Command): Promise<void> {
	try {
		switch (cmd.type) {
			case "init":
				await handleInit(cmd, ctx);
				break;
			case "prompt":
				await handlePrompt(cmd, ctx);
				break;
			case "regenerate":
				await handleRegenerate(cmd, ctx);
				break;
			case "abort":
				await handleAbort(cmd, ctx);
				break;
			case "steer":
				await handleSteer(cmd, ctx);
				break;
			case "setModel":
				await handleSetModel(cmd, ctx);
				break;
			case "setThinkingLevel":
				handleSetThinkingLevel(cmd, ctx);
				break;
			case "setToolFilter":
				handleSetToolFilter(cmd, ctx);
				break;
			case "listAgentTools":
				handleListAgentTools(cmd, ctx);
				break;
			case "getMessages":
				handleGetMessages(cmd, ctx);
				break;
			case "getState":
				handleGetState(cmd, ctx);
				break;
			case "getSystemPrompt":
				handleGetSystemPrompt(cmd, ctx);
				break;
			case "setApprovalMode":
				handleSetApprovalMode(cmd, ctx);
				break;
			case "getMcpStatus":
				handleGetMcpStatus(cmd, ctx);
				break;
			case "getMcpServerTools":
				handleGetMcpServerTools(cmd, ctx);
				break;
			case "reloadMcp":
				handleReloadMcp(cmd, ctx);
				break;
			case "cancelSubagent":
				await handleCancelSubagent(cmd, ctx);
				break;
			case "compact":
				await handleCompact(cmd, ctx);
				break;
			case "destroy":
				await handleDestroy(cmd, ctx);
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

// ─── Main Loop ──────────────────────────────────────────

// ready 握手：host 等待此帧后才认为 runner 子进程就绪
send({ type: "ready" });

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

	if (typeof parsed !== "object" || parsed === null) return;
	const frame = parsed as Record<string, unknown>;

	// 往返帧（tool_result / approval_response / trust_response）路由到 pending 桥
	switch (frame.type) {
		case "tool_result":
			handleToolResult(parsed as ToolResultMessage);
			return;
		case "approval_response":
			handleApprovalResponse(parsed as ApprovalResponseMessage);
			return;
		case "trust_response":
			handleTrustResponse(parsed as TrustResponseMessage);
			return;
	}

	void handleCommand(parsed as Command);
});

// host 关闭 stdin（会话销毁）→ 退出进程
process.stdin.on("end", () => {
	process.exit(0);
});
