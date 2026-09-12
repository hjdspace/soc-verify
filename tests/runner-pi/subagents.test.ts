/**
 * runner-pi subagents.ts —— pi-subagents 扩展集成（issue 05）。
 *
 * 覆盖：事件归一化（pi-subagents 通道 → host SubagentFrame 契约）、
 * 终态映射、Token usage 提取（父子归属）、审批继承 → capability ceiling、
 * RPC stop 帧（取消传播）、活动 run 跟踪。
 */
import { describe, expect, it } from 'vitest';
import {
  buildRpcStopRequest,
  extractSubagentUsage,
  mapTerminalStatus,
  normalizeChildStreamFrame,
  normalizeForegroundProgressFrames,
  normalizeSubagentFrame,
  RPC_REPLY_CHANNEL_PREFIX,
  RPC_REQUEST_CHANNEL,
  resolveSubagentCeiling,
  SUBAGENT_DELEGATION_RESPONSE_CHANNEL,
  SUBAGENT_DELEGATION_UPDATE_CHANNEL,
  SUBAGENT_ASYNC_STARTED_CHANNEL,
  SUBAGENT_FOREGROUND_COMPLETE_CHANNEL,
  trackSubagentRun,
  type SubagentRunRegistry,
} from '../../runner-pi/subagents';

// ─── 事件归一化 ─────────────────────────────────────────

