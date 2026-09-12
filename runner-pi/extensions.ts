/**
 * pi runner 内联扩展与信任/审批装配逻辑（issue 04）。
 *
 * 纯逻辑部分（审批门、项目信任决策、MCP 信任装配计划）在本模块中保持
 * 可单元测试 —— 不导入 pi SDK；pi 侧的接线（pi.on("tool_call")、
 * DefaultResourceLoader、pi-mcp-adapter）在 session.ts 完成。
 *
 * 权限边界（spec 验收项 4/5）：
 *   - 单次工具审批由审批模式（always-ask/write/yolo）控制；
 *   - 项目 extension 信任（project-extension）与 MCP server 信任
 *     （mcp-server）独立于审批模式 —— yolo 只放宽单次审批，不跳过信任。
 */

import { needsApproval, type ApprovalMode } from "./approval-logic.ts";
import type { McpConfigIgnore, McpConfigResolution, McpServerEntry } from "./mcp-config";
import type { TrustKind } from "./protocol";

// ─── 单次工具审批门 ─────────────────────────────────────

export interface ToolCallGateDeps {
  /** 当前审批模式（setApprovalMode 可动态改变） */
  getMode(): ApprovalMode;
  /** 请求用户审批一次工具调用 */
  requestApproval(toolName: string, args: unknown): Promise<boolean>;
}

/**
 * 计算一次工具调用的审批结果。
 *
 * 返回 undefined 表示放行；返回 `{ block: true, reason }` 表示拦截
 * （pi 的 tool_call 事件结果语义）。拒绝时 block 帧的 reason 会回流到
 * 模型上下文，模型可据此调整行为。
 */
export async function resolveToolCallGate(
  toolName: string,
  input: unknown,
  getMode: ToolCallGateDeps["getMode"],
  requestApproval: ToolCallGateDeps["requestApproval"],
): Promise<{ block: true; reason: string } | undefined> {
  if (!needsApproval(toolName, getMode())) return undefined;
  const approved = await requestApproval(toolName, input);
  if (approved) return undefined;
  return {
    block: true,
    reason: `Tool call "${toolName}" was not approved by the user.`,
  };
}

// ─── 项目信任决策 ───────────────────────────────────────

/**
 * 决定项目（cwd）是否受信任（决定其 .pi extension/settings 是否加载）。
 *
 * 决策顺序：
 * 1. 项目无信任敏感资源（.pi/extensions 等）→ 直接信任（无攻击面）；
 * 2. cwd 已在 host 信任存储下发的 trustedProjectDirs → 直接信任；
 * 3. 否则向用户发起 trust_request（project-extension），透传结果。
 */
export async function resolveProjectTrustDecision(
  cwd: string,
  trustedProjectDirs: readonly string[],
  hasTrustRequiringResources: boolean,
  requestTrust: (kind: TrustKind, name: string, path?: string) => Promise<boolean>,
): Promise<boolean> {
  if (!hasTrustRequiringResources) return true;
  if (trustedProjectDirs.includes(cwd)) return true;
  return requestTrust("project-extension", cwd);
}

// ─── MCP 信任装配计划 ───────────────────────────────────

export interface McpAssemblyOptions {
  /** 会话是否启用 MCP */
  enableMCP: boolean;
  /** host 信任存储中已确认信任的 server 名 */
  trustedMcpServers: readonly string[];
  /** 请求用户信任确认（每个未信任 server 一次） */
  requestTrust: (kind: TrustKind, name: string, path?: string) => Promise<boolean>;
}

export interface McpAssemblyPlan {
  /** 交给 pi-mcp-adapter 的 server 集（单一来源 + 信任过滤后） */
  mcpServers: Record<string, McpServerEntry>;
  /** 配置来源冲突报告（原样透出给 host） */
  ignored: McpConfigIgnore[];
}

/**
 * 把「单一来源 MCP 配置解析结果」装配成实际交给 adapter 的 server 集：
 * - enableMCP=false 或无选中来源 → 空集（adapter 不加载）；
 * - disabled server 跳过（不启动、不询问）；
 * - host 信任存储命中 → 直接并入；
 * - 未信任 server 逐个请求信任确认（mcp-server），批准者并入。
 */
export async function buildTrustedMcpServers(
  resolution: McpConfigResolution,
  opts: McpAssemblyOptions,
): Promise<McpAssemblyPlan> {
  if (!opts.enableMCP || resolution.selected === null) {
    return { mcpServers: {}, ignored: resolution.ignored };
  }

  const trustedSet = new Set(opts.trustedMcpServers);
  const mcpServers: Record<string, McpServerEntry> = {};

  for (const [name, entry] of Object.entries(resolution.selected.servers)) {
    if (entry?.disabled === true) continue;
    if (trustedSet.has(name) || (await opts.requestTrust("mcp-server", name))) {
      mcpServers[name] = entry;
    }
  }

  return { mcpServers, ignored: resolution.ignored };
}
