import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

export type WriteSnapshot = {
	fileExistedBefore: boolean;
	beforeContent?: string;
};

export function captureWriteSnapshot(args: unknown, cwd: string): WriteSnapshot | null {
	if (typeof args !== "object" || args === null) return null;
	const path = (args as Record<string, unknown>).path;
	if (typeof path !== "string" || !path) return null;
	const filePath = resolve(cwd, path);
	if (!existsSync(filePath)) return { fileExistedBefore: false };
	try {
		return { fileExistedBefore: true, beforeContent: readFileSync(filePath, "utf-8") };
	} catch {
		return { fileExistedBefore: true };
	}
}

export function attachWriteSnapshot(result: unknown, snapshot: WriteSnapshot | null): unknown {
	if (!snapshot || typeof result !== "object" || result === null || Array.isArray(result)) return result;
	const record = result as Record<string, unknown>;
	const details = typeof record.details === "object" && record.details !== null && !Array.isArray(record.details)
		? record.details as Record<string, unknown>
		: {};
	return { ...record, details: { ...details, ...snapshot } };
}

export function attachWriteSnapshotToStartEvent(event: unknown, cwd: string): unknown {
	if (typeof event !== "object" || event === null) return event;
	const record = event as Record<string, unknown>;
	if (record.type !== "tool_execution_start" || record.toolName !== "write") return event;
	const snapshot = captureWriteSnapshot(record.args, cwd);
	return snapshot ? { ...record, ...snapshot } : event;
}
