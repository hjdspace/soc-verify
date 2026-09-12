// @vitest-environment jsdom
import { describe, expect, it, vi } from 'vitest';
import { createElement } from 'react';
import { fireEvent, render, screen } from '@testing-library/react';
import type { ChatMessage } from '@renderer/stores/session-types';

// Mock thinking-orbs via the visual wrapper so ToolRunGroup's ThinkingOrb renders a testable stub
vi.mock('@renderer/components/visual', () => ({
  ThinkingOrb: (props: { state?: string; size?: number; theme?: string }) =>
    createElement('canvas', {
      'data-testid': 'thinking-orb',
      'data-state': props.state ?? 'working',
      'data-size': String(props.size ?? 64),
      'data-theme': props.theme ?? 'auto',
    }),
}));

vi.mock('@renderer/stores/diff-review', () => ({
  openReviewAwareFile: vi.fn(),
}));

// Session store mock — ToolRunGroup reads pi-subagents live state.
const { mockSessionState } = vi.hoisted(() => ({
  mockSessionState: {
    sessions: [] as Array<{ subagents?: Record<string, unknown> }>,
  },
}));

vi.mock('@renderer/stores/session-core', () => ({
  useSessionCoreStore: Object.assign(
    vi.fn((selector: (state: typeof mockSessionState) => unknown) => selector(mockSessionState)),
    { getState: () => mockSessionState },
  ),
}));

vi.mock('@renderer/stores/workbench', () => ({
  useWorkbenchStore: Object.assign(
    vi.fn(),
    { getState: () => ({ open: vi.fn() }) },
  ),
  openFileDestination: vi.fn(),
}));

vi.mock('@renderer/lib/trpc', () => ({
  trpc: {
    simulation: {
      runInTerminal: { mutate: vi.fn().mockResolvedValue({ terminalId: 'test', cwd: '.', backend: 'log-mode', warning: null }) },
    },
  },
}));

vi.mock('@renderer/stores/project', () => ({
  useProjectStore: Object.assign(
    vi.fn((selector: (state: { currentProjectId: string | null }) => unknown) => selector({ currentProjectId: 'test-project' })),
    { getState: () => ({ currentProjectId: 'test-project' }) },
  ),
}));

vi.mock('@renderer/stores/terminal', () => ({
  useTerminalStore: Object.assign(
    vi.fn(),
    { getState: () => ({ createTabForSession: vi.fn() }) },
  ),
}));

vi.mock('@renderer/stores/toast', () => ({
  useToastStore: Object.assign(
    vi.fn(),
    { getState: () => ({ warning: vi.fn(), error: vi.fn() }) },
  ),
}));

import { ToolRunGroup, groupToolMessages } from '@renderer/components/chat/ToolRunGroup';
import { openReviewAwareFile } from '@renderer/stores/diff-review';

function completedMessage(toolName: string, toolArgs: unknown, result: unknown, idSuffix = ''): ChatMessage {
  return {
    id: `tool-${toolName}${idSuffix}`,
    role: 'tool',
    content: '',
    timestamp: Date.now(),
    toolName,
    toolArgs,
    toolResult: result,
    toolStartTime: Date.now() - 11,
    toolEndTime: Date.now(),
  };
}

function pendingMessage(toolName: string, toolArgs: unknown, idSuffix = ''): ChatMessage {
  return {
    id: `tool-${toolName}${idSuffix}`,
    role: 'tool',
    content: '',
    timestamp: Date.now(),
    toolName,
    toolArgs,
    toolStartTime: Date.now(),
  };
}

describe('groupToolMessages', () => {
  it('groups consecutive tool messages into one run', () => {
    const messages = [
      completedMessage('read', { path: 'a.sv' }, 'content'),
      completedMessage('grep', { pattern: 'x' }, 'matches', '-2'),
    ];
    const items = groupToolMessages(messages);
    expect(items).toHaveLength(1);
    expect(items[0].kind).toBe('run');
    if (items[0].kind === 'run') expect(items[0].messages).toHaveLength(2);
  });

  it('breaks the run at interactive (ask) tool messages', () => {
    const messages = [
      completedMessage('read', { path: 'a.sv' }, 'content'),
      completedMessage('ask', { question: 'continue?' }, 'yes', '-ask'),
      completedMessage('bash', { command: 'ls' }, 'out', '-2'),
    ];
    const items = groupToolMessages(messages);
    expect(items.map((i) => i.kind)).toEqual(['run', 'card', 'run']);
  });

  it('keeps non-tool messages as card items', () => {
    const messages: ChatMessage[] = [
      { id: 'u1', role: 'user', content: 'hi', timestamp: Date.now() },
      completedMessage('read', { path: 'a.sv' }, 'content'),
      { id: 'a1', role: 'assistant', content: 'done', timestamp: Date.now() },
    ];
    const items = groupToolMessages(messages);
    expect(items.map((i) => i.kind)).toEqual(['card', 'run', 'card']);
  });
});

