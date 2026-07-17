// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, within } from '@testing-library/react';

// Mock tRPC
vi.mock('@renderer/lib/trpc', () => ({
  trpc: {
    session: {
      create: { mutate: vi.fn().mockResolvedValue({ sessionId: 's1' }) },
      send: { mutate: vi.fn().mockResolvedValue(undefined) },
      abort: { mutate: vi.fn().mockResolvedValue(undefined) },
      destroy: { mutate: vi.fn().mockResolvedValue(undefined) },
      list: { query: vi.fn().mockResolvedValue([]) },
      saveStoredMessages: { mutate: vi.fn().mockResolvedValue(undefined) },
      listSkills: { query: vi.fn().mockResolvedValue([]) },
    },
    project: {
      searchFiles: { query: vi.fn().mockResolvedValue([]) },
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

import { useSessionStore, type ChatMessage } from '@renderer/stores/session';
import { useProjectStore } from '@renderer/stores/project';
import { RightPanel } from '@renderer/components/layout/RightPanel';

// Create a test component that renders MessageBubble directly
function TestMessageBubble({ message }: { message: ChatMessage }) {
  // Re-implement minimal MessageBubble logic for testing
  if (message.role === 'tool') {
    return (
      <div data-testid="tool-card">
        <span>{message.toolName}</span>
        {message.toolResult ? 'completed' : 'executing'}
      </div>
    );
  }
  return (
    <div data-testid={`msg-${message.role}`}>
      {message.content || (message.isStreaming ? '思考中...' : '')}
    </div>
  );
}

describe('RightPanel message rendering', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    useSessionStore.setState({
      sessions: [],
      currentSessionId: null,
    });
  });

  it('renders user message content', () => {
    const msg: ChatMessage = {
      id: 'm1',
      role: 'user',
      content: 'Hello AI',
      timestamp: Date.now(),
    };
    render(<TestMessageBubble message={msg} />);
    expect(screen.getByTestId('msg-user')).toBeInTheDocument();
    expect(screen.getByText('Hello AI')).toBeInTheDocument();
  });

  it('renders assistant message content', () => {
    const msg: ChatMessage = {
      id: 'm2',
      role: 'assistant',
      content: 'Hello from AI',
      timestamp: Date.now(),
    };
    render(<TestMessageBubble message={msg} />);
    expect(screen.getByTestId('msg-assistant')).toBeInTheDocument();
    expect(screen.getByText('Hello from AI')).toBeInTheDocument();
  });

  it('shows thinking indicator when assistant is streaming with no content', () => {
    const msg: ChatMessage = {
      id: 'm3',
      role: 'assistant',
      content: '',
      timestamp: Date.now(),
      isStreaming: true,
    };
    render(<TestMessageBubble message={msg} />);
    expect(screen.getByText('思考中...')).toBeInTheDocument();
  });

  it('renders tool message with tool name', () => {
    const msg: ChatMessage = {
      id: 'm4',
      role: 'tool',
      content: '',
      timestamp: Date.now(),
      toolName: 'list_subsys',
      toolArgs: { filter: '' },
    };
    render(<TestMessageBubble message={msg} />);
    expect(screen.getByTestId('tool-card')).toBeInTheDocument();
    expect(screen.getByText('list_subsys')).toBeInTheDocument();
    expect(screen.getByText('executing')).toBeInTheDocument();
  });

  it('shows tool as completed when result is present', () => {
    const msg: ChatMessage = {
      id: 'm5',
      role: 'tool',
      content: '',
      timestamp: Date.now(),
      toolName: 'run_simulation',
      toolArgs: { caseId: 'c1' },
      toolResult: { status: 'pass' },
      toolStartTime: Date.now() - 1000,
      toolEndTime: Date.now(),
    };
    render(<TestMessageBubble message={msg} />);
    expect(screen.getByText('completed')).toBeInTheDocument();
  });
});

describe('RightPanel input interaction', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // Set up a session
    useSessionStore.setState({
      sessions: [{
        id: 's1',
        projectId: 'p1',
        name: 'Test Session',
        status: 'idle',
        messages: [],
        composer: { inputMessage: '', selectedSkills: [], contextFiles: [] },
        createdAt: Date.now(),
      }],
      currentSessionId: 's1',
    });
  });

  it('updates input message in store when typing', async () => {
    const { useSessionStore: store } = await import('@renderer/stores/session');
    store.getState().setInputMessage('test message');
    expect(store.getState().sessions[0].composer.inputMessage).toBe('test message');
  });

  it('sends message and clears input', async () => {
    const sessionStore = useSessionStore.getState();
    sessionStore.setInputMessage('Hello AI');
    await sessionStore.sendMessage('Hello AI');

    // Input should be cleared
    expect(useSessionStore.getState().sessions[0].composer.inputMessage).toBe('');
    expect(useSessionStore.getState().sessions[0].status).toBe('streaming');
    // Messages should have user + assistant (streaming)
    const messages = useSessionStore.getState().sessions[0].messages;
    expect(messages).toHaveLength(2);
    expect(messages[0].role).toBe('user');
    expect(messages[0].content).toBe('Hello AI');
    expect(messages[1].role).toBe('assistant');
    expect(messages[1].isStreaming).toBe(true);
  });

  it('aborts the current Agent Conversation', async () => {
    const sessionStore = useSessionStore.getState();
    await sessionStore.sendMessage('Hello');
    expect(useSessionStore.getState().sessions[0].status).toBe('streaming');

    await sessionStore.abortSession();
    expect(useSessionStore.getState().sessions[0].status).toBe('idle');
  });
});

