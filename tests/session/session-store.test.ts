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

  it('does not render echoed user message events as assistant content', async () => {
    await useSessionStore.getState().createSession('proj_1', '/tmp/proj');
    await useSessionStore.getState().sendMessage('What model are you?');

    useSessionStore.getState().handleSessionEvent('session_test_1', {
      type: 'message_start',
      message: { role: 'user', content: [{ type: 'text', text: 'What model are you?' }] },
    });
    useSessionStore.getState().handleSessionEvent('session_test_1', {
      type: 'message_end',
      message: { role: 'user', content: [{ type: 'text', text: 'What model are you?' }] },
    });

    const session = useSessionStore.getState().sessions[0];
    expect(session.messages).toHaveLength(2);
    expect(session.messages[0]).toMatchObject({ role: 'user', content: 'What model are you?' });
    expect(session.messages[1]).toMatchObject({ role: 'assistant', content: '', isStreaming: true });
  });

  it('handles message_update event by extracting text from message content', async () => {
    await useSessionStore.getState().createSession('proj_1', '/tmp/proj');
    await useSessionStore.getState().sendMessage('Hello');

    useSessionStore.getState().handleSessionEvent('session_test_1', {
      type: 'message_update',
      message: { role: 'assistant', content: [{ type: 'text', text: 'World' }] },
    });

    const session = useSessionStore.getState().sessions[0];
    const assistantMsg = session.messages[1];
    expect(assistantMsg.content).toBe('World');
  });

  it('handles multiple message_update events to build full response', async () => {
    await useSessionStore.getState().createSession('proj_1', '/tmp/proj');
    await useSessionStore.getState().sendMessage('Hello');

    // Each message_update contains a full snapshot (not a delta), so later ones replace earlier ones
    useSessionStore.getState().handleSessionEvent('session_test_1', {
      type: 'message_update',
      message: { role: 'assistant', content: [{ type: 'text', text: 'Hello ' }] },
    });
    useSessionStore.getState().handleSessionEvent('session_test_1', {
      type: 'message_update',
      message: { role: 'assistant', content: [{ type: 'text', text: 'Hello world' }] },
    });
    useSessionStore.getState().handleSessionEvent('session_test_1', {
      type: 'message_update',
      message: { role: 'assistant', content: [{ type: 'text', text: 'Hello world!' }] },
    });

    const assistantMsg = useSessionStore.getState().sessions[0].messages[1];
    expect(assistantMsg.content).toBe('Hello world!');
  });

  it('handles message_end event by extracting final content and stopping streaming', async () => {
    await useSessionStore.getState().createSession('proj_1', '/tmp/proj');
    await useSessionStore.getState().sendMessage('Hello');

    // message_update with partial content
    useSessionStore.getState().handleSessionEvent('session_test_1', {
      type: 'message_update',
      message: { role: 'assistant', content: [{ type: 'text', text: 'Partial' }] },
    });
    // message_end with final content
    useSessionStore.getState().handleSessionEvent('session_test_1', {
      type: 'message_end',
      message: { role: 'assistant', content: [{ type: 'text', text: 'Final Response' }], stopReason: 'stop' },
    });

    const session = useSessionStore.getState().sessions[0];
    // message_end no longer sets status to 'idle' — only agent_end does.
    // This allows multiple messages within a single agent turn.
    expect(session.status).toBe('streaming');
    const assistantMsg = session.messages[1];
    expect(assistantMsg.isStreaming).toBe(false);
    expect(assistantMsg.content).toBe('Final Response');
  });

  it('handles multiple message_start/message_end pairs within one agent turn', async () => {
    await useSessionStore.getState().createSession('proj_1', '/tmp/proj');
    await useSessionStore.getState().sendMessage('Hello');

    // First message
    useSessionStore.getState().handleSessionEvent('session_test_1', {
      type: 'message_start',
      message: { role: 'assistant', content: [{ type: 'text', text: 'First' }] },
    });
    useSessionStore.getState().handleSessionEvent('session_test_1', {
      type: 'message_end',
      message: { role: 'assistant', content: [{ type: 'text', text: 'First response' }], stopReason: 'stop' },
    });

    // Second message (no streaming assistant exists — should create a new one)
    useSessionStore.getState().handleSessionEvent('session_test_1', {
      type: 'message_start',
      message: { role: 'assistant', content: [{ type: 'text', text: 'Second' }] },
    });
    useSessionStore.getState().handleSessionEvent('session_test_1', {
      type: 'message_end',
      message: { role: 'assistant', content: [{ type: 'text', text: 'Second response' }], stopReason: 'stop' },
    });

    // Agent ends
    useSessionStore.getState().handleSessionEvent('session_test_1', { type: 'agent_end' });

    const session = useSessionStore.getState().sessions[0];
    // Messages: user + first assistant + second assistant
    expect(session.messages.length).toBe(3);
    expect(session.messages[0].role).toBe('user');
    expect(session.messages[1].role).toBe('assistant');
    expect(session.messages[1].content).toBe('First response');
    expect(session.messages[1].isStreaming).toBe(false);
    expect(session.messages[2].role).toBe('assistant');
    expect(session.messages[2].content).toBe('Second response');
    expect(session.messages[2].isStreaming).toBe(false);
    expect(session.status).toBe('idle');
  });

  it('handles message_end with no prior message_update by extracting content from message_end', async () => {
    await useSessionStore.getState().createSession('proj_1', '/tmp/proj');
    await useSessionStore.getState().sendMessage('Hello');

    // No message_update events — content comes directly from message_end
    useSessionStore.getState().handleSessionEvent('session_test_1', {
      type: 'message_end',
      message: { role: 'assistant', content: [{ type: 'text', text: 'Direct response' }], stopReason: 'stop' },
    });

    const session = useSessionStore.getState().sessions[0];
    const assistantMsg = session.messages[1];
    expect(assistantMsg.isStreaming).toBe(false);
    expect(assistantMsg.content).toBe('Direct response');
  });

  it('handles message_end with error stopReason', async () => {
    await useSessionStore.getState().createSession('proj_1', '/tmp/proj');
    await useSessionStore.getState().sendMessage('Hello');

    useSessionStore.getState().handleSessionEvent('session_test_1', {
      type: 'message_end',
      message: { role: 'assistant', content: [], stopReason: 'error', errorMessage: 'API key invalid' },
    });

    const assistantMsg = useSessionStore.getState().sessions[0].messages[1];
    expect(assistantMsg.isStreaming).toBe(false);
    expect(assistantMsg.content).toContain('API key invalid');
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
