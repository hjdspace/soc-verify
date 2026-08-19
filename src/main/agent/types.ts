/**
 * Agent SDK 协议类型定义
 *
 * 用于 Electron 主进程与 Bun runner 之间的 JSONL 通信。
 * 比 pi-coding-agent RPC 协议大幅简化：无 Host Tool/URI Scheme 帧，直接使用 SDK 的 customTools。
 */

// ─── 就绪信号 ───────────────────────────────────────────────

export interface ReadyFrame {
  type: 'ready';
}

// ─── 命令（host → runner stdin）────────────────────────────

export type ApprovalMode = 'always-ask' | 'write' | 'yolo';

export interface InitConfig {
  cwd: string;
  apiKey?: string;
  baseUrl?: string;
  provider?: string;
  model?: string;
  sessionDir?: string;
  env?: Record<string, string>;
  enableMCP?: boolean;
  resumeSessionId?: string;
  systemPrompt?: string;
  contextWindow: number;
  customToolDefinitions: CustomToolDefinition[];
  /** 额外的 extension 包路径（每个包的 skills/ 和 agents/ 子目录会被 omp 扫描） */
  additionalExtensionPaths?: string[];
  /** 工具审批模式：always-ask（总询问）、write（自动编辑）、yolo（完全信任） */
  approvalMode?: ApprovalMode;
}

export interface CustomToolDefinition {
  name: string;
  label?: string;
  description: string;
  parameters: Record<string, unknown>;
  approval?: string;
}

export type Command =
  | { id: string; type: 'init'; config: InitConfig }
  | { id: string; type: 'prompt'; message: string; images?: string[] }
  | { id: string; type: 'abort' }
  | { id: string; type: 'steer'; message: string }
  | { id: string; type: 'setModel'; provider: string; modelId: string }
  | { id: string; type: 'setApprovalMode'; approvalMode: ApprovalMode }
  | { id: string; type: 'getMessages' }
  | { id: string; type: 'getState' }
  | { id: string; type: 'compact' }
  | { id: string; type: 'getMcpStatus' }
  | { id: string; type: 'getMcpServerTools'; serverName: string }
  | { id: string; type: 'reloadMcp' }
  | { id: string; type: 'destroy' };

// ─── 响应（runner → host stdout）───────────────────────────

export interface ResponseFrame {
  id: string;
  type: 'response';
  success: boolean;
  data?: unknown;
  error?: string;
}

// ─── 事件帧（runner → host stdout）─────────────────────────

export interface EventFrame {
  type: 'event';
  event: unknown;
}

// ─── Subagent 帧（runner → host stdout）────────────────────
// 由 runner 订阅 omp SDK EventBus 的 task:subagent:* channel 转发而来。
// lifecycle：subagent 启动/完成/失败/中止（低频）
// progress：subagent 实时进度（~150ms 节流合并）

export type SubagentFrame = {
  type: 'subagent_lifecycle' | 'subagent_progress';
  payload: unknown;
};

export function isSubagentFrame(value: unknown): value is SubagentFrame {
  return (
    isRecord(value) &&
    (value.type === 'subagent_lifecycle' || value.type === 'subagent_progress')
  );
}

// ─── Tool Call 帧（runner → host stdout）───────────────────

export interface ToolCallFrame {
  type: 'tool_call';
  id: string;
  toolName: string;
  args: unknown;
}

// ─── Tool Result 帧（host → runner stdin）──────────────────

export interface ToolResultCommand {
  type: 'tool_result';
  id: string;
  result: unknown;
  isError?: boolean;
}

// ─── 审批请求/响应帧 ───────────────────────────────────────

/** Runner → Host：请求用户审批工具调用 */
export interface ApprovalRequestFrame {
  type: 'approval_request';
  id: string;
  toolName: string;
  args: unknown;
}

/** Host → Runner：用户审批结果 */
export interface ApprovalResponseCommand {
  type: 'approval_response';
  id: string;
  approved: boolean;
}

// ─── Agent Client 配置 ─────────────────────────────────────

export interface AgentClientOptions {
  /**
   * 预编译 runner 二进制路径（binary 模式）。
   * 设置后直接执行该二进制，不需要 Bun。
   */
  runnerBinaryPath?: string;
  /** Bun 可执行文件路径（script 模式必需） */
  bunPath?: string;
  /** runner 脚本路径（script 模式必需） */
  runnerPath?: string;
  /** 工作目录 */
  cwd: string;
  /** 环境变量 */
  env?: Record<string, string>;
  /** 就绪超时（ms，默认 30000） */
  readyTimeoutMs?: number;
}

// ─── 类型守卫 ───────────────────────────────────────────────

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function isReadyFrame(value: unknown): value is ReadyFrame {
  return isRecord(value) && value.type === 'ready';
}

export function isResponseFrame(value: unknown): value is ResponseFrame {
  return (
    isRecord(value) &&
    value.type === 'response' &&
    typeof value.id === 'string' &&
    typeof value.success === 'boolean'
  );
}

export function isEventFrame(value: unknown): value is EventFrame {
  return isRecord(value) && value.type === 'event' && isRecord(value.event);
}

export function isToolCallFrame(value: unknown): value is ToolCallFrame {
  return (
    isRecord(value) &&
    value.type === 'tool_call' &&
    typeof value.id === 'string' &&
    typeof value.toolName === 'string'
  );
}

export function isApprovalRequestFrame(value: unknown): value is ApprovalRequestFrame {
  return (
    isRecord(value) &&
    value.type === 'approval_request' &&
    typeof value.id === 'string' &&
    typeof value.toolName === 'string'
  );
}

// ─── 会话状态 ───────────────────────────────────────────────

export interface SessionState {
  model?: { provider: string; id: string };
  isStreaming: boolean;
  sessionId: string;
  messageCount: number;
}
