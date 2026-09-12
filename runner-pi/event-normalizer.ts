/**
 * pi 原生事件 → Agent Event Contract 归一化层（runner 内部边界）。
 *
 * renderer 只消费 @shared/agent-events 的 AgentEvent；pi 的原生事件名和
 * 字段形状绝不能越出 runner 进程。事件形状依据 pi-coding-agent 0.85.1
 * 的类型声明：
 *   - 核心 AgentEvent（pi-agent-core）：agent_start/end、message 生命周期、
 *     tool_execution 生命周期（字段与契约一致，基本透传）。
 *   - AgentSession 扩展事件：compaction 系列（带 reason）、auto_retry 系列、
 *     summarization_retry 系列、queue_update、agent_settled 等。
 *
 * 映射规则：
 *   - 透传：agent_start、message_*、tool_execution_*、message_update 的
 *     assistantMessageEvent（renderer 忽略多余字段）。
 *   - 改写：agent_end.willRetry → willContinue；tool_execution_end.isError
 *     归一为布尔；compaction_* 按 reason 分流为手动/自动压缩事件。
 *   - 降级：auto_retry_* / summarization_retry_scheduled → notice。
 *   - 丢弃：契约外的 session 专属事件（queue_update、agent_settled、
 *     entry_appended、session_info_changed、thinking_level_changed、
 *     bash_execution_update、turn_*）。
 */

/** pi AgentSession 压缩结束原因（'manual' | 'threshold' | 'overflow'）。 */
type CompactionReason = 'manual' | 'threshold' | 'overflow';

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function toText(value: unknown): string {
	return typeof value === "string" ? value : "";
}

function autoRetryNotice(text: string): Record<string, unknown> {
	return { type: "notice", text, message: text };
}

export function normalizePiEvent(event: unknown): Array<Record<string, unknown>> {
	if (!isRecord(event) || typeof event.type !== "string") return [];
	const type = event.type;

	switch (type) {
		case "agent_start":
		case "message_start":
		case "message_end":
		case "message_update":
		case "tool_execution_start":
		case "tool_execution_update":
			return [event];

		case "tool_execution_end": {
			// 契约守卫要求 isError 为布尔；pi 类型声明为 boolean，此处兜底归一。
			return [
				{
					...event,
					isError: event.isError === true,
				},
			];
		}

		case "agent_end": {
			return [
				{
					type: "agent_end",
					messages: Array.isArray(event.messages) ? event.messages : [],
					willContinue: event.willRetry === true,
				},
			];
		}

		case "compaction_start": {
			if (event.reason === "manual") return [{ type: "compaction_start" }];
			return [{ type: "auto_compaction_start", reason: event.reason }];
		}

		case "compaction_end": {
			const reason = event.reason as CompactionReason | undefined;
			if (reason === "manual" || reason === undefined) {
				return [{ type: "compaction_end" }];
			}
			const mapped: Record<string, unknown> = { type: "auto_compaction_end" };
			if (event.result !== undefined) mapped.result = event.result;
			if (event.aborted !== undefined) mapped.aborted = event.aborted;
			if (event.willRetry !== undefined) mapped.willRetry = event.willRetry;
			if (event.errorMessage !== undefined) mapped.errorMessage = event.errorMessage;
			return [mapped];
		}

		case "auto_retry_start": {
			const attempt = typeof event.attempt === "number" ? event.attempt : 0;
			const maxAttempts = typeof event.maxAttempts === "number" ? event.maxAttempts : 0;
			return [
				autoRetryNotice(
					`LLM 请求失败，自动重试中（${attempt}/${maxAttempts}）：${toText(event.errorMessage)}`,
				),
			];
		}

		case "auto_retry_end": {
			// 重试成功不打扰用户（错误从未展示过，无需报喜）；失败仍输出 notice
			if (event.success === true) return [];
			return [
				autoRetryNotice(
					`LLM 请求自动重试失败：${toText(event.finalError) || toText(event.errorMessage)}`,
				),
			];
		}

		case "summarization_retry_scheduled": {
			const attempt = typeof event.attempt === "number" ? event.attempt : 0;
			const maxAttempts = typeof event.maxAttempts === "number" ? event.maxAttempts : 0;
			return [
				autoRetryNotice(
					`上下文摘要重试已排程（${attempt}/${maxAttempts}）：${toText(event.errorMessage)}`,
				),
			];
		}

		// 契约外事件一律丢弃，避免 pi 原生事件名泄漏到 renderer。
		default:
			return [];
	}
}
