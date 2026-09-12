/**
 * pi runner 工具审批逻辑（issue 04）。
 *
 * 与 omp runner（runner/approval-logic.ts）保持同一套语义，使 always-ask /
 * write / yolo 三种模式统一覆盖 pi 内置工具、host 工具、MCP 和 extension
 * tools：按工具名归类能力层级，再依据当前审批模式决定是否请求用户审批。
 *
 * 边界说明：审批模式只控制「单次工具调用」审批；yolo 不绕过 extension /
 * MCP 信任确认（信任由 trust 流程独立处理，见 protocol.ts 的 trust_request）。
 */

export type ApprovalMode = "always-ask" | "write" | "yolo";

/** 工具能力层级 */
export type ToolTier = "read" | "write" | "exec";

/** 只读工具 — 无副作用，任何模式自动放行 */
const READ_TOOLS = new Set([
  "read",
  "grep",
  "glob",
  "find",
  "ls",
  "ast_grep",
  "todo",
  "todo_write",
  "web_search",
  "ask",
  "inspect_image",
]);

/** 写工具 — 修改文件但不执行任意命令（write 模式自动放行，走快照 + Diff Review） */
const WRITE_TOOLS = new Set(["edit", "write", "ast_edit"]);

/**
 * 按工具名归类能力层级：
 * - read：无副作用（read/grep/find/ls/ask 等）
 * - write：修改文件（edit/write/ast_edit）
 * - exec：其余全部 —— bash、未知 host 工具、MCP 与 extension 工具
 *   （副作用未知，按最保守层级处理）
 */
export function getToolTier(toolName: string): ToolTier {
  if (READ_TOOLS.has(toolName)) return "read";
  if (WRITE_TOOLS.has(toolName)) return "write";
  return "exec";
}

/**
 * 判断一次工具调用是否需要用户审批。
 *
 * - **yolo**：不需要审批（只放宽单次工具审批，不影响 trust）
 * - **always-ask**：write + exec 需要审批（read 自动放行）
 * - **write**：仅 exec 需要审批（read + write 自动放行）
 */
export function needsApproval(toolName: string, mode: ApprovalMode): boolean {
  if (mode === "yolo") return false;
  const tier = getToolTier(toolName);
  if (mode === "always-ask") return tier !== "read";
  if (mode === "write") return tier === "exec";
  return false;
}
