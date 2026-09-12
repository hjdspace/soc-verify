import { type ChildProcess, spawn, execFileSync } from 'node:child_process';
import { createInterface } from 'node:readline';
import { existsSync, statSync } from 'node:fs';
import { platform } from 'node:os';
import type {
  AgentClientOptions,
  Command,
  ResponseFrame,
  ToolCallFrame,
  ToolResultCommand,
  ApprovalRequestFrame,
  ApprovalResponseCommand,
  TrustRequestFrame,
  TrustResponseCommand,
} from './types';
import {
  isEventFrame,
  isReadyFrame,
  isResponseFrame,
  isSubagentFrame,
  isToolCallFrame,
  isApprovalRequestFrame,
  isTrustRequestFrame,
} from './types';
import type {
  AgentInitResult,
  AgentRegenerateResult,
  ApprovalHandler,
  EventListener,
  IAgentClient,
  ToolCallHandler,
  TrustHandler,
} from './agent-contract';
import type { AgentEngine } from '@shared/agent-events';
import type { ContextBreakdown, ContextUsage } from '@shared/context-management';
import type { ThinkingLevelSetting } from '@shared/types';

// Re-exported for backward compatibility — these types now live on the
// engine-neutral contract (agent-contract.ts).
export type { ToolCallHandler, EventListener, ApprovalHandler } from './agent-contract';

/**
 * Diagnose why a binary spawn failed. Returns a diagnostic string to append
 * to the error message, or an empty string if no additional info is available.
 *
 * On Linux, when `spawn` returns ENOENT for a binary that exists on disk,
 * the most common cause is a missing shared library — the dynamic linker
 * fails to find a required `.so` file, and the kernel translates this to
 * ENOENT. This function runs `ldd` to detect missing libraries.
 */
export function diagnoseSpawnFailure(binaryPath: string, err: Error): string {
  const errStr = err.message || String(err);

  // Diagnose common binary execution failures. EACCES means the executable
  // bit was lost; ENOEXEC usually means an incompatible ELF/architecture;
  // ENOENT can mean a missing ELF loader or shared library when the path exists.
  if (!errStr.includes('ENOENT') && !errStr.includes('EACCES') && !errStr.includes('ENOEXEC')) return '';
  if (!existsSync(binaryPath)) {
    return `\n  Binary not found at: ${binaryPath}`;
  }

  const parts: string[] = [];
  const stats = statSync(binaryPath);
  parts.push(`\n  Binary exists: yes (${stats.size} bytes)`);

  // Check if the file is executable
  const isExecutable = (stats.mode & 0o111) !== 0;
  if (!isExecutable) {
    parts.push('  Executable permission: NO — run `chmod +x` on the binary');
  }

  // On Linux, run ldd to check for missing shared libraries. EACCES is a
  // permission problem and does not need ELF dependency probing.
  if (process.platform === 'linux' && !errStr.includes('EACCES')) {
    try {
      const lddOutput = execFileSync('ldd', [binaryPath], {
        encoding: 'utf-8',
        timeout: 5000,
        stdio: ['pipe', 'pipe', 'pipe'],
      });
      const missingLibs = lddOutput
        .split('\n')
        .filter((line) => line.includes('not found'))
        .map((line) => line.trim());
      if (missingLibs.length > 0) {
        parts.push('  Missing shared libraries (detected via ldd):');
        for (const lib of missingLibs) {
          parts.push(`    ${lib}`);
        }
        parts.push('  Install the missing libraries or use a compatible binary.');
      }
    } catch {
      // ldd might fail for statically linked binaries or non-ELF files
      parts.push('  (ldd analysis failed — binary may be statically linked or wrong format)');
    }
  }

  return parts.join('\n');
}

/**
 * Engine-neutral JSONL client base class.
 *
 * 持有与引擎无关的客户端机制：ready 握手、请求/响应关联、tool_call/
 * approval/trust 桥、事件转发、进程树清理。引擎身份（`engine`）与
 * 启动方式（`resolveSpawn`）由子类决定 —— issue 10 移除 omp 运行时后，
 * 基类不再提供 binary（预编译二进制）或 Bun 脚本两种启动模式。
 */
export abstract class AgentClient implements IAgentClient {
  /** Engine identity — declared by the concrete engine subclass. */
  abstract readonly engine: AgentEngine;

