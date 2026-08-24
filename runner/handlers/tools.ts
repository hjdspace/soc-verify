/**
 * Tools handlers — approval mode, tool filter, and tool listing.
 *
 * Also exports `applyApprovalMode`, the shared function that wraps the
 * session's tool set with approval proxies and disabled-tool filtering.
 * Called by handleInit (on session creation) and by setApprovalMode /
 * setToolFilter (on dynamic mode/filter changes).
 */

import { attachWriteSnapshot, captureWriteSnapshot } from "../write-snapshot";
import { needsApproval } from "../approval-logic";
import { type Command, sendResponse } from "../protocol";
import type { RunnerContext } from "../types";

/**
 * Rebuild agent tools: filter by currentDisabledTools + wrap by approval mode.
 * - yolo mode: no approval wrapping (but disabled-tool filter still applies)
 * - other modes: insert requestApproval proxy for tools that need it
 *
 * Uses Proxy wrapping (not object spread) to preserve prototype chain methods.
 * omp engine's tool execute signature: (toolCallId, args, signal, onUpdate, ctx).
 */
export function applyApprovalMode(ctx: RunnerContext): void {
	const session = ctx.session;
	if (!session) return;
	try {
		// Save original tools snapshot on first call (before any wrapping)
		if (!ctx.originalTools) {
			const activeNames = (session as { getActiveToolNames: () => string[] }).getActiveToolNames() as string[];
			ctx.originalTools = activeNames
				.map((name: string) => (session as { getToolByName: (n: string) => unknown }).getToolByName(name))
				.filter((tool: unknown) => tool != null);
		}

		// eslint-disable-next-line @typescript-eslint/no-explicit-any
		const wrappedTools = (ctx.originalTools as any[])
			.filter((tool) => !ctx.currentDisabledTools.has((tool as { name: string }).name))
			// eslint-disable-next-line @typescript-eslint/no-explicit-any
			.map((tool: any) => {
			const toolName: string = tool.name;
			const requiresApproval = needsApproval(toolName, ctx.currentApprovalMode);
			const capturesWriteSnapshot = toolName === "write";
			if (!requiresApproval && !capturesWriteSnapshot) return tool;

			// Use Proxy to preserve prototype chain, intercepting only execute
			return new Proxy(tool, {
				get(target, prop, receiver) {
					if (prop !== "execute") return Reflect.get(target, prop, receiver);
					return async (
						toolCallId: string,
						args: unknown,
						signal: unknown,
						onUpdate: unknown,
						ctx2: unknown,
					) => {
						if (requiresApproval && !await ctx.requestApproval(toolName, args)) {
							return {
								content: [{ type: "text" as const, text: `[已拒绝] 用户拒绝了此工具调用的执行。` }],
							};
						}
						const snapshot = capturesWriteSnapshot ? captureWriteSnapshot(args, ctx.currentCwd) : null;
						// eslint-disable-next-line @typescript-eslint/no-explicit-any
						const result = await target.execute(toolCallId, args, signal as any, onUpdate as any, ctx2 as any);
						return attachWriteSnapshot(result, snapshot);
					};
				},
			});
		});
		// eslint-disable-next-line @typescript-eslint/no-explicit-any
		(session as any).agent.setTools(wrappedTools as any);
	} catch (wrapErr) {
		console.error("[socverify-runner] failed to apply approval mode:", wrapErr);
	}
}

export async function handleSetApprovalMode(cmd: Command & { type: "setApprovalMode" }, ctx: RunnerContext): Promise<void> {
	if (!ctx.session) throw new Error("Session not initialized");
	ctx.currentApprovalMode = cmd.approvalMode;
	applyApprovalMode(ctx);
	sendResponse(cmd.id, true, { ok: true, approvalMode: ctx.currentApprovalMode });
}

export async function handleSetToolFilter(cmd: Command & { type: "setToolFilter" }, ctx: RunnerContext): Promise<void> {
	if (!ctx.session) throw new Error("Session not initialized");
	ctx.currentDisabledTools = new Set(cmd.disabledTools);
	// `ask` is the host interaction Q&A channel; disabling it would prevent
	// the agent from asking the user questions — always force-keep it.
	ctx.currentDisabledTools.delete("ask");
	applyApprovalMode(ctx);
	sendResponse(cmd.id, true, { ok: true, disabledCount: ctx.currentDisabledTools.size });
}

export async function handleListAgentTools(cmd: Command & { type: "listAgentTools" }, ctx: RunnerContext): Promise<void> {
	if (!ctx.session) throw new Error("Session not initialized");
	const session = ctx.session;
	// Prefer original snapshot (includes disabled tools for settings display);
	// fall back to currently active tools if session was just created
	// (before applyApprovalMode saved the snapshot).
	const source =
		ctx.originalTools ??
		((session as { getActiveToolNames: () => string[] }).getActiveToolNames() as string[])
			.map((name: string) => (session as { getToolByName: (n: string) => unknown }).getToolByName(name))
			.filter((tool: unknown) => tool != null);
	const tools = (source as Array<{ name: string; description?: string }>).map((tool) => ({
		name: tool.name,
		description: typeof tool.description === "string" ? tool.description : "",
	}));
	sendResponse(cmd.id, true, { tools });
}
