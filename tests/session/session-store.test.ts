// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from 'vitest';

// Use vi.hoisted to make mock functions available in vi.mock factory
const {
  mockSend,
  mockAbort,
  mockCreate,
  mockDestroy,
  mockList,
  mockRestore,
  mockGetMessages,
  mockGetPersistedSessions,
  mockGetStoredMessages,
  mockSaveStoredMessages,
  mockListHistory,
  mockDeleteHistorySession,
  mockRename,
  mockToastSuccess,
} = vi.hoisted(() => ({
  mockSend: vi.fn().mockResolvedValue(undefined),
  mockAbort: vi.fn().mockResolvedValue(undefined),
  mockCreate: vi.fn().mockResolvedValue({ sessionId: 'session_test_1' }),
  mockDestroy: vi.fn().mockResolvedValue(undefined),
  mockList: vi.fn().mockResolvedValue([]),
  mockRestore: vi.fn().mockResolvedValue({ sessionId: 'session_runtime_1', name: 'Restored session' }),
  mockGetMessages: vi.fn().mockResolvedValue([]),
  mockGetPersistedSessions: vi.fn().mockResolvedValue([]),
  mockGetStoredMessages: vi.fn().mockResolvedValue([]),
  mockSaveStoredMessages: vi.fn().mockResolvedValue(undefined),
  mockListHistory: vi.fn().mockResolvedValue([]),
  mockDeleteHistorySession: vi.fn().mockResolvedValue(undefined),
  mockRename: vi.fn().mockResolvedValue(undefined),
  mockToastSuccess: vi.fn(),
}));

vi.mock('@renderer/lib/trpc', () => ({
  trpc: {
    session: {
      create: { mutate: mockCreate },
      send: { mutate: mockSend },
      abort: { mutate: mockAbort },
      destroy: { mutate: mockDestroy },
      list: { query: mockList },
      restore: { mutate: mockRestore },
      getMessages: { query: mockGetMessages },
      getPersistedSessions: { query: mockGetPersistedSessions },
      getStoredMessages: { query: mockGetStoredMessages },
      saveStoredMessages: { mutate: mockSaveStoredMessages },
      listHistory: { query: mockListHistory },
      deleteHistorySession: { mutate: mockDeleteHistorySession },
      rename: { mutate: mockRename },
    },
  },
}));

