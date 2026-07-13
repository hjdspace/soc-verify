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
  customToolDefinitions: CustomToolDefinition[];
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
  | { id: string; type: 'getMessages' }
  | { id: string; type: 'getState' }
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

// ─── Agent Client 配置 ─────────────────────────────────────

export interface AgentClientOptions {
  /** Bun 可执行文件路径 */
  bunPath: string;
  /** runner 脚本路径 */
  runnerPath: string;
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

// ─── 会话状态 ───────────────────────────────────────────────

export interface SessionState {
  model?: { provider: string; id: string };
  isStreaming: boolean;
  sessionId: string;
  messageCount: number;
}