  private process: ChildProcess | null = null;
  /** The PID captured at spawn time, used for process-tree kill on Windows. */
  private processPid: number | null = null;
  private requestId = 0;
  private pendingRequests = new Map<
    string,
    { resolve: (response: ResponseFrame) => void; reject: (error: Error) => void; timeoutId: NodeJS.Timeout }
  >();
  private pendingToolCalls = new Map<string, AbortController>();
  private toolCallHandler: ToolCallHandler | null = null;
  private approvalHandler: ApprovalHandler | null = null;
  private trustHandler: TrustHandler | null = null;
  private eventListeners: EventListener[] = [];
  private stderrBuffer = '';
  private readyTimeoutMs: number;
  /** Guards against double-kill: once stop() runs, subsequent calls are no-ops. */
  private stopping = false;
  /** Set when the child emits 'exit' — makes isRunning() truthful after a crash. */
  private exited = false;
  /** Set when the ready handshake completed — crash detection needs it (issue 08). */
  private readyAchieved = false;

  constructor(protected readonly options: AgentClientOptions) {
    this.readyTimeoutMs = options.readyTimeoutMs ?? 30000;
  }

  /**
   * Resolve the runner spawn command.
   *
   * Template-method seam: engine subclasses override this to launch their
   * runner (e.g. PiAgentClient runs the runner-pi script with Node via
   * ELECTRON_RUN_AS_NODE=1). The base class has no default launch mode —
   * omp 时代的 binary/Bun 双模式已随运行时移除（issue 10）。
   */
  protected resolveSpawn(): { cmd: string; args: string[] } {
    throw new Error(
      'Engine-neutral AgentClient subclass must override resolveSpawn() to launch its runner',
    );
  }

  async start(): Promise<void> {
    if (this.process) throw new Error('Client already started');
    if (!existsSync(this.options.cwd)) {
      throw new Error(`Agent working directory does not exist: ${this.options.cwd}`);
    }

    const { cmd: spawnCmd, args: spawnArgs } = this.resolveSpawn();

    const child = spawn(spawnCmd, spawnArgs, {
      cwd: this.options.cwd,
      env: { ...process.env, ...this.options.env },
      stdio: ['pipe', 'pipe', 'pipe'],
      // On non-Windows platforms, start a new process group so we can
      // signal the entire tree (omp may spawn subagents). Windows uses
      // `killProcessTree()` which shells out to `taskkill /T /PID`.
      ...(platform() !== 'win32' ? { detached: true } : {}),
    });
    this.process = child;
    this.processPid = child.pid ?? null;

    const { promise: readyPromise, resolve: readyResolve, reject: readyReject } = Promise.withResolvers<void>();
    let readySettled = false;

    // Handle spawn errors (e.g. runner not found, incompatible binary).
    //  Without this listener, Node.js treats the 'error'
    // event as an uncaught exception and crashes the Electron main process
    // with a "A JavaScript error occurred in the main process" dialog.
    child.on('error', (err: Error) => {
      const diagnostic = diagnoseSpawnFailure(spawnCmd, err);
      const enriched = new Error(
        `Failed to spawn agent process '${spawnCmd}': ${err.message}. ` +
        `This usually means the runner is missing or not executable on this system.${diagnostic}`,
      );
      if (!readySettled) {
        readySettled = true;
        readyReject(enriched);
      } else {
        // Process started but later failed (e.g. killed signal)
        for (const [, pending] of this.pendingRequests) {
          clearTimeout(pending.timeoutId);
          pending.reject(enriched);
        }
        this.pendingRequests.clear();
      }
    });

    const rl = createInterface({ input: child.stdout!, crlfDelay: Infinity });

    rl.on('line', (line: string) => {
      if (!line.trim()) return;
      let parsed: unknown;
      try {
        parsed = JSON.parse(line);
      } catch {
        return;
      }

      if (!readySettled && isReadyFrame(parsed)) {
        readySettled = true;
        this.readyAchieved = true;
        readyResolve();
        return;
      }

      this.handleLine(parsed);
    });

    child.stderr?.on('data', (chunk: Buffer) => {
      const text = chunk.toString();
      this.stderrBuffer += text;
      if (this.stderrBuffer.length > 10000) {
        this.stderrBuffer = this.stderrBuffer.slice(-10000);
      }
      const trimmed = text.trim();
      if (trimmed) {
        console.error(`[agent:stderr] ${trimmed}`);
      }
    });

    child.on('exit', (code, signal) => {
      this.exited = true;

      for (const [, pending] of this.pendingRequests) {
        clearTimeout(pending.timeoutId);
        pending.reject(new Error(`Process exited (code=${code}, signal=${signal})`));
      }
      this.pendingRequests.clear();

      for (const controller of this.pendingToolCalls.values()) {
        controller.abort();
      }
      this.pendingToolCalls.clear();

      // issue 08: runner 崩溃（ready 已达成且非主动 stop）→ 合成 error 事件
      // 分发给监听者。渲染层据 error 事件把会话置为 error 状态，等待用户
      // 显式重启 —— 绝不自动重放可能产生副作用的 turn。主动 stop（destroy/
      // abort/模型热切换）与 ready 前退出（start() 拒绝路径）都不算崩溃。
      if (this.readyAchieved && !this.stopping) {
        const reason = `Agent process crashed (code=${code}, signal=${signal})`;
        console.error(`[agent:client] ${reason}`);
        for (const listener of this.eventListeners) {
          listener({ type: 'error', error: reason, message: reason });
        }
      }

      if (!readySettled) {
        readySettled = true;
        readyReject(new Error(`Agent process exited before ready. Stderr: ${this.stderrBuffer}`));
      }
    });

    const readyTimeout = setTimeout(() => {
      if (readySettled) return;
      readySettled = true;
      readyReject(new Error(`Timeout waiting for agent to become ready. Stderr: ${this.stderrBuffer}`));
    }, this.readyTimeoutMs);
    readyTimeout.unref();

    try {
      await readyPromise;
    } catch (err) {
      // Kill the process tree (not just the leader) for proper cleanup.
      this.stop();
      throw err;
    } finally {
      clearTimeout(readyTimeout);
    }
  }