describe('normalizeSubagentFrame', () => {
  it('async-started 归一为 subagent_lifecycle running，携带父子归属与 artifacts 目录', () => {
    const frames = normalizeSubagentFrame(
      SUBAGENT_ASYNC_STARTED_CHANNEL,
      {
        id: 'run-abc',
        agent: 'coverage-analyzer',
        task: '分析覆盖率缺口',
        mode: 'single',
        asyncDir: '/tmp/pi/async/run-abc',
        sessionId: 'child-session-1',
      },
      { parentSessionId: 'pi-session-0001' },
    );

    expect(frames).toHaveLength(1);
    expect(frames[0]).toMatchObject({
      type: 'subagent_lifecycle',
      payload: {
        id: 'run-abc',
        status: 'running',
        agent: 'coverage-analyzer',
        description: '分析覆盖率缺口',
        parentSessionId: 'pi-session-0001',
        runDir: '/tmp/pi/async/run-abc',
      },
    });
  });

  it('async-started 缺少 id 时不产出帧（无法归属的子代理不透传）', () => {
    const frames = normalizeSubagentFrame(
      SUBAGENT_ASYNC_STARTED_CHANNEL,
      { agent: 'x' },
      { parentSessionId: 'p' },
    );
    expect(frames).toEqual([]);
  });

  it('delegation update 归一为 subagent_progress（tokens/当前工具/输出窗口）', () => {
    const frames = normalizeSubagentFrame(
      SUBAGENT_DELEGATION_UPDATE_CHANNEL,
      {
        requestId: 'req-1',
        ownerRunId: 'run-abc',
        nodeId: 'node-1',
        runId: 'run-abc',
        currentTool: 'read',
        currentToolArgs: '{"path":"a.ts"}',
        recentOutputLines: ['line-1', 'line-2'],
        toolCount: 4,
        tokens: 320,
      },
      { parentSessionId: 'p' },
    );

    expect(frames).toHaveLength(1);
    expect(frames[0]?.type).toBe('subagent_progress');
    const payload = (frames[0] as { payload: Record<string, unknown> }).payload;
    expect(payload).toMatchObject({
      id: 'run-abc',
      parentSessionId: 'p',
      progress: {
        tokens: 320,
        currentTool: 'read',
        currentToolArgs: '{"path":"a.ts"}',
        recentOutput: ['line-1', 'line-2'],
        toolCount: 4,
      },
    });
  });

  it('delegation response completed 归一为 lifecycle 终态并携带 usage（Token 归属）', () => {
    const frames = normalizeSubagentFrame(
      SUBAGENT_DELEGATION_RESPONSE_CHANNEL,
      {
        requestId: 'req-1',
        ownerRunId: 'run-abc',
        nodeId: 'node-1',
        status: 'completed',
        runId: 'run-abc',
        agent: 'coverage-analyzer',
        result: { kind: 'text', text: 'done' },
        usage: {
          input: 100,
          output: 50,
          cacheRead: 10,
          cacheWrite: 5,
          cost: 0.01,
          turns: 3,
          toolCalls: 7,
          durationMs: 1200,
        },
      },
      { parentSessionId: 'pi-session-0001' },
    );

    expect(frames).toHaveLength(1);
    expect(frames[0]).toMatchObject({
      type: 'subagent_lifecycle',
      payload: {
        id: 'run-abc',
        status: 'completed',
        agent: 'coverage-analyzer',
        parentSessionId: 'pi-session-0001',
        usage: {
          input: 100,
          output: 50,
          cacheRead: 10,
          cacheWrite: 5,
          costUsd: 0.01,
          turns: 3,
          toolCalls: 7,
          durationMs: 1200,
        },
      },
    });
  });

  it('async-complete 使用 pi-subagents 的 success/state 字段判定完成状态', () => {
    const frames = normalizeSubagentFrame(
      'subagent:async-complete',
      {
        id: 'run-async-1',
        runId: 'run-async-1',
        agent: 'reviewer',
        success: true,
        state: 'complete',
      },
      { parentSessionId: 'p', parentToolCallId: 'call-1' },
    );

    expect(frames[0]).toMatchObject({
      type: 'subagent_lifecycle',
      payload: {
        id: 'run-async-1',
        status: 'completed',
        parentToolCallId: 'call-1',
      },
    });
  });

  it('foreground-complete 使用 child id 和 taskIndex 保留同一 run 内的子代理身份', () => {
    const frames = normalizeSubagentFrame(
      SUBAGENT_FOREGROUND_COMPLETE_CHANNEL,
      {
        id: 'run-foreground-1:2',
        runId: 'run-foreground-1',
        taskIndex: 2,
        agent: 'reviewer',
        success: true,
        state: 'complete',
      },
      { parentSessionId: 'p', parentToolCallId: 'call-foreground-1' },
    );

    expect(frames[0]).toMatchObject({
      type: 'subagent_lifecycle',
      payload: {
        id: 'run-foreground-1:2',
        index: 2,
        status: 'completed',
        parentToolCallId: 'call-foreground-1',
      },
    });
  });

  it('delegation response 失败/超时归一为 failed，显式携带阻断原因', () => {
    for (const status of ['failed', 'timed_out', 'tool_budget_exhausted'] as const) {
      const frames = normalizeSubagentFrame(
        SUBAGENT_DELEGATION_RESPONSE_CHANNEL,
        { requestId: 'r', ownerRunId: 'run-1', nodeId: 'n', status, error: 'boom' },
        { parentSessionId: 'p' },
      );
      expect(frames[0]).toMatchObject({
        type: 'subagent_lifecycle',
        // 终态无 runId 时以 requestId 关联（ownerRunId 是父 run，透传用于父子链路）
        payload: { id: 'r', status: 'failed', blockedReason: 'boom', ownerRunId: 'run-1' },
      });
    }
  });

  it('delegation response cancelled/interrupted 归一为 aborted（取消传播可见）', () => {
    for (const status of ['cancelled', 'interrupted'] as const) {
      const frames = normalizeSubagentFrame(
        SUBAGENT_DELEGATION_RESPONSE_CHANNEL,
        { requestId: 'r', ownerRunId: 'run-1', nodeId: 'n', status },
        { parentSessionId: 'p' },
      );
      expect(frames[0]).toMatchObject({
        type: 'subagent_lifecycle',
        payload: { id: 'r', status: 'aborted', ownerRunId: 'run-1' },
      });
    }
  });

  it('delegation response invalid_request（能力不足）归一为 failed 并显式报告阻断原因', () => {
    const frames = normalizeSubagentFrame(
      SUBAGENT_DELEGATION_RESPONSE_CHANNEL,
      { requestId: 'r', status: 'invalid_request', error: 'missing agent definition' },
      { parentSessionId: 'p' },
    );
    expect(frames[0]).toMatchObject({
      type: 'subagent_lifecycle',
      payload: { status: 'failed', blockedReason: 'missing agent definition' },
    });
  });

  it('child-status stopping/stopped 归一为 aborted（子会话取消事件）', () => {
    for (const status of ['stopping', 'stopped'] as const) {
      const frames = normalizeSubagentFrame(
        'subagent:child-status',
        { runId: 'run-1', childId: 'c1', status, ts: 1 },
        { parentSessionId: 'p' },
      );
      expect(frames[0]).toMatchObject({
        type: 'subagent_lifecycle',
        payload: { id: 'run-1', status: 'aborted' },
      });    }
  });

  it('未知通道一律丢弃（pi-subagents 原生事件名不越出 runner）', () => {
    expect(
      normalizeSubagentFrame('subagent:some-unknown-channel', { foo: 1 }, { parentSessionId: 'p' }),
    ).toEqual([]);
  });
});

// ─── 终态映射与 usage 提取 ──────────────────────────────

