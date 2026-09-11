/**
 * session-scan —— 外部 pi session 只读扫描 CLI（issue 08）。
 *
 * host（Electron 主进程）以 `node + ELECTRON_RUN_AS_NODE=1` 一次性 spawn
 * 本脚本，扫描指定 cwd bucket 中的 pi 原生 session 或导出单个 session 的
 * 对话内容。与常驻 runner 分离：扫描不要求 runner 进程活着，也绝不写入
 * 任何状态（应用索引的写入是 host 侧 adopt 的显式动作）。
 *
 * 用法：
 *   node session-scan.ts list   --cwd <dir>          # 列出 cwd bucket 的 session 元数据
 *   node session-scan.ts export --file <session>     # 导出单个 session 的归一化对话内容
 *
 * 输出协议：stdout 单行 JSON，带 SCAN_SENTINEL 前缀 —— pi SDK 偶发的
 * console 日志不会破坏 host 侧解析（host 只认哨兵行）。错误帧输出
 * { ok: false, error } 并置 exitCode 1，进程不裸抛崩溃。
 *
 * pi 的 AgentMessage 形状知识只存在于本脚本（issue 03 验收标准：pi 原生
 * 形状不越出 runner 侧），host 拿到的是引擎中立的归一化消息。
 */

import { existsSync } from "node:fs";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { pathToFileURL } from "node:url";
import { classifyContentBlock } from "./message-blocks.ts";

/** stdout 帧哨兵前缀：host 只解析以此开头的行 */
export const SCAN_SENTINEL = "@@SOCVERIFY_SCAN@@";

// ─── 参数解析 ───────────────────────────────────────────

export type ScanArgs =
	| { mode: "list"; cwd: string }
	| { mode: "export"; file: string };

/** 解析 CLI 参数；非法组合返回 null（由 main 转错误帧）。 */
export function parseScanArgs(argv: string[]): ScanArgs | null {
	if (argv.length === 0) return null;
	const mode = argv[0];
	if (mode !== "list" && mode !== "export") return null;

	let value: string | undefined;
	for (let i = 1; i < argv.length; i++) {
		const arg = argv[i];
		if (arg.startsWith("--cwd=")) {
			value = arg.slice("--cwd=".length);
		} else if (arg === "--cwd" || arg === "--file") {
			value = argv[i + 1];
			i++;
		}
	}
	if (value === undefined || value.length === 0) return null;
	return mode === "list" ? { mode: "list", cwd: value } : { mode: "export", file: value };
}

// ─── export 消息归一化 ──────────────────────────────────

/** 归一化后的对话消息（host 直接映射 UI transcript）。 */
export type ScanMessage = {
	role: "user" | "assistant";
	/** text blocks 以换行拼接（string content 原样）；thinking/toolCall 不参与 */
	text: string;
	timestamp?: number;
	/** 图片块 → data URL（data:<mime>;base64,<data>） */
	images?: string[];
};

/**
 * pi AgentMessage[] → ScanMessage[]：只保留 user/assistant 的可见文本与
 * 图片；toolResult/thinking/toolCall 等引擎内部形状全部丢弃。UI transcript
 * 是文本为主的历史视图，原生文件仍是权威历史（回看走原生恢复路径）。
 */
export function normalizeScanMessages(messages: unknown[]): ScanMessage[] {
	const out: ScanMessage[] = [];
	for (const message of messages) {
		const m = message as {
			role?: string;
			content?: unknown;
			timestamp?: number;
		};
		if (m.role !== "user" && m.role !== "assistant") continue;
		const textParts: string[] = [];
		const images: string[] = [];
		if (typeof m.content === "string") {
			textParts.push(m.content);
		} else if (Array.isArray(m.content)) {
			for (const block of m.content) {
				const b = classifyContentBlock(block);
				if (!b) continue;
				if (b.kind === "text") {
					textParts.push(b.text);
				} else {
					images.push(`data:${b.mimeType};base64,${b.data}`);
				}
			}
		}
		out.push({
			role: m.role,
			text: textParts.join("\n"),
			timestamp: typeof m.timestamp === "number" ? m.timestamp : undefined,
			images: images.length > 0 ? images : undefined,
		});
	}
	return out;
}

// ─── 扫描执行 ───────────────────────────────────────────

/** SessionInfo → JSON 安全元数据（Date → ISO，丢弃重量级 allMessagesText）。 */
function toSessionMeta(info: unknown): Record<string, unknown> {
	const s = info as {
		id: string;
		path: string;
		cwd: string;
		name?: string;
		parentSessionPath?: string;
		created: Date;
		modified: Date;
		messageCount: number;
		firstMessage: string;
	};
	return {
		id: s.id,
		path: s.path,
		cwd: s.cwd,
		name: s.name,
		parentSessionPath: s.parentSessionPath,
		created: s.created instanceof Date ? s.created.toISOString() : s.created,
		modified: s.modified instanceof Date ? s.modified.toISOString() : s.modified,
		messageCount: s.messageCount,
		firstMessage: s.firstMessage,
	};
}

/**
 * 执行扫描。失败时抛错（由 main 捕获转错误帧）。
 *   list   → { sessions: SessionMeta[] }
 *   export → { messages: ScanMessage[] }
 */
export async function runScan(args: ScanArgs): Promise<unknown> {
	if (args.mode === "list") {
		const sessions = await SessionManager.list(args.cwd);
		return { sessions: sessions.map(toSessionMeta) };
	}
	// SessionManager.open 对缺失文件不抛错（静默返回空 manager）——显式检查，
	// 让"导出不存在的 session"成为响亮的错误而非空结果。
	if (!existsSync(args.file)) {
		throw new Error(`session file not found: ${args.file}`);
	}
	const manager = SessionManager.open(args.file);
	const context = manager.buildSessionContext();
	return { messages: normalizeScanMessages(context.messages as unknown[]) };
}

// ─── 帧输出与入口 ───────────────────────────────────────

/** 组装单行哨兵帧（哨兵 + JSON + 换行）。 */
export function formatScanFrame(payload: unknown): string {
	return `${SCAN_SENTINEL}${JSON.stringify(payload)}\n`;
}

/** 向 stdout 输出哨兵帧。 */
export function emitScanFrame(payload: unknown): void {
	process.stdout.write(formatScanFrame(payload));
}

/** CLI 入口：解析参数 → 执行扫描 → 输出单条结果帧。任何失败转错误帧。 */
export async function main(argv: string[]): Promise<void> {
	const args = parseScanArgs(argv);
	if (!args) {
		emitScanFrame({
			ok: false,
			error: "usage: session-scan.ts list --cwd <dir> | session-scan.ts export --file <session-file>",
		});
		process.exitCode = 1;
		return;
	}
	try {
		const data = await runScan(args);
		emitScanFrame({ ok: true, mode: args.mode, data });
	} catch (err) {
		emitScanFrame({
			ok: false,
			mode: args.mode,
			error: err instanceof Error ? err.message : String(err),
		});
		process.exitCode = 1;
	}
}

// 直接执行时进入入口（被 import 时不触发）；pathToFileURL 处理 win32 反斜杠路径
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
	void main(process.argv.slice(2));
}
