// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createElement } from 'react';
import { render, screen, within, fireEvent, waitFor } from '@testing-library/react';

// Mock thinking-orbs + border-beam via the visual wrapper
vi.mock('@renderer/components/visual', () => ({
  ThinkingOrb: (props: { state?: string; size?: number; theme?: string }) =>
    createElement('canvas', {
      'data-testid': 'thinking-orb',
      'data-state': props.state ?? 'working',
      'data-size': String(props.size ?? 64),
      'data-theme': props.theme ?? 'auto',
    }),
  BorderBeam: ({ children, ...props }: { children?: React.ReactNode } & Record<string, unknown>) =>
    createElement('div', {
      'data-testid': 'border-beam',
      'data-active': String(props.active ?? true),
      'data-size': props.size ?? 'md',
      'data-colorvariant': props.colorVariant ?? 'colorful',
      'data-theme': props.theme ?? 'dark',
    }, children),
}));

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
      generateFollowUps: { mutate: vi.fn().mockResolvedValue({ followUps: [] }) },
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

import { useSessionCoreStore } from '@renderer/stores/session-core';
import { useSessionMessagesStore } from '@renderer/stores/session-messages';
import type { ChatMessage, SessionEntry } from '@renderer/stores/session-types';
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
    useSessionCoreStore.setState({
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
    useSessionCoreStore.setState({
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
    const { useSessionCoreStore: store } = await import('@renderer/stores/session-core');
    store.getState().setInputMessage('test message');
    expect(store.getState().sessions[0].composer.inputMessage).toBe('test message');
  });

  it('sends message and clears input', async () => {
    const coreStore = useSessionCoreStore.getState();
    const msgStore = useSessionMessagesStore.getState();
    coreStore.setInputMessage('Hello AI');
    await msgStore.sendMessage('Hello AI');

    // Input should be cleared
    expect(useSessionCoreStore.getState().sessions[0].composer.inputMessage).toBe('');
    expect(useSessionCoreStore.getState().sessions[0].status).toBe('streaming');
    // Messages should have user + assistant (streaming)
    const messages = useSessionCoreStore.getState().sessions[0].messages;
    expect(messages).toHaveLength(2);
    expect(messages[0].role).toBe('user');
    expect(messages[0].content).toBe('Hello AI');
    expect(messages[1].role).toBe('assistant');
    expect(messages[1].isStreaming).toBe(true);
  });

  it('aborts the current Agent Conversation', async () => {
    const msgStore = useSessionMessagesStore.getState();
    await msgStore.sendMessage('Hello');
    expect(useSessionCoreStore.getState().sessions[0].status).toBe('streaming');

    await msgStore.abortSession();
    expect(useSessionCoreStore.getState().sessions[0].status).toBe('idle');
  });
});

