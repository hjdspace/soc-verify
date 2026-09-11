/**
 * JSONL protocol layer for the SoC Verify pi runner.
 *
 * runner 通过 pi SDK 驱动 Agent 会话，与 Electron 主进程之间沿用现有
 * JSONL 命令/事件协议（与 omp runner 相同的帧形状）：
 *   host → runner (stdin):  JSONL commands (init, prompt, abort, ...)
 *   runner → host (stdout): JSONL responses + events + tool_call requests
 *
 * 与 omp runner 的 protocol.ts 不同，本模块在导入时**无副作用**：
 * stdout JSONL guard 改为显式的 installStdoutJsonlGuard()，由 runner-pi/index.ts
 * 在产生任何协议输出之前调用。这样协议层可以独立测试，也避免了测试进程被改写 stdout。
 */

import type { ApprovalMode } from "./approval-logic";

/** 信任确认类型：项目 extension 首次加载 / MCP server 首次启动 */
export type TrustKind = "project-extension" | "mcp-server";

// ─── stdout JSONL guard ─────────────────────────────────
// pi SDK 及其依赖可能通过 console.log 向 stdout 写日志，这会破坏
// runner 与 host 之间的 JSONL 协议。guard 只放行「能解析为 JSON 且
// 带 type 字段」的行（协议帧判别字段），其余一律重定向到 stderr
// （host 侧捕获为 [agent:stderr] 诊断输出）。

export function shouldPassToStdout(str: string): boolean {
	const line = str.trim();
	if (!line) return false;
	try {
		const parsed: unknown = JSON.parse(line);
		return (
			typeof parsed === "object" && parsed !== null && !Array.isArray(parsed) && "type" in parsed
		);
	} catch {
		return false;
	}
}

let stdoutGuardInstalled = false;

/** 安装 stdout JSONL guard（幂等）。必须在产生任何协议输出之前调用。 */
export function installStdoutJsonlGuard(): void {
	if (stdoutGuardInstalled) return;
	stdoutGuardInstalled = true;
	const origStdoutWrite = process.stdout.write.bind(process.stdout);
	process.stdout.write = ((data: unknown, ...args: unknown[]) => {
		const str = typeof data === "string" ? data : String(data);
		if (shouldPassToStdout(str)) {
			return origStdoutWrite(data as string, ...(args as never[]));
		}
		return process.stderr.write(str, ...(args as never[]));
	}) as typeof process.stdout.write;
}

// ─── Types ──────────────────────────────────────────────

/** host 下发的自定义工具定义（host tools + `ask`），runner 原样注册进 pi。 */
export type HostToolDefinition = {
	name: string;
	label?: string;
	description: string;
	parameters: Record<string, unknown>;
	/** 保留字段：pi 0.85.1 的 ToolDefinition 无 per-tool approval，审批由 issue 04 统一处理 */
	approval?: string;
};

/**
 * pi runner 的 init 配置。字段与 host 侧 src/main/agent/types.ts 的 InitConfig
 * 对齐，但只声明 runner 实际消费的字段（多余字段自然忽略）。
 *
 * 与 omp 的差异：
 *   - sessionDir 不使用 —— pi 使用其原生用户级 session 根目录 + cwd bucket
 *   - resumeSessionId / seedHistory 属于 issue 07（会话恢复）
 *   - contextWindow 属于 issue 06（模型与上下文 parity）
 */
export type InitConfig = {
	cwd: string;
	apiKey?: string;
	baseUrl?: string;
	provider?: string;
	model?: string;
	env?: Record<string, string>;
	customToolDefinitions?: HostToolDefinition[];
	/** 工具审批模式：always-ask（总询问）、write（自动编辑）、yolo（完全信任，仅单次审批） */
	approvalMode?: ApprovalMode;
	/** 被禁用的工具名列表（host 工具 + pi 内置工具），会话创建时不暴露给 LLM */
	disabledTools?: string[];
	/** 是否为会话启用 MCP（缺省 true） */
	enableMCP?: boolean;
	/** 是否为会话启用 subagent 扩展（pi-subagents，缺省 true；停用不做阻断） */
	enableSubagents?: boolean;
	/** host 信任存储中已确认信任的 MCP server 名（首次启动确认的持久化结果） */
	trustedMcpServers?: string[];
	/** host 信任存储中已确认信任的项目目录（extension 首次加载确认的持久化结果） */
	trustedProjectDirs?: string[];
};

export type Command =
	| { id: string; type: "init"; config: InitConfig }
	| { id: string; type: "prompt"; message: string; images?: string[] }
	| { id: string; type: "abort" }
	| { id: string; type: "steer"; message: string }
	| { id: string; type: "setModel"; provider: string; modelId: string }
	| { id: string; type: "setApprovalMode"; approvalMode: ApprovalMode }
	| { id: string; type: "getMcpStatus" }
	| { id: string; type: "getMcpServerTools"; serverName: string }
	| { id: string; type: "reloadMcp" }
	| { id: string; type: "cancelSubagent"; target: SubagentStopTarget }
	| { id: string; type: "compact" }
	| { id: string; type: "destroy" };

/** cancelSubagent 的目标（runId / runId 前缀 / async 目录，与 pi-subagents stop 语义一致） */
export type SubagentStopTarget = {
	runId?: string;
	id?: string;
	dir?: string;
}

/** runner 内部共享的可变状态，传给各命令处理器。 */
export interface PiRunnerContext {
	/** pi AgentSession（init 前 / destroy 后为 null） */
	session: unknown;
	/** 事件订阅退订函数（无活动会话时为 null） */
	unsubscribe: (() => void) | null;
	/** 当前工作目录（init 时设置） */
	currentCwd: string;
	/** 当前审批模式（init 设置，setApprovalMode 动态更新） */
	currentApprovalMode: ApprovalMode;
	/** 把工具调用转发给 Electron host 并等待结果（ask 等） */
	callHostTool: (toolName: string, args: unknown) => Promise<unknown>;
	/** 请求用户审批一次工具调用（审批模式判定后的出口） */
	requestApproval: (toolName: string, args: unknown) => Promise<boolean>;
	/** 请求用户信任确认（extension 首次加载 / MCP server 首次启动） */
	requestTrust: (kind: TrustKind, name: string, path?: string) => Promise<boolean>;
	/** MCP 运行时状态（init 时装配；未启用 MCP 时为 null） */
	mcpRuntime: import("./mcp-runtime").McpRuntimeState | null;
	/** subagent 运行时状态（init 时装配；显式停用/加载失败时 enabled=false） */
	subagentRuntime: import("./subagents").SubagentRuntime | null;
}

// ─── 入站帧（host → runner stdin）──────────────────────

/** host 对 tool_call 的应答（工具结果回流） */
export interface ToolResultMessage {
	type: "tool_result";
	id: string;
	result: unknown;
	isError?: boolean;
}

/** host 对 approval_request 的应答 */
export interface ApprovalResponseMessage {
	type: "approval_response";
	id: string;
	approved: boolean;
}

/** host 对 trust_request 的应答 */
export interface TrustResponseMessage {
	type: "trust_response";
	id: string;
	approved: boolean;
}

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

export function sendToolCall(id: string, toolName: string, args: unknown): void {
	send({ type: "tool_call", id, toolName, args });
}