// Mock toast store
vi.mock('@renderer/stores/toast', () => ({
  useToastStore: {
    getState: () => ({
      success: mockToastSuccess,
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
      historySessions: [],
      historyLoading: false,
    });
    mockCreate.mockResolvedValue({ sessionId: 'session_test_1' });
    mockRestore.mockResolvedValue({ sessionId: 'session_runtime_1', name: 'Restored session' });
    mockGetMessages.mockResolvedValue([]);
    mockGetPersistedSessions.mockResolvedValue([]);
    mockGetStoredMessages.mockResolvedValue([]);
    mockSaveStoredMessages.mockResolvedValue(undefined);
    mockListHistory.mockResolvedValue([]);
  });

  it('creates a session and sets it as current', async () => {
    const id = await useSessionStore.getState().createSession('proj_1', '/tmp/proj');
    expect(id).toMatch(/^local_/);
    const state = useSessionStore.getState();
    expect(state.sessions).toHaveLength(1);
    expect(state.currentSessionId).toBe(id);
    expect(state.sessions[0].status).toBe('idle');
    expect(state.sessions[0].cwd).toBe('/tmp/proj');
    expect(mockCreate).not.toHaveBeenCalled();
    expect(mockToastSuccess).not.toHaveBeenCalledWith('AI 会话已创建');
  });

  it('opens a usable local tab without waiting for backend session creation', async () => {
    const id = await useSessionStore.getState().createSession('proj_1', '/tmp/proj');
    const state = useSessionStore.getState();
    expect(state.sessions).toHaveLength(1);
    expect(state.currentSessionId).toBe(id);
    expect(state.sessions[0]).toMatchObject({
      id,
      projectId: 'proj_1',
      name: '新会话',
      status: 'idle',
      messages: [],
    });
    expect(mockCreate).not.toHaveBeenCalled();
  });

  it('sends a message and transitions to streaming state', async () => {
    await useSessionStore.getState().createSession('proj_1', '/tmp/proj');

    await useSessionStore.getState().sendMessage('Hello AI');

    const state = useSessionStore.getState();
    expect(mockCreate).toHaveBeenCalledWith({
      projectId: 'proj_1',
      cwd: '/tmp/proj',
      provider: undefined,
      model: undefined,
    });
    expect(mockSend).toHaveBeenCalledWith({ sessionId: 'session_test_1', message: 'Hello AI' });
    expect(state.isSending).toBe(true);

    const session = state.sessions[0];
    expect(session.runtimeSessionId).toBe('session_test_1');
    expect(session.persistedSessionId).toBe('session_test_1');
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
    const id = await useSessionStore.getState().createSession('proj_1', '/tmp/proj');
    useSessionStore.getState().handleSessionEvent(id!, { type: 'message_start' });
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

    // message_update is throttled in production to coalesce rapid stream updates;
    // wait for the throttle window to elapse so the snapshot is applied.
    await new Promise((r) => setTimeout(r, 60));

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

    // Coalesced updates flush after the throttle window.
    await new Promise((r) => setTimeout(r, 60));

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

  it('separates thinking content from text content in message events', async () => {
    await useSessionStore.getState().createSession('proj_1', '/tmp/proj');
    await useSessionStore.getState().sendMessage('What model are you?');

    // message_start with thinking content only
    useSessionStore.getState().handleSessionEvent('session_test_1', {
      type: 'message_start',
      message: {
        role: 'assistant',
        content: [{ type: 'thinking', thinking: 'The user is asking what model I am.' }],
      },
    });

    let session = useSessionStore.getState().sessions[0];
    let assistantMsg = session.messages[1];
    expect(assistantMsg.content).toBe('');
    expect(assistantMsg.thinking).toBe('The user is asking what model I am.');
    expect(assistantMsg.isStreaming).toBe(true);

    // message_update with both thinking and text
    useSessionStore.getState().handleSessionEvent('session_test_1', {
      type: 'message_update',
      message: {
        role: 'assistant',
        content: [
          { type: 'thinking', thinking: 'The user is asking what model I am. I should respond briefly.' },
          { type: 'text', text: 'I am' },
        ],
      },
    });

    // message_update is throttled in production; wait for the flush.
    await new Promise((r) => setTimeout(r, 60));

    session = useSessionStore.getState().sessions[0];
    assistantMsg = session.messages[1];
    expect(assistantMsg.thinking).toBe('The user is asking what model I am. I should respond briefly.');
    expect(assistantMsg.content).toBe('I am');

    // message_end with final content
    useSessionStore.getState().handleSessionEvent('session_test_1', {
      type: 'message_end',
      message: {
        role: 'assistant',
        content: [
          { type: 'thinking', thinking: 'The user is asking what model I am. I should respond briefly.' },
          { type: 'text', text: 'I am Agnes-2.0-Flash, by Sapiens AI.' },
        ],
        stopReason: 'stop',
      },
    });

    session = useSessionStore.getState().sessions[0];
    assistantMsg = session.messages[1];
    expect(assistantMsg.isStreaming).toBe(false);
    expect(assistantMsg.thinking).toBe('The user is asking what model I am. I should respond briefly.');
    expect(assistantMsg.content).toBe('I am Agnes-2.0-Flash, by Sapiens AI.');
  });

  it('does not include [思考] prefix in content when thinking blocks are present', async () => {
    await useSessionStore.getState().createSession('proj_1', '/tmp/proj');
    await useSessionStore.getState().sendMessage('Hello');

    useSessionStore.getState().handleSessionEvent('session_test_1', {
      type: 'message_end',
      message: {
        role: 'assistant',
        content: [
          { type: 'thinking', thinking: 'Internal reasoning here' },
          { type: 'text', text: 'Visible response' },
        ],
        stopReason: 'stop',
      },
    });

    const assistantMsg = useSessionStore.getState().sessions[0].messages[1];
    // Content should NOT contain the [思考] prefix — thinking is stored separately
    expect(assistantMsg.content).not.toContain('[思考]');
    expect(assistantMsg.content).toBe('Visible response');
    expect(assistantMsg.thinking).toBe('Internal reasoning here');
  });

  it('handles tool_execution_start by adding a tool message', async () => {
    const id = await useSessionStore.getState().createSession('proj_1', '/tmp/proj');

    useSessionStore.getState().handleSessionEvent(id!, {
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
    const id = await useSessionStore.getState().createSession('proj_1', '/tmp/proj');

    useSessionStore.getState().handleSessionEvent(id!, {
      type: 'tool_execution_start',
      toolName: 'list_subsys',
      args: {},
    });

    useSessionStore.getState().handleSessionEvent(id!, {
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
    const id = await useSessionStore.getState().createSession('proj_1', '/tmp/proj');
    useSessionStore.getState().handleSessionEvent(id!, { type: 'agent_start' });
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
    const id = await useSessionStore.getState().createSession('proj_1', '/tmp/proj');
    expect(useSessionStore.getState().sessions).toHaveLength(1);

    await useSessionStore.getState().destroySession(id!);

    expect(mockDestroy).toHaveBeenCalledWith({ sessionId: id });
    expect(useSessionStore.getState().sessions).toHaveLength(0);
    expect(useSessionStore.getState().currentSessionId).toBeNull();
  });

  it('switches between sessions', async () => {
    // Create two sessions
    mockCreate.mockResolvedValueOnce({ sessionId: 'session_1' });
    const id1 = await useSessionStore.getState().createSession('proj_1', '/tmp/proj');
    mockCreate.mockResolvedValueOnce({ sessionId: 'session_2' });
    const id2 = await useSessionStore.getState().createSession('proj_1', '/tmp/proj');

    expect(useSessionStore.getState().currentSessionId).toBe(id2);

    useSessionStore.getState().switchSession(id1!);
    expect(useSessionStore.getState().currentSessionId).toBe(id1);
  });

  it('loads a history session once under concurrent clicks without restoring the agent', async () => {
    mockGetStoredMessages.mockResolvedValue([
      {
        id: 'stored_1',
        role: 'user',
        content: 'Why did reset fail?',
        timestamp: 100,
      },
      {
        id: 'stored_2',
        role: 'assistant',
        content: 'Reset was deasserted too early.',
        timestamp: 200,
      },
    ]);

    const historySession = {
      sessionId: 'session_persisted_1',
      name: 'Debug reset failure',
      projectId: 'proj_1',
      createdAt: 100,
      lastActivityAt: 200,
      isActive: false,
    };

    await Promise.all([
      useSessionStore.getState().loadHistorySession(historySession, 'proj_1', '/tmp/proj'),
      useSessionStore.getState().loadHistorySession(historySession, 'proj_1', '/tmp/proj'),
    ]);

    expect(mockRestore).not.toHaveBeenCalled();
    expect(mockGetStoredMessages).toHaveBeenCalledTimes(1);
    expect(mockGetStoredMessages).toHaveBeenCalledWith({
      projectId: 'proj_1',
      sessionId: 'session_persisted_1',
    });
    expect(mockGetMessages).not.toHaveBeenCalled();

    const state = useSessionStore.getState();
    expect(state.sessions).toHaveLength(1);
    expect(state.currentSessionId).toBe('session_persisted_1');
    expect(state.sessions[0]).toMatchObject({
      id: 'session_persisted_1',
      persistedSessionId: 'session_persisted_1',
      name: 'Debug reset failure',
    });
    expect(state.sessions[0].messages.map((m) => [m.role, m.content])).toEqual([
      ['user', 'Why did reset fail?'],
      ['assistant', 'Reset was deasserted too early.'],
    ]);
  });

  it('restores a history session runtime only when sending a message', async () => {
    await useSessionStore.getState().loadHistorySession({
      sessionId: 'session_persisted_1',
      name: 'Debug reset failure',
      projectId: 'proj_1',
      createdAt: 100,
      lastActivityAt: 200,
      isActive: false,
    }, 'proj_1', '/tmp/proj');

    expect(mockRestore).not.toHaveBeenCalled();

    await useSessionStore.getState().sendMessage('Continue debugging');

    expect(mockRestore).toHaveBeenCalledWith({
      projectId: 'proj_1',
      cwd: '/tmp/proj',
      sessionId: 'session_persisted_1',
      name: 'Debug reset failure',
    });
    expect(mockSend).toHaveBeenCalledWith({
      sessionId: 'session_runtime_1',
      message: 'Continue debugging',
      images: undefined,
    });
    expect(useSessionStore.getState().sessions[0]).toMatchObject({
      id: 'session_persisted_1',
      runtimeSessionId: 'session_runtime_1',
      persistedSessionId: 'session_persisted_1',
    });
  });

  it('restores all persisted sessions on startup and selects the most recent one', async () => {
    mockGetPersistedSessions.mockResolvedValue([
      {
        sessionId: 'session_old',
        name: 'Old session',
        projectId: 'proj_1',
        createdAt: 10,
        lastActivityAt: 100,
      },
      {
        sessionId: 'session_latest',
        name: 'Latest session',
        projectId: 'proj_1',
        createdAt: 20,
        lastActivityAt: 200,
      },
    ]);
    mockRestore.mockResolvedValue({
      sessionId: 'session_runtime_latest',
      name: 'Latest session',
    });

    const restored = await useSessionStore.getState().restoreSessions('proj_1', '/tmp/proj');

    expect(restored).toBe(true);
    // Lazy restore: agent runtime is NOT started until the user sends a message.
    expect(mockRestore).not.toHaveBeenCalled();
    const state = useSessionStore.getState();
    // Both persisted sessions should be restored as open tabs.
    expect(state.sessions).toHaveLength(2);
    expect(state.sessions.map((s) => s.id).sort()).toEqual(
      ['session_old', 'session_latest'].sort(),
    );
    // The most recently active session becomes the current tab.
    expect(state.currentSessionId).toBe('session_latest');
    const latest = state.sessions.find((s) => s.id === 'session_latest');
    const old = state.sessions.find((s) => s.id === 'session_old');
    expect(latest).toMatchObject({
      id: 'session_latest',
      persistedSessionId: 'session_latest',
      name: 'Latest session',
    });
    expect(old).toMatchObject({
      id: 'session_old',
      persistedSessionId: 'session_old',
      name: 'Old session',
    });
  });

  it('skips already-open sessions when restoring and keeps the latest as current', async () => {
    // Pre-populate the store as if one session is already open (e.g. user switched projects and back).
    useSessionStore.setState({
      sessions: [
        {
          id: 'session_old',
          persistedSessionId: 'session_old',
          projectId: 'proj_1',
          cwd: '/tmp/proj',
          name: 'Old session',
          status: 'idle' as const,
          messages: [],
          createdAt: 10,
        },
      ],
      currentSessionId: 'session_old',
    });

    mockGetPersistedSessions.mockResolvedValue([
      {
        sessionId: 'session_old',
        name: 'Old session',
        projectId: 'proj_1',
        createdAt: 10,
        lastActivityAt: 100,
      },
      {
        sessionId: 'session_latest',
        name: 'Latest session',
        projectId: 'proj_1',
        createdAt: 20,
        lastActivityAt: 200,
      },
    ]);

    const restored = await useSessionStore.getState().restoreSessions('proj_1', '/tmp/proj');

    expect(restored).toBe(true);
    const state = useSessionStore.getState();
    // The already-open session should not be duplicated.
    expect(state.sessions).toHaveLength(2);
    expect(state.sessions.map((s) => s.id).sort()).toEqual(
      ['session_old', 'session_latest'].sort(),
    );
    // The most recently active persisted session becomes the current tab.
    expect(state.currentSessionId).toBe('session_latest');
  });

  it('hydrates history sessions from stored UI messages before asking the agent', async () => {
    mockRestore.mockResolvedValue({
      sessionId: 'session_runtime_1',
      name: 'Stored transcript',
    });
    mockGetStoredMessages.mockResolvedValue([
      {
        id: 'stored_1',
        role: 'user',
        content: 'Stored question',
        timestamp: 100,
      },
      {
        id: 'stored_2',
        role: 'assistant',
        content: 'Stored answer',
        timestamp: 200,
      },
    ]);

    await useSessionStore.getState().loadHistorySession({
      sessionId: 'session_persisted_1',
      name: 'Stored transcript',
      projectId: 'proj_1',
      createdAt: 100,
      lastActivityAt: 200,
      isActive: false,
    }, 'proj_1', '/tmp/proj');

    expect(mockGetStoredMessages).toHaveBeenCalledWith({
      projectId: 'proj_1',
      sessionId: 'session_persisted_1',
    });
    expect(mockGetMessages).not.toHaveBeenCalled();
    expect(useSessionStore.getState().sessions[0].messages.map((m) => [m.role, m.content])).toEqual([
      ['user', 'Stored question'],
      ['assistant', 'Stored answer'],
    ]);
  });
});