describe('mapTerminalStatus', () => {
  it('completed → completed；cancelled/interrupted → aborted；其余 → failed', () => {
    expect(mapTerminalStatus('completed')).toBe('completed');
    expect(mapTerminalStatus('cancelled')).toBe('aborted');
    expect(mapTerminalStatus('interrupted')).toBe('aborted');
    expect(mapTerminalStatus('failed')).toBe('failed');
    expect(mapTerminalStatus('timed_out')).toBe('failed');
    expect(mapTerminalStatus('unavailable_context')).toBe('failed');
  });
});

describe('extractSubagentUsage', () => {
  it('从 delegation usage 提取完整用量并归一 cost → costUsd', () => {
    expect(
      extractSubagentUsage({
        input: 1,
        output: 2,
        cacheRead: 3,
        cacheWrite: 4,
        cost: 0.5,
        turns: 2,
        toolCalls: 5,
        durationMs: 100,
      }),
    ).toEqual({
      input: 1,
      output: 2,
      cacheRead: 3,
      cacheWrite: 4,
      costUsd: 0.5,
      turns: 2,
      toolCalls: 5,
      durationMs: 100,
    });
  });

  it('缺字段安全兜底为 0，非对象返回 null', () => {
    expect(extractSubagentUsage({ input: 1 })).toEqual({
      input: 1,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      costUsd: 0,
      turns: 0,
      toolCalls: 0,
      durationMs: 0,
    });
    expect(extractSubagentUsage(null)).toBeNull();
    expect(extractSubagentUsage('nope')).toBeNull();
  });
});

// ─── 审批继承 → capability ceiling ──────────────────────

describe('resolveSubagentCeiling', () => {
  it('always-ask / write 下子会话禁用 extension 工具面（审批边界继承）', () => {
    expect(resolveSubagentCeiling('always-ask')).toEqual({ denyExtensions: true });
    expect(resolveSubagentCeiling('write')).toEqual({ denyExtensions: true });
  });

  it('yolo 不额外收紧（信任边界独立于审批模式，由 issue 04 流程保证）', () => {
    expect(resolveSubagentCeiling('yolo')).toBeNull();
  });
});

// ─── RPC stop（取消传播 host 出口）──────────────────────

describe('buildRpcStopRequest', () => {
  it('构造 subagents:rpc:v1:request stop 信封并给出对应 reply 通道', () => {
    const { envelope, replyChannel } = buildRpcStopRequest('req-x', { runId: 'run-1' });
    expect(envelope).toMatchObject({
      version: 1,
      requestId: 'req-x',
      method: 'stop',
      params: { runId: 'run-1' },
      source: { extension: 'socverify-runner' },
    });
    expect(replyChannel).toBe(`${RPC_REPLY_CHANNEL_PREFIX}req-x`);
    expect(RPC_REQUEST_CHANNEL).toBe('subagents:rpc:v1:request');
  });
});

// ─── 活动 run 跟踪 ──────────────────────────────────────

describe('trackSubagentRun', () => {
  it('started 登记活动 run，终态移除；destroy 时可枚举待取消 run', () => {
    const registry: SubagentRunRegistry = trackSubagentRun.create();

    trackSubagentRun.onStart(registry, {
      channel: SUBAGENT_ASYNC_STARTED_CHANNEL,
      payload: { id: 'run-1', agent: 'a' },
    });
    trackSubagentRun.onStart(registry, {
      channel: SUBAGENT_ASYNC_STARTED_CHANNEL,
      payload: { id: 'run-2', agent: 'b', asyncDir: '/tmp/async/run-2' },
    });
    expect(trackSubagentRun.activeRunIds(registry).sort()).toEqual(['run-1', 'run-2']);

    trackSubagentRun.onTerminal(registry, 'run-1');
    expect(trackSubagentRun.activeRunIds(registry)).toEqual(['run-2']);
  });

  it('非 async-started 通道不登记', () => {
    const registry: SubagentRunRegistry = trackSubagentRun.create();
    trackSubagentRun.onStart(registry, {
      channel: SUBAGENT_DELEGATION_UPDATE_CHANNEL,
      payload: { id: 'run-x' },
    });
    expect(trackSubagentRun.activeRunIds(registry)).toEqual([]);
  });
});

// ─── 前台工具进度归一化（tool_execution_update 路径）─────

