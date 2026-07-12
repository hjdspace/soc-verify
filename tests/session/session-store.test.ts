// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from 'vitest';

// Use vi.hoisted to make mock functions available in vi.mock factory
const { mockSend, mockAbort, mockCreate, mockDestroy, mockList } = vi.hoisted(() => ({
  mockSend: vi.fn().mockResolvedValue(undefined),
  mockAbort: vi.fn().mockResolvedValue(undefined),
  mockCreate: vi.fn().mockResolvedValue({ sessionId: 'session_test_1' }),
  mockDestroy: vi.fn().mockResolvedValue(undefined),
  mockList: vi.fn().mockResolvedValue([]),
}));

vi.mock('@renderer/lib/trpc', () => ({
  trpc: {
    session: {
      create: { mutate: mockCreate },
      send: { mutate: mockSend },
      abort: { mutate: mockAbort },
      destroy: { mutate: mockDestroy },
      list: { query: mockList },
    },
  },
}));

// Mock toast store
vi.mock('@renderer/stores/toast', () => ({
  useToastStore: {
    getState: () => ({
      success: vi.fn(),
      error: vi.fn(),
      info: vi.fn(),
    }),
  },
}));

import { useSessionStore } from '@renderer/stores/session';

describe('SessionStore — event handling and state machine', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    useSessionStore.setState({
      sessions: [],
      currentSessionId: null,
      inputMessage: '',
      isSending: false,
    });
  });

  it('creates a session and sets it as current', async () => {
    const id = await useSessionStore.getState().createSession('proj_1', '/tmp/proj');
    expect(id).toBe('session_test_1');
    const state = useSessionStore.getState();
    expect(state.sessions).toHaveLength(1);
    expect(state.currentSessionId).toBe('session_test_1');
    expect(state.sessions[0].status).toBe('idle');
  });

  it('sends a message and transitions to streaming state', async () => {
    await useSessionStore.getState().createSession('proj_1', '/tmp/proj');

    await useSessionStore.getState().sendMessage('Hello AI');

    const state = useSessionStore.getState();
    expect(mockSend).toHaveBeenCalledWith({ sessionId: 'session_test_1', message: 'Hello AI' });
    expect(state.isSending).toBe(true);

    const session = state.sessions[0];
    expect(session.status).toBe('streaming');
    expect(session.messages).toHaveLength(2);

    // First message is user
    expect(session.messages[0].role).toBe('user');
    expect(session.messages[0].content).toBe('Hello AI');

    // Second message is empty assistant (streaming)
    expect(session.messages[1].role).toBe('assistant');
    expect(session.messages[1].isStreaming).toBe(true);
  });

  it('handles message_start event by setting status to streaming', async () => {
    await useSessionStore.getState().createSession('proj_1', '/tmp/proj');
    useSessionStore.getState().handleSessionEvent('session_test_1', { type: 'message_start' });
    expect(useSessionStore.getState().sessions[0].status).toBe('streaming');
  });

  it('handles message_update event by appending delta to assistant message', async () => {
    await useSessionStore.getState().createSession('proj_1', '/tmp/proj');
    await useSessionStore.getState().sendMessage('Hello');

    useSessionStore.getState().handleSessionEvent('session_test_1', { type: 'message_update', delta: 'World' });

    const session = useSessionStore.getState().sessions[0];
    const assistantMsg = session.messages[1];
    expect(assistantMsg.content).toBe('World');
  });

  it('handles multiple message_update events to build full response', async () => {
    await useSessionStore.getState().createSession('proj_1', '/tmp/proj');
    await useSessionStore.getState().sendMessage('Hello');

    useSessionStore.getState().handleSessionEvent('session_test_1', { type: 'message_update', delta: 'Hello ' });
    useSessionStore.getState().handleSessionEvent('session_test_1', { type: 'message_update', delta: 'world' });
    useSessionStore.getState().handleSessionEvent('session_test_1', { type: 'message_update', delta: '!' });

    const assistantMsg = useSessionStore.getState().sessions[0].messages[1];
    expect(assistantMsg.content).toBe('Hello world!');
  });

  it('handles message_end event by stopping streaming', async () => {
    await useSessionStore.getState().createSession('proj_1', '/tmp/proj');
    await useSessionStore.getState().sendMessage('Hello');

    useSessionStore.getState().handleSessionEvent('session_test_1', { type: 'message_update', delta: 'Response' });
    useSessionStore.getState().handleSessionEvent('session_test_1', { type: 'message_end' });

    const session = useSessionStore.getState().sessions[0];
    expect(session.status).toBe('idle');
    const assistantMsg = session.messages[1];
    expect(assistantMsg.isStreaming).toBe(false);
    expect(assistantMsg.content).toBe('Response');
  });

  it('handles tool_execution_start by adding a tool message', async () => {
    await useSessionStore.getState().createSession('proj_1', '/tmp/proj');

    useSessionStore.getState().handleSessionEvent('session_test_1', {
      type: 'tool_execution_start',
      toolName: 'list_subsys',
      args: { filter: '' },
    });

    const session = useSessionStore.getState().sessions[0];
    expect(session.status).toBe('tool_executing');
    const toolMsg = session.messages.find((m) => m.role === 'tool');
    expect(toolMsg).toBeDefined();
    expect(toolMsg!.toolName).toBe('list_subsys');
    expect(toolMsg!.toolArgs).toEqual({ filter: '' });
    expect(toolMsg!.toolStartTime).toBeDefined();
    expect(toolMsg!.toolResult).toBeUndefined();
  });

  it('handles tool_execution_end by updating the tool message with result', async () => {
    await useSessionStore.getState().createSession('proj_1', '/tmp/proj');

    useSessionStore.getState().handleSessionEvent('session_test_1', {
      type: 'tool_execution_start',
      toolName: 'list_subsys',
      args: {},
    });

    useSessionStore.getState().handleSessionEvent('session_test_1', {
      type: 'tool_execution_end',
      toolName: 'list_subsys',
      result: [{ name: 'subsys_a' }],
    });

    const session = useSessionStore.getState().sessions[0];
    expect(session.status).toBe('streaming');
    const toolMsg = session.messages.find((m) => m.role === 'tool');
    expect(toolMsg!.toolResult).toEqual([{ name: 'subsys_a' }]);
    expect(toolMsg!.toolEndTime).toBeDefined();
  });

  it('handles agent_start by setting status to streaming', async () => {
    await useSessionStore.getState().createSession('proj_1', '/tmp/proj');
    useSessionStore.getState().handleSessionEvent('session_test_1', { type: 'agent_start' });
    expect(useSessionStore.getState().sessions[0].status).toBe('streaming');
  });

  it('handles agent_end by setting status to idle and clearing isSending', async () => {
    await useSessionStore.getState().createSession('proj_1', '/tmp/proj');
    await useSessionStore.getState().sendMessage('Hello');

    useSessionStore.getState().handleSessionEvent('session_test_1', { type: 'agent_end' });

    const state = useSessionStore.getState();
    expect(state.isSending).toBe(false);
    expect(state.sessions[0].status).toBe('idle');
    // All streaming messages should have isStreaming=false
    const streaming = state.sessions[0].messages.filter((m) => m.isStreaming);
    expect(streaming).toHaveLength(0);
  });

  it('aborts the current session and resets state', async () => {
    await useSessionStore.getState().createSession('proj_1', '/tmp/proj');
    await useSessionStore.getState().sendMessage('Hello');

    await useSessionStore.getState().abortSession();

    expect(mockAbort).toHaveBeenCalledWith({ sessionId: 'session_test_1' });
    expect(useSessionStore.getState().isSending).toBe(false);
    expect(useSessionStore.getState().sessions[0].status).toBe('idle');
  });

  it('ignores events for unknown sessions', async () => {
    await useSessionStore.getState().createSession('proj_1', '/tmp/proj');

    // This should not throw or modify state
    useSessionStore.getState().handleSessionEvent('unknown_session', { type: 'message_start' });

    expect(useSessionStore.getState().sessions[0].status).toBe('idle');
  });

  it('destroys a session and removes it from the list', async () => {
    await useSessionStore.getState().createSession('proj_1', '/tmp/proj');
    expect(useSessionStore.getState().sessions).toHaveLength(1);

    await useSessionStore.getState().destroySession('session_test_1');

    expect(mockDestroy).toHaveBeenCalledWith({ sessionId: 'session_test_1' });
    expect(useSessionStore.getState().sessions).toHaveLength(0);
    expect(useSessionStore.getState().currentSessionId).toBeNull();
  });

  it('switches between sessions', async () => {
    // Create two sessions
    mockCreate.mockResolvedValueOnce({ sessionId: 'session_1' });
    await useSessionStore.getState().createSession('proj_1', '/tmp/proj');
    mockCreate.mockResolvedValueOnce({ sessionId: 'session_2' });
    await useSessionStore.getState().createSession('proj_1', '/tmp/proj');

    expect(useSessionStore.getState().currentSessionId).toBe('session_2');

    useSessionStore.getState().switchSession('session_1');
    expect(useSessionStore.getState().currentSessionId).toBe('session_1');
  });
});