  /**
   * Hard-kill the agent process and its entire process tree.
   *
   * On POSIX (Linux/macOS): sends SIGTERM to the process group (negative
   * PID), then escalates to SIGKILL after a 1s grace period. This catches
   * any descendants the engine spawned that would otherwise survive.
   *
   * On Windows: uses `taskkill /F /T /PID` which recursively terminates
   * all child processes. Windows has no process groups in the POSIX sense,
   * so this is the only reliable way to kill a process tree.
   *
   * After calling stop(), the AgentClient cannot be reused — a new process
   * must be spawned via start().
   */
  stop(): void {
    if (this.stopping) return;
    this.stopping = true;

    if (!this.process) {
      this.processPid = null;
      return;
    }

    const pid = this.processPid ?? this.process.pid;
    this.process = null;
    this.processPid = null;

    if (pid) {
      this.killProcessTree(pid);
    }

    for (const [, pending] of this.pendingRequests) {
      clearTimeout(pending.timeoutId);
      pending.reject(new Error('Client stopped'));
    }
    this.pendingRequests.clear();

    for (const controller of this.pendingToolCalls.values()) {
      controller.abort();
    }
    this.pendingToolCalls.clear();
  }

  /**
   * Kill an entire process tree.
   *
   * POSIX: signal the process group (killpg via negative PID), escalating
   * SIGTERM → SIGKILL.
   *
   * Windows: `taskkill /F /T /PID` recursively kills all descendants.
   */
  private killProcessTree(pid: number): void {
    if (platform() === 'win32') {
      // Windows: taskkill /F (force) /T (tree) /PID
      try {
        execFileSync('taskkill', ['/F', '/T', '/PID', String(pid)], {
          stdio: ['pipe', 'pipe', 'pipe'],
          timeout: 5000,
        });
      } catch {
        // Process may have already exited — best-effort.
      }
      return;
    }

    // POSIX: signal the process group via negative PID.
    // `detached: true` at spawn ensures the child leads its own group.
    try {
      process.kill(-pid, 'SIGTERM');
    } catch {
      // ESRCH: process already exited — nothing to kill.
      return;
    }

    // Escalate to SIGKILL after 1 second if the process is still alive.
    const killTimer = setTimeout(() => {
      try {
        process.kill(-pid, 'SIGKILL');
      } catch {
        // Already gone — no-op.
      }
    }, 1000);
    killTimer.unref();
  }

  getStderr(): string {
    return this.stderrBuffer;
  }

  isRunning(): boolean {
    return this.process !== null && !this.stopping && !this.exited && !this.process.killed;
  }

  // ─── 事件订阅 ─────────────────────────────────────────

  onEvent(listener: EventListener): () => void {
    this.eventListeners.push(listener);
    return () => {
      const i = this.eventListeners.indexOf(listener);
      if (i !== -1) this.eventListeners.splice(i, 1);
    };
  }

  // ─── Tool Call Handler 注册 ─────────────────────────────

