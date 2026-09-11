/**
 * pi 消息 content block 的共享分类（runner-pi 构建目标内部复用）。
 *
 * session.ts 的 regenerate 重放与 session-scan.ts 的扫描归一化都只关心
 * text / image 两类可见块；thinking / toolCall 等引擎内部块不参与。
 * 分类逻辑集中在此，避免两处块遍历漂移。
 */

/** 分类后的 content block */
export type ContentBlock =
	| { kind: "text"; text: string }
	| { kind: "image"; data: string; mimeType: string };

/**
 * 分类单个 content block：text → {kind:'text', text}；image →
 * {kind:'image', data, mimeType}（data 为 base64 裸数据，由调用方决定
 * 包装形状 —— prompt 重放原样透传，扫描序列化为 data URL）；
 * 其余（thinking/toolCall 等）返回 null。
 */
export function classifyContentBlock(block: unknown): ContentBlock | null {
	const b = block as { type?: string; text?: string; data?: string; mimeType?: string };
	if (b.type === "text" && typeof b.text === "string") {
		return { kind: "text", text: b.text };
	}
	if (b.type === "image" && typeof b.data === "string" && typeof b.mimeType === "string") {
		return { kind: "image", data: b.data, mimeType: b.mimeType };
	}
	return null;
}
