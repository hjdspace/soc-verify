/**
 * Agent 通信协议类型定义
 *
 * 基于 pi-coding-agent SDK 的 RPC 协议。
 * host → agent：JSONL on stdin（RpcCommand + side-channel 帧）
 * agent → host：JSONL on stdout（ready 信号 + RpcResponse + 事件帧 + Host Tool/URI 请求）
 */

// ─── 就绪信号 ───────────────────────────────────────────────

export interface AgentReadyFrame {
  type: 'ready';
}

// ─── RPC 命令（host → agent stdin）────────────────────────────

export type RpcCommand =
  | { id?: string; type: 'prompt'; message: string; images?: unknown[]; streamingBehavior?: 'steer' | 'followUp' }
  | { id?: string; type: 'steer'; message: string; images?: unknown[] }
  | { id?: string; type: 'follow_up'; message: string; images?: unknown[] }
  | { id?: string; type: 'abort' }
  | { id?: string; type: 'abort_and_prompt'; message: string; images?: unknown[] }
  | { id?: string; type: 'new_session'; parentSession?: string }
  | { id?: string; type: 'get_state' }
  | { id?: string; type: 'get_available_commands' }
  | { id?: string; type: 'set_host_tools'; tools: RpcHostToolDefinition[] }
  | { id?: string; type: 'set_host_uri_schemes'; schemes: RpcHostUriSchemeDefinition[] }
  | { id?: string; type: 'set_subagent_subscription'; level: 'off' | 'progress' | 'events' }
  | { id?: string; type: 'get_subagents' }
  | { id?: string; type: 'set_model'; provider: string; modelId: string }
  | { id?: string; type: 'cycle_model' }
  | { id?: string; type: 'get_available_models' }
  | { id?: string; type: 'set_thinking_level'; level: string }
  | { id?: string; type: 'set_steering_mode'; mode: 'all' | 'one-at-a-time' }
  | { id?: string; type: 'set_follow_up_mode'; mode: 'all' | 'one-at-a-time' }
  | { id?: string; type: 'set_interrupt_mode'; mode: 'immediate' | 'wait' }
  | { id?: string; type: 'compact'; customInstructions?: string }
  | { id?: string; type: 'set_auto_compaction'; enabled: boolean }
  | { id?: string; type: 'set_auto_retry'; enabled: boolean }
  | { id?: string; type: 'abort_retry' }
  | { id?: string; type: 'bash'; command: string }
  | { id?: string; type: 'abort_bash' }
  | { id?: string; type: 'get_session_stats' }
  | { id?: string; type: 'export_html'; outputPath?: string }
  | { id?: string; type: 'switch_session'; sessionPath: string }
  | { id?: string; type: 'branch'; entryId: string }
  | { id?: string; type: 'get_branch_messages' }
  | { id?: string; type: 'get_last_assistant_text' }
  | { id?: string; type: 'set_session_name'; name: string }
  | { id?: string; type: 'handoff'; customInstructions?: string }
  | { id?: string; type: 'get_messages' }
  | { id?: string; type: 'get_login_providers' }
  | { id?: string; type: 'login'; providerId: string };

/** 去除 id 的命令体（用于内部发送） */
type DistributiveOmit<T, K extends keyof T> = T extends unknown ? Omit<T, K> : never;
export type RpcCommandBody = DistributiveOmit<RpcCommand, 'id'>;

// ─── RPC 响应（agent → host stdout）───────────────────────────

export interface RpcResponseBase {
  id?: string;
  type: 'response';
  command: string;
  success: boolean;
}

export interface RpcSuccessResponse extends RpcResponseBase {
  success: true;
  data?: unknown;
}

export interface RpcErrorResponse extends RpcResponseBase {
  success: false;
  error: string;
}

export type RpcResponse = RpcSuccessResponse | RpcErrorResponse;

// ─── 事件帧（agent → host stdout）─────────────────────────────

/** prompt 命令完成后的结果帧 */
export interface RpcPromptResultFrame {
  type: 'prompt_result';
  id?: string;
  agentInvoked: boolean;
}

/** 可用命令更新帧 */
export interface RpcAvailableCommandsUpdateFrame {
  type: 'available_commands_update';
  commands: unknown[];
}

/** 会话信息更新帧 */
export interface RpcSessionInfoUpdateFrame {
  type: 'session_info_update';
  title?: string;
  sessionId: string;
}

/** 配置更新帧 */
export interface RpcConfigUpdateFrame {
  type: 'config_update';
  model: unknown;
  thinkingLevel: unknown;
}

/** 命令输出帧 */
export interface RpcCommandOutputFrame {
  type: 'command_output';
  text: string;
}

/** 扩展 UI 请求帧 */
export interface RpcExtensionUiRequest {
  type: 'extension_ui_request';
  id: string;
  method: string;
  [key: string]: unknown;
}

/** 子代理生命周期帧 */
export interface RpcSubagentLifecycleFrame {
  type: 'subagent_lifecycle';
  payload: unknown;
}