describe('ToolRunGroup rendering', () => {
  it('shows a collapsed header with tool count for a multi-tool run', () => {
    const messages = [
      completedMessage('read', { path: 'a.sv' }, 'content'),
      completedMessage('grep', { pattern: 'x' }, 'matches', '-2'),
    ];
    render(<ToolRunGroup messages={messages} />);
    expect(screen.getByTestId('tool-run-header')).toHaveTextContent('2 个工具调用');
    // 折叠态不挂载行集（懒挂载）：行只在组展开后渲染
    expect(screen.queryAllByTestId('tool-run-row')).toHaveLength(0);
    fireEvent.click(screen.getByTestId('tool-run-header'));
    expect(screen.getAllByTestId('tool-run-row')).toHaveLength(2);
  });

  it('renders a single tool without a group header', () => {
    render(<ToolRunGroup messages={[completedMessage('read', { path: 'a.sv' }, 'content')]} />);
    expect(screen.queryByTestId('tool-run-header')).not.toBeInTheDocument();
    expect(screen.getAllByTestId('tool-run-row')).toHaveLength(1);
  });

  it('renders SubagentCard for a running pi-subagents tool call', () => {
    const message = pendingMessage('subagent', { agent: 'reviewer', task: 'Review the project' });
    message.toolCallId = 'call_pi_subagent_1';
    mockSessionState.sessions = [{
      subagents: {
        'run-pi-1': {
          id: 'run-pi-1',
          index: 0,
          agent: 'reviewer',
          status: 'running',
          parentToolCallId: 'call_pi_subagent_1',
          recentOutput: [],
          toolCount: 0,
          tokens: 0,
          requests: 0,
          tokenHistory: [],
          startedAt: Date.now(),
        },
      },
    }];

    render(<ToolRunGroup messages={[message]} />);
    fireEvent.click(screen.getByTestId('tool-run-row').querySelector('button')!);

    expect(screen.getByTestId('subagent-card')).toBeInTheDocument();
    expect(screen.getByTestId('subagent-tile-run-pi-1')).toHaveTextContent('reviewer');
    mockSessionState.sessions = [];
  });

  it('marks an executing run and expands it by default', () => {
    const messages = [
      completedMessage('read', { path: 'a.sv' }, 'content'),
      pendingMessage('bash', { command: 'make sim' }, '-2'),
    ];
    const { container } = render(<ToolRunGroup messages={messages} />);
    expect(container.querySelector('[data-testid="tool-run-group"]')).toHaveAttribute('data-executing');
    expect(screen.getAllByTestId('thinking-orb').length).toBeGreaterThan(0);
    expect(screen.getByText(/正在执行工具/)).toBeInTheDocument();
  });

  it('expands a row into its specialized body on click', () => {
    const messages = [completedMessage('custom_tool_x', { q: 1 }, 'BODY_MARKER_12345')];
    render(<ToolRunGroup messages={messages} />);
    const rowButton = screen.getAllByTestId('tool-run-row')[0].querySelector('button')!;
    // 行级懒挂载：折叠时展开体不在 DOM（aria-expanded 断言展开行为）
    expect(rowButton).toHaveAttribute('aria-expanded', 'false');
    expect(screen.queryByText('BODY_MARKER_12345')).not.toBeInTheDocument();
    fireEvent.click(rowButton);
    expect(rowButton).toHaveAttribute('aria-expanded', 'true');
    expect(screen.getByText('BODY_MARKER_12345')).toBeInTheDocument();
  });

  it('shows failed count in the header when a tool errors', () => {
    const messages = [
      completedMessage('read', { path: 'a.sv' }, { isError: true, content: 'boom' }),
      completedMessage('grep', { pattern: 'x' }, 'matches', '-2'),
    ];
    render(<ToolRunGroup messages={messages} />);
    expect(screen.getByTestId('tool-run-header')).toHaveTextContent('1 失败');
  });
});

describe('ToolRunGroup diff chips', () => {
  function editMessage(idSuffix = ''): ChatMessage {
    return completedMessage(
      'edit',
      { path: '/proj/dv/tb/timer_top.sv', oldText: 'a', newText: 'b' },
      'edited',
      idSuffix,
    );
  }

  it('renders a diff chip with added/deleted stats after completion', () => {
    render(<ToolRunGroup messages={[editMessage()]} />);
    const chip = screen.getByTestId('tool-diff-chip');
    expect(chip).toHaveTextContent('timer_top.sv');
    expect(chip).toHaveTextContent('+1');
    expect(chip).toHaveTextContent('−1');
  });

  it('previews the line-level diff on hover via a body portal', () => {
    render(<ToolRunGroup messages={[editMessage()]} />);
    fireEvent.mouseEnter(screen.getByTestId('tool-diff-chip'));
    const preview = screen.getByTestId('tool-diff-preview');
    expect(preview).toHaveTextContent('/proj/dv/tb/timer_top.sv');
    expect(preview).toHaveTextContent('b');
  });

  it('opens the file when the chip is clicked', () => {
    render(<ToolRunGroup messages={[editMessage()]} />);
    fireEvent.click(screen.getByTestId('tool-diff-chip'));
    expect(openReviewAwareFile).toHaveBeenCalledWith('/proj/dv/tb/timer_top.sv', 'timer_top.sv');
  });

  it('does not render chips for tools without file edits', () => {
    render(<ToolRunGroup messages={[completedMessage('grep', { pattern: 'x' }, 'matches')]} />);
    expect(screen.queryByTestId('tool-diff-chip')).not.toBeInTheDocument();
  });
});
