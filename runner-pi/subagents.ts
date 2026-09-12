/**
 * pi-subagents 扩展集成（issue 05 — Subagent 父子工作流）。
 *
 * 纯逻辑部分：pi-subagents 在 pi.events 上发布的扩展事件归一化为 host
 * SubagentFrame 契约、终态映射、Token usage 提取、
 * 审批继承 → capability ceiling、RPC stop 帧、活动 run 跟踪。
 * pi 侧接线（扩展加载、pi.events 订阅、ceiling 注册）在 session.ts 完成。
 *
 * 契约边界（spec）：
 *   - pi-subagents 的原生通道名/事件形状只在 runner 进程内出现；
 *   - renderer 只接收稳定的 subagent_lifecycle / subagent_progress 帧，
 *     不感知 pi-subagents 的原生事件通道与字段差异；
 *   - Token usage 在终态事件中携带 usage（父子归属：payload.parentSessionId
 *     + id），host 侧写入 Token Monitor 时保留引擎、会话与父子关联；
 *   - 能力不足（扩展加载失败、invalid_request 等）以 blockedReason 显式
 *     上报，不静默降级。
 */

import type { ApprovalMode } from "./approval-logic";

// ─── pi-subagents 事件通道（原生名，不越出 runner）──────

/** 异步 subagent 启动（pi-subagents src/shared/types.ts） */
export const SUBAGENT_ASYNC_STARTED_CHANNEL = "subagent:async-started";
/** 异步 subagent 终态 */
export const SUBAGENT_ASYNC_COMPLETE_CHANNEL = "subagent:async-complete";
/** 前台 subagent 终态 */
export const SUBAGENT_FOREGROUND_COMPLETE_CHANNEL = "subagent:foreground-complete";
/** 子会话状态（stopping/stopped — 取消传播观测点） */
export const SUBAGENT_CHILD_STATUS_CHANNEL = "subagent:child-status";
/** 结构化委派协议（extension-to-extension，src/api/delegation.ts） */
export const SUBAGENT_DELEGATION_UPDATE_CHANNEL = "prompt-template:subagent:update";
export const SUBAGENT_DELEGATION_RESPONSE_CHANNEL = "prompt-template:subagent:response";

/** 订阅的原生通道全集（未知通道一律丢弃） */
export const SUBAGENT_CHANNELS: readonly string[] = [
  SUBAGENT_ASYNC_STARTED_CHANNEL,
  SUBAGENT_ASYNC_COMPLETE_CHANNEL,
  SUBAGENT_FOREGROUND_COMPLETE_CHANNEL,
  SUBAGENT_CHILD_STATUS_CHANNEL,
  SUBAGENT_DELEGATION_UPDATE_CHANNEL,
  SUBAGENT_DELEGATION_RESPONSE_CHANNEL,
];

// ─── RPC stop（取消传播 host 出口）──────────────────────

export const RPC_REQUEST_CHANNEL = "subagents:rpc:v1:request";
export const RPC_REPLY_CHANNEL_PREFIX = "subagents:rpc:v1:reply:";
const RPC_PROTOCOL_VERSION = 1;

export interface RpcStopEnvelope {
	version: typeof RPC_PROTOCOL_VERSION;
	requestId: string;
	method: "stop";
	params: { runId?: string; id?: string; dir?: string };
	source: { extension: string };
}

export function buildRpcStopRequest(
	requestId: string,
	target: { runId?: string; id?: string; dir?: string },
): { envelope: RpcStopEnvelope; replyChannel: string } {
	return {
		envelope: {
			version: RPC_PROTOCOL_VERSION,
			requestId,
			method: "stop",
			params: target,
			source: { extension: "socverify-runner" },
		},
		replyChannel: `${RPC_REPLY_CHANNEL_PREFIX}${requestId}`,
	};
}

// ─── 归一化输出（host SubagentFrame 契约形状）───────────

export type SubagentTerminalStatus = "completed" | "failed" | "aborted";

/** 归一化后的 Token usage（终态事件携带，父子归属用） */
export type SubagentUsage = {
	input: number;
	output: number;
	cacheRead: number;
	cacheWrite: number;
	costUsd: number;
	turns: number;
	toolCalls: number;
	durationMs: number;
}

export type SubagentFrame = {
	type: "subagent_lifecycle" | "subagent_progress" | "subagent_stream";
	payload: Record<string, unknown>;
}

export type SubagentNormalizeContext = {
	/** 父 pi 会话 id（父子归属关键字段） */
	parentSessionId: string | null;
	/** 发起本次运行的 subagent 工具调用 id（UI 卡片关联） */
	parentToolCallId?: string;
}

