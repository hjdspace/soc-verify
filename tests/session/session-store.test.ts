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
  mockUpdateContextUsage,
  mockListHistory,
  mockDeleteHistorySession,
  mockRename,
  mockCompact,
  mockGenerateTitle,
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
  mockUpdateContextUsage: vi.fn().mockResolvedValue(undefined),
  mockListHistory: vi.fn().mockResolvedValue([]),
  mockDeleteHistorySession: vi.fn().mockResolvedValue(undefined),
  mockRename: vi.fn().mockResolvedValue(undefined),
  mockCompact: vi.fn().mockResolvedValue({
    contextUsage: { tokens: 12000, contextWindow: 200000, percent: 6 },
    contextBreakdown: {
      systemPromptTokens: 1000,
      systemToolsTokens: 2000,
      systemContextTokens: 1000,
      skillsTokens: 0,
      messagesTokens: 8000,
    },
  }),
  mockGenerateTitle: vi.fn().mockResolvedValue({ title: null }),
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
      updateContextUsage: { mutate: mockUpdateContextUsage },
      listHistory: { query: mockListHistory },
      deleteHistorySession: { mutate: mockDeleteHistorySession },
      rename: { mutate: mockRename },
      compact: { mutate: mockCompact },
      generateTitle: { mutate: mockGenerateTitle },
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

import { useSessionCoreStore } from '@renderer/stores/session-core';
import { useSessionMessagesStore } from '@renderer/stores/session-messages';

// Backward-compatible alias: tests use useSessionStore.setState for sessions/currentSessionId
// which now lives in session-core. Message-related operations (handleSessionEvent, sendMessage,
// abortSession, compactSession, steerSession) live in session-messages.
// Approval-related operations (setApprovalMode, resolveApproval, resolveAsk) live in session-approval.
const useSessionStore = useSessionCoreStore;

