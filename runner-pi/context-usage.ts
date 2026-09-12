/**
 * pi 引擎 context_usage 组装层（issue 06）。
 *
 * spec：context_usage 优先采用 pi 原生值（AgentSession.getContextUsage()，
 * 来自真实 usage 统计）；pi 返回 tokens=null（压缩后、首轮回复前等未知
 * 状态）时由 runner 从消息文本估算并标记为近似（approximate: true）。
 *
 * 推送边界与 omp runner 的 shouldSendContextUsage 保持一致：上下文只在
 * LLM 轮次与压缩截止点增长。
 */
import { sendEvent } from "./protocol.ts";

/** pi 原生 ContextUsage（AgentSession.getContextUsage()），tokens/percent 可为 null。 */
export type PiNativeContextUsage = {
	tokens: number | null;
	contextWindow: number;
	percent: number | null;
};

/** host 契约（@shared/context-management 的 ContextUsage + approximate 标记）。 */
export type HostContextUsage = {
	tokens: number;
	contextWindow: number;
	percent: number;
	/** true 表示 tokens 为 runner 估算值而非 pi 原生统计 */
	approximate: boolean;
};

/**
 * 上下文只在这些事件边界增长/收缩（与 omp runner 相同集合）：
 * message_end 每轮 LLM 响应触发一次（多轮工具任务内也逐轮推送），
 * compaction 系列在压缩截止点触发。
 */
export function shouldSendContextUsage(eventType: string): boolean {
	return (
		eventType === "message_end" ||
		eventType === "agent_end" ||
		eventType === "compaction_start" ||
		eventType === "compaction_end" ||
		eventType === "auto_compaction_start" ||
		eventType === "auto_compaction_end"
	);
}

/**
 * 粗略 token 估算：文本按 chars/4。仅在 pi 原生值未知（tokens=null）时
 * 作为近似回退使用；图片等内容块不计入。
 */
export function estimateTokensFromMessages(messages: unknown): number {
	if (!Array.isArray(messages)) return 0;
	let chars = 0;
	for (const message of messages) {
		if (typeof message !== "object" || message === null) continue;
		const content = (message as { content?: unknown }).content;
		if (typeof content === "string") {
			chars += content.length;
			continue;
		}
		if (!Array.isArray(content)) continue;
		for (const block of content) {
			if (
				typeof block === "object" &&
				block !== null &&
				(block as { type?: string }).type === "text" &&
				typeof (block as { text?: unknown }).text === "string"
			) {
				chars += (block as { text: string }).text.length;
			}
		}
	}
	return Math.ceil(chars / 4);
}

/**
 * pi 原生值 → host 契约映射。
 *
 * - tokens 为数字：透传 pi 原生值（percent 缺失时按 tokens/window 补算），
 *   approximate=false；
 * - tokens 为 null：以消息估算回退，approximate=true；
 * - 无原生值且无消息可估算：返回 null（调用方跳过本次推送）。
 */
export function mapPiContextUsage(
	native: PiNativeContextUsage | undefined,
	opts: { messages?: unknown } = {},
): HostContextUsage | null {
	const contextWindow = native?.contextWindow ?? 0;

	if (native && typeof native.tokens === "number") {
		const windowKnown = contextWindow > 0;
		const percent =
			typeof native.percent === "number"
				? native.percent
				: windowKnown
					? (native.tokens / contextWindow) * 100
					: 0;
		// 窗口未知时 percent 不可信，整体降级为近似标记
		return {
			tokens: native.tokens,
			contextWindow,
			percent,
			approximate: !windowKnown,
		};
	}

	const estimated = estimateTokensFromMessages(opts.messages);
	if (!native && estimated === 0) return null;
	const percent = contextWindow > 0 ? (estimated / contextWindow) * 100 : 0;
	return { tokens: estimated, contextWindow, percent, approximate: true };
}

// ─── 事件推送 ───────────────────────────────────────────

/** 会话对象上与 context_usage 相关的最小结构面。 */
export type ContextUsageSession = {
	getContextUsage?: () => PiNativeContextUsage | undefined;
	messages?: unknown;
	isCompacting?: boolean;
	autoCompactionEnabled?: boolean;
};

/**
 * 发送一条 context_usage 事件帧（值来自 pi 原生统计，未知时为近似估算）。
 * 无会话或无法得出任何用量时跳过。
 */
export function sendContextUsage(session: unknown): void {
	if (!session) return;
	const s = session as ContextUsageSession;
	const contextUsage = mapPiContextUsage(s.getContextUsage?.(), { messages: s.messages });
	if (!contextUsage) return;
	sendEvent({
		type: "context_usage",
		contextUsage,
		isCompacting: s.isCompacting === true,
		autoCompactionEnabled: s.autoCompactionEnabled !== false,
	});
}
