import { type ChildProcess, spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import type {
  AgentClientOptions,
  Command,
  ResponseFrame,
  ToolCallFrame,
  ToolResultCommand,
} from './types';
import {
  isEventFrame,
  isReadyFrame,
  isResponseFrame,
  isToolCallFrame,
} from './types';

export type ToolCallHandler = (
  toolName: string,
  args: unknown,
) => Promise<unknown>;

export type EventListener = (event: unknown) => void;

export class AgentClient {
  private process: ChildProcess | null = null;
  private requestId = 0;
  private pendingRequests = new Map<
    string,
    { resolve: (response: ResponseFrame) => void; reject: (error: Error) => void; timeoutId: NodeJS.Timeout }
  >();
  private pendingToolCalls = new Map<string, AbortController>();
  private toolCallHandler: ToolCallHandler | null = null;
  private eventListeners: EventListener[] = [];
  private stderrBuffer = '';
  private readyTimeoutMs: number;

  constructor(private options: AgentClientOptions) {
    this.readyTimeoutMs = options.readyTimeoutMs ?? 30000;
  }

  async start(): Promise<void> {
    if (this.process) throw new Error('Client already started');

    const child = spawn(this.options.bunPath, ['run', this.options.runnerPath], {
      cwd: this.options.cwd,
      env: { ...process.env, ...this.options.env },
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    this.process = child;

    const { promise: readyPromise, resolve: readyResolve, reject: readyReject } = Promise.withResolvers<void>();
    let readySettled = false;

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
      for (const [, pending] of this.pendingRequests) {
        clearTimeout(pending.timeoutId);
        pending.reject(new Error(`Process exited (code=${code}, signal=${signal})`));
      }
      this.pendingRequests.clear();

      for (const controller of this.pendingToolCalls.values()) {
        controller.abort();
      }
      this.pendingToolCalls.clear();

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
      try {
        child.kill();
      } catch {
        // best-effort cleanup
      }
      this.process = null;
      throw err;
    } finally {
      clearTimeout(readyTimeout);
    }
  }

  stop(): void {
    if (!this.process) return;
    this.process.kill();
    this.process = null;

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

  getStderr(): string {
    return this.stderrBuffer;
  }

  isRunning(): boolean {
    return this.process !== null && !this.process.killed;
  }

  // ─── 事件订阅 ─────────────────────────────────────────

  onEvent(listener: EventListener): () => void {
    this.eventListeners.push(listener);
    return () => {
      const i = this.eventListeners.indexOf(listener);
      if (i !== -1) this.eventListeners.splice(i, 1);
    };
  }

  // ─── Tool Call Handler 注册 ───────────────────────────

  setToolCallHandler(handler: ToolCallHandler): void {
    this.toolCallHandler = handler;
  }

  // ─── 命令方法 ─────────────────────────────────────────

  async init(config: import('./types').InitConfig): Promise<{ sessionId: string }> {
    const response = await this.send({ type: 'init', config });
    return this.getData<{ sessionId: string }>(response);
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

  async abort(): Promise<void> {
    await this.send({ type: 'abort' });
  }

  async setModel(provider: string, modelId: string): Promise<void> {
    await this.send({ type: 'setModel', provider, modelId });
  }

  async getMessages(): Promise<unknown[]> {
    const response = await this.send({ type: 'getMessages' });
    return this.getData<{ messages: unknown[] }>(response).messages;
  }

  async getState(): Promise<unknown> {
    const response = await this.send({ type: 'getState' });
    return this.getData<{ state: unknown }>(response).state;
  }

  async destroy(): Promise<void> {
    try {
      await this.send({ type: 'destroy' });
    } finally {
      this.stop();
    }
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

  private send<T extends Omit<Command, 'id'>>(command: T, timeoutMs = 120000): Promise<ResponseFrame> {
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

    if (isEventFrame(data)) {
      for (const listener of this.eventListeners) listener(data.event);
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

  private getData<T>(response: ResponseFrame): T {
    if (!response.success) {
      throw new Error(response.error ?? 'Unknown error');
    }
    return (response as { data: unknown }).data as T;
  }
}
