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
 *
 * 命令处理在 runner-pi/session.ts，协议层在 runner-pi/protocol.ts，
 * pi 事件归一化在 runner-pi/event-normalizer.ts。
 */

import { createInterface } from "node:readline";
import {
	installStdoutJsonlGuard,
	type Command,
	type PiRunnerContext,
	type ToolResultMessage,
	send,
	sendResponse,
	sendToolCall,
} from "./protocol.ts";
import {
	handleAbort,
	handleCompact,
	handleDestroy,
	handleInit,
	handlePrompt,
	handleSetModel,
	handleSteer,
} from "./session.ts";

// Guard 必须先于任何输出安装（包括底部的 ready 帧）
installStdoutJsonlGuard();

// ─── Pending Tool Calls（runner ↔ host 桥）──────────────

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
		// 120s 超时：host 工具无响应时不永久挂起引擎 turn
		const timeout = setTimeout(() => {
			if (pendingToolCalls.has(id)) {
				pendingToolCalls.delete(id);
				reject(new Error(`Tool "${toolName}" timed out`));
			}
		}, 120_000);
		timeout.unref?.();
	});
}

// ─── Runner Context ─────────────────────────────────────

const ctx: PiRunnerContext = {
	session: null,
	unsubscribe: null,
	currentCwd: process.cwd(),
	callHostTool,
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
			case "setModel":
				await handleSetModel(cmd, ctx);
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

	// tool_result 帧不是命令，路由到 pending 桥
	if (
		typeof parsed === "object" &&
		parsed !== null &&
		(parsed as Record<string, unknown>).type === "tool_result"
	) {
		handleToolResult(parsed as ToolResultMessage);
		return;
	}

	void handleCommand(parsed as Command);
});

// host 关闭 stdin（会话销毁）→ 退出进程
process.stdin.on("end", () => {
	process.exit(0);
});