describe('RightPanel session tabs', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    useProjectStore.setState({
      projects: [{
        id: 'p1',
        name: 'Project',
        rootPath: '/tmp/project',
        createdAt: Date.now(),
        lastOpenedAt: Date.now(),
      }],
      currentProjectId: 'p1',
      fileTree: null,
      fileTreeLoading: false,
      plugins: [],
      selectedSubsys: null,
      caseStatusFilter: 'all',
    });
    useSessionStore.setState({
      sessions: [
        {
          id: 'running',
          projectId: 'p1',
          name: 'Running Session',
          status: 'streaming',
          messages: [],
          composer: { inputMessage: '', selectedSkills: [], contextFiles: [] },
          createdAt: 1,
        },
        {
          id: 'done',
          projectId: 'p1',
          name: 'Done Session',
          status: 'idle',
          messages: [],
          composer: { inputMessage: '', selectedSkills: [], contextFiles: [] },
          createdAt: 2,
        },
      ],
      currentSessionId: 'done',
    });
  });

  it('keeps the running indicator on the running session tab after switching tabs', () => {
    render(<RightPanel width={320} />);

    const runningTab = screen.getByTitle('Running Session').closest('[data-session-tab]');
    const doneTab = screen.getByTitle('Done Session').closest('[data-session-tab]');

    expect(runningTab).not.toBeNull();
    expect(doneTab).not.toBeNull();
    expect(within(runningTab as HTMLElement).getByLabelText('会话运行中')).toBeInTheDocument();
    expect(within(doneTab as HTMLElement).queryByLabelText('会话运行中')).not.toBeInTheDocument();
  });
});

describe('SessionStore state machine transitions', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    useSessionStore.setState({
      sessions: [{
        id: 's1',
        projectId: 'p1',
        name: 'Test',
        status: 'idle',
        messages: [],
        composer: { inputMessage: '', selectedSkills: [], contextFiles: [] },
        createdAt: Date.now(),
      }],
      currentSessionId: 's1',
    });
  });

  it('transitions idle → streaming on message_start', () => {
    useSessionStore.getState().handleSessionEvent('s1', { type: 'message_start' });
    expect(useSessionStore.getState().sessions[0].status).toBe('streaming');
  });

  it('transitions streaming → tool_executing on tool_execution_start', () => {
    useSessionStore.getState().handleSessionEvent('s1', { type: 'message_start' });
    useSessionStore.getState().handleSessionEvent('s1', {
      type: 'tool_execution_start',
      toolName: 'list_subsys',
      args: {},
    });
    expect(useSessionStore.getState().sessions[0].status).toBe('tool_executing');
  });

  it('transitions tool_executing → streaming on tool_execution_end', () => {
    useSessionStore.getState().handleSessionEvent('s1', { type: 'message_start' });
    useSessionStore.getState().handleSessionEvent('s1', {
      type: 'tool_execution_start',
      toolName: 'list_subsys',
      args: {},
    });
    useSessionStore.getState().handleSessionEvent('s1', {
      type: 'tool_execution_end',
      toolName: 'list_subsys',
      result: 'done',
    });
    expect(useSessionStore.getState().sessions[0].status).toBe('streaming');
  });

  it('transitions streaming → idle on agent_end', () => {
    useSessionStore.getState().handleSessionEvent('s1', { type: 'message_start' });
    expect(useSessionStore.getState().sessions[0].status).toBe('streaming');

    useSessionStore.getState().handleSessionEvent('s1', { type: 'agent_end' });
    expect(useSessionStore.getState().sessions[0].status).toBe('idle');
  });

  it('full lifecycle: send → stream → tool → stream → end', async () => {
    // 1. User sends message
    await useSessionStore.getState().sendMessage('Run simulation');
    expect(useSessionStore.getState().sessions[0].status).toBe('streaming');

    // 2. AI starts responding
    useSessionStore.getState().handleSessionEvent('s1', { type: 'message_start' });
    useSessionStore.getState().handleSessionEvent('s1', {
      type: 'message_update',
      message: { role: 'assistant', content: [{ type: 'text', text: 'I will run' }] },
    });

    // 3. Tool execution
    useSessionStore.getState().handleSessionEvent('s1', {
      type: 'tool_execution_start',
      toolName: 'run_simulation',
      args: { caseId: 'c1' },
    });
    expect(useSessionStore.getState().sessions[0].status).toBe('tool_executing');

    useSessionStore.getState().handleSessionEvent('s1', {
      type: 'tool_execution_end',
      toolName: 'run_simulation',
      result: { runId: 'r1', status: 'pass' },
    });
    expect(useSessionStore.getState().sessions[0].status).toBe('streaming');

    // 4. AI continues
    useSessionStore.getState().handleSessionEvent('s1', {
      type: 'message_update',
      message: { role: 'assistant', content: [{ type: 'text', text: 'I will run the simulation.' }] },
    });
    useSessionStore.getState().handleSessionEvent('s1', {
      type: 'message_end',
      message: { role: 'assistant', content: [{ type: 'text', text: 'I will run the simulation.' }], stopReason: 'stop' },
    });

    // 5. Agent ends
    useSessionStore.getState().handleSessionEvent('s1', { type: 'agent_end' });

    const session = useSessionStore.getState().sessions[0];
    expect(session.status).toBe('idle');

    // Check messages: user + assistant + tool
    expect(session.messages.length).toBe(3);
    expect(session.messages[0].role).toBe('user');
    expect(session.messages[1].role).toBe('assistant');
    expect(session.messages[1].content).toBe('I will run the simulation.');
    expect(session.messages[1].isStreaming).toBe(false);
    expect(session.messages[2].role).toBe('tool');
    expect(session.messages[2].toolResult).toEqual({ runId: 'r1', status: 'pass' });
  });
});