describe('normalizeForegroundProgressFrames', () => {
  it('单代理：帧 id 与派遣占位（toolCallId）严格一致，携带流式进度字段', () => {
    const frames = normalizeForegroundProgressFrames(
      'tc_sub_1',
      [
        {
          index: 0,
          agent: 'scout',
          tokens: 1250,
          currentTool: 'read',
          currentToolArgs: '{"path":"src/a.ts"}',
          recentOutput: ['reading src/a.ts', '  ', 'found 3 symbols'],
          toolCount: 3,
          turnCount: 2,
        },
      ],
      { parentSessionId: 'pi-session-1', parentToolCallId: 'tc_sub_1' },
    );

    expect(frames).toHaveLength(1);
    expect(frames[0]?.type).toBe('subagent_progress');
    const payload = (frames[0] as { payload: Record<string, unknown> }).payload;
    // id 必须等于 toolCallId：renderer 派遣占位以此作 id，store 直接流式更新
    expect(payload).toMatchObject({
      id: 'tc_sub_1',
      parentToolCallId: 'tc_sub_1',
      parentSessionId: 'pi-session-1',
      index: 0,
      agent: 'scout',
      progress: {
        tokens: 1250,
        currentTool: 'read',
        currentToolArgs: '{"path":"src/a.ts"}',
        recentOutput: ['reading src/a.ts', 'found 3 symbols'],
        toolCount: 3,
        requests: 2,
      },
    });
  });

  it('多代理：按 index 派生子 id（toolCallId:index）', () => {
    const frames = normalizeForegroundProgressFrames(
      'tc_sub_2',
      [
        { index: 0, agent: 'scout', tokens: 10 },
        { index: 1, agent: 'reviewer', tokens: 20 },
      ],
      { parentSessionId: 'p', parentToolCallId: 'tc_sub_2' },
    );

    expect(frames).toHaveLength(2);
    const ids = frames.map((f) => (f.payload as Record<string, unknown>).id);
    expect(ids).toEqual(['tc_sub_2:0', 'tc_sub_2:1']);
  });

  it('progress.task 已被 redact，不透传为任务概要；空 progressList 返回空', () => {
    const frames = normalizeForegroundProgressFrames(
      'tc_sub_3',
      [{ index: 0, agent: 'scout', task: '[redacted]', tokens: 5 }],
      { parentSessionId: 'p' },
    );
    const payload = (frames[0] as { payload: Record<string, unknown> }).payload;
    expect(payload.assignment).toBeUndefined();
    expect(payload.description).toBeUndefined();
    expect('task' in payload).toBe(false);

    expect(normalizeForegroundProgressFrames('tc', [], { parentSessionId: 'p' })).toEqual([]);
  });

  it('非对象条目跳过；缺 turnCount 时不发送会覆盖旧值的 requests', () => {
    const frames = normalizeForegroundProgressFrames(
      'tc_sub_4',
      ['not-an-object', null, { tokens: 7 }],
      { parentSessionId: 'p' },
    );
    expect(frames).toHaveLength(1);
    const payload = (frames[0] as { payload: Record<string, unknown> }).payload;
    expect(payload.progress).toMatchObject({ tokens: 7 });
    expect(payload.progress).not.toHaveProperty('requests');
  });
});

describe('normalizeChildStreamFrame', () => {
  it('preserves the actual child user prompt for the drawer', () => {
    expect(normalizeChildStreamFrame('child', {
      type: 'message_start', message: { role: 'user', content: [{ type: 'text', text: 'Task: inspect router' }] },
    }, { parentSessionId: 'parent' })).toEqual([expect.objectContaining({
      type: 'subagent_stream', payload: expect.objectContaining({ event: expect.objectContaining({
        message: expect.objectContaining({ role: 'user' }),
      }) }),
    })]);
  });
  it('projects assistant deltas and tool lifecycle events into an isolated child stream', () => {
    expect(normalizeChildStreamFrame(
      'call-1:1',
      {
        type: 'message_update',
        message: { private: 'partial snapshot must not cross the boundary' },
        assistantMessageEvent: { type: 'thinking_delta', delta: 'checking', partial: {} },
      },
      { parentSessionId: 'parent-1', parentToolCallId: 'call-1', index: 1, agent: 'reviewer' },
    )).toEqual([{
      type: 'subagent_stream',
      payload: {
        id: 'call-1:1',
        index: 1,
        agent: 'reviewer',
        parentSessionId: 'parent-1',
        parentToolCallId: 'call-1',
        event: {
          type: 'message_update',
          assistantMessageEvent: { type: 'thinking_delta', delta: 'checking' },
        },
      },
    }]);
  });

  it('drops non-assistant messages and private child events', () => {
    expect(normalizeChildStreamFrame('child', {
      type: 'message_end',
      message: { role: 'toolResult', content: [] },
    }, { parentSessionId: 'parent' })).toEqual([]);
    expect(normalizeChildStreamFrame('child', {
      type: 'agent_settled',
    }, { parentSessionId: 'parent' })).toEqual([]);
  });
});
