import { type ChildProcess, spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import type {
  AgentToolResult,
  OmpEventListener,
  OmpRpcClientOptions,
  OmpSessionEventListener,
  RpcCommand,
  RpcCommandBody,
  RpcHostToolCallRequest,
  RpcHostToolDefinition,
  RpcHostToolResult,
  RpcHostUriRequest,
  RpcHostUriResult,
  RpcHostUriSchemeDefinition,
  RpcResponse,
  RpcSessionState,
} from './types';
import {
  isAgentEvent,
  isAgentSessionEvent,
  isOmpReadyFrame,
  isRpcAvailableCommandsUpdateFrame,
  isRpcExtensionUiRequest,
  isRpcHostToolCallRequest,
  isRpcHostToolCancelRequest,
  isRpcHostUriCancelRequest,
  isRpcHostUriRequest,
  isRpcPromptResultFrame,
  isRpcResponse,
  isRpcSubagentEventFrame,
  isRpcSubagentLifecycleFrame,
  isRpcSubagentProgressFrame,
} from './types';

export class OmpRpcClient {
  private process: ChildProcess | null = null;
  private requestId = 0;
  private pendingRequests = new Map<
    string,
    { resolve: (response: RpcResponse) => void; reject: (error: Error) => void; timeoutId: NodeJS.Timeout }
  >();
  private pendingHostToolCalls = new Map<string, AbortController>();
  private customTools = new Map<string, (request: RpcHostToolCallRequest) => Promise<AgentToolResult | string>>();
  private hostUriHandlers = new Map<string, (request: RpcHostUriRequest) => Promise<RpcHostUriResult>>();

  private eventListeners: OmpEventListener[] = [];
  private sessionEventListeners: OmpSessionEventListener[] = [];
  private subagentLifecycleListeners: Array<(payload: unknown) => void> = [];
  private subagentProgressListeners: Array<(payload: unknown) => void> = [];
  private subagentEventListeners: Array<(payload: unknown) => void> = [];
  private extensionUiListeners: Array<(req: unknown) => void> = [];
  private availableCommandsListeners: Array<(commands: unknown[]) => void> = [];
  private promptResultListeners: Array<(frame: { id?: string; agentInvoked: boolean }) => void> = [];

  private stderrBuffer = '';
  private readyTimeoutMs: number;

  constructor(private options: OmpRpcClientOptions) {
    this.readyTimeoutMs = options.readyTimeoutMs ?? 30000;
  }

  async start(): Promise<void> {
    if (this.process) throw new Error('Client already started');

    const extraArgs = this.options.extraArgs ?? [];
    let spawnCmd: string;
    let spawnArgs: string[];

    if (this.options.ompBinaryPath) {
      spawnCmd = this.options.ompBinaryPath;
      spawnArgs = ['--mode', 'rpc', ...extraArgs];
      if (this.options.provider) spawnArgs.push('--provider', this.options.provider);
      if (this.options.model) spawnArgs.push('--model', this.options.model);
      if (this.options.sessionDir) spawnArgs.push('--session-dir', this.options.sessionDir);
    } else {
      if (!this.options.bunPath || !this.options.ompEntryPath) {
        throw new Error('Either ompBinaryPath or (bunPath + ompEntryPath) must be provided');
      }
      spawnCmd = this.options.bunPath;
      spawnArgs = [this.options.ompEntryPath, '--mode', 'rpc'];
      if (this.options.provider) spawnArgs.push('--provider', this.options.provider);
      if (this.options.model) spawnArgs.push('--model', this.options.model);
      if (this.options.sessionDir) spawnArgs.push('--session-dir', this.options.sessionDir);
      spawnArgs.push(...extraArgs);
    }

    const child = spawn(spawnCmd, spawnArgs, {
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

      if (!readySettled && isOmpReadyFrame(parsed)) {
        readySettled = true;
        readyResolve();
        return;
      }

      this.handleLine(parsed);
    });

    child.stderr?.on('data', (chunk: Buffer) => {
      this.stderrBuffer += chunk.toString();
      if (this.stderrBuffer.length > 10000) {
        this.stderrBuffer = this.stderrBuffer.slice(-10000);
      }
    });

    child.on('exit', (code, signal) => {
      for (const [, pending] of this.pendingRequests) {
        clearTimeout(pending.timeoutId);
        pending.reject(new Error(`Process exited (code=${code}, signal=${signal})`));
      }
      this.pendingRequests.clear();

      for (const controller of this.pendingHostToolCalls.values()) {
        controller.abort();
      }
      this.pendingHostToolCalls.clear();

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

    for (const controller of this.pendingHostToolCalls.values()) {
      controller.abort();
    }
    this.pendingHostToolCalls.clear();
  }

  getStderr(): string {
    return this.stderrBuffer;
  }

  isRunning(): boolean {
    return this.process !== null && !this.process.killed;
  }

  // ─── 事件订阅 ─────────────────────────────────────────

  onEvent(listener: OmpEventListener): () => void {
    this.eventListeners.push(listener);
    return () => {
      const i = this.eventListeners.indexOf(listener);
      if (i !== -1) this.eventListeners.splice(i, 1);
    };
  }

  onSessionEvent(listener: OmpSessionEventListener): () => void {
    this.sessionEventListeners.push(listener);
    return () => {
      const i = this.sessionEventListeners.indexOf(listener);
      if (i !== -1) this.sessionEventListeners.splice(i, 1);
    };
  }

  onSubagentLifecycle(listener: (payload: unknown) => void): () => void {
    this.subagentLifecycleListeners.push(listener);
    return () => {
      const i = this.subagentLifecycleListeners.indexOf(listener);
      if (i !== -1) this.subagentLifecycleListeners.splice(i, 1);
    };
  }

  onSubagentProgress(listener: (payload: unknown) => void): () => void {
    this.subagentProgressListeners.push(listener);
    return () => {
      const i = this.subagentProgressListeners.indexOf(listener);
      if (i !== -1) this.subagentProgressListeners.splice(i, 1);
    };
  }

  onSubagentEvent(listener: (payload: unknown) => void): () => void {
    this.subagentEventListeners.push(listener);
    return () => {
      const i = this.subagentEventListeners.indexOf(listener);
      if (i !== -1) this.subagentEventListeners.splice(i, 1);
    };
  }

  onExtensionUi(listener: (req: unknown) => void): () => void {
    this.extensionUiListeners.push(listener);
    return () => {
      const i = this.extensionUiListeners.indexOf(listener);
      if (i !== -1) this.extensionUiListeners.splice(i, 1);
    };
  }

  onAvailableCommandsUpdate(listener: (commands: unknown[]) => void): () => void {
    this.availableCommandsListeners.push(listener);
    return () => {
      const i = this.availableCommandsListeners.indexOf(listener);
      if (i !== -1) this.availableCommandsListeners.splice(i, 1);
    };
  }

  onPromptResult(listener: (frame: { id?: string; agentInvoked: boolean }) => void): () => void {
    this.promptResultListeners.push(listener);
    return () => {
      const i = this.promptResultListeners.indexOf(listener);
      if (i !== -1) this.promptResultListeners.splice(i, 1);
    };
  }

  // ─── 命令方法 ─────────────────────────────────────────

  async prompt(message: string, images?: string[]): Promise<void> {
    await this.send({ type: 'prompt', message, images });
  }

  async steer(message: string): Promise<void> {
    await this.send({ type: 'steer', message });
  }

  async followUp(message: string): Promise<void> {
    await this.send({ type: 'follow_up', message });
  }

  async abort(): Promise<void> {
    await this.send({ type: 'abort' });
  }

  async abortAndPrompt(message: string): Promise<void> {
    await this.send({ type: 'abort_and_prompt', message });
  }

  async newSession(parentSession?: string): Promise<{ cancelled: boolean }> {
    const response = await this.send({ type: 'new_session', parentSession });
    return this.getData<{ cancelled: boolean }>(response);
  }

  async getState(): Promise<RpcSessionState> {
    const response = await this.send({ type: 'get_state' });
    return this.getData<RpcSessionState>(response);
  }

  async setHostTools(tools: RpcHostToolDefinition[]): Promise<string[]> {
    const response = await this.send({ type: 'set_host_tools', tools });
    return this.getData<{ toolNames: string[] }>(response).toolNames;
  }

  async setHostUriSchemes(schemes: RpcHostUriSchemeDefinition[]): Promise<string[]> {
    const response = await this.send({ type: 'set_host_uri_schemes', schemes });
    return this.getData<{ schemes: string[] }>(response).schemes;
  }

  async setSubagentSubscription(level: 'off' | 'progress' | 'events'): Promise<void> {
    await this.send({ type: 'set_subagent_subscription', level });
  }

  async setModel(provider: string, modelId: string): Promise<void> {
    await this.send({ type: 'set_model', provider, modelId });
  }

  async getAvailableModels(): Promise<unknown[]> {
    const response = await this.send({ type: 'get_available_models' });
    return this.getData<{ models: unknown[] }>(response).models;
  }

  async switchSession(sessionPath: string): Promise<{ cancelled: boolean }> {
    const response = await this.send({ type: 'switch_session', sessionPath });
    return this.getData<{ cancelled: boolean }>(response);
  }

  async branch(entryId: string): Promise<{ text: string; cancelled: boolean }> {
    const response = await this.send({ type: 'branch', entryId });
    return this.getData<{ text: string; cancelled: boolean }>(response);
  }

  async getMessages(): Promise<unknown[]> {
    const response = await this.send({ type: 'get_messages' });
    return this.getData<{ messages: unknown[] }>(response).messages;
  }

  // ─── Host Tool / URI 注册 ─────────────────────────────

  registerHostTool(
    name: string,
    handler: (request: RpcHostToolCallRequest) => Promise<AgentToolResult | string>,
  ): void {
    this.customTools.set(name, handler);
  }

  unregisterHostTool(name: string): boolean {
    return this.customTools.delete(name);
  }

  registerHostUriHandler(
    scheme: string,
    handler: (request: RpcHostUriRequest) => Promise<RpcHostUriResult>,
  ): void {
    this.hostUriHandlers.set(scheme, handler);
  }

  unregisterHostUriHandler(scheme: string): boolean {
    return this.hostUriHandlers.delete(scheme);
  }

  sendHostToolUpdate(id: string, partialResult: AgentToolResult): void {
    this.writeFrame({ type: 'host_tool_update', id, partialResult });
  }

  sendExtensionUiResponse(response: unknown): void {
    this.writeFrame(response);
  }

  // ─── 内部方法 ─────────────────────────────────────────

  private send(command: RpcCommandBody, timeoutMs = 30000): Promise<RpcResponse> {
    if (!this.process?.stdin) throw new Error('Client not started');

    const id = `req_${++this.requestId}`;
    const fullCommand = { ...command, id } as RpcCommand;
    const { promise, resolve, reject } = Promise.withResolvers<RpcResponse>();
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
    if (isRpcResponse(data)) {
      const id = data.id;
      if (id && this.pendingRequests.has(id)) {
        const pending = this.pendingRequests.get(id)!;
        this.pendingRequests.delete(id);
        pending.resolve(data);
        return;
      }
    }

    if (isRpcHostToolCallRequest(data)) {
      void this.handleHostToolCall(data);
      return;
    }

    if (isRpcHostToolCancelRequest(data)) {
      this.pendingHostToolCalls.get(data.targetId)?.abort();
      return;
    }

    if (isRpcHostUriRequest(data)) {
      void this.handleHostUriRequest(data);
      return;
    }

    if (isRpcHostUriCancelRequest(data)) {
      return;
    }

    if (isRpcExtensionUiRequest(data)) {
      for (const listener of this.extensionUiListeners) listener(data);
      return;
    }

    if (isRpcSubagentLifecycleFrame(data)) {
      for (const listener of this.subagentLifecycleListeners) listener(data.payload);
      return;
    }

    if (isRpcSubagentProgressFrame(data)) {
      for (const listener of this.subagentProgressListeners) listener(data.payload);
      return;
    }

    if (isRpcSubagentEventFrame(data)) {
      for (const listener of this.subagentEventListeners) listener(data.payload);
      return;
    }

    if (isRpcAvailableCommandsUpdateFrame(data)) {
      for (const listener of this.availableCommandsListeners) listener(data.commands);
      return;
    }

    if (isRpcPromptResultFrame(data)) {
      for (const listener of this.promptResultListeners) listener(data);
      return;
    }

    if (isAgentSessionEvent(data)) {
      for (const listener of this.sessionEventListeners) listener(data);
      if (isAgentEvent(data)) {
        for (const listener of this.eventListeners) listener(data);
      }
      return;
    }
  }

  private async handleHostToolCall(request: RpcHostToolCallRequest): Promise<void> {
    const handler = this.customTools.get(request.toolName) ?? this.customTools.get('*');
    if (!handler) {
      this.writeFrame({
        type: 'host_tool_result',
        id: request.id,
        result: { content: [{ type: 'text', text: `Host tool "${request.toolName}" is not registered` }] },
        isError: true,
      } satisfies RpcHostToolResult);
      return;
    }

    const controller = new AbortController();
    this.pendingHostToolCalls.set(request.id, controller);

    try {
      const result = await handler(request);
      if (controller.signal.aborted) return;

      const normalized: AgentToolResult =
        typeof result === 'string' ? { content: [{ type: 'text', text: result }] } : result;

      this.writeFrame({ type: 'host_tool_result', id: request.id, result: normalized } satisfies RpcHostToolResult);
    } catch (error) {
      if (controller.signal.aborted) return;
      this.writeFrame({
        type: 'host_tool_result',
        id: request.id,
        result: {
          content: [{ type: 'text', text: error instanceof Error ? error.message : String(error) }],
        },
        isError: true,
      } satisfies RpcHostToolResult);
    } finally {
      this.pendingHostToolCalls.delete(request.id);
    }
  }

  private async handleHostUriRequest(request: RpcHostUriRequest): Promise<void> {
    const scheme = request.url.split(':')[0];
    const handler = this.hostUriHandlers.get(scheme) ?? this.hostUriHandlers.get('*');

    if (!handler) {
      this.writeFrame({
        type: 'host_uri_result',
        id: request.id,
        isError: true,
        error: `No handler registered for URI scheme "${scheme}"`,
      } satisfies RpcHostUriResult);
      return;
    }

    try {
      const result = await handler(request);
      this.writeFrame(result);
    } catch (error) {
      this.writeFrame({
        type: 'host_uri_result',
        id: request.id,
        isError: true,
        error: error instanceof Error ? error.message : String(error),
      } satisfies RpcHostUriResult);
    }
  }

  private getData<T>(response: RpcResponse): T {
    if (!response.success) {
      throw new Error(response.error);
    }
    return (response as { data: unknown }).data as T;
  }
}
