/**
 * MCP handlers — status, server tools, and reload.
 *
 * All three share the MCPManager dynamic import and statusMap construction
 * logic, so grouping them in one module avoids duplicating the import path
 * and the status-mapping helper.
 */

import { type Command, sendResponse } from "../protocol";
import type { RunnerContext } from "../types";

/**
 * Build a { serverName → { status, toolCount } } map from the MCPManager.
 * Shared by getMcpStatus and reloadMcp.
 */
function buildStatusMap(manager: {
	getAllServerNames: () => string[];
	getConnectionStatus: (name: string) => string;
	getConnection: (name: string) => { tools?: unknown[] } | null;
}): Record<string, { status: string; toolCount: number }> {
	const statusMap: Record<string, { status: string; toolCount: number }> = {};
	for (const name of manager.getAllServerNames()) {
		const status = manager.getConnectionStatus(name);
		let toolCount = 0;
		if (status === "connected") {
			try {
				const conn = manager.getConnection(name);
				toolCount = conn?.tools?.length ?? 0;
			} catch {
				// best-effort
			}
		}
		statusMap[name] = { status, toolCount };
	}
	return statusMap;
}

export async function handleGetMcpStatus(cmd: Command & { type: "getMcpStatus" }, ctx: RunnerContext): Promise<void> {
	if (!ctx.session) throw new Error("Session not initialized");

	try {
		// Access the MCPManager from the session. The SDK creates a singleton
		// MCPManager.instance() that manages all MCP connections.
		// eslint-disable-next-line @typescript-eslint/no-explicit-any
		const { MCPManager } = await import("../../engine/oh-my-pi/packages/coding-agent/src/mcp/manager") as any;
		const manager = MCPManager.instance();
		if (!manager) {
			sendResponse(cmd.id, true, { servers: {} });
			return;
		}
		const statusMap = buildStatusMap(manager);
		sendResponse(cmd.id, true, { servers: statusMap });
	} catch {
		// If MCPManager is not available (e.g. enableMCP was false), return empty.
		sendResponse(cmd.id, true, { servers: {} });
	}
}

export async function handleGetMcpServerTools(cmd: Command & { type: "getMcpServerTools"; serverName: string }, ctx: RunnerContext): Promise<void> {
	if (!ctx.session) throw new Error("Session not initialized");

	try {
		// eslint-disable-next-line @typescript-eslint/no-explicit-any
		const { MCPManager } = await import("../../engine/oh-my-pi/packages/coding-agent/src/mcp/manager") as any;
		const manager = MCPManager.instance();
		if (!manager) {
			sendResponse(cmd.id, true, { tools: [] });
			return;
		}

		const connection = manager.getConnection(cmd.serverName);
		if (!connection) {
			sendResponse(cmd.id, true, { tools: [] });
			return;
		}

		// Use cached tools if available; otherwise call listTools to fetch.
		let tools = connection.tools;
		if (!tools) {
			// eslint-disable-next-line @typescript-eslint/no-explicit-any
			const { listTools } = await import("../../engine/oh-my-pi/packages/coding-agent/src/mcp/client") as any;
			tools = await listTools(connection);
		}

		const toolList = (tools ?? []).map((t: { name: string; description?: string; inputSchema?: unknown }) => ({
			name: t.name,
			description: t.description,
			inputSchema: t.inputSchema,
		}));

		sendResponse(cmd.id, true, { tools: toolList });
	} catch (err) {
		// On any error, return empty tool list rather than failing the RPC.
		const msg = err instanceof Error ? err.message : String(err);
		console.error(`[socverify-runner] getMcpServerTools error: ${msg}`);
		sendResponse(cmd.id, true, { tools: [] });
	}
}

export async function handleReloadMcp(cmd: Command & { type: "reloadMcp" }, ctx: RunnerContext): Promise<void> {
	if (!ctx.session) throw new Error("Session not initialized");

	try {
		// eslint-disable-next-line @typescript-eslint/no-explicit-any
		const { MCPManager } = await import("../../engine/oh-my-pi/packages/coding-agent/src/mcp/manager") as any;
		const manager = MCPManager.instance();
		if (!manager) {
			sendResponse(cmd.id, true, { ok: true, servers: {} });
			return;
		}

		// Disconnect all existing connections, then re-discover and connect.
		// This picks up changes made to .mcp.json since the session started.
		manager.disconnectAll();
		await manager.discoverAndConnect();

		// Refresh the agent's tool list so newly connected MCP tools are
		// immediately available to the LLM.
		const mcpTools = manager.getTools();
		if (typeof (ctx.session as { refreshMCPTools?: unknown }).refreshMCPTools === "function") {
			await (ctx.session as { refreshMCPTools: (tools: unknown[], opts: { activateAll: boolean }) => Promise<void> })
				.refreshMCPTools(mcpTools, { activateAll: true });
		}

		const statusMap = buildStatusMap(manager);
		sendResponse(cmd.id, true, { ok: true, servers: statusMap });
	} catch (err) {
		const msg = err instanceof Error ? err.message : String(err);
		console.error(`[socverify-runner] reloadMcp error: ${msg}`);
		sendResponse(cmd.id, false, undefined, `Failed to reload MCP: ${msg}`);
	}
}