/** 子代理进度帧 */
export interface RpcSubagentProgressFrame {
  type: 'subagent_progress';
  payload: unknown;
}

/** 子代理事件帧 */
export interface RpcSubagentEventFrame {
  type: 'subagent_event';
  payload: unknown;
}

/** 扩展错误帧 */
export interface RpcExtensionErrorFrame {
  type: 'extension_error';
  extensionPath?: string;
  event?: string;
  error?: string;
}

// ─── Host Tool 帧（双向）────────────────────────────────────

export interface RpcHostToolDefinition {
  name: string;
  label?: string;
  description: string;
  parameters: Record<string, unknown>;
  hidden?: boolean;
}

/** agent 请求宿主执行 Host Tool（agent → host stdout） */
export interface RpcHostToolCallRequest {
  type: 'host_tool_call';
  id: string;
  toolCallId: string;
  toolName: string;
  arguments: Record<string, unknown>;
}

/** agent 取消 Host Tool 执行（agent → host stdout） */
export interface RpcHostToolCancelRequest {
  type: 'host_tool_cancel';
  id: string;
  targetId: string;
}

/** AgentToolResult 结构 */
export interface AgentToolResult<TDetails = unknown> {
  content: Array<{ type: 'text' | 'image' | 'resource'; text?: string; data?: string; mimeType?: string }>;
  details?: TDetails;
}

/** 宿主返回 Host Tool 进度更新（host → agent stdin） */
export interface RpcHostToolUpdate {
  type: 'host_tool_update';
  id: string;
  partialResult: AgentToolResult;
}

/** 宿主返回 Host Tool 执行结果（host → agent stdin） */
export interface RpcHostToolResult {
  type: 'host_tool_result';
  id: string;
  result: AgentToolResult;
  isError?: boolean;
}

// ─── Host URI 帧（双向）─────────────────────────────────────

export interface RpcHostUriSchemeDefinition {
  scheme: string;
  description?: string;
  writable?: boolean;
  immutable?: boolean;
}

/** agent 请求宿主处理 URI（agent → host stdout） */
export interface RpcHostUriRequest {
  type: 'host_uri_request';
  id: string;
  operation: 'read' | 'write';
  url: string;
  content?: string;
}

/** agent 取消 URI 请求（agent → host stdout） */
export interface RpcHostUriCancelRequest {
  type: 'host_uri_cancel';
  id: string;
  targetId: string;
}

/** 宿主返回 URI 处理结果（host → agent stdin） */
export interface RpcHostUriResult {
  type: 'host_uri_result';
  id: string;
  content?: string;
  contentType?: 'text/markdown' | 'application/json' | 'text/plain';
  notes?: string[];
  immutable?: boolean;
  isError?: boolean;
  error?: string;
}

// ─── 扩展 UI 响应（host → agent stdin）────────────────────────

export type RpcExtensionUiResponse =
  | { type: 'extension_ui_response'; id: string; value: string }
  | { type: 'extension_ui_response'; id: string; confirmed: boolean }
  | { type: 'extension_ui_response'; id: string; cancelled: true; timedOut?: boolean };

// ─── 会话状态 ───────────────────────────────────────────────

export interface RpcSessionState {
  model?: { provider: string; id: string; [key: string]: unknown };
  thinkingLevel: unknown;
  isStreaming: boolean;
  isCompacting: boolean;
  steeringMode: 'all' | 'one-at-a-time';
  followUpMode: 'all' | 'one-at-a-time';
  interruptMode: 'immediate' | 'wait';
  sessionFile?: string;
  sessionId: string;
  sessionName?: string;
  autoCompactionEnabled: boolean;
  messageCount: number;
  queuedMessageCount: number;
  todoPhases: unknown[];
  contextUsage?: unknown;
}

// ─── AgentClient 配置 ─────────────────────────────────────────

export interface AgentClientOptions {
  /** Bun 可执行文件路径 */
  bunPath?: string;
  /** runner 脚本路径（如 engine/oh-my-pi/packages/coding-agent/src/socverify-runner.ts） */
  runnerPath?: string;
  /** 工作目录（项目目录） */
  cwd: string;
  /** 环境变量 */
  env?: Record<string, string>;
  /** LLM provider */
  provider?: string;
  /** LLM model ID */
  model?: string;
  /** API key for the LLM provider */
  apiKey?: string;
  /** 会话存储目录 */
  sessionDir?: string;
  /** 额外 CLI 参数 */
  extraArgs?: string[];
  /** 就绪超时（ms，默认 30000） */
  readyTimeoutMs?: number;
}

// ─── 事件回调 ───────────────────────────────────────────────

export type AgentEventListener = (event: unknown) => void;
export type AgentSessionEventListener = (event: unknown) => void;
export type AgentSubagentLifecycleListener = (payload: unknown) => void;
export type AgentSubagentProgressListener = (payload: unknown) => void;
export type AgentSubagentEventListener = (payload: unknown) => void;
export type AgentHostToolCallHandler = (request: RpcHostToolCallRequest) => Promise<AgentToolResult | string>;
export type AgentHostUriHandler = (request: RpcHostUriRequest) => Promise<RpcHostUriResult>;

