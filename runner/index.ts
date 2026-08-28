/**
 * SoC Verify Agent Runner — main loop
 *
 * A lightweight Bun entry point that uses the pi-coding-agent SDK directly
 * (not the RPC mode). Communicates with the Electron main process via JSONL
 * on stdin/stdout.
 *
 * This file is the entry point for `bun build --compile`. It owns:
 *   1. The readline main loop (stdin → command dispatch)
 *   2. The handleCommand router (switch/case → handler modules)
 *   3. The pendingToolCalls / pendingApprovalRequests maps (runner ↔ host)
 *   4. The RunnerContext object (shared mutable state passed to handlers)
 *
 * All command handlers are extracted to runner/handlers/*.ts.
 * Protocol layer (send, sendResponse, stdout guard, types) is in runner/protocol.ts.
 * Pure utility functions (approval-logic, write-snapshot) remain in their
 * respective modules.
 *
 * Protocol:
 *   host → runner (stdin):  JSONL commands (init, prompt, abort, steer, ...)
 *   runner → host (stdout): JSONL responses + events + tool_call requests
 *
 * Tool call protocol (runner → host → runner):
 *   runner → host: { type: 'tool_call', id, toolName, args }
 *   host → runner: { type: 'tool_result', id, result, isError? }
 */

import { createInterface } from "node:readline";

// Protocol layer: stdout guard, types, send/sendResponse/sendEvent — all
// imported here so the guard is installed before any output is produced.
import {
	type Command,
	type ToolResultMessage,
	type ApprovalResponseMessage,
	send,
	sendResponse,
	sendToolCall,
} from "./protocol";
import type { RunnerContext } from "./types";

// Handler modules
import { handleInit } from "./handlers/init";
import { handlePrompt, handleAbort, handleSteer, handleRegenerate, handleSetModel, handleSetThinkingLevel, handleGetMessages, handleGetState, handleCompact, handleDestroy } from "./handlers/session";
import { handleGetMcpStatus, handleGetMcpServerTools, handleReloadMcp } from "./handlers/mcp";
import { handleSetApprovalMode, handleSetToolFilter, handleListAgentTools } from "./handlers/tools";

// The `Bun` global is provided by the bun-types package (installed in
// engine/oh-my-pi/node_modules) at compile time, and by the Bun runtime
// at execution time. No manual `declare global` is needed — adding one
// conflicts with bun-types' own declaration (TS2451).

// ─── Pending Tool Calls (runner ↔ host bridge) ─────────

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

// ─── Pending Approval Requests (runner ↔ host bridge) ─────

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

// ─── Runner Context ─────────────────────────────────────

const ctx: RunnerContext = {
	session: null,
	unsubscribe: null,
	currentCwd: process.cwd(),
	currentApprovalMode: "yolo",
	currentDisabledTools: new Set(),
	originalTools: null,
	callHostTool,
	requestApproval,
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
			case "abort":
				await handleAbort(cmd, ctx);
				break;
			case "steer":
				await handleSteer(cmd, ctx);
				break;
			case "regenerate":
				await handleRegenerate(cmd, ctx);
				break;
			case "setModel":
				await handleSetModel(cmd, ctx);
				break;
			case "setApprovalMode":
				await handleSetApprovalMode(cmd, ctx);
				break;
			case "setThinkingLevel":
				await handleSetThinkingLevel(cmd, ctx);
				break;
			case "setToolFilter":
				await handleSetToolFilter(cmd, ctx);
				break;
			case "listAgentTools":
				await handleListAgentTools(cmd, ctx);
				break;
			case "getMessages":
				await handleGetMessages(cmd, ctx);
				break;
			case "getState":
				await handleGetState(cmd, ctx);
				break;
			case "compact":
				await handleCompact(cmd, ctx);
				break;
			case "getMcpStatus":
				await handleGetMcpStatus(cmd, ctx);
				break;
			case "getMcpServerTools":
				await handleGetMcpServerTools(cmd, ctx);
				break;
			case "reloadMcp":
				await handleReloadMcp(cmd, ctx);
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