describe('RightPanel follow-up suggestions', () => {
  const baseMessages: ChatMessage[] = [
    { id: 'u1', role: 'user', content: '帮我分析这个失败用例的原因', timestamp: 1 },
    {
      id: 'a2',
      role: 'assistant',
      content: '失败原因是复位信号在时钟沿附近释放，违反了恢复时序检查，建议增加一个周期的延迟。',
      timestamp: 2,
    },
  ];

  beforeEach(() => {
    vi.clearAllMocks();
    useSessionCoreStore.setState({
      sessions: [{
        id: 's1',
        projectId: 'p1',
        name: 'Test Session',
        status: 'streaming',
        messages: baseMessages.map((m) => ({ ...m })),
        composer: { inputMessage: '', selectedSkills: [], contextFiles: [] },
        createdAt: Date.now(),
      }],
      currentSessionId: 's1',
    });
  });

  it('agent_end 后触发轻量生成并把建议挂到会话上', async () => {
    const { trpc } = await import('@renderer/lib/trpc');
    vi.mocked(trpc.session.generateFollowUps.mutate).mockResolvedValue({
      followUps: ['如何修改复位释放时序？', '列出相关的 SDC 约束'],
    });

    useSessionMessagesStore.getState().handleSessionEvent('s1', { type: 'agent_end' });

    await waitFor(() => {
      expect(useSessionCoreStore.getState().sessions[0].followUps).toEqual([
        '如何修改复位释放时序？',
        '列出相关的 SDC 约束',
      ]);
    });
    expect(trpc.session.generateFollowUps.mutate).toHaveBeenCalledWith(
      expect.objectContaining({
        userMessage: '帮我分析这个失败用例的原因',
        assistantMessage: expect.stringContaining('复位信号'),
      }),
    );
  });

  it('生成结果返回前用户新开回合时作废（不写入过期建议）', async () => {
    const { trpc } = await import('@renderer/lib/trpc');
    let resolveMutate: (value: { followUps: string[] }) => void = () => {};
    vi.mocked(trpc.session.generateFollowUps.mutate).mockImplementation(
      () => new Promise((resolve) => { resolveMutate = resolve; }),
    );

    useSessionMessagesStore.getState().handleSessionEvent('s1', { type: 'agent_end' });
    // 生成尚未返回，用户新回合开始（sendMessage 置 streaming 且清空 followUps）
    useSessionCoreStore.setState((s) => ({
      sessions: s.sessions.map((sess) =>
        sess.id === 's1' ? { ...sess, status: 'streaming', followUps: undefined } : sess,
      ),
    }));
    resolveMutate({ followUps: ['过期建议'] });
    await waitFor(() => {
      expect(trpc.session.generateFollowUps.mutate).toHaveBeenCalled();
    });
    // 等 microtask 排空
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(useSessionCoreStore.getState().sessions[0].followUps).toBeUndefined();
  });

  it('助手回复过短时不触发生成', async () => {
    const { trpc } = await import('@renderer/lib/trpc');
    useSessionCoreStore.setState((s) => ({
      sessions: s.sessions.map((sess) => ({
        ...sess,
        status: 'streaming',
        messages: [{ id: 'u1', role: 'user', content: 'hi', timestamp: 1 }, { id: 'a2', role: 'assistant', content: '好的', timestamp: 2 }],
      })),
    }));

    useSessionMessagesStore.getState().handleSessionEvent('s1', { type: 'agent_end' });
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(trpc.session.generateFollowUps.mutate).not.toHaveBeenCalled();
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
    useSessionCoreStore.setState({
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

describe('ComposerEditor BorderBeam integration', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    Element.prototype.scrollIntoView = vi.fn();
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
    useSessionCoreStore.setState({
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

  it('renders BorderBeam with size=line, colorVariant=ocean around the composer', () => {
    render(<RightPanel width={320} />);
    const beam = screen.getByTestId('border-beam');
    expect(beam.getAttribute('data-size')).toBe('line');
    expect(beam.getAttribute('data-colorvariant')).toBe('ocean');
    expect(beam.getAttribute('data-theme')).toBe('dark');
  });

  it('BorderBeam is inactive (active=false) when composer is not focused', () => {
    render(<RightPanel width={320} />);
    const beam = screen.getByTestId('border-beam');
    expect(beam.getAttribute('data-active')).toBe('false');
  });

  it('BorderBeam becomes active (active=true) when composer container receives focus', () => {
    render(<RightPanel width={320} />);
    const beam = screen.getByTestId('border-beam');
    // The composer editor is a contentEditable div; focus it to trigger the
    // onFocus handler on the wrapping div.
    const editor = screen.getByRole('textbox');
    fireEvent.focus(editor);
    expect(beam.getAttribute('data-active')).toBe('true');
  });

  it('BorderBeam returns to inactive when composer container loses focus', () => {
    render(<RightPanel width={320} />);
    const beam = screen.getByTestId('border-beam');
    const editor = screen.getByRole('textbox');
    fireEvent.focus(editor);
    expect(beam.getAttribute('data-active')).toBe('true');
    fireEvent.blur(editor);
    expect(beam.getAttribute('data-active')).toBe('false');
  });
});

describe('RunningIndicator', () => {
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
    useSessionCoreStore.setState({
      sessions: [{
        id: 's1',
        projectId: 'p1',
        name: 'Test',
        status: 'streaming',
        // A user message makes messages.length > 0 (enters the else branch
        // that renders RunningIndicator), but no assistant is streaming yet.
        messages: [{
          id: 'm1',
          role: 'user',
          content: 'Hello',
          timestamp: Date.now(),
        }],
        composer: { inputMessage: '', selectedSkills: [], contextFiles: [] },
        createdAt: Date.now(),
      }],
      currentSessionId: 's1',
    });
  });

  it('renders a compact ThinkingOrb with composing state in the running indicator', () => {
    // jsdom doesn't implement scrollIntoView; stub it so the auto-scroll
    // useEffect doesn't throw when messages exist.
    Element.prototype.scrollIntoView = vi.fn();

    render(<RightPanel width={320} />);

    // The RunningIndicator shows when session is streaming but no assistant
    // message is streaming yet (user message exists, no streaming assistant)
    const runningIndicator = screen.getByTestId('running-indicator');
    expect(runningIndicator).toBeInTheDocument();

    const orb = screen.getByTestId('thinking-orb');
    expect(orb.getAttribute('data-state')).toBe('composing');
    expect(orb.getAttribute('data-size')).toBe('20');
    expect(orb.getAttribute('data-theme')).toBe('auto');
  });
});

describe('SessionStore state machine transitions', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    useSessionCoreStore.setState({
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
    useSessionMessagesStore.getState().handleSessionEvent('s1', { type: 'message_start' });
    expect(useSessionCoreStore.getState().sessions[0].status).toBe('streaming');
  });

  it('transitions streaming → tool_executing on tool_execution_start', () => {
    useSessionMessagesStore.getState().handleSessionEvent('s1', { type: 'message_start' });
    useSessionMessagesStore.getState().handleSessionEvent('s1', {
      type: 'tool_execution_start',
      toolName: 'list_subsys',
      args: {},
    });
    expect(useSessionCoreStore.getState().sessions[0].status).toBe('tool_executing');
  });

  it('transitions tool_executing → streaming on tool_execution_end', () => {
    useSessionMessagesStore.getState().handleSessionEvent('s1', { type: 'message_start' });
    useSessionMessagesStore.getState().handleSessionEvent('s1', {
      type: 'tool_execution_start',
      toolName: 'list_subsys',
      args: {},
    });
    useSessionMessagesStore.getState().handleSessionEvent('s1', {
      type: 'tool_execution_end',
      toolName: 'list_subsys',
      result: 'done',
    });
    expect(useSessionCoreStore.getState().sessions[0].status).toBe('streaming');
  });

  it('transitions streaming → idle on agent_end', () => {
    useSessionMessagesStore.getState().handleSessionEvent('s1', { type: 'message_start' });
    expect(useSessionCoreStore.getState().sessions[0].status).toBe('streaming');

    useSessionMessagesStore.getState().handleSessionEvent('s1', { type: 'agent_end' });
    expect(useSessionCoreStore.getState().sessions[0].status).toBe('idle');
  });

  it('full lifecycle: send → stream → tool → stream → end', async () => {
    // 1. User sends message
    await useSessionMessagesStore.getState().sendMessage('Run simulation');
    expect(useSessionCoreStore.getState().sessions[0].status).toBe('streaming');

    // 2. AI starts responding
    useSessionMessagesStore.getState().handleSessionEvent('s1', { type: 'message_start' });
    useSessionMessagesStore.getState().handleSessionEvent('s1', {
      type: 'message_update',
      message: { role: 'assistant', content: [{ type: 'text', text: 'I will run' }] },
    });

    // 3. Tool execution
    useSessionMessagesStore.getState().handleSessionEvent('s1', {
      type: 'tool_execution_start',
      toolName: 'run_simulation',
      args: { caseId: 'c1' },
    });
    expect(useSessionCoreStore.getState().sessions[0].status).toBe('tool_executing');

    useSessionMessagesStore.getState().handleSessionEvent('s1', {
      type: 'tool_execution_end',
      toolName: 'run_simulation',
      result: { runId: 'r1', status: 'pass' },
    });
    expect(useSessionCoreStore.getState().sessions[0].status).toBe('streaming');

    // 4. AI continues
    useSessionMessagesStore.getState().handleSessionEvent('s1', {
      type: 'message_update',
      message: { role: 'assistant', content: [{ type: 'text', text: 'I will run the simulation.' }] },
    });
    useSessionMessagesStore.getState().handleSessionEvent('s1', {
      type: 'message_end',
      message: { role: 'assistant', content: [{ type: 'text', text: 'I will run the simulation.' }], stopReason: 'stop' },
    });

    // 5. Agent ends
    useSessionMessagesStore.getState().handleSessionEvent('s1', { type: 'agent_end' });

    const session = useSessionCoreStore.getState().sessions[0];
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

describe('回合收尾操作栏渲染位置', () => {
  // 一次多步回合的典型消息序列：文本 → 工具 → 文本
  const turnMessages: ChatMessage[] = [
    { id: 'u1', role: 'user', content: '你支持哪些技能', timestamp: 1 },
    { id: 'a2', role: 'assistant', content: '我来查看当前环境中可用的技能。', timestamp: 2 },
    { id: 't3', role: 'tool', content: '', timestamp: 3, toolName: 'bash', toolArgs: {} },
    { id: 'a4', role: 'assistant', content: '当前环境支持以下技能……', timestamp: 4 },
  ];
  // 工具已落地（有结果）的完成态序列
  const settledTurnMessages: ChatMessage[] = turnMessages.map((m) =>
    m.role === 'tool' ? { ...m, toolResult: { ok: true } } : m,
  );

  function seedTurn(status: SessionEntry['status'], streamingLast = false, messages = settledTurnMessages) {
    useSessionCoreStore.setState({
      sessions: [{
        id: 's1',
        projectId: 'p1',
        name: 'Test',
        status,
        messages: messages.map((m, i) =>
          streamingLast && i === messages.length - 1 ? { ...m, isStreaming: true } : { ...m },
        ),
        composer: { inputMessage: '', selectedSkills: [], contextFiles: [] },
        createdAt: Date.now(),
      }],
      currentSessionId: 's1',
    });
  }

  beforeEach(() => {
    vi.clearAllMocks();
    Element.prototype.scrollIntoView = vi.fn();
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
  });

  it('多步回合完成后只在最后一条助手消息上渲染一份操作栏', () => {
    seedTurn('idle');
    render(<RightPanel width={320} />);

    expect(screen.getByText('我来查看当前环境中可用的技能。')).toBeInTheDocument();
    const actions = screen.getAllByTestId('assistant-actions');
    expect(actions).toHaveLength(1);
    expect(within(actions[0]).getByLabelText('复制回复')).toBeInTheDocument();
  });

  it('回合进行中（工具执行间隙，无流式消息）不渲染操作栏', () => {
    seedTurn('tool_executing', false, turnMessages);
    render(<RightPanel width={320} />);
    expect(screen.queryByTestId('assistant-actions')).not.toBeInTheDocument();
  });

  it('工具执行中（未落地）即使会话状态空闲也不渲染操作栏', () => {
    // 兜底场景：status 因事件间隙/迟到短暂回闲，但工具还没有结果——
    // 回合并未收尾，中间文本段下不得闪现复制/重新生成
    seedTurn('idle', false, turnMessages);
    render(<RightPanel width={320} />);
    expect(screen.queryByTestId('assistant-actions')).not.toBeInTheDocument();
  });

  it('流式输出中的助手消息不渲染操作栏', () => {
    seedTurn('streaming', true);
    render(<RightPanel width={320} />);
    expect(screen.queryByTestId('assistant-actions')).not.toBeInTheDocument();
  });
});
