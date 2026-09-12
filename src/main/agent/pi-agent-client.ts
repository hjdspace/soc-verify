/**
 * PiAgentClient — IAgentClient implementation driving the pi runner
 * (runner-pi/index.ts, plain Node script speaking the existing JSONL
 * command/event protocol).
 *
 * 复用 AgentClient 的 JSONL 客户端机制（ready 握手、请求/响应关联、
 * tool_call/approval 桥、事件转发、进程树清理），仅覆盖启动方式：
 * 以 Node（ELECTRON_RUN_AS_NODE=1 复用 Electron 内置 Node）直接运行
 * runner 脚本，不再依赖 Bun compile 或 omp native addon。
 *
 * 引擎差异全部封装在 runner 进程内（pi 原生事件在 runner 侧归一化），
 * 因此客户端命令集与 omp 客户端保持一致。
 */

import type { AgentClientOptions } from './types';
import { AgentClient } from './agent-client';
import type { AgentRegenerateResult } from './agent-contract';
import type { AgentEngine } from '@shared/agent-events';

export class PiAgentClient extends AgentClient {
  /** Engine identity — this client drives the upstream pi coding agent. */
  readonly engine: AgentEngine = 'pi';

  constructor(options: AgentClientOptions) {
    super({
      ...options,
      // runner-pi 以普通 Node 脚本运行；Electron 主进程下 process.execPath
      // 是 Electron 二进制，必须置 ELECTRON_RUN_AS_NODE=1 才能把它当 Node
      // 用。显式传入的 options.env 优先（允许部署/测试场景覆盖）。
      env: { ELECTRON_RUN_AS_NODE: '1', ...(options.env ?? {}) },
    });
  }

  protected override resolveSpawn(): { cmd: string; args: string[] } {
    if (!this.options.runnerPath) {
      throw new Error('PiAgentClient requires runnerPath pointing at runner-pi/index.ts');
    }
    return { cmd: this.options.nodePath ?? process.execPath, args: [this.options.runnerPath] };
  }

  /**
   * Regenerate the last assistant response（issue 08）。
   *
   * runner-pi 分支到最后一条 user message 之前：持久化 session 用
   * createBranchedSession/newSession 产生新的 engineSessionId（旧文件保留
   * 可回看），非持久化退化为同文件 branch（id 不变）。response 在 re-prompt
   * 之前发出，携带分支后的 engineSessionId 供 host 更新持久化记录。
   */
  override async regenerate(): Promise<AgentRegenerateResult> {
    const response = await this.send({ type: 'regenerate' }, 60_000);
    const data = this.getData<{ engineSessionId: string }>(response);
    return { engineSessionId: data.engineSessionId };
  }
}
