import { describe, it, expect } from 'vitest';
import {
  isRecord,
  isAgentReadyFrame,
  isRpcResponse,
  isRpcHostToolCallRequest,
  isRpcHostToolCancelRequest,
  isRpcHostUriRequest,
  isRpcHostUriCancelRequest,
  isRpcExtensionUiRequest,
  isRpcSubagentLifecycleFrame,
  isRpcSubagentProgressFrame,
  isRpcSubagentEventFrame,
  isRpcAvailableCommandsUpdateFrame,
  isRpcPromptResultFrame,
  isAgentEvent,
  isAgentSessionEvent,
  AGENT_EVENT_TYPES,
  SESSION_EVENT_TYPES,
} from '../../src/main/host/types';

describe('Type guards', () => {
  describe('isRecord', () => {
    it('returns true for plain objects', () => {
      expect(isRecord({})).toBe(true);
      expect(isRecord({ a: 1 })).toBe(true);
    });

    it('returns false for non-objects', () => {
      expect(isRecord(null)).toBe(false);
      expect(isRecord(undefined)).toBe(false);
      expect(isRecord('string')).toBe(false);
      expect(isRecord(42)).toBe(false);
      expect(isRecord(true)).toBe(false);
    });

    it('returns false for arrays', () => {
      expect(isRecord([])).toBe(false);
      expect(isRecord([1, 2])).toBe(false);
    });
  });

  describe('isAgentReadyFrame', () => {
    it('returns true for { type: "ready" }', () => {
      expect(isAgentReadyFrame({ type: 'ready' })).toBe(true);
    });

    it('returns false for other types', () => {
      expect(isAgentReadyFrame({ type: 'response' })).toBe(false);
      expect(isAgentReadyFrame({ type: 'prompt' })).toBe(false);
      expect(isAgentReadyFrame(null)).toBe(false);
    });
  });

  describe('isRpcResponse', () => {
    it('returns true for success response', () => {
      expect(isRpcResponse({ type: 'response', command: 'prompt', success: true })).toBe(true);
    });

    it('returns true for success response with id and data', () => {
      expect(isRpcResponse({ id: '1', type: 'response', command: 'get_state', success: true, data: {} })).toBe(true);
    });

    it('returns true for error response with error string', () => {
      expect(isRpcResponse({ type: 'response', command: 'prompt', success: false, error: 'failed' })).toBe(true);
    });

    it('returns false for error response without error string', () => {
      expect(isRpcResponse({ type: 'response', command: 'prompt', success: false })).toBe(false);
    });

    it('returns false for non-response types', () => {
      expect(isRpcResponse({ type: 'ready' })).toBe(false);
      expect(isRpcResponse({ type: 'host_tool_call' })).toBe(false);
    });

    it('returns false for missing required fields', () => {
      expect(isRpcResponse({ type: 'response' })).toBe(false);
      expect(isRpcResponse({ type: 'response', command: 'prompt' })).toBe(false);
    });
  });

  describe('isRpcHostToolCallRequest', () => {
    it('returns true for valid host_tool_call', () => {
      expect(isRpcHostToolCallRequest({
        type: 'host_tool_call',
        id: '1',
        toolCallId: 'tc1',
        toolName: 'list_subsys',
        arguments: {},
      })).toBe(true);
    });

    it('returns false for missing fields', () => {
      expect(isRpcHostToolCallRequest({ type: 'host_tool_call', id: '1' })).toBe(false);
      expect(isRpcHostToolCallRequest({ type: 'host_tool_call', id: '1', toolCallId: 'tc1' })).toBe(false);
    });
  });

  describe('isRpcHostToolCancelRequest', () => {
    it('returns true for valid cancel request', () => {
      expect(isRpcHostToolCancelRequest({ type: 'host_tool_cancel', id: '1', targetId: 't1' })).toBe(true);
    });

    it('returns false for missing targetId', () => {
      expect(isRpcHostToolCancelRequest({ type: 'host_tool_cancel', id: '1' })).toBe(false);
    });
  });

  describe('isRpcHostUriRequest', () => {
    it('returns true for valid read request', () => {
      expect(isRpcHostUriRequest({ type: 'host_uri_request', id: '1', operation: 'read', url: 'case://test' })).toBe(true);
    });

    it('returns true for valid write request', () => {
      expect(isRpcHostUriRequest({ type: 'host_uri_request', id: '1', operation: 'write', url: 'case://test' })).toBe(true);
    });

    it('returns false for invalid operation', () => {
      expect(isRpcHostUriRequest({ type: 'host_uri_request', id: '1', operation: 'delete', url: 'case://test' })).toBe(false);
    });
  });

  describe('isRpcHostUriCancelRequest', () => {
    it('returns true for valid cancel', () => {
      expect(isRpcHostUriCancelRequest({ type: 'host_uri_cancel', id: '1', targetId: 't1' })).toBe(true);
    });
  });

  describe('isRpcExtensionUiRequest', () => {
    it('returns true for valid extension UI request', () => {
      expect(isRpcExtensionUiRequest({ type: 'extension_ui_request', id: '1', method: 'confirm' })).toBe(true);
    });
  });

  describe('Subagent frame guards', () => {
    it('isRpcSubagentLifecycleFrame', () => {
      expect(isRpcSubagentLifecycleFrame({ type: 'subagent_lifecycle', payload: {} })).toBe(true);
      expect(isRpcSubagentLifecycleFrame({ type: 'subagent_lifecycle' })).toBe(false);
    });

    it('isRpcSubagentProgressFrame', () => {
      expect(isRpcSubagentProgressFrame({ type: 'subagent_progress', payload: {} })).toBe(true);
    });

    it('isRpcSubagentEventFrame', () => {
      expect(isRpcSubagentEventFrame({ type: 'subagent_event', payload: {} })).toBe(true);
    });
  });

  describe('Frame guards', () => {
    it('isRpcAvailableCommandsUpdateFrame', () => {
      expect(isRpcAvailableCommandsUpdateFrame({ type: 'available_commands_update', commands: [] })).toBe(true);
      expect(isRpcAvailableCommandsUpdateFrame({ type: 'available_commands_update' })).toBe(false);
    });

    it('isRpcPromptResultFrame', () => {
      expect(isRpcPromptResultFrame({ type: 'prompt_result', agentInvoked: true })).toBe(true);
      expect(isRpcPromptResultFrame({ type: 'prompt_result', agentInvoked: false })).toBe(true);
      expect(isRpcPromptResultFrame({ type: 'prompt_result' })).toBe(false);
    });
  });

  describe('Event type sets', () => {
    it('AGENT_EVENT_TYPES contains core agent events', () => {
      expect(AGENT_EVENT_TYPES.has('agent_start')).toBe(true);
      expect(AGENT_EVENT_TYPES.has('agent_end')).toBe(true);
      expect(AGENT_EVENT_TYPES.has('message_start')).toBe(true);
      expect(AGENT_EVENT_TYPES.has('tool_execution_start')).toBe(true);
    });

    it('SESSION_EVENT_TYPES is a superset of AGENT_EVENT_TYPES', () => {
      for (const t of AGENT_EVENT_TYPES) {
        expect(SESSION_EVENT_TYPES.has(t)).toBe(true);
      }
      expect(SESSION_EVENT_TYPES.size).toBeGreaterThan(AGENT_EVENT_TYPES.size);
    });

    it('SESSION_EVENT_TYPES contains additional session events', () => {
      expect(SESSION_EVENT_TYPES.has('auto_compaction_start')).toBe(true);
      expect(SESSION_EVENT_TYPES.has('todo_reminder')).toBe(true);
      expect(SESSION_EVENT_TYPES.has('goal_updated')).toBe(true);
    });
  });

  describe('isAgentEvent / isAgentSessionEvent', () => {
    it('isAgentEvent returns true for agent events', () => {
      expect(isAgentEvent({ type: 'agent_start' })).toBe(true);
      expect(isAgentEvent({ type: 'message_end' })).toBe(true);
    });

    it('isAgentEvent returns false for non-agent events', () => {
      expect(isAgentEvent({ type: 'auto_compaction_start' })).toBe(false);
      expect(isAgentEvent({ type: 'unknown' })).toBe(false);
      expect(isAgentEvent(null)).toBe(false);
    });

    it('isAgentSessionEvent returns true for both agent and session events', () => {
      expect(isAgentSessionEvent({ type: 'agent_start' })).toBe(true);
      expect(isAgentSessionEvent({ type: 'auto_compaction_start' })).toBe(true);
      expect(isAgentSessionEvent({ type: 'goal_updated' })).toBe(true);
    });

    it('isAgentSessionEvent returns false for unknown types', () => {
      expect(isAgentSessionEvent({ type: 'unknown_event' })).toBe(false);
      expect(isAgentSessionEvent(null)).toBe(false);
    });
  });
});
