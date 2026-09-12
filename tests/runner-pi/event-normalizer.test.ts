import { describe, it, expect } from 'vitest';
import { normalizePiEvent } from '../../runner-pi/event-normalizer';
import { isAgentEvent, AGENT_EVENT_TYPES } from '../../src/shared/agent-events';

/**
 * pi 原生事件 → Agent Event Contract 归一化测试。
 *
 * 事件形状依据 pi-coding-agent 0.85.1 的类型声明（pi-agent-core AgentEvent
 * 与 AgentSession 扩展事件），这是 issue 03 的归一化边界：renderer 不依赖
 * pi 原生事件名。
 */

const assistantMessage = {
  role: 'assistant',
  content: [{ type: 'text', text: '你好' }],
  api: 'openai-completions',
  provider: 'socverify-openai-compatible',
  model: 'test-model',
  usage: {},
  stopReason: 'stop',
  timestamp: 0,
};

describe('normalizePiEvent — 核心 Agent 事件透传', () => {
  it('agent_start 原样透传', () => {
    expect(normalizePiEvent({ type: 'agent_start' })).toEqual([{ type: 'agent_start' }]);
  });

  it('message_start / message_end 携带 message 透传', () => {
    for (const type of ['message_start', 'message_end']) {
      const event = { type, message: assistantMessage };
      const out = normalizePiEvent(event);
      expect(out).toEqual([event]);
    }
  });

  it('message_update 保留 message 快照与 assistantMessageEvent', () => {
    const event = {
      type: 'message_update',
      message: assistantMessage,
      assistantMessageEvent: { type: 'text_delta', delta: '你好' },
    };
    expect(normalizePiEvent(event)).toEqual([event]);
  });

  it('tool_execution_start / update 透传', () => {
    const start = { type: 'tool_execution_start', toolCallId: 't1', toolName: 'read', args: { path: 'a' } };
    const update = { type: 'tool_execution_update', toolCallId: 't1', toolName: 'read', args: {}, partialResult: 'x' };
    expect(normalizePiEvent(start)).toEqual([start]);
    expect(normalizePiEvent(update)).toEqual([update]);
  });

  it('tool_execution_end 透传且 isError 归一为布尔', () => {
    const ok = { type: 'tool_execution_end', toolCallId: 't1', toolName: 'read', result: 'ok', isError: false };
    const bad = { type: 'tool_execution_end', toolCallId: 't2', toolName: 'bash', result: 'boom', isError: true };
    expect(normalizePiEvent(ok)).toEqual([ok]);
    expect(normalizePiEvent(bad)).toEqual([bad]);
    // isError 缺失时归一为 false（契约守卫要求布尔）
    const missing = { type: 'tool_execution_end', toolCallId: 't3', toolName: 'read', result: 'x' };
    expect(normalizePiEvent(missing)).toEqual([
      { type: 'tool_execution_end', toolCallId: 't3', toolName: 'read', result: 'x', isError: false },
    ]);
  });

  it('message_end 的 errorMessage 保留（renderer 错误展示依赖该字段）', () => {
    const event = {
      type: 'message_end',
      message: { ...assistantMessage, stopReason: 'error', errorMessage: 'api down' },
    };
    expect(normalizePiEvent(event)).toEqual([event]);
  });
});

describe('normalizePiEvent — agent_end 语义映射', () => {
  it('willRetry=true 映射为 willContinue=true', () => {
    const event = { type: 'agent_end', messages: [assistantMessage], willRetry: true };
    expect(normalizePiEvent(event)).toEqual([
      { type: 'agent_end', messages: [assistantMessage], willContinue: true },
    ]);
  });

  it('willRetry=false 映射为 willContinue=false', () => {
    const event = { type: 'agent_end', messages: [], willRetry: false };
    expect(normalizePiEvent(event)).toEqual([
      { type: 'agent_end', messages: [], willContinue: false },
    ]);
  });
});

describe('normalizePiEvent — 压缩事件按 reason 分流', () => {
  it('reason=manual → compaction_start / compaction_end', () => {
    expect(normalizePiEvent({ type: 'compaction_start', reason: 'manual' })).toEqual([
      { type: 'compaction_start' },
    ]);
    const end = { type: 'compaction_end', reason: 'manual', result: { messages: [] }, aborted: false, willRetry: false };
    expect(normalizePiEvent(end)).toEqual([{ type: 'compaction_end' }]);
  });

  it('reason=threshold/overflow → auto_compaction_start / auto_compaction_end（带原因与结果）', () => {
    for (const reason of ['threshold', 'overflow']) {
      expect(normalizePiEvent({ type: 'compaction_start', reason })).toEqual([
        { type: 'auto_compaction_start', reason },
      ]);
    }
    const end = {
      type: 'compaction_end',
      reason: 'threshold',
      result: { messages: [] },
      aborted: false,
      willRetry: false,
      errorMessage: undefined,
    };
    const out = normalizePiEvent(end);
    expect(out).toEqual([
      { type: 'auto_compaction_end', result: { messages: [] }, aborted: false, willRetry: false },
    ]);
  });

  it('compaction_end 中止时保留 aborted 与 errorMessage', () => {
    const end = {
      type: 'compaction_end',
      reason: 'overflow',
      result: undefined,
      aborted: true,
      willRetry: true,
      errorMessage: 'compaction failed',
    };
    expect(normalizePiEvent(end)).toEqual([
      { type: 'auto_compaction_end', aborted: true, willRetry: true, errorMessage: 'compaction failed' },
    ]);
  });
});

