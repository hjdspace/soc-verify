/**
 * Session lifecycle handlers — prompt, abort, steer, model switching,
 * message/state retrieval, compaction, and destroy.
 *
 * These are the "core interaction" handlers that the host calls most
 * frequently after init.
 */

import { type Command, sendResponse, sendContextUsage, toEngineThinkingLevel } from "../protocol";
import type { RunnerContext } from "../types";

export async function handlePrompt(cmd: Command & { type: "prompt" }, ctx: RunnerContext): Promise<void> {
	if (!ctx.session) throw new Error("Session not initialized");

	// Convert image strings to ImageContent objects expected by the SDK.
	// Images arrive as full data URLs (data:image/png;base64,...) so we can
	// recover the MIME type.  Raw base64 strings fall back to image/png.
	let images: Array<{ type: "image"; data: string; mimeType: string }> | undefined;
	if (cmd.images?.length) {
		images = cmd.images.map((img) => {
			const match = img.match(/^data:([^;]+);base64,(.+)$/);
			if (match) {
				return { type: "image" as const, data: match[2], mimeType: match[1] };
			}
			return { type: "image" as const, data: img, mimeType: "image/png" };
		});
	}

	await (ctx.session as { prompt: (msg: string, opts?: { images?: unknown[] }) => Promise<void> })
		.prompt(cmd.message, images ? { images } : undefined);
	sendResponse(cmd.id, true, { ok: true });
}

export async function handleAbort(cmd: Command & { type: "abort" }, ctx: RunnerContext): Promise<void> {
	if (!ctx.session) throw new Error("Session not initialized");
	await (ctx.session as { abort: () => Promise<void> }).abort();
	sendResponse(cmd.id, true, { ok: true });
}

export async function handleSteer(cmd: Command & { type: "steer" }, ctx: RunnerContext): Promise<void> {
	if (!ctx.session) throw new Error("Session not initialized");
	await (ctx.session as { steer: (msg: string) => Promise<void> }).steer(cmd.message);
	sendResponse(cmd.id, true, { ok: true });
}

export async function handleSetModel(cmd: Command & { type: "setModel" }, ctx: RunnerContext): Promise<void> {
	if (!ctx.session) throw new Error("Session not initialized");
	// The SDK's AgentSession doesn't have a direct setModel method like the RPC mode.
	// Model switching requires recreating the session or using the agent's internal API.
	// For now, we just acknowledge the request.
	sendResponse(cmd.id, true, { ok: true, note: "Model switching via SDK is not yet supported" });
}

export async function handleSetThinkingLevel(cmd: Command & { type: "setThinkingLevel" }, ctx: RunnerContext): Promise<void> {
	if (!ctx.session) throw new Error("Session not initialized");
	// AgentSession.setThinkingLevel(level, persist): persist=true appends a
	// thinking_level_change entry to the omp session file so the setting
	// survives omp-native resume (e.g. after a holistic model swap).
	// 'default' maps to undefined — hand control back to the engine default.
	const session = ctx.session as {
		setThinkingLevel: (level: string | undefined, persist?: boolean) => void;
	};
	session.setThinkingLevel(toEngineThinkingLevel(cmd.level), true);
	sendResponse(cmd.id, true, { ok: true });
}

export async function handleGetMessages(cmd: Command & { type: "getMessages" }, ctx: RunnerContext): Promise<void> {
	if (!ctx.session) throw new Error("Session not initialized");
	const messages = (ctx.session as { messages: unknown }).messages;
	sendResponse(cmd.id, true, { messages });
}

export async function handleGetState(cmd: Command & { type: "getState" }, ctx: RunnerContext): Promise<void> {
	if (!ctx.session) throw new Error("Session not initialized");
	const session = ctx.session as {
		state: Record<string, unknown>;
		model: unknown;
		getContextUsage?: () => unknown;
		getContextBreakdown?: () => unknown;
		isCompacting?: boolean;
		autoCompactionEnabled?: boolean;
		// Configured thinking selector ('auto' | 'off' | concrete effort | undefined).
		// Note: session.state.thinkingLevel is the per-turn RESOLVED effort — the
		// host UI wants the configured selector instead, so it overrides the spread.
		configuredThinkingLevel?: () => unknown;
	};
	const state = {
		...session.state,
		model: session.model,
		contextUsage: session.getContextUsage?.(),
		contextBreakdown: session.getContextBreakdown?.(),
		isCompacting: session.isCompacting === true,
		autoCompactionEnabled: session.autoCompactionEnabled !== false,
		thinkingLevel: session.configuredThinkingLevel?.(),
	};
	sendResponse(cmd.id, true, { state });
}

export async function handleCompact(cmd: Command & { type: "compact" }, ctx: RunnerContext): Promise<void> {
	if (!ctx.session) throw new Error("Session not initialized");
	const session = ctx.session as {
		compact: () => Promise<unknown>;
		getContextUsage?: () => unknown;
		getContextBreakdown?: () => unknown;
	};
	const result = await session.compact();
	const contextUsage = session.getContextUsage?.();
	const contextBreakdown = session.getContextBreakdown?.();
	sendResponse(cmd.id, true, { result, contextUsage, contextBreakdown });
	sendContextUsage(ctx.session);
}

export async function handleDestroy(cmd: Command & { type: "destroy" }, ctx: RunnerContext): Promise<void> {
	if (ctx.unsubscribe) {
		ctx.unsubscribe();
		ctx.unsubscribe = null;
	}
	if (ctx.session) {
		// eslint-disable-next-line @typescript-eslint/no-explicit-any
		await (ctx.session as any).dispose?.();
		ctx.session = null;
	}
	sendResponse(cmd.id, true, { ok: true });
}
