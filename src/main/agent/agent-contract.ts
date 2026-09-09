/**
 * Engine-neutral agent client contract.
 *
 * This module is the seam that decouples the host (SessionManager, routers,
 * services) from any specific agent engine. Today the only implementation is
 * the omp-backed `AgentClient`; a future pi client (or any other engine)
 * implements the same interface and is handed to `SessionManagerImpl` via an
 * `AgentClientFactory`.
 *
 * Rules (issue 02):
 *   - No engine-specific field names here (`ompSessionId` → `engineSessionId`).
 *   - The host never constructs engine clients directly — always via factory.
 *   - Event payloads crossing this boundary are `AgentEvent`s
 *     (see @shared/agent-events).
 */

import type { AgentEngine } from '@shared/agent-events';
import type { ContextBreakdown, ContextUsage } from '@shared/context-management';
import type { ThinkingLevelSetting } from '@shared/types';
import type { ApprovalMode, InitConfig } from './types';

// ─── Callback types ─────────────────────────────────────────────
// Owned here (previously on agent-client.ts) so both the contract and the
// omp implementation share one definition without import cycles.

/** Tool call handler — invoked when the engine wants to execute a host tool. */
export type ToolCallHandler = (toolName: string, args: unknown) => Promise<unknown>;

/** Event listener receiving engine events (AgentEvent-shaped). */
export type EventListener = (event: unknown) => void;

/** 审批请求处理器——返回 true 表示用户同意，false 表示拒绝 */
export type ApprovalHandler = (requestId: string, toolName: string, args: unknown) => Promise<boolean>;

// ─── Contract ───────────────────────────────────────────────────

/** Result of initializing a runtime engine session. */
export type AgentInitResult = { engineSessionId: string };

/** Result of regenerating — the engine may fork its session (new id). */
export type AgentRegenerateResult = { engineSessionId: string };

/**
 * Engine-neutral agent client. Covers initialization, prompting, steering,
 * abort, model switching, compaction, destruction, tool callbacks, approval
 * callbacks, and event subscription.
 */
export interface IAgentClient {
  /** Engine identity of this client instance (e.g. 'omp', 'pi'). */
  readonly engine: AgentEngine;

  // ── Process lifecycle ──
  /** Spawn the engine runner process and wait until it is ready. */
  start(): Promise<void>;
  /** Hard-kill the engine process tree. The client is unusable afterwards. */
  stop(): void;
  /** Whether the engine process is currently alive. */
  isRunning(): boolean;
  /** Recent stderr output, for diagnostics when the engine misbehaves. */
  getStderr(): string;

  // ── Session lifecycle ──
  /** Initialize a runtime engine session (optionally resuming one). */
  init(config: InitConfig): Promise<AgentInitResult>;
  /** Destroy the runtime session and the engine process. */
  destroy(): Promise<void>;

  // ── Turn control ──
  /** Fire-and-forget prompt — responses arrive via `onEvent` frames. */
  prompt(message: string, images?: string[]): Promise<void>;
  /** Steer the agent while it is processing. */
  steer(message: string): Promise<void>;
  /** Abort the current agent turn (the process is dead when this returns). */
  abort(): Promise<void>;
  /** Regenerate the last assistant response; may fork the engine session. */
  regenerate(): Promise<AgentRegenerateResult>;

  // ── Model / session settings ──
  setModel(provider: string, modelId: string): Promise<void>;
  setApprovalMode(approvalMode: ApprovalMode): Promise<void>;
  setThinkingLevel(level: ThinkingLevelSetting): Promise<void>;
  setToolFilter(disabledTools: string[]): Promise<void>;

  // ── Introspection ──
  listAgentTools(): Promise<Array<{ name: string; description: string }>>;
  getMessages(): Promise<unknown[]>;
  getState(): Promise<unknown>;
  compact(): Promise<{
    result: unknown;
    contextUsage?: ContextUsage;
    contextBreakdown?: ContextBreakdown;
  }>;

  // ── MCP ──
  getMcpStatus(): Promise<Record<string, { status: string; toolCount: number }>>;
  getMcpServerTools(
    serverName: string,
  ): Promise<Array<{ name: string; description?: string; inputSchema?: unknown }>>;
  reloadMcp(): Promise<Record<string, { status: string; toolCount: number }>>;

  // ── Callbacks / subscription ──
  /** Subscribe to engine events; returns an unsubscribe function. */
  onEvent(listener: EventListener): () => void;
  /** Register the host tool call handler. */
  setToolCallHandler(handler: ToolCallHandler): void;
  /** Register the approval request handler. */
  setApprovalHandler(handler: ApprovalHandler): void;
  /** Send the user's approval decision for a pending request. */
  sendApprovalResponse(requestId: string, approved: boolean): void;
}

// ─── Factory seam ───────────────────────────────────────────────

/**
 * Options handed to a client factory. `mode` mirrors the runner launch mode
 * resolved by `resolveAgentRuntime()`; the factory maps it onto whatever
 * launch options its engine client needs.
 */
export type AgentClientFactoryOptions = {
  mode: 'binary' | 'script';
  /** Runner binary path (binary mode) or runner script path (script mode). */
  runnerPath: string;
  /** Bun executable path (script mode only). */
  bunPath?: string;
  cwd: string;
  env?: Record<string, string>;
};

/**
 * Factory that creates engine clients for `SessionManagerImpl`.
 * The default implementation builds the omp-backed `AgentClient`; tests and
 * future engines inject their own.
 */
export type AgentClientFactory = (options: AgentClientFactoryOptions) => IAgentClient;