  setToolCallHandler(handler: ToolCallHandler): void {
    this.toolCallHandler = handler;
  }

  // ─── 审批 Handler 注册 ─────────────────────────────────

  setApprovalHandler(handler: ApprovalHandler): void {
    this.approvalHandler = handler;
  }

  /** 发送审批响应到 runner */
  sendApprovalResponse(requestId: string, approved: boolean): void {
    this.writeFrame({
      type: 'approval_response',
      id: requestId,
      approved,
    } satisfies ApprovalResponseCommand);
  }

  // ─── 信任 Handler 注册（issue 04）──────────────────────

  setTrustHandler(handler: TrustHandler): void {
    this.trustHandler = handler;
  }

  /** 发送信任响应到 runner */
  sendTrustResponse(requestId: string, approved: boolean): void {
    this.writeFrame({
      type: 'trust_response',
      id: requestId,
      approved,
    } satisfies TrustResponseCommand);
  }

  // ─── 命令方法 ─────────────────────────────────────────

  async init(config: import('./types').InitConfig): Promise<AgentInitResult> {
    const response = await this.send({ type: 'init', config });
    const data = this.getData<{ sessionId: string }>(response);
    // Map the runner's omp-native `sessionId` onto the engine-neutral name.
    return { engineSessionId: data.sessionId };
  }

  async prompt(message: string, images?: string[]): Promise<void> {
    // Fire-and-forget: the response frame for `prompt` only arrives when the
    // agent finishes processing (which can take many minutes, especially with
    // subagents).  Real-time updates are delivered via event frames and the
    // `agent_end` event signals completion — we must NOT block on the response
    // frame with a short timeout, otherwise a false "Timeout waiting for
    // response to prompt" error is thrown while the LLM is still working.
    this.sendFireAndForget({ type: 'prompt', message, images });
  }

  async steer(message: string): Promise<void> {
    // Same rationale as prompt(): steer may also take a long time when the
    // agent is actively processing.  Use fire-and-forget to avoid spurious
    // timeout errors.
    this.sendFireAndForget({ type: 'steer', message });
  }

  /**
   * Regenerate the last assistant response.
   *
   * 分支语义由各引擎子类实现（如 PiAgentClient 分支到最后一条 user
   * message 之前并返回新的 engineSessionId）；基类不提供默认实现。
   */
  abstract regenerate(): Promise<AgentRegenerateResult>;

  /**
   * Abort the current agent turn.
   *
   * Sends an `abort` command to the runner as fire-and-forget (the runner
   * may take a long time to respond or never respond if the SDK abort is
   * stuck). Immediately after sending, calls `stop()` to hard-kill the
   * process tree — this ensures the LLM and any subagents are terminated,
   * not just "asked to stop".
   *
   * The caller should NOT await this method expecting the agent to finish
   * gracefully; the process is dead by the time this returns.
   */
  async abort(): Promise<void> {
    // Send abort as fire-and-forget — we don't need (or want to wait for)
    // the runner's response. The runner may be stuck in a long-running
    // tool call or SDK abort that never resolves.
    try {
      this.sendFireAndForget({ type: 'abort' });
    } catch {
      // If stdin is already closed, the process is likely dead — proceed
      // to stop() anyway for cleanup.
    }
    // Hard-kill the process tree immediately.
    this.stop();
  }

  async setModel(provider: string, modelId: string): Promise<void> {
    await this.send({ type: 'setModel', provider, modelId });
  }

  async setApprovalMode(approvalMode: import('./types').ApprovalMode): Promise<void> {
    await this.send({ type: 'setApprovalMode', approvalMode });
  }

  /**
   * 动态设置会话思考强度。
   * 'default' 表示交还引擎默认行为（runner 端映射为 undefined）。
   */
  async setThinkingLevel(level: ThinkingLevelSetting): Promise<void> {
    await this.send({ type: 'setThinkingLevel', level });
  }

  /** 动态更新会话的工具开关（被禁用的工具立即从 LLM 工具集中移除/恢复）。 */
  async setToolFilter(disabledTools: string[]): Promise<void> {
    await this.send({ type: 'setToolFilter', disabledTools });
  }

  /** 枚举会话当前激活的全部工具（含 omp 内置与 host 自定义）。 */
  async listAgentTools(): Promise<Array<{ name: string; description: string }>> {
    const response = await this.send({ type: 'listAgentTools' });
    const data = this.getData<{ tools: Array<{ name: string; description: string }> }>(response);
    return data.tools ?? [];
  }

