/**
 * Agent Event Contract — engine-neutral definitions for the event stream an
 * agent engine (omp today, pi tomorrow) emits into the SoC Verify host.
 *
 * This module is the single source of truth for:
 *   1. `AgentEngine`     — identifiers of the engines a session may be bound to.
 *   2. `AgentEvent`      — the discriminated union every engine runner must map
 *                          its native events onto (消息 / 工具 / 审批 / 上下文 /
 *                          压缩 / subagent / 错误 生命周期)。
 *   3. Type guards       — runtime validation for events that cross the
 *                          process boundary as untyped JSON.
 *
 * The omp runner forwards engine events verbatim, so the omp engine's shapes
 * are the reference shapes below. A future pi runner must normalize its native
 * events to these types at the runner boundary — the host side never grows
 * engine-specific event handling.
 */

import type { ContextBreakdown, ContextUsage } from '@shared/context-management';

// ─── Engine identity ─────────────────────────────────────────

/**
 * Identifier of the agent engine backing a session.
 * 'omp' = oh-my-pi coding agent (current); 'pi' = pi coding agent (migration target).
 */
export type AgentEngine = 'omp' | 'pi';

// ─── Message payload ─────────────────────────────────────────

/** Text content block inside an agent message. */
export type AgentTextBlock = { type: 'text'; text: string };

/** Thinking/reasoning content block inside an agent message. */
export type AgentThinkingBlock = { type: 'thinking'; thinking: string };

/** A message as carried by message_start/update/end events. */
export type AgentMessage = {
  role: string;
  /** Plain string (user/assistant text) or an array of content blocks. */
  content: string | Array<Record<string, unknown>>;
  /** Populated when the LLM round failed (transport errors, provider errors). */
  errorMessage?: string;
  stopReason?: string;
  usage?: unknown;
};

// ─── Agent Event union ───────────────────────────────────────

/** Events emitted by an agent engine session, keyed by a `type` discriminant. */
export type AgentEvent =
  // ── Agent turn lifecycle ──
  | { type: 'agent_start' }
  | {
      type: 'agent_end';
      messages?: unknown[];
      /** True when the engine already scheduled an automatic continuation. */
      willContinue?: boolean;
    }
  // ── Message lifecycle ──
  | { type: 'message_start'; message: AgentMessage }
  | { type: 'message_update'; message: AgentMessage }
  | { type: 'message_end'; message: AgentMessage }
  // ── Tool execution lifecycle ──
  | { type: 'tool_execution_start'; toolCallId: string; toolName: string; args?: unknown; intent?: string }
  | {
      type: 'tool_execution_update';
      toolCallId: string;
      toolName: string;
      args?: unknown;
      partialResult?: unknown;
    }
  | {
      type: 'tool_execution_end';
      toolCallId: string;
      toolName: string;
      result?: unknown;
      isError?: boolean;
    }
  // ── Approval lifecycle ──
  | { type: 'approval_request'; id: string; toolName: string; args?: unknown }
  // ── Context usage ──
  | {
      type: 'context_usage';
      contextUsage?: ContextUsage;
      contextBreakdown?: ContextBreakdown;
      isCompacting?: boolean;
      autoCompactionEnabled?: boolean;
    }
  // ── Compaction lifecycle (manual + auto) ──
  | { type: 'compaction_start' }
  | { type: 'compaction_end' }
  | { type: 'auto_compaction_start'; reason?: string; action?: string }
  | {
      type: 'auto_compaction_end';
      result?: unknown;
      aborted?: boolean;
      willRetry?: boolean;
      errorMessage?: string;
      skipped?: boolean;
    }
  // ── Subagent lifecycle / progress ──
  | { type: 'subagent_lifecycle'; payload: unknown }
  | { type: 'subagent_progress'; payload: unknown }
  // ── Notice / error ──
  | { type: 'notice'; text?: string; message?: string }
  | { type: 'error'; error?: string; message?: string };

/** All valid `AgentEvent` discriminants. */
export const AGENT_EVENT_TYPES = [
  'agent_start',
  'agent_end',
  'message_start',
  'message_update',
  'message_end',
  'tool_execution_start',
  'tool_execution_update',
  'tool_execution_end',
  'approval_request',
  'context_usage',
  'compaction_start',
  'compaction_end',
  'auto_compaction_start',
  'auto_compaction_end',
  'subagent_lifecycle',
  'subagent_progress',
  'notice',
  'error',
] as const satisfies ReadonlyArray<AgentEvent['type']>;

export type AgentEventType = (typeof AGENT_EVENT_TYPES)[number];

// ─── Type guards ─────────────────────────────────────────────

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isMessagePayload(value: unknown): boolean {
  if (!isRecord(value)) return false;
  return typeof value.role === 'string';
}

function isMessageEvent(value: Record<string, unknown>): boolean {
  return isMessagePayload(value.message);
}

/**
 * Runtime check whether an untyped frame is a valid `AgentEvent`.
 * Enforces the discriminant plus the minimal required fields per variant —
 * engines must not emit malformed events past the process boundary.
 */
export function isAgentEvent(value: unknown): value is AgentEvent {
  if (!isRecord(value)) return false;
  const type = value.type;
  if (typeof type !== 'string') return false;

  switch (type) {
    case 'agent_start':
    case 'compaction_start':
    case 'compaction_end':
      return true;
    case 'agent_end':
    case 'auto_compaction_start':
    case 'auto_compaction_end':
    case 'context_usage':
    case 'subagent_lifecycle':
    case 'subagent_progress':
    case 'notice':
    case 'error':
      return true;
    case 'message_start':
    case 'message_update':
    case 'message_end':
      return isMessageEvent(value);
    case 'tool_execution_start':
    case 'tool_execution_update':
      return typeof value.toolCallId === 'string' && typeof value.toolName === 'string';
    case 'tool_execution_end':
      return (
        typeof value.toolCallId === 'string' &&
        typeof value.toolName === 'string' &&
        typeof value.isError === 'boolean'
      );
    case 'approval_request':
      return typeof value.id === 'string' && typeof value.toolName === 'string';
    default:
      return false;
  }
}

/**
 * Narrow an unknown value to a specific `AgentEvent` variant.
 *
 * @example
 * if (isAgentEventOfType(event, 'tool_execution_end')) {
 *   console.log(event.toolName, event.isError);
 * }
 */
export function isAgentEventOfType<K extends AgentEvent['type']>(
  value: unknown,
  type: K,
): value is Extract<AgentEvent, { type: K }> {
  return isAgentEvent(value) && value.type === type;
}