describe('SessionStore — event handling and state machine', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    useSessionStore.setState({
      sessions: [],
      currentSessionId: null,
      historySessions: [],
      historyLoading: false,
    });
    mockCreate.mockResolvedValue({ sessionId: 'session_test_1' });
    mockRestore.mockResolvedValue({ sessionId: 'session_runtime_1', name: 'Restored session' });
    mockGetMessages.mockResolvedValue([]);
    mockGetPersistedSessions.mockResolvedValue([]);
    mockGetStoredMessages.mockResolvedValue([]);
    mockSaveStoredMessages.mockResolvedValue(undefined);
    mockUpdateContextUsage.mockResolvedValue(undefined);
    mockCompact.mockResolvedValue({
      contextUsage: { tokens: 12000, contextWindow: 200000, percent: 6 },
      contextBreakdown: {
        systemPromptTokens: 1000,
        systemToolsTokens: 2000,
        systemContextTokens: 1000,
        skillsTokens: 0,
        messagesTokens: 8000,
      },
    });
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

  it('keeps composer drafts, skills, and context files isolated per Agent Conversation', async () => {
    const firstId = await useSessionStore.getState().createSession('proj_1', '/tmp/proj');
    useSessionStore.getState().setInputMessage('draft for first');
    useSessionStore.getState().addSkill({
      name: 'debug',
      description: 'Debug failures',
      filePath: '/skills/debug/SKILL.md',
      source: 'project',
    });
    useSessionStore.getState().addContextFile({
      name: 'core.sv',
      path: '/tmp/proj/rtl/core.sv',
      type: 'file',
    });

    const secondId = await useSessionStore.getState().createSession('proj_1', '/tmp/proj');
    const second = useSessionStore.getState().sessions.find((session) => session.id === secondId);
    expect(second?.composer).toEqual({ inputMessage: '', selectedSkills: [], contextFiles: [] });

    useSessionStore.getState().setInputMessage('draft for second');
    useSessionStore.getState().switchSession(firstId!);

    const first = useSessionStore.getState().sessions.find((session) => session.id === firstId);
    expect(first?.composer).toEqual({
      inputMessage: 'draft for first',
      selectedSkills: [expect.objectContaining({ name: 'debug' })],
      contextFiles: [expect.objectContaining({ path: '/tmp/proj/rtl/core.sv' })],
    });
    expect(useSessionStore.getState().sessions.find((session) => session.id === secondId)?.composer.inputMessage)
      .toBe('draft for second');
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

    await useSessionMessagesStore.getState().sendMessage('Hello AI');

    const state = useSessionStore.getState();
    expect(mockCreate).toHaveBeenCalledWith({
      projectId: 'proj_1',
      cwd: '/tmp/proj',
      provider: undefined,
      model: undefined,
      providerId: undefined,
      approvalMode: 'yolo',
    });
    expect(mockSend).toHaveBeenCalledWith({ sessionId: 'session_test_1', message: 'Hello AI' });
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
    useSessionMessagesStore.getState().handleSessionEvent(id!, { type: 'message_start' });
    expect(useSessionStore.getState().sessions[0].status).toBe('streaming');
  });

  it('does not render echoed user message events as assistant content', async () => {
    await useSessionStore.getState().createSession('proj_1', '/tmp/proj');
    await useSessionMessagesStore.getState().sendMessage('What model are you?');

    useSessionMessagesStore.getState().handleSessionEvent('session_test_1', {
      type: 'message_start',
      message: { role: 'user', content: [{ type: 'text', text: 'What model are you?' }] },
    });
    useSessionMessagesStore.getState().handleSessionEvent('session_test_1', {
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
    await useSessionMessagesStore.getState().sendMessage('Hello');

    useSessionMessagesStore.getState().handleSessionEvent('session_test_1', {
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
    await useSessionMessagesStore.getState().sendMessage('Hello');

    // Each message_update contains a full snapshot (not a delta), so later ones replace earlier ones
    useSessionMessagesStore.getState().handleSessionEvent('session_test_1', {
      type: 'message_update',
      message: { role: 'assistant', content: [{ type: 'text', text: 'Hello ' }] },
    });
    useSessionMessagesStore.getState().handleSessionEvent('session_test_1', {
      type: 'message_update',
      message: { role: 'assistant', content: [{ type: 'text', text: 'Hello world' }] },
    });
    useSessionMessagesStore.getState().handleSessionEvent('session_test_1', {
      type: 'message_update',
      message: { role: 'assistant', content: [{ type: 'text', text: 'Hello world!' }] },
    });

    // Coalesced updates flush after the throttle window.
    await new Promise((r) => setTimeout(r, 60));

    const assistantMsg = useSessionStore.getState().sessions[0].messages[1];
    expect(assistantMsg.content).toBe('Hello world!');
  });

  it('creates a pending file tool card from a streaming tool-call snapshot', async () => {
    await useSessionStore.getState().createSession('proj_1', '/tmp/proj');
    await useSessionMessagesStore.getState().sendMessage('Create src/demo.ts');

    useSessionMessagesStore.getState().handleSessionEvent('session_test_1', {
      type: 'message_update',
      message: {
        role: 'assistant',
        content: [
          {
            type: 'toolCall',
            id: 'tc_write_streaming',
            name: 'write',
            arguments: { path: 'src/demo.ts' },
          },
        ],
      },
    });

    await new Promise((r) => setTimeout(r, 60));

    const toolMsg = useSessionStore.getState().sessions[0].messages.find(
      (message) => message.role === 'tool' && message.toolCallId === 'tc_write_streaming',
    );
    expect(toolMsg).toMatchObject({
      toolName: 'write',
      toolArgs: { path: 'src/demo.ts' },
    });
    expect(toolMsg?.toolResult).toBeUndefined();
    expect(toolMsg?.toolStartTime).toBeDefined();

    useSessionMessagesStore.getState().handleSessionEvent('session_test_1', {
      type: 'message_update',
      message: {
        role: 'assistant',
        content: [
          {
            type: 'toolCall',
            id: 'tc_write_streaming',
            name: 'write',
            arguments: { path: 'src/demo.ts', content: 'const value = 1;' },
          },
        ],
      },
    });

    await new Promise((r) => setTimeout(r, 60));

    const toolMessages = useSessionStore.getState().sessions[0].messages.filter(
      (message) => message.role === 'tool' && message.toolCallId === 'tc_write_streaming',
    );
    expect(toolMessages).toHaveLength(1);
    expect(toolMessages[0].toolArgs).toEqual({
      path: 'src/demo.ts',
      content: 'const value = 1;',
    });
  });

  it('creates a pending edit card from a streaming tool-call snapshot', async () => {
    await useSessionStore.getState().createSession('proj_1', '/tmp/proj');
    await useSessionMessagesStore.getState().sendMessage('Edit src/demo.ts');

    useSessionMessagesStore.getState().handleSessionEvent('session_test_1', {
      type: 'message_update',
      message: {
        role: 'assistant',
        content: [
          {
            type: 'toolCall',
            id: 'tc_edit_streaming',
            name: 'edit',
            arguments: { path: 'src/demo.ts' },
          },
        ],
      },
    });

    await new Promise((r) => setTimeout(r, 60));

    const toolMsg = useSessionStore.getState().sessions[0].messages.find(
      (message) => message.role === 'tool' && message.toolCallId === 'tc_edit_streaming',
    );
    expect(toolMsg).toMatchObject({
      toolName: 'edit',
      toolArgs: { path: 'src/demo.ts' },
    });
    expect(toolMsg?.toolResult).toBeUndefined();
  });

  it('handles message_end event by extracting final content and stopping streaming', async () => {
    await useSessionStore.getState().createSession('proj_1', '/tmp/proj');
    await useSessionMessagesStore.getState().sendMessage('Hello');

    // message_update with partial content
    useSessionMessagesStore.getState().handleSessionEvent('session_test_1', {
      type: 'message_update',
      message: { role: 'assistant', content: [{ type: 'text', text: 'Partial' }] },
    });
    // message_end with final content
    useSessionMessagesStore.getState().handleSessionEvent('session_test_1', {
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
    await useSessionMessagesStore.getState().sendMessage('Hello');

    // First message
    useSessionMessagesStore.getState().handleSessionEvent('session_test_1', {
      type: 'message_start',
      message: { role: 'assistant', content: [{ type: 'text', text: 'First' }] },
    });
    useSessionMessagesStore.getState().handleSessionEvent('session_test_1', {
      type: 'message_end',
      message: { role: 'assistant', content: [{ type: 'text', text: 'First response' }], stopReason: 'stop' },
    });

    // Second message (no streaming assistant exists — should create a new one)
    useSessionMessagesStore.getState().handleSessionEvent('session_test_1', {
      type: 'message_start',
      message: { role: 'assistant', content: [{ type: 'text', text: 'Second' }] },
    });
    useSessionMessagesStore.getState().handleSessionEvent('session_test_1', {
      type: 'message_end',
      message: { role: 'assistant', content: [{ type: 'text', text: 'Second response' }], stopReason: 'stop' },
    });

    // Agent ends
    useSessionMessagesStore.getState().handleSessionEvent('session_test_1', { type: 'agent_end' });

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
    await useSessionMessagesStore.getState().sendMessage('Hello');

    // No message_update events — content comes directly from message_end
    useSessionMessagesStore.getState().handleSessionEvent('session_test_1', {
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
    await useSessionMessagesStore.getState().sendMessage('Hello');

    useSessionMessagesStore.getState().handleSessionEvent('session_test_1', {
      type: 'message_end',
      message: { role: 'assistant', content: [], stopReason: 'error', errorMessage: 'API key invalid' },
    });

    const assistantMsg = useSessionStore.getState().sessions[0].messages[1];
    expect(assistantMsg.isStreaming).toBe(false);
    expect(assistantMsg.content).toContain('API key invalid');
  });

  it('suppresses transient MCP transport errors and keeps streaming placeholder alive', async () => {
    await useSessionStore.getState().createSession('proj_1', '/tmp/proj');
    await useSessionMessagesStore.getState().sendMessage('Hello');

    // MCP transport glitch: message_end with only errorMessage, no content
    useSessionMessagesStore.getState().handleSessionEvent('session_test_1', {
      type: 'message_end',
      message: { role: 'assistant', content: [], stopReason: 'error', errorMessage: 'Transport closed' },
    });

    // The streaming placeholder must survive — MCPManager auto-reconnects
    const session = useSessionStore.getState().sessions[0];
    const assistantMsg = session.messages[1];
    expect(assistantMsg.isStreaming).toBe(true);
    expect(assistantMsg.content).toBe('');

    // The real response arrives via message_start / message_end
    useSessionMessagesStore.getState().handleSessionEvent('session_test_1', {
      type: 'message_start',
      message: { role: 'assistant', content: [{ type: 'text', text: 'Hello!' }] },
    });
    useSessionMessagesStore.getState().handleSessionEvent('session_test_1', {
      type: 'message_end',
      message: { role: 'assistant', content: [{ type: 'text', text: 'Hello!' }], stopReason: 'stop' },
    });

    const updated = useSessionStore.getState().sessions[0];
    expect(updated.messages[1].isStreaming).toBe(false);
    expect(updated.messages[1].content).toBe('Hello!');
  });

  it('suppresses ECONNRESET and other transient transport errors', async () => {
    await useSessionStore.getState().createSession('proj_1', '/tmp/proj');
    await useSessionMessagesStore.getState().sendMessage('Hello');

    for (const transientError of ['ECONNRESET', 'EPIPE', 'fetch failed', 'network error']) {
      useSessionMessagesStore.getState().handleSessionEvent('session_test_1', {
        type: 'message_end',
        message: { role: 'assistant', content: [], stopReason: 'error', errorMessage: transientError },
      });

      const assistantMsg = useSessionStore.getState().sessions[0].messages[1];
      expect(assistantMsg.isStreaming).toBe(true);
      expect(assistantMsg.content).toBe('');
    }

    // Also test the default error handler suppresses transient errors
    useSessionMessagesStore.getState().handleSessionEvent('session_test_1', {
      type: 'transport_error',
      error: 'Transport closed',
    });

    const session = useSessionStore.getState().sessions[0];
    expect(session.status).not.toBe('error');
  });

  it('separates thinking content from text content in message events', async () => {
    await useSessionStore.getState().createSession('proj_1', '/tmp/proj');
    await useSessionMessagesStore.getState().sendMessage('What model are you?');

    // message_start with thinking content only
    useSessionMessagesStore.getState().handleSessionEvent('session_test_1', {
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
    useSessionMessagesStore.getState().handleSessionEvent('session_test_1', {
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
    useSessionMessagesStore.getState().handleSessionEvent('session_test_1', {
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
    await useSessionMessagesStore.getState().sendMessage('Hello');

    useSessionMessagesStore.getState().handleSessionEvent('session_test_1', {
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

    useSessionMessagesStore.getState().handleSessionEvent(id!, {
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

  it('preserves the write snapshot from tool_execution_start', async () => {
    const id = await useSessionStore.getState().createSession('proj_1', '/tmp/proj');

    useSessionMessagesStore.getState().handleSessionEvent(id!, {
      type: 'tool_execution_start',
      toolCallId: 'write-new-file',
      toolName: 'write',
      args: { path: '/tmp/generated.md', content: 'generated' },
      fileExistedBefore: false,
    });

    useSessionMessagesStore.getState().handleSessionEvent(id!, {
      type: 'tool_execution_end',
      toolCallId: 'write-new-file',
      toolName: 'write',
      result: { details: { resolvedPath: '/tmp/generated.md' } },
    });

    const toolMsg = useSessionStore.getState().sessions[0].messages.find((m) => m.role === 'tool');
    expect(toolMsg).toEqual(expect.objectContaining({
      toolFileExistedBefore: false,
      toolBeforeContent: undefined,
    }));
  });

  it('handles tool_execution_end by updating the tool message with result', async () => {
    const id = await useSessionStore.getState().createSession('proj_1', '/tmp/proj');

    useSessionMessagesStore.getState().handleSessionEvent(id!, {
      type: 'tool_execution_start',
      toolName: 'list_subsys',
      args: {},
    });

    useSessionMessagesStore.getState().handleSessionEvent(id!, {
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

  it('creates a tool message on tool_execution_end when tool_execution_start was missed', async () => {
    const id = await useSessionStore.getState().createSession('proj_1', '/tmp/proj');

    // Send tool_execution_end WITHOUT a preceding tool_execution_start
    useSessionMessagesStore.getState().handleSessionEvent(id!, {
      type: 'tool_execution_end',
      toolCallId: 'tc_missed_1',
      toolName: 'write',
      args: { path: '/tmp/test.txt', content: 'hello' },
      result: { content: [{ type: 'text', text: 'File written successfully' }] },
    });

    const session = useSessionStore.getState().sessions[0];
    expect(session.status).toBe('streaming');
    const toolMsg = session.messages.find((m) => m.role === 'tool');
    expect(toolMsg).toBeDefined();
    expect(toolMsg!.toolName).toBe('write');
    expect(toolMsg!.toolCallId).toBe('tc_missed_1');
    expect(toolMsg!.toolResult).toEqual({ content: [{ type: 'text', text: 'File written successfully' }] });
    expect(toolMsg!.toolEndTime).toBeDefined();
  });

  it('handles agent_start by setting status to streaming', async () => {
    const id = await useSessionStore.getState().createSession('proj_1', '/tmp/proj');
    useSessionMessagesStore.getState().handleSessionEvent(id!, { type: 'agent_start' });
    expect(useSessionStore.getState().sessions[0].status).toBe('streaming');
  });

  it('handles agent_end by setting the matching Agent Conversation to idle', async () => {
    await useSessionStore.getState().createSession('proj_1', '/tmp/proj');
    await useSessionMessagesStore.getState().sendMessage('Hello');

    useSessionMessagesStore.getState().handleSessionEvent('session_test_1', { type: 'agent_end' });

    const state = useSessionStore.getState();
    expect(state.sessions[0].status).toBe('idle');
    // All streaming messages should have isStreaming=false
    const streaming = state.sessions[0].messages.filter((m) => m.isStreaming);
    expect(streaming).toHaveLength(0);
  });

  it('triggers AI title generation immediately on long first message (no agent_end needed)', async () => {
    await useSessionStore.getState().createSession('proj_1', '/tmp/proj');
    // Long input (> 40 chars) should trigger AI title generation immediately
    await useSessionMessagesStore.getState().sendMessage('请帮我分析一下这个模块的覆盖率报告，找出未覆盖的代码行并给出修复建议，需要包含详细的分析过程和具体的代码修改方案');

    // generateTitle should be called right away — no need to wait for agent_end
    await vi.waitFor(() => {
      expect(mockGenerateTitle).toHaveBeenCalledWith({
        userMessage: '请帮我分析一下这个模块的覆盖率报告，找出未覆盖的代码行并给出修复建议，需要包含详细的分析过程和具体的代码修改方案',
      });
    });
  });

  it('triggers AI title generation for short substantive first message', async () => {
    // Even short messages like "启动三个subagent分析当前项目" benefit from
    // AI-summarized titles — only low-signal input (greetings, acks) is
    // skipped (by the backend, not the frontend).
    await useSessionStore.getState().createSession('proj_1', '/tmp/proj');
    await useSessionMessagesStore.getState().sendMessage('Hello AI');

    await vi.waitFor(() => {
      expect(mockGenerateTitle).toHaveBeenCalledWith({
        userMessage: 'Hello AI',
      });
    });
  });

  it('renames session with AI-generated title after first message', async () => {
    mockGenerateTitle.mockResolvedValueOnce({ title: 'AI生成的标题' });

    await useSessionStore.getState().createSession('proj_1', '/tmp/proj');
    // Any substantive first message triggers AI title generation
    await useSessionMessagesStore.getState().sendMessage('请帮我分析一下这个模块的覆盖率报告，找出未覆盖的代码行并给出修复建议，需要包含详细的分析过程和具体的代码修改方案');

    // Wait for the async title generation to complete — no agent_end needed
    await vi.waitFor(() => {
      expect(mockGenerateTitle).toHaveBeenCalled();
    });

    // The session should be renamed with the AI-generated title
    await vi.waitFor(() => {
      expect(mockRename).toHaveBeenCalledWith(
        expect.objectContaining({ name: 'AI生成的标题' }),
      );
    });
  });

  it('does not overwrite a non-placeholder name with backend placeholder in ensureRuntimeSession', async () => {
    // Simulate a session that was already renamed (non-placeholder name)
    mockCreate.mockResolvedValueOnce({ sessionId: 'session_custom_1', name: '新会话' });

    await useSessionStore.getState().createSession('proj_1', '/tmp/proj');
    const sessionId = useSessionStore.getState().currentSessionId!;

    // Manually rename the session to a non-placeholder name
    await useSessionStore.getState().renameSession(sessionId, 'proj_1', '我的自定义名称');
    expect(useSessionStore.getState().sessions[0].name).toBe('我的自定义名称');

    // Send a message — this triggers ensureRuntimeSession which calls the backend
    await useSessionMessagesStore.getState().sendMessage('Hello');

    // The backend returned name='新会话' (placeholder), but the session's name
    // should NOT be overwritten because it's already a non-placeholder name.
    expect(useSessionStore.getState().sessions[0].name).toBe('我的自定义名称');
  });

  it('aborts the current session and resets state', async () => {
    await useSessionStore.getState().createSession('proj_1', '/tmp/proj');
    await useSessionMessagesStore.getState().sendMessage('Hello');

    await useSessionMessagesStore.getState().abortSession();

    expect(mockAbort).toHaveBeenCalledWith({ sessionId: 'session_test_1' });
    expect(useSessionStore.getState().sessions[0].status).toBe('idle');
    expect(useSessionStore.getState().sessions[0].status).toBe('idle');
  });

  it('ignores events for unknown sessions', async () => {
    await useSessionStore.getState().createSession('proj_1', '/tmp/proj');

    // This should not throw or modify state
    useSessionMessagesStore.getState().handleSessionEvent('unknown_session', { type: 'message_start' });

    expect(useSessionStore.getState().sessions[0].status).toBe('idle');
  });

  it('tracks context usage and its estimated breakdown from runner events', async () => {
    const id = await useSessionStore.getState().createSession('proj_1', '/tmp/proj');
    useSessionMessagesStore.getState().handleSessionEvent(id!, {
      type: 'context_usage',
      contextUsage: { tokens: 50000, contextWindow: 200000, percent: 25 },
      contextBreakdown: {
        systemPromptTokens: 5000,
        systemToolsTokens: 10000,
        systemContextTokens: 5000,
        skillsTokens: 2000,
        messagesTokens: 28000,
      },
      autoCompactionEnabled: true,
    });

    expect(useSessionStore.getState().sessions[0]).toMatchObject({
      contextUsage: { tokens: 50000, contextWindow: 200000, percent: 25 },
      contextBreakdown: { messagesTokens: 28000, systemToolsTokens: 10000 },
      autoCompactionEnabled: true,
    });
  });

  it('manually compacts an idle session and refreshes context usage', async () => {
    const id = await useSessionStore.getState().createSession('proj_1', '/tmp/proj');
    useSessionStore.setState((state) => ({
      sessions: state.sessions.map((session) => ({
        ...session,
        runtimeSessionId: 'session_test_1',
        contextUsage: { tokens: 90000, contextWindow: 200000, percent: 45 },
      })),
    }));

    const succeeded = await useSessionMessagesStore.getState().compactSession();

    expect(succeeded).toBe(true);
    expect(mockCompact).toHaveBeenCalledWith({ sessionId: 'session_test_1' });
    expect(useSessionStore.getState().sessions.find((session) => session.id === id)).toMatchObject({
      contextCompacted: true,
      contextUsage: { tokens: 12000, contextWindow: 200000, percent: 6 },
    });

    expect(await useSessionMessagesStore.getState().compactSession()).toBe(false);
    expect(mockCompact).toHaveBeenCalledOnce();

    await useSessionMessagesStore.getState().sendMessage('Continue after compaction');
    expect(useSessionStore.getState().sessions.find((session) => session.id === id)?.contextCompacted)
      .toBe(false);
  });

  it('creates and selects an error analysis session for the right panel', () => {
    useSessionStore.getState().addErrorAnalysisSession({
      sessionId: 'session_error_1',
      projectId: 'proj_1',
      caseName: 'core_smoke',
      errorType: 'compile_error',
      initialMessage: '## 仿真失败错误分析请求\n\nError details here',
    });

    const state = useSessionStore.getState();
    expect(state.currentSessionId).toBe('session_error_1');
    expect(state.sessions).toContainEqual(expect.objectContaining({
      id: 'session_error_1',
      runtimeSessionId: 'session_error_1',
      name: '[编译修复] core_smoke',
      status: 'streaming',
    }));
    expect(state.sessions.find((session) => session.id === 'session_error_1')?.messages[0]).toMatchObject({
      role: 'user',
      content: expect.stringContaining('Error details here'),
    });
  });

  it('replays agent events that arrive before the analysis session is announced', () => {
    useSessionMessagesStore.getState().handleSessionEvent('session_error_2', { type: 'message_start' });
    useSessionStore.getState().addErrorAnalysisSession({
      sessionId: 'session_error_2',
      projectId: 'proj_1',
      caseName: 'core_smoke',
      errorType: 'sim_error',
    });

    const session = useSessionStore.getState().sessions.find((item) => item.id === 'session_error_2');
    expect(session?.messages).toHaveLength(2);
    expect(session?.messages[0].role).toBe('user');
    expect(session?.messages[1].role).toBe('assistant');
    expect(session?.status).toBe('streaming');
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

    await useSessionMessagesStore.getState().sendMessage('Continue debugging');

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
          composer: { inputMessage: '', selectedSkills: [], contextFiles: [] },
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

describe('SessionStore — subagent activity (subagent_* frames)', () => {
  let sessionId: string;

  function progressFrame(id: string, recentOutput: string[], parentToolCallId = 'tc_task_1') {
    // 匹配引擎 SubagentProgressPayload 结构：id 在 progress 对象内，
    // payload 顶层没有 id。见 engine/.../task/types.ts + executor.ts emitProgressNow。
    return {
      type: 'subagent_progress',
      payload: {
        index: 0,
        agent: 'analyzer',
        agentSource: 'bundled',
        task: 'analyze coverage',
        parentToolCallId,
        assignment: 'do stuff',
        progress: { id, index: 0, agent: 'analyzer', recentOutput, tokens: 100, status: 'running', task: 'analyze coverage', toolCount: 0, requests: 0, recentTools: [], durationMs: 0, cost: 0 },
      },
    };
  }

  function getSubagent(id: string) {
    const session = useSessionStore.getState().sessions.find((s) => s.id === sessionId);
    return session?.subagents?.[id];
  }

  beforeEach(async () => {
    vi.clearAllMocks();
    useSessionStore.setState({ sessions: [], currentSessionId: null });
    mockCreate.mockResolvedValue({ sessionId: 'session_test_1' });
    sessionId = (await useSessionStore.getState().createSession('proj_1', '/tmp/proj'))!;
  });

  it('accumulates engine scrolling windows into an ordered log (sliding overlap deduped)', () => {
    const store = useSessionMessagesStore.getState();
    // 引擎窗口为倒序（[0] 最新）：帧1 尾部 A,B,C；帧2 滑动到 B,C,D
    store.handleSessionEvent(sessionId, progressFrame('sa-1', ['C', 'B', 'A']));
    store.handleSessionEvent(sessionId, progressFrame('sa-1', ['D', 'C', 'B']));

    expect(getSubagent('sa-1')?.recentOutput).toEqual(['A', 'B', 'C', 'D']);
  });

  it('keeps the accumulated log when the engine clears its window at a new turn', () => {
    const store = useSessionMessagesStore.getState();
    store.handleSessionEvent(sessionId, progressFrame('sa-1', ['B', 'A']));
    // 新一轮 message_start：引擎窗口清空 → 空帧不得冲掉已累积日志
    store.handleSessionEvent(sessionId, progressFrame('sa-1', []));

    expect(getSubagent('sa-1')?.recentOutput).toEqual(['A', 'B']);
  });

  it('appends all lines of a fresh turn output after the window was cleared', () => {
    const store = useSessionMessagesStore.getState();
    store.handleSessionEvent(sessionId, progressFrame('sa-1', ['B', 'A']));
    store.handleSessionEvent(sessionId, progressFrame('sa-1', []));
    // 新一轮输出与旧日志尾部无重叠 → 全部追加
    store.handleSessionEvent(sessionId, progressFrame('sa-1', ['Y', 'X']));

    expect(getSubagent('sa-1')?.recentOutput).toEqual(['A', 'B', 'X', 'Y']);
  });
});

describe('SessionStore — MCP mount notice suppression', () => {
  beforeEach(async () => {
    vi.clearAllMocks();
    useSessionStore.setState({ sessions: [], currentSessionId: null });
    mockCreate.mockResolvedValue({ sessionId: 'session_test_1' });
    await useSessionStore.getState().createSession('proj_1', '/tmp/proj');
  });

  it('suppresses MCP mount notice events (type=notice)', async () => {
    await useSessionMessagesStore.getState().sendMessage('Hello');
    useSessionMessagesStore.getState().handleSessionEvent('session_test_1', {
      type: 'notice',
      message: 'xd://: mounted mcp__codegraph_callees, mcp__codegraph',
    });

    const session = useSessionStore.getState().sessions[0];
    const systemMsgs = session.messages.filter((m) => m.role === 'system');
    expect(systemMsgs).toHaveLength(0);
  });

  it('suppresses MCP mount text arriving via irc_message events', async () => {
    await useSessionMessagesStore.getState().sendMessage('Hello');
    // omp engine may send MCP mount text as an irc_message frame which gets
    // appended directly to the streaming assistant content.
    useSessionMessagesStore.getState().handleSessionEvent('session_test_1', {
      type: 'irc_message',
      message: 'xd://: mounted mcp__codegraph_callees, mcp__codegraph',
    });

    const session = useSessionStore.getState().sessions[0];
    const assistantMsg = session.messages.find((m) => m.role === 'assistant');
    expect(assistantMsg?.content).toBe('');
  });
});

describe('SessionStore — removeMessagesFrom（划选操作条 Discard 恢复原文）', () => {
  beforeEach(async () => {
    vi.clearAllMocks();
    useSessionStore.setState({ sessions: [], currentSessionId: null });
    mockCreate.mockResolvedValue({ sessionId: 'session_test_1' });
    mockGetMessages.mockResolvedValue([]);
    mockGetPersistedSessions.mockResolvedValue([]);
    mockGetStoredMessages.mockResolvedValue([]);
    mockSaveStoredMessages.mockResolvedValue(undefined);
    await useSessionStore.getState().createSession('proj_1', '/tmp/proj');
  });

  it('截断 fromIndex 起的消息、回 idle 并全量持久化', async () => {
    await useSessionMessagesStore.getState().sendMessage('第一问');
    await useSessionMessagesStore.getState().sendMessage('第二问');

    const before = useSessionStore.getState().sessions[0];
    expect(before.messages.length).toBe(4); // user+assistant ×2

    useSessionMessagesStore.getState().removeMessagesFrom(before.id, 2);

    const after = useSessionStore.getState().sessions[0];
    expect(after.messages).toHaveLength(2);
    expect(after.messages[0].content).toBe('第一问');
    expect(after.messages[1].role).toBe('assistant');
    expect(after.status).toBe('idle');
    // 全量覆盖持久化——删除同步到存储
    expect(mockSaveStoredMessages).toHaveBeenCalled();
  });

  it('fromIndex 0 清空全部消息', async () => {
    await useSessionMessagesStore.getState().sendMessage('唯一一问');
    const session = useSessionStore.getState().sessions[0];

    useSessionMessagesStore.getState().removeMessagesFrom(session.id, 0);

    expect(useSessionStore.getState().sessions[0].messages).toHaveLength(0);
  });
});