describe('normalizePiEvent — 重试事件映射为 notice', () => {
  it('auto_retry_start → notice（含尝试次数与错误信息）', () => {
    const out = normalizePiEvent({
      type: 'auto_retry_start',
      attempt: 1,
      maxAttempts: 3,
      delayMs: 500,
      errorMessage: 'rate limited',
    });
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({ type: 'notice' });
    expect(JSON.stringify(out[0])).toContain('rate limited');
    expect(JSON.stringify(out[0])).toContain('1');
  });

  it('auto_retry_end 成功 → 丢弃（错误从未展示，无需报喜）', () => {
    const out = normalizePiEvent({ type: 'auto_retry_end', success: true, attempt: 2 });
    expect(out).toEqual([]);
  });

  it('auto_retry_end 失败 → notice（携带 finalError）', () => {
    const out = normalizePiEvent({ type: 'auto_retry_end', success: false, attempt: 3, finalError: 'overloaded' });
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({ type: 'notice' });
    expect(JSON.stringify(out[0])).toContain('overloaded');
  });

  it('summarization_retry_scheduled → notice；其余 summarization_retry_* 丢弃', () => {
    const scheduled = normalizePiEvent({
      type: 'summarization_retry_scheduled',
      attempt: 1,
      maxAttempts: 2,
      delayMs: 100,
      errorMessage: 'too long',
    });
    expect(scheduled).toHaveLength(1);
    expect(scheduled[0]).toMatchObject({ type: 'notice' });

    expect(normalizePiEvent({ type: 'summarization_retry_attempt_start', source: 'branchSummary' })).toEqual([]);
    expect(normalizePiEvent({ type: 'summarization_retry_finished' })).toEqual([]);
  });
});

describe('normalizePiEvent — 契约外事件丢弃', () => {
  it('session 专属事件不进入契约流', () => {
    const dropped = [
      { type: 'agent_settled' },
      { type: 'queue_update', steering: [], followUp: [] },
      { type: 'entry_appended', entry: {} },
      { type: 'session_info_changed', name: 'x' },
      { type: 'thinking_level_changed', level: 'medium' },
      { type: 'bash_execution_update', id: 'b1', delta: 'ls' },
      { type: 'turn_start' },
      { type: 'turn_end', message: assistantMessage, toolResults: [] },
    ];
    for (const event of dropped) {
      expect(normalizePiEvent(event)).toEqual([]);
    }
  });

  it('非对象与未知 type 丢弃', () => {
    expect(normalizePiEvent(null)).toEqual([]);
    expect(normalizePiEvent('text')).toEqual([]);
    expect(normalizePiEvent({ type: 'unknown_future_event' })).toEqual([]);
    expect(normalizePiEvent({})).toEqual([]);
  });
});

describe('normalizePiEvent — 契约不变式', () => {
  it('所有非丢弃输出都通过 isAgentEvent 守卫', () => {
    const piEvents = [
      { type: 'agent_start' },
      { type: 'agent_end', messages: [assistantMessage], willRetry: false },
      { type: 'message_start', message: assistantMessage },
      { type: 'message_update', message: assistantMessage, assistantMessageEvent: { type: 'text_delta', delta: 'a' } },
      { type: 'message_end', message: assistantMessage },
      { type: 'tool_execution_start', toolCallId: 't1', toolName: 'read', args: {} },
      { type: 'tool_execution_update', toolCallId: 't1', toolName: 'read', args: {}, partialResult: 'x' },
      { type: 'tool_execution_end', toolCallId: 't1', toolName: 'read', result: 'ok', isError: false },
      { type: 'compaction_start', reason: 'manual' },
      { type: 'compaction_start', reason: 'threshold' },
      { type: 'compaction_end', reason: 'manual', result: {}, aborted: false, willRetry: false },
      { type: 'compaction_end', reason: 'overflow', result: {}, aborted: true, willRetry: true, errorMessage: 'e' },
      { type: 'auto_retry_start', attempt: 1, maxAttempts: 3, delayMs: 0, errorMessage: 'x' },
      { type: 'auto_retry_end', success: true, attempt: 1 },
    ];
    for (const event of piEvents) {
      for (const mapped of normalizePiEvent(event)) {
        expect(isAgentEvent(mapped)).toBe(true);
        expect(AGENT_EVENT_TYPES).toContain((mapped as { type: string }).type);
      }
    }
  });
});