export interface AgentEventHandlers {
  onEvent?: AgentEventListener;
  onSessionEvent?: AgentSessionEventListener;
  onSubagentLifecycle?: AgentSubagentLifecycleListener;
  onSubagentProgress?: AgentSubagentProgressListener;
  onSubagentEvent?: AgentSubagentEventListener;
  onError?: (error: Error) => void;
  onExit?: (code: number | null, signal: NodeJS.Signals | null) => void;
}

// ─── 类型守卫 ───────────────────────────────────────────────

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function isAgentReadyFrame(value: unknown): value is AgentReadyFrame {
  return isRecord(value) && value.type === 'ready';
}

export function isRpcResponse(value: unknown): value is RpcResponse {
  if (!isRecord(value)) return false;
  if (value.type !== 'response') return false;
  if (typeof value.command !== 'string') return false;
  if (typeof value.success !== 'boolean') return false;
  if (value.id !== undefined && typeof value.id !== 'string') return false;
  if (value.success === false) return typeof value.error === 'string';
  return true;
}

export function isRpcHostToolCallRequest(value: unknown): value is RpcHostToolCallRequest {
  return (
    isRecord(value) &&
    value.type === 'host_tool_call' &&
    typeof value.id === 'string' &&
    typeof value.toolCallId === 'string' &&
    typeof value.toolName === 'string' &&
    isRecord(value.arguments)
  );
}

export function isRpcHostToolCancelRequest(value: unknown): value is RpcHostToolCancelRequest {
  return (
    isRecord(value) &&
    value.type === 'host_tool_cancel' &&
    typeof value.id === 'string' &&
    typeof value.targetId === 'string'
  );
}

export function isRpcHostUriRequest(value: unknown): value is RpcHostUriRequest {
  return (
    isRecord(value) &&
    value.type === 'host_uri_request' &&
    typeof value.id === 'string' &&
    (value.operation === 'read' || value.operation === 'write') &&
    typeof value.url === 'string'
  );
}

export function isRpcHostUriCancelRequest(value: unknown): value is RpcHostUriCancelRequest {
  return (
    isRecord(value) &&
    value.type === 'host_uri_cancel' &&
    typeof value.id === 'string' &&
    typeof value.targetId === 'string'
  );
}

export function isRpcExtensionUiRequest(value: unknown): value is RpcExtensionUiRequest {
  return (
    isRecord(value) &&
    value.type === 'extension_ui_request' &&
    typeof value.id === 'string' &&
    typeof value.method === 'string'
  );
}

export function isRpcSubagentLifecycleFrame(value: unknown): value is RpcSubagentLifecycleFrame {
  return isRecord(value) && value.type === 'subagent_lifecycle' && isRecord(value.payload);
}

export function isRpcSubagentProgressFrame(value: unknown): value is RpcSubagentProgressFrame {
  return isRecord(value) && value.type === 'subagent_progress' && isRecord(value.payload);
}

export function isRpcSubagentEventFrame(value: unknown): value is RpcSubagentEventFrame {
  return isRecord(value) && value.type === 'subagent_event' && isRecord(value.payload);
}

export function isRpcAvailableCommandsUpdateFrame(value: unknown): value is RpcAvailableCommandsUpdateFrame {
  return isRecord(value) && value.type === 'available_commands_update' && Array.isArray(value.commands);
}

export function isRpcPromptResultFrame(value: unknown): value is RpcPromptResultFrame {
  return isRecord(value) && value.type === 'prompt_result' && typeof value.agentInvoked === 'boolean';
}

// ─── Agent 事件类型集合（用于区分会话事件 vs 核心事件）─────────

export const AGENT_EVENT_TYPES = new Set([
  'agent_start', 'agent_end',
  'turn_start', 'turn_end',
  'message_start', 'message_update', 'message_end',
  'tool_execution_start', 'tool_execution_update', 'tool_execution_end',
]);

export const SESSION_EVENT_TYPES = new Set([
  ...AGENT_EVENT_TYPES,
  'auto_compaction_start', 'auto_compaction_end',
  'auto_retry_start', 'auto_retry_end',
  'retry_fallback_applied', 'retry_fallback_succeeded',
  'ttsr_triggered',
  'todo_reminder', 'todo_auto_clear',
  'irc_message', 'notice',
  'thinking_level_changed', 'goal_updated',
]);

export function isAgentEvent(value: unknown): boolean {
  if (!isRecord(value)) return false;
  const type = value.type;
  if (typeof type !== 'string') return false;
  return AGENT_EVENT_TYPES.has(type);
}

export function isAgentSessionEvent(value: unknown): boolean {
  if (!isRecord(value)) return false;
  const type = value.type;
  if (typeof type !== 'string') return false;
  return SESSION_EVENT_TYPES.has(type);
}