  async getMessages(): Promise<unknown[]> {
    const response = await this.send({ type: 'getMessages' });
    return this.getData<{ messages: unknown[] }>(response).messages;
  }

  async getState(): Promise<unknown> {
    const response = await this.send({ type: 'getState' });
    return this.getData<{ state: unknown }>(response).state;
  }

  /**
   * 当前生效的系统提示词（issue 06）。引擎未实现该命令时返回失败响应 ——
   * 这里优雅降级为 null，调用方（设置/会话 UI）无需感知引擎差异。
   */
  async getSystemPrompt(): Promise<string | null> {
    try {
      const response = await this.send({ type: 'getSystemPrompt' });
      return this.getData<{ systemPrompt: string }>(response).systemPrompt;
    } catch {
      return null;
    }
  }

  async compact(): Promise<{
    result: unknown;
    contextUsage?: ContextUsage;
    contextBreakdown?: ContextBreakdown;
  }> {
    const response = await this.send({ type: 'compact' }, 5 * 60 * 1000);
    return this.getData<{
      result: unknown;
      contextUsage?: ContextUsage;
      contextBreakdown?: ContextBreakdown;
    }>(response);
  }

  /**
   * Query the omp engine's MCPManager for all known MCP servers and their
   * runtime connection status. Returns a map of server name → { status, toolCount }.
   *
   * Returns an empty object if MCP is disabled or no servers are configured.
   */
  async getMcpStatus(): Promise<Record<string, { status: string; toolCount: number }>> {
    const response = await this.send({ type: 'getMcpStatus' });
    const data = this.getData<{ servers: Record<string, { status: string; toolCount: number }> }>(response);
    return data.servers ?? {};
  }

  /**
   * Query the omp engine for the list of tools exposed by a specific MCP server.
   * Returns an empty array if the server is not connected or has no tools.
   */
  async getMcpServerTools(serverName: string): Promise<Array<{ name: string; description?: string; inputSchema?: unknown }>> {
    const response = await this.send({ type: 'getMcpServerTools', serverName });
    const data = this.getData<{ tools: Array<{ name: string; description?: string; inputSchema?: unknown }> }>(response);
    return data.tools ?? [];
  }

  /**
   * Reload MCP configuration in the running session.
   *
   * Triggers `MCPManager.disconnectAll()` + `discoverAndConnect()` +
   * `session.refreshMCPTools()` so newly added/removed servers in `.mcp.json`
   * are picked up without restarting the session. Returns the post-reload
   * status map (same shape as `getMcpStatus`).
   */
  async reloadMcp(): Promise<Record<string, { status: string; toolCount: number }>> {
    const response = await this.send({ type: 'reloadMcp' }, 60000);
    const data = this.getData<{ ok: boolean; servers: Record<string, { status: string; toolCount: number }> }>(response);
    return data.servers ?? {};
  }

  async destroy(): Promise<void> {
    // Send destroy as fire-and-forget — we don't need to wait for the
    // runner's response before killing the process.
    try {
      this.sendFireAndForget({ type: 'destroy' });
    } catch {
      // If stdin is already closed, the process may already be dead.
    }
    this.stop();
  }

  // ─── 内部方法 ─────────────────────────────────────────

  /**
   * Send a command without waiting for its response frame.
   *
   * Used for long-running commands (`prompt`, `steer`) whose response frame
   * only arrives after the agent finishes processing — which can take many
   * minutes.  Real-time updates are delivered via event frames, so the caller
   * does not need to await the response.
   *
   * When the response frame eventually arrives, `handleLine` will not find a
   * matching pending request and will silently ignore it.
   */
  private sendFireAndForget<T extends Omit<Command, 'id'>>(command: T): void {
    if (!this.process?.stdin) throw new Error('Client not started');
    const id = `req_${++this.requestId}`;
    const fullCommand = { ...command, id } as Command;
    this.writeFrame(fullCommand);
  }

  // protected：引擎子类（PiAgentClient）覆写 regenerate 等命令时复用
  // 请求/响应关联与响应解包机制。
  protected send<T extends Omit<Command, 'id'>>(command: T, timeoutMs = 120000): Promise<ResponseFrame> {
    if (!this.process?.stdin) throw new Error('Client not started');

    const id = `req_${++this.requestId}`;
    const fullCommand = { ...command, id } as Command;
    const { promise, resolve, reject } = Promise.withResolvers<ResponseFrame>();
    let settled = false;

    const timeoutId = setTimeout(() => {
      if (settled) return;
      this.pendingRequests.delete(id);
      settled = true;
      reject(new Error(`Timeout waiting for response to ${command.type}`));
    }, timeoutMs);
    timeoutId.unref();

    this.pendingRequests.set(id, {
      resolve: (response) => {
        if (settled) return;
        settled = true;
        clearTimeout(timeoutId);
        resolve(response);
      },
      reject: (error) => {
        if (settled) return;
        settled = true;
        clearTimeout(timeoutId);
        reject(error);
      },
      timeoutId,
    });

    this.writeFrame(fullCommand);
    return promise;
  }