function num(value: unknown): number {
	return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

function str(value: unknown): string | undefined {
	return typeof value === "string" && value.length > 0 ? value : undefined;
}

function record(value: unknown): Record<string, unknown> | undefined {
	return typeof value === "object" && value !== null && !Array.isArray(value)
		? value as Record<string, unknown>
		: undefined;
}

/**
 * 子会话原生事件的最小白名单投影。前台订阅和异步 events.jsonl 共用，
 * 防止 pi 私有事件或 message_update 的 partial 快照越过 runner 边界。
 */
export function normalizeChildStreamFrame(
	id: string,
	raw: unknown,
	metadata: SubagentNormalizeContext & { index?: number; agent?: string },
): SubagentFrame[] {
	const event = record(raw);
	if (!id || !event || typeof event.type !== "string") return [];
	let projected: Record<string, unknown> | undefined;

	switch (event.type) {
		case "agent_start":
			projected = { type: "agent_start" };
			break;
		case "agent_end":
			projected = { type: "agent_end", ...(event.willRetry === true ? { willContinue: true } : {}) };
			break;
		case "message_start":
		case "message_end": {
			const message = record(event.message);
			if (!message || message.role !== "assistant") return [];
			projected = { type: event.type, message };
			break;
		}
		case "message_update": {
			const update = record(event.assistantMessageEvent);
			if (!update || typeof update.type !== "string") return [];
			projected = {
				type: "message_update",
				assistantMessageEvent: {
					type: update.type,
					...(typeof update.delta === "string" ? { delta: update.delta } : {}),
				},
			};
			break;
		}
		case "tool_execution_start":
		case "tool_execution_update":
		case "tool_execution_end": {
			if (typeof event.toolCallId !== "string" || typeof event.toolName !== "string") return [];
			projected = {
				type: event.type,
				toolCallId: event.toolCallId,
				toolName: event.toolName,
				...(event.args !== undefined ? { args: event.args } : {}),
				...(event.partialResult !== undefined ? { partialResult: event.partialResult } : {}),
				...(event.result !== undefined ? { result: event.result } : {}),
				...(event.type === "tool_execution_end" ? { isError: event.isError === true } : {}),
			};
			break;
		}
		default:
			return [];
	}

	return [{
		type: "subagent_stream",
		payload: {
			id,
			...(metadata.index !== undefined ? { index: metadata.index } : {}),
			...(metadata.agent ? { agent: metadata.agent } : {}),
			parentSessionId: metadata.parentSessionId,
			parentToolCallId: metadata.parentToolCallId,
			event: projected,
		},
	}];
}

/** delegation/async 终态状态 → host 契约终态 */
export function mapTerminalStatus(status: unknown): SubagentTerminalStatus {
	if (status === "completed") return "completed";
	if (status === "cancelled" || status === "interrupted") return "aborted";
	return "failed";
}

/** 从 delegation response / async-complete payload 提取 usage */
export function extractSubagentUsage(usage: unknown): SubagentUsage | null {
	if (typeof usage !== "object" || usage === null || Array.isArray(usage)) return null;
	const u = usage as Record<string, unknown>;
	const cost = typeof u.cost === "object" && u.cost !== null ? u.cost : u;
	return {
		input: num(u.input),
		output: num(u.output),
		cacheRead: num(u.cacheRead),
		cacheWrite: num(u.cacheWrite),
		costUsd: num((cost as Record<string, unknown>).total ?? (cost as Record<string, unknown>).cost),
		turns: num(u.turns),
		toolCalls: num(u.toolCalls),
		durationMs: num(u.durationMs),
	};
}

function lifecycleFrame(
	id: string,
	status: SubagentTerminalStatus | "running",
	ctx: SubagentNormalizeContext,
	extra: Record<string, unknown>,
): SubagentFrame {
	return {
		type: "subagent_lifecycle",
		payload: {
			id,
			status,
			parentSessionId: ctx.parentSessionId,
			parentToolCallId: ctx.parentToolCallId,
			...extra,
		},
	};
}

/**
 * pi-subagents 原生事件 → host SubagentFrame 归一化。
 *
 * 支持：async-started（启动）、delegation update（进度）、delegation response
 * 与 async-complete（终态 + usage）、child-status（取消观测）。未知通道
 * 返回空数组 —— 原生事件名与未识别 payload 绝不透传给 host。
 */
export function normalizeSubagentFrame(
	channel: string,
	payload: unknown,
	ctx: SubagentNormalizeContext,
): SubagentFrame[] {
	if (typeof payload !== "object" || payload === null || Array.isArray(payload)) return [];
	const p = payload as Record<string, unknown>;

	switch (channel) {
		case SUBAGENT_ASYNC_STARTED_CHANNEL: {
			const id = str(p.id);
			if (!id) return [];
			return [
				lifecycleFrame(id, "running", ctx, {
					agent: str(p.agent) ?? str(p.goal) ?? "subagent",
					description: str(p.task) ?? str(p.goal),
					// async 生命周期目录（status.json/events.jsonl 等 run 产物）；
					// artifacts 输出桶按约定位于父 pi 会话 bucket 的 subagent-artifacts/
					runDir: str(p.asyncDir),
					mode: str(p.mode),
				}),
			];
		}

		case SUBAGENT_DELEGATION_UPDATE_CHANNEL: {
			const id = str(p.runId) ?? str(p.requestId);
			if (!id) return [];
			return [
				{
					type: "subagent_progress",
					payload: {
						id,
						parentSessionId: ctx.parentSessionId,
						parentToolCallId: ctx.parentToolCallId,
						progress: {
							tokens: num(p.tokens),
							currentTool: str(p.currentTool),
							currentToolArgs: str(p.currentToolArgs),
							recentOutput: Array.isArray(p.recentOutputLines)
								? p.recentOutputLines.filter((l): l is string => typeof l === "string")
								: undefined,
							toolCount: num(p.toolCount),
						},
					},
				},
			];
		}

		case SUBAGENT_DELEGATION_RESPONSE_CHANNEL:
		case SUBAGENT_ASYNC_COMPLETE_CHANNEL:
		case SUBAGENT_FOREGROUND_COMPLETE_CHANNEL: {
			const id = channel === SUBAGENT_FOREGROUND_COMPLETE_CHANNEL
				? str(p.id) ?? str(p.runId)
				: str(p.runId) ?? str(p.requestId) ?? str(p.id);
			if (!id) return [];
			const status = channel === SUBAGENT_DELEGATION_RESPONSE_CHANNEL
				? mapTerminalStatus(p.status)
				: p.success === true || p.state === "complete" || p.status === "completed"
					? "completed"
					: p.stopped === true || p.interrupted === true || p.state === "stopped" || p.status === "cancelled"
						? "aborted"
						: "failed";
			return [
				lifecycleFrame(id, status, ctx, {
					agent: str(p.agent),
					index: num(p.taskIndex),
					usage: extractSubagentUsage(p.usage) ?? undefined,
					blockedReason: status !== "completed" ? (str(p.error) ?? str(p.reason)) : undefined,
					ownerRunId: str(p.ownerRunId),
				}),
			];
		}

		case SUBAGENT_CHILD_STATUS_CHANNEL: {
			const id = str(p.runId) ?? str(p.childId);
			if (!id) return [];
			if (p.status !== "stopping" && p.status !== "stopped") return [];
			return [lifecycleFrame(id, "aborted", ctx, { agent: str(p.agent) })];
		}

		default:
			return [];
	}
}

// ─── 前台工具进度归一化（tool_execution_update 路径）─────

/**
 * pi `subagent` 工具 onUpdate 快照中的 progress 条目（AgentProgress 形状，
 * 见 pi-subagents src/shared/types.ts）归一化为 host subagent_progress 帧。
 *
 * delegation/async 原生通道只覆盖 slash 委派与异步 run；主代理直接调用的
 * 前台子代理进度仅经 pi 的 tool_execution_update 事件透出（tokens /
 * currentTool / recentOutput / toolCount / turnCount）。单代理帧 id 与
 * renderer 派遣占位 id（toolCallId）严格一致，store 可直接流式更新；
 * 多代理按 index 派生子 id，终态帧由 renderer 经 index+agent 匹配合并。
 * AgentProgress.task 在流式快照中已被 pi-subagents redact，不作为任务概要
 * 来源（概要来自 renderer 侧派遣参数快照）。
 */
export function normalizeForegroundProgressFrames(
	toolCallId: string,
	progressList: unknown[],
	ctx: SubagentNormalizeContext,
): SubagentFrame[] {
	if (!toolCallId) return [];
	const frames: SubagentFrame[] = [];
	for (let i = 0; i < progressList.length; i++) {
		const raw = progressList[i];
		if (typeof raw !== "object" || raw === null) continue;
		const p = raw as Record<string, unknown>;
		const index = typeof p.index === "number" && Number.isFinite(p.index) ? p.index : i;
		const id = progressList.length === 1 ? toolCallId : `${toolCallId}:${index}`;
		const agent = str(p.agent);
		const payload: Record<string, unknown> = {
			id,
			parentSessionId: ctx.parentSessionId,
			parentToolCallId: ctx.parentToolCallId ?? toolCallId,
			index,
			progress: {
				...(typeof p.tokens === "number" && Number.isFinite(p.tokens) ? { tokens: p.tokens } : {}),
				currentTool: str(p.currentTool),
				currentToolArgs: str(p.currentToolArgs),
				recentOutput: Array.isArray(p.recentOutput)
					? p.recentOutput.filter((l): l is string => typeof l === "string" && l.trim().length > 0)
					: [],
				...(typeof p.toolCount === "number" && Number.isFinite(p.toolCount) ? { toolCount: p.toolCount } : {}),
				...(typeof p.turnCount === "number" && Number.isFinite(p.turnCount) ? { requests: p.turnCount } : {}),
			},
		};
		if (agent) payload.agent = agent;
		frames.push({ type: "subagent_progress", payload });
	}
	return frames;
}

/** detached runner 的 status.json 快照使用 TokenUsage 对象，其余字段与 AgentProgress 一致。 */
export function normalizeAsyncStatusProgressFrames(
	runId: string,
	status: unknown,
	ctx: SubagentNormalizeContext,
): SubagentFrame[] {
	if (typeof status !== "object" || status === null || Array.isArray(status)) return [];
	const steps = (status as Record<string, unknown>).steps;
	if (!Array.isArray(steps)) return [];
	return normalizeForegroundProgressFrames(
		runId,
		steps.map((raw) => {
			if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return raw;
			const step = raw as Record<string, unknown>;
			const usage = typeof step.tokens === "object" && step.tokens !== null && !Array.isArray(step.tokens)
				? step.tokens as Record<string, unknown>
				: undefined;
			return {
				...step,
				tokens: usage
					? num(usage.total) || num(usage.input) + num(usage.output)
					: step.tokens,
			};
		}),
		ctx,
	);
}

// ─── 审批继承 → capability ceiling ──────────────────────

/**
 * 把父会话审批模式映射为 pi-subagents capability ceiling（引擎提供的
 * host 级子会话约束机制，按 sessionId 注册并可动态 update）。
 *
 * - always-ask / write：子会话禁用 extension 工具面（MCP/extension 工具
 *   未经父层单次审批链路，不下放给子会话）—— 审批边界继承；
 * - yolo：不额外收紧（单次审批放宽；extension/MCP 信任边界由 issue 04
 *   的信任流程独立保证，yolo 不绕过）。
 */
export function resolveSubagentCeiling(mode: ApprovalMode): { denyExtensions: true } | null {
	if (mode === "yolo") return null;
	return { denyExtensions: true };
}

// ─── 活动 run 跟踪（取消传播 / destroy 清理）────────────

export type SubagentRunRegistry = {
	runs: Map<string, { agent?: string; dir?: string }>;
}

/** pi.events 的最小结构面（bridge 装配时注入，供 RPC stop 使用） */
export type SubagentEventBus = {
	emit(channel: string, data: unknown): void;
	on(channel: string, handler: (data: unknown) => void): () => void;
}

/** capability ceiling 句柄（pi-subagents/capability-ceiling 返回） */
export type SubagentCeilingHandle = {
	update(ceiling: { denyExtensions: true }): void;
	dispose(): void;
}

/** runner 侧 subagent 运行时状态（挂在 PiRunnerContext 上） */
export type SubagentRuntime = {
	enabled: boolean;
	/** 能力不足时的显式阻断原因（不静默降级） */
	blockedReason: string | null;
	registry: SubagentRunRegistry;
	/** pi.events 引用（bridge 扩展装配时注入；未装配时为 null） */
	events: SubagentEventBus | null;
	/** 审批继承 ceiling 句柄（yolo 模式为 null） */
	ceilingHandle: SubagentCeilingHandle | null;
	/** 前台 child session 的结构化事件入口，由 bridge extension 在装载时注入。 */
	onChildEvent?: (input: {
		runId?: string;
		agent?: string;
		index: number;
		event: unknown;
	}) => void;
}

export const trackSubagentRun = {
	create(): SubagentRunRegistry {
		return { runs: new Map() };
	},

	/** 启动事件登记活动 run（async-started） */
	onStart(
		registry: SubagentRunRegistry,
		event: { channel: string; payload: unknown },
	): void {
		if (event.channel !== SUBAGENT_ASYNC_STARTED_CHANNEL) return;
		if (typeof event.payload !== "object" || event.payload === null) return;
		const p = event.payload as Record<string, unknown>;
		const id = str(p.id);
		if (!id) return;
		registry.runs.set(id, { agent: str(p.agent), dir: str(p.asyncDir) });
	},

	/** 终态事件移除 */
	onTerminal(registry: SubagentRunRegistry, runId: string): void {
		registry.runs.delete(runId);
	},

	activeRunIds(registry: SubagentRunRegistry): string[] {
		return [...registry.runs.keys()];
	},
};
