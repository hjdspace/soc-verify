/**
 * Tool approval logic extracted from runner/index.ts.
 *
 * These pure functions determine whether a given tool requires user approval
 * based on the tool's capability tier and the current approval mode.
 *
 * Extracted to make the approval logic unit-testable without spinning up
 * the full Bun runner process.
 */

export type ApprovalMode = "always-ask" | "write" | "yolo";

/** Tool capability tiers */
export type ToolTier = "read" | "write" | "exec";

/** Read-only tools — no side effects, safe to auto-approve */
const READ_TOOLS = new Set([
  "read",
  "grep",
  "glob",
  "ast_grep",
  "todo",
  "web_search",
  "ask",
  "inspect_image",
]);

/** Write tools — modify files but don't execute arbitrary commands */
const WRITE_TOOLS = new Set(["edit", "write", "ast_edit"]);

/**
 * Classify a tool by its capability tier.
 *
 * - **read**: no side effects (grep, glob, read, etc.)
 * - **write**: modifies files (edit, write, ast_edit)
 * - **exec**: everything else — potentially executes commands
 */
export function getToolTier(toolName: string): ToolTier {
  if (READ_TOOLS.has(toolName)) return "read";
  if (WRITE_TOOLS.has(toolName)) return "write";
  return "exec";
}

/**
 * Determine whether a tool call requires user approval.
 *
 * Approval logic by mode:
 * - **yolo**:       never requires approval (fully trusted)
 * - **always-ask**: requires approval for write + exec tools (read is auto)
 * - **write**:      requires approval only for exec tools (read + write auto)
 *
 * @param toolName - the name of the tool to check
 * @param mode - the current approval mode
 * @returns true if the user must approve this tool call before execution
 */
export function needsApproval(toolName: string, mode: ApprovalMode): boolean {
  if (mode === "yolo") return false;
  const tier = getToolTier(toolName);
  if (mode === "always-ask") return tier !== "read";
  if (mode === "write") return tier === "exec";
  return false;
}