  private writeFrame(frame: unknown): void {
    if (!this.process?.stdin) throw new Error('Client not started');
    this.process.stdin.write(`${JSON.stringify(frame)}\n`);
  }

  private handleLine(data: unknown): void {
    if (isResponseFrame(data)) {
      const pending = this.pendingRequests.get(data.id);
      if (pending) {
        this.pendingRequests.delete(data.id);
        pending.resolve(data);
      }
      return;
    }

    if (isToolCallFrame(data)) {
      void this.handleToolCall(data);
      return;
    }

    if (isApprovalRequestFrame(data)) {
      void this.handleApprovalRequest(data);
      return;
    }

    if (isTrustRequestFrame(data)) {
      void this.handleTrustRequest(data);
      return;
    }

    if (isEventFrame(data)) {
      for (const listener of this.eventListeners) listener(data.event);
      return;
    }

    // Subagent frames (lifecycle/progress) are forwarded to event listeners
    // as-is; session-manager relays them to the renderer via 'sessionEvent'.
    if (isSubagentFrame(data)) {
      console.log(`[agent:client] SUBAGENT_FRAME received: type=${(data as Record<string, unknown>).type}`);
      for (const listener of this.eventListeners) listener(data);
      return;
    }

    // Catch-all: forward unknown frames as events
    const dataType = (data as Record<string, unknown>)?.type;
    console.log(`[agent:rpc] unhandled frame type="${dataType}" — forwarding as event`);
    for (const listener of this.eventListeners) listener(data);
  }

  private async handleToolCall(frame: ToolCallFrame): Promise<void> {
    if (!this.toolCallHandler) {
      this.writeFrame({
        type: 'tool_result',
        id: frame.id,
        result: { content: [{ type: 'text', text: 'No tool call handler registered' }] },
        isError: true,
      } satisfies ToolResultCommand);
      return;
    }

    const controller = new AbortController();
    this.pendingToolCalls.set(frame.id, controller);

    try {
      const result = await this.toolCallHandler(frame.toolName, frame.args);
      if (controller.signal.aborted) return;

      const normalized =
        typeof result === 'string'
          ? { content: [{ type: 'text', text: result }] }
          : result;

      this.writeFrame({
        type: 'tool_result',
        id: frame.id,
        result: normalized,
      } satisfies ToolResultCommand);
    } catch (error) {
      if (controller.signal.aborted) return;
      this.writeFrame({
        type: 'tool_result',
        id: frame.id,
        result: error instanceof Error ? error.message : String(error),
        isError: true,
      } satisfies ToolResultCommand);
    } finally {
      this.pendingToolCalls.delete(frame.id);
    }
  }

  private async handleApprovalRequest(frame: ApprovalRequestFrame): Promise<void> {
    if (!this.approvalHandler) {
      // No handler — auto-approve to avoid blocking
      this.sendApprovalResponse(frame.id, true);
      return;
    }
    try {
      const approved = await this.approvalHandler(frame.id, frame.toolName, frame.args);
      this.sendApprovalResponse(frame.id, approved);
    } catch {
      this.sendApprovalResponse(frame.id, false);
    }
  }

  private async handleTrustRequest(frame: TrustRequestFrame): Promise<void> {
    if (!this.trustHandler) {
      // 无 handler 时 fail closed：信任确认绝不自动放行（安全边界，
      // 与审批的 fail open 语义相反 —— 误拒无害，误信有风险）。
      this.sendTrustResponse(frame.id, false);
      return;
    }
    try {
      const approved = await this.trustHandler(frame.id, frame.kind, frame.name, frame.path);
      this.sendTrustResponse(frame.id, approved);
    } catch {
      this.sendTrustResponse(frame.id, false);
    }
  }

  protected getData<T>(response: ResponseFrame): T {
    if (!response.success) {
      throw new Error(response.error ?? 'Unknown error');
    }
    return (response as { data: unknown }).data as T;
  }
}
