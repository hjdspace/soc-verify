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
 * 在进程启动时调用。这样协议层可以独立测试，也避免了测试进程被改写 stdout。
 */

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
 *   - approvalMode / disabledTools 属于 issue 04（审批）
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
};

export type Command =
	| { id: string; type: "init"; config: InitConfig }
	| { id: string; type: "prompt"; message: string; images?: string[] }
	| { id: string; type: "abort" }
	| { id: string; type: "steer"; message: string }
	| { id: string; type: "setModel"; provider: string; modelId: string }
	| { id: string; type: "compact" }
	| { id: string; type: "destroy" };

/** runner 内部共享的可变状态，传给各命令处理器。 */
export interface PiRunnerContext {
	/** pi AgentSession（init 前 / destroy 后为 null） */
	session: unknown;
	/** 事件订阅退订函数（无活动会话时为 null） */
	unsubscribe: (() => void) | null;
	/** 当前工作目录（init 时设置） */
	currentCwd: string;
	/** 把工具调用转发给 Electron host 并等待结果（ask 等） */
	callHostTool: (toolName: string, args: unknown) => Promise<unknown>;
}

// ─── 入站帧（host → runner stdin）──────────────────────

/** host 对 tool_call 的应答（工具结果回流） */
export interface ToolResultMessage {
	type: "tool_result";
	id: string;
	result: unknown;
	isError?: boolean;
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
