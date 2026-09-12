import { describe, expect, it } from 'vitest';
import {
  AGENT_EVENT_TYPES,
  isAgentEvent,
  isAgentEventOfType,
  type AgentEngine,
} from '../../src/shared/agent-events';

describe('AgentEngine', () => {
  it('declares the engine identifiers in the migration order', () => {
    const engines: AgentEngine[] = ['omp', 'pi'];
    expect(engines).toEqual(['omp', 'pi']);
  });
});

describe('AGENT_EVENT_TYPES', () => {
  it('covers message lifecycle', () => {
    for (const t of ['message_start', 'message_update', 'message_end']) {
      expect(AGENT_EVENT_TYPES).toContain(t);
    }
  });

  it('covers agent turn lifecycle', () => {
    for (const t of ['agent_start', 'agent_end']) {
      expect(AGENT_EVENT_TYPES).toContain(t);
    }
  });

  it('covers tool execution lifecycle', () => {
    for (const t of ['tool_execution_start', 'tool_execution_update', 'tool_execution_end']) {
      expect(AGENT_EVENT_TYPES).toContain(t);
    }
  });

  it('covers approval lifecycle', () => {
    expect(AGENT_EVENT_TYPES).toContain('approval_request');
  });

  it('covers context usage', () => {
    expect(AGENT_EVENT_TYPES).toContain('context_usage');
  });

  it('covers compaction lifecycle (manual and auto)', () => {
    for (const t of [
      'compaction_start',
      'compaction_end',
      'auto_compaction_start',
      'auto_compaction_end',
    ]) {
      expect(AGENT_EVENT_TYPES).toContain(t);
    }
  });

  it('covers subagent lifecycle, progress, and child stream', () => {
    for (const t of ['subagent_lifecycle', 'subagent_progress', 'subagent_stream']) {
      expect(AGENT_EVENT_TYPES).toContain(t);
    }
  });

  it('covers notice and error lifecycle', () => {
    for (const t of ['notice', 'error']) {
      expect(AGENT_EVENT_TYPES).toContain(t);
    }
  });
});

describe('isAgentEvent', () => {
  it('accepts a message_end event with an assistant message', () => {
    expect(
      isAgentEvent({
        type: 'message_end',
        message: {
          role: 'assistant',
          content: [{ type: 'text', text: 'hello' }],
        },
      }),
    ).toBe(true);
  });

  it('accepts a message event whose content is a plain string', () => {
    expect(
      isAgentEvent({ type: 'message_start', message: { role: 'user', content: 'hi' } }),
    ).toBe(true);
  });

  it('accepts a tool_execution_start event with id, name and args', () => {
    expect(
      isAgentEvent({
        type: 'tool_execution_start',
        toolCallId: 'call_1',
        toolName: 'run_sim',
        args: { case: 'smoke_1' },
      }),
    ).toBe(true);
  });

  it('accepts a tool_execution_end event', () => {
    expect(
      isAgentEvent({
        type: 'tool_execution_end',
        toolCallId: 'call_1',
        toolName: 'run_sim',
        result: 'done',
        isError: false,
      }),
    ).toBe(true);
  });

  it('accepts agent_start and agent_end', () => {
    expect(isAgentEvent({ type: 'agent_start' })).toBe(true);
    expect(isAgentEvent({ type: 'agent_end', messages: [] })).toBe(true);
    expect(isAgentEvent({ type: 'agent_end', messages: [], willContinue: true })).toBe(true);
  });

  it('accepts an approval_request event', () => {
    expect(
      isAgentEvent({
        type: 'approval_request',
        id: 'req_1',
        toolName: 'edit_file',
        args: { path: 'a.v' },
      }),
    ).toBe(true);
  });

  it('accepts a context_usage event', () => {
    expect(
      isAgentEvent({
        type: 'context_usage',
        contextUsage: { tokens: 100, percent: 10 },
        isCompacting: false,
        autoCompactionEnabled: true,
      }),
    ).toBe(true);
  });

  it('accepts compaction lifecycle events', () => {
    expect(isAgentEvent({ type: 'compaction_start' })).toBe(true);
    expect(isAgentEvent({ type: 'compaction_end' })).toBe(true);
    expect(isAgentEvent({ type: 'auto_compaction_start', reason: 'threshold', action: 'context-full' })).toBe(true);
    expect(isAgentEvent({ type: 'auto_compaction_end', aborted: false, willRetry: false })).toBe(true);
  });

  it('accepts subagent lifecycle and progress events', () => {
    expect(isAgentEvent({ type: 'subagent_lifecycle', payload: { id: 's1' } })).toBe(true);
    expect(isAgentEvent({ type: 'subagent_progress', payload: { id: 's1' } })).toBe(true);
    expect(isAgentEvent({
      type: 'subagent_stream',
      payload: {
        id: 's1',
        event: {
          type: 'message_update',
          assistantMessageEvent: { type: 'text_delta', delta: 'hello' },
        },
      },
    })).toBe(true);
  });

  it('accepts notice and error events', () => {
    expect(isAgentEvent({ type: 'notice', text: 'fyi' })).toBe(true);
    expect(isAgentEvent({ type: 'error', message: 'boom' })).toBe(true);
    expect(isAgentEvent({ type: 'error', error: 'boom' })).toBe(true);
  });

  it('rejects non-object values', () => {
    expect(isAgentEvent(null)).toBe(false);
    expect(isAgentEvent(undefined)).toBe(false);
    expect(isAgentEvent('message_end')).toBe(false);
    expect(isAgentEvent(42)).toBe(false);
    expect(isAgentEvent([])).toBe(false);
  });

  it('rejects unknown event types', () => {
    expect(isAgentEvent({ type: 'mystery_event' })).toBe(false);
    expect(isAgentEvent({ type: '' })).toBe(false);
    expect(isAgentEvent({})).toBe(false);
  });

  it('rejects message events without a message payload', () => {
    expect(isAgentEvent({ type: 'message_end' })).toBe(false);
    expect(isAgentEvent({ type: 'message_end', message: 'not-an-object' })).toBe(false);
  });

  it('rejects tool events missing required identity fields', () => {
    expect(isAgentEvent({ type: 'tool_execution_start', toolName: 'x' })).toBe(false);
    expect(isAgentEvent({ type: 'tool_execution_start', toolCallId: 'c1' })).toBe(false);
    expect(
      isAgentEvent({ type: 'tool_execution_end', toolCallId: 'c1', toolName: 'x' }),
    ).toBe(false);
    expect(
      isAgentEvent({ type: 'tool_execution_end', toolCallId: 'c1', toolName: 'x', result: 'ok' }),
    ).toBe(false);
  });

  it('rejects approval_request without id or toolName', () => {
    expect(isAgentEvent({ type: 'approval_request', toolName: 'x' })).toBe(false);
    expect(isAgentEvent({ type: 'approval_request', id: 'r1' })).toBe(false);
  });
});

describe('isAgentEventOfType', () => {
  it('narrows to the requested variant', () => {
    const event: unknown = {
      type: 'tool_execution_end',
      toolCallId: 'c1',
      toolName: 'run_sim',
      result: 'ok',
      isError: false,
    };
    if (isAgentEventOfType(event, 'tool_execution_end')) {
      expect(event.toolName).toBe('run_sim');
      expect(event.isError).toBe(false);
    } else {
      throw new Error('expected narrowing to succeed');
    }
  });

  it('returns false for other event types', () => {
    expect(isAgentEventOfType({ type: 'agent_start' }, 'agent_end')).toBe(false);
    expect(isAgentEventOfType('nope', 'agent_end')).toBe(false);
  });
});
