// @vitest-environment jsdom
import { describe, expect, it, vi } from 'vitest';
import { createElement } from 'react';
import { fireEvent, render, screen } from '@testing-library/react';
import type { ChatMessage, SubagentActivity } from '@renderer/stores/session-types';

// Mock thinking-orbs via the visual wrapper so ToolCard's ThinkingOrb renders a testable stub
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

// Session store mock — ToolCard 读取 subagent 实时状态（task 工具）
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

import { ToolCard } from '@renderer/components/chat/ToolCard';
import { openReviewAwareFile } from '@renderer/stores/diff-review';

function completedMessage(toolName: string, toolArgs: unknown, result: unknown): ChatMessage {
  return {
    id: `tool-${toolName}`,
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

function pendingMessage(toolName: string, toolArgs: unknown): ChatMessage {
  return {
    id: `tool-${toolName}`,
    role: 'tool',
    content: '',
    timestamp: Date.now(),
    toolName,
    toolArgs,
    toolStartTime: Date.now(),
  };
}

describe('ToolCard file tools', () => {
  it('shows a spinner and writing state before write arguments finish streaming', () => {
    render(<ToolCard message={pendingMessage(
      'write',
      { path: 'src/demo.ts' },
    )} />);

    const card = screen.getByTestId('tool-card');
    expect(card.querySelector('[data-status="running"]')).not.toBeNull();
    expect(card.textContent).toContain('writing...');
    expect(screen.queryByText(/^\+\d+$/)).not.toBeInTheDocument();
  });

  it('renders ThinkingOrb with working state for file tools while running', () => {
    render(<ToolCard message={pendingMessage(
      'write',
      { path: 'src/demo.ts' },
    )} />);

    const orb = screen.getByTestId('thinking-orb');
    expect(orb.getAttribute('data-state')).toBe('working');
    expect(orb.getAttribute('data-size')).toBe('20');
    expect(orb.getAttribute('data-theme')).toBe('auto');
  });

  it('renders ThinkingOrb with searching state for grep tool while running', () => {
    render(<ToolCard message={pendingMessage(
      'grep',
      { pattern: 'test' },
    )} />);

    const orb = screen.getByTestId('thinking-orb');
    expect(orb.getAttribute('data-state')).toBe('searching');
    expect(orb.getAttribute('data-size')).toBe('20');
  });

  it('renders ThinkingOrb with solving state for bash tool while running', () => {
    render(<ToolCard message={pendingMessage(
      'bash',
      { command: 'echo test' },
    )} />);

    const orb = screen.getByTestId('thinking-orb');
    expect(orb.getAttribute('data-state')).toBe('solving');
    expect(orb.getAttribute('data-size')).toBe('20');
  });

  it('renders ThinkingOrb with solving state in executing placeholder when expanded', () => {
    render(<ToolCard message={pendingMessage(
      'list_subsys',
      { filter: '' },
    )} />);

    fireEvent.click(screen.getByTitle('展开'));
    const orbs = screen.getAllByTestId('thinking-orb');
    // First orb is the header running indicator (host tool = working),
    // second orb is the executing placeholder (solving)
    const placeholderOrb = orbs.find((o) => o.getAttribute('data-state') === 'solving');
    expect(placeholderOrb).toBeDefined();
    expect(placeholderOrb?.getAttribute('data-size')).toBe('20');
  });

  it('renders read_file path in the summary and file content when expanded', () => {
    render(<ToolCard message={completedMessage(
      'read_file',
      { path: 'src/renderer/src/lib/runsim-command.ts' },
      { content: [{ type: 'text', text: 'const command = "runsim";' }] },
    )} />);

    expect(screen.getByText('.../lib/runsim-command.ts')).toBeInTheDocument();
    fireEvent.click(screen.getByTitle('展开'));

    expect(screen.getByTestId('tool-card').textContent).toContain('const command = "runsim";');
    expect(screen.queryByText('ARGS')).not.toBeInTheDocument();
  });

  it('renders write content as added lines', () => {
    render(<ToolCard message={completedMessage(
      'write',
      { path: 'src/demo.ts', content: 'const value = 1;' },
      'File written',
    )} />);

    fireEvent.click(screen.getByTitle('展开'));
    expect(screen.getByTestId('tool-card').textContent).toContain('const value = 1;');
    expect(screen.getByText('+')).toBeInTheDocument();
  });

  it('shows write diff statistics after completion', () => {
    render(<ToolCard message={completedMessage(
      'write',
      { path: 'src/demo.ts', content: 'const first = 1;\nconst second = 2;' },
      {
        content: [{ type: 'text', text: 'File written' }],
        details: { fileExistedBefore: false },
      },
    )} />);

    expect(screen.getByText('+2')).toHaveClass('text-status-pass-foreground');
    expect(screen.getByText('-0')).toHaveClass('text-destructive');
  });

  it('shows edit diff statistics after completion', () => {
    render(<ToolCard message={completedMessage(
      'edit',
      {
        path: 'src/demo.ts',
        oldText: 'const first = 1;\nconst second = 2;',
        newText: 'const first = 1;\nconst second = 3;\nconst third = 4;',
      },
      'Edit applied',
    )} />);

    expect(screen.getByText('+2')).toHaveClass('text-status-pass-foreground');
    expect(screen.getByText('-1')).toHaveClass('text-destructive');
  });

  it('shows overwrite statistics from the write result snapshot', () => {
    render(<ToolCard message={completedMessage(
      'write',
      { path: 'src/demo.ts', content: 'const first = 2;\nconst second = 2;\nconst third = 3;' },
      {
        content: [{ type: 'text', text: 'File written' }],
        details: { beforeContent: 'const first = 1;\nconst second = 2;' },
      },
    )} />);

    expect(screen.getByText('+2')).toHaveClass('text-status-pass-foreground');
    expect(screen.getByText('-1')).toHaveClass('text-destructive');
  });

  it('shows omp edit statistics from result details', () => {
    render(<ToolCard message={completedMessage(
      'edit',
      { path: 'src/demo.ts', input: '[src/demo.ts#TAG]\nSET 2: updated' },
      {
        content: [{ type: 'text', text: 'Edit applied' }],
        details: { diff: ' 1|unchanged\n-2|old\n+2|new\n+3|added' },
      },
    )} />);

    expect(screen.getByText('+2')).toHaveClass('text-status-pass-foreground');
    expect(screen.getByText('-1')).toHaveClass('text-destructive');
  });

  it('aggregates statistics across all edits in one tool call', () => {
    render(<ToolCard message={completedMessage(
      'edit',
      {
        path: 'src/demo.ts',
        edits: [
          { old_text: 'const first = 1;', new_text: 'const first = 2;' },
          { old_text: 'const second = 2;', new_text: 'const second = 2;\nconst third = 3;' },
        ],
      },
      'Edit applied',
    )} />);

    expect(screen.getByText('+2')).toHaveClass('text-status-pass-foreground');
    expect(screen.getByText('-1')).toHaveClass('text-destructive');
  });

  it('renders apply_patch input as a file path and diff', () => {
    render(<ToolCard message={completedMessage(
      'apply_patch',
      { input: '*** Begin Patch\n*** Update File: src/demo.ts\n@@\n-old\n+new\n*** End Patch' },
      'Patch applied',
    )} />);

    expect(screen.getByText('src/demo.ts')).toBeInTheDocument();
    fireEvent.click(screen.getByTitle('展开'));

    const card = screen.getByTestId('tool-card');
    expect(card.textContent).toContain('old');
    expect(card.textContent).toContain('new');
    expect(card.textContent).not.toContain('ARGS');
  });

  it('renders omp edit tool file path extracted from result text', () => {
    render(<ToolCard message={completedMessage(
      'edit',
      { input: '[approval-mode.test.ts#DEBA]\nDEL 42-49\n' },
      '[D:\\doc\\AI\\soc-verify\\tests\\agent\\approval-mode.test.ts#8C05]\n40:// ─── Fixtures ───\n41:\n42:\n43:// ─── Tests ───\n\nWarnings:\nPath "approval-mode.test.ts" does not exist; matched its filename and snapshot tag #DEBA to D:\\doc\\AI\\soc-verify\\tests\\agent\\approval-mode.test.ts (read earlier this session). Anchor future edits on [D:\\doc\\AI\\soc-verify\\tests\\agent\\approval-mode.test.ts#TAG].',
    )} />);

    // The summary should show the file path extracted from result
    expect(screen.getByText('.../agent/approval-mode.test.ts')).toBeInTheDocument();
    // Summary should mention warnings
    expect(screen.getByTestId('tool-card').textContent).toContain('with warnings');
  });

  it('shows warning-colored status dot when result contains Warnings', () => {
    render(<ToolCard message={completedMessage(
      'edit',
      { path: 'src/demo.ts', oldText: 'old', newText: 'new' },
      '[src/demo.ts#TAG]\n1:old\n2:new\n\nWarnings:\nPath "demo.ts" does not exist; matched its filename.',
    )} />);

    // The status dot should have the warning color state
    const dot = screen.getByTestId('tool-card').querySelector('[data-status="warn"]');
    expect(dot).not.toBeNull();
  });

  it('shows green status dot for successful edit without warnings', () => {
    render(<ToolCard message={completedMessage(
      'edit',
      { path: 'src/demo.ts', oldText: 'old', newText: 'new' },
      'Edit applied',
    )} />);

    const dot = screen.getByTestId('tool-card').querySelector('[data-status="ok"]');
    expect(dot).not.toBeNull();
  });

  it('renders omp edit result as code view with warnings when expanded', () => {
    render(<ToolCard message={completedMessage(
      'edit',
      { input: '[test.ts#ABCD]\nDEL 42-49\n' },
      '[D:\\project\\test.ts#TAG]\n40:// code line\n41:\n42:\n43:// more code\n\nWarnings:\nPath "test.ts" does not exist; matched its filename.',
    )} />);

    fireEvent.click(screen.getByTitle('展开'));

    const card = screen.getByTestId('tool-card');
    // Should show file content (not ARGS/RESULT generic view)
    expect(card.textContent).toContain('code line');
    expect(card.textContent).toContain('more code');
    // Should show warnings section
    expect(card.textContent).toContain('Warnings');
    // Should NOT show the generic ARGS section
    expect(card.textContent).not.toContain('"input"');
  });

  it('renders sloppy-mode edit (SM:EDIT input, no #tag header) as a diff when expanded', () => {
    render(<ToolCard message={completedMessage(
      'edit',
      {
        input: '<SM:EDIT path="/proj/view/work/demo.py">\n<SM:FIND>\nif closest_sdf_file:\n    print(msg)\n</SM:FIND>\n<SM:PUT>\nif closest_sdf_file:\n    print(f"found {closest_sdf_file}")\n</SM:PUT>\n</SM:EDIT>',
      },
      // sloppy 模式结果头为 `[绝对路径]`（无 #tag），无 details（旧会话消息）
      { content: [{ type: 'text', text: '[/proj/view/work/demo.py]\n1:if closest_sdf_file:\n2:    print(f"found {closest_sdf_file}")\n' }], details: {} },
    )} />);

    // 折叠摘要应显示文件路径（从无 tag 的结果头提取）
    expect(screen.getByTestId('tool-card').textContent).toContain('demo.py');

    fireEvent.click(screen.getByTitle('展开'));

    const card = screen.getByTestId('tool-card');
    // 应渲染为 diff（FIND/PUT 行级对比），而不是 IN/OUT 兜底
    expect(card.textContent).toContain('print(f"found {closest_sdf_file}")');
    expect(card.textContent).not.toContain('"input"');
    expect(card.textContent).not.toContain('<SM:FIND>');
  });

  it('renders edit detail diff from result details when expanded', () => {
    render(<ToolCard message={completedMessage(
      'edit',
      { input: '[src/demo.ts#TAG]\nSET 2: updated' },
      {
        content: [{ type: 'text', text: '[src/demo.ts]\n1:unchanged\n2:new\n' }],
        details: { path: 'src/demo.ts', diff: ' 1|unchanged\n-2|old\n+2|new\n' },
      },
    )} />);

    fireEvent.click(screen.getByTitle('展开'));

    const card = screen.getByTestId('tool-card');
    expect(card.textContent).toContain('unchanged');
    expect(card.textContent).toContain('new');
    // diff 行不应把编号前缀（` 1|`）当作内容渲染
    expect(card.textContent).not.toContain('1|unchanged');
    expect(card.textContent).not.toContain('"input"');
  });

  it('shows edit file path as clickable link even when not in review queue', () => {
    render(<ToolCard message={completedMessage(
      'edit',
      { path: 'src/demo.ts', oldText: 'old', newText: 'new' },
      'Edit applied',
    )} />);

    // The summary text should be clickable (cursor-pointer)
    const summary = screen.getByTestId('tool-card').querySelector('.cursor-pointer');
    expect(summary).not.toBeNull();
    expect(summary?.textContent).toContain('demo.ts');
  });

  it('shows read_file path as clickable link in the summary', () => {
    render(<ToolCard message={completedMessage(
      'read_file',
      { path: 'src/renderer/src/lib/runsim-command.ts' },
      { content: [{ type: 'text', text: 'const command = "runsim";' }] },
    )} />);

    // The summary path should be clickable (cursor-pointer)
    const summary = screen.getByTestId('tool-card').querySelector('.cursor-pointer');
    expect(summary).not.toBeNull();
    expect(summary?.textContent).toContain('runsim-command.ts');
  });

  it('shows read clickable path header in expanded view', () => {
    render(<ToolCard message={completedMessage(
      'read',
      { path: 'src/demo.ts' },
      'const value = 1;',
    )} />);

    fireEvent.click(screen.getByTitle('展开'));
    const card = screen.getByTestId('tool-card');
    // The expanded body should show a clickable header with the full path
    const clickable = card.querySelectorAll('.cursor-pointer');
    const header = Array.from(clickable).find((el) => el.textContent === 'src/demo.ts');
    expect(header).not.toBeUndefined();
    expect(header?.getAttribute('title')).toContain('点击打开文件');
  });

  it('shows skill badge and skill name when reading skill:// path', () => {
    render(<ToolCard message={completedMessage(
      'read',
      { path: 'skill://soc-tb-diagram' },
      { content: [{ type: 'text', text: '---\nname: soc-tb-diagram\n---\n# SoC 验证环境框图' }] },
    )} />);

    // Should show the skill badge
    expect(screen.getByTestId('skill-badge')).toBeInTheDocument();
    // Summary should show skill name, not the raw skill:// path
    expect(screen.getByTestId('tool-card').textContent).toContain('soc-tb-diagram');
    expect(screen.getByTestId('tool-card').textContent).not.toContain('skill://');
  });

  it('shows skill badge while skill is still loading', () => {
    render(<ToolCard message={pendingMessage(
      'read',
      { path: 'skill://drawio-skill' },
    )} />);

    expect(screen.getByTestId('skill-badge')).toBeInTheDocument();
    expect(screen.getByTestId('tool-card').textContent).toContain('drawio-skill');
    expect(screen.getByTestId('tool-card').textContent).toContain('loading skill');
  });

  it('does not show skill badge for regular file reads', () => {
    render(<ToolCard message={completedMessage(
      'read',
      { path: 'src/demo.ts' },
      'const value = 1;',
    )} />);

    expect(screen.queryByTestId('skill-badge')).not.toBeInTheDocument();
  });

  it('disables read path click when result is a directory listing', () => {
    render(<ToolCard message={completedMessage(
      'read',
      { path: 'src' },
      { content: [{ type: 'text', text: 'src/\n  a.ts\n  b.ts' }], details: { isDirectory: true } },
    )} />);

    // 折叠态：omp read 读目录成功返回目录树（不报错），路径不可点击
    expect(screen.queryByTitle(/点击打开文件/)).toBeNull();

    // 展开态：路径头渲染为纯文本（title 即路径本身）
    fireEvent.click(screen.getByTitle('展开'));
    expect(screen.queryByTitle(/点击打开文件/)).toBeNull();
    expect(screen.getByTitle('src')).not.toBeNull();
  });

  it('opens an edit through the review-aware file entry from summary and expanded path', () => {
    render(<ToolCard message={completedMessage(
      'edit',
      { path: 'D:\\project\\src\\demo.ts', oldText: 'old', newText: 'new' },
      'Edit applied',
    )} />);

    fireEvent.click(screen.getByText('.../src/demo.ts'));
    expect(openReviewAwareFile).toHaveBeenCalledWith('D:\\project\\src\\demo.ts', 'demo.ts');

    fireEvent.click(screen.getByTitle('展开'));
    fireEvent.click(screen.getByText('D:\\project\\src\\demo.ts'));
    expect(openReviewAwareFile).toHaveBeenCalledTimes(2);
  });
});

describe('ToolCard task tool — subagent tiles', () => {
  function agent(partial: Partial<SubagentActivity> & { id: string }): SubagentActivity {
    return {
      index: 0,
      agent: 'test-agent',
      status: 'running',
      recentOutput: [],
      toolCount: 0,
      tokens: 0,
      requests: 0,
      tokenHistory: [],
      startedAt: Date.now(),
      ...partial,
    };
  }

  function setStoreSubagents(subagents: Record<string, SubagentActivity>): void {
    mockSessionState.sessions = [{ subagents }];
  }

  function taskMessage(): ChatMessage {
    return {
      id: 'tool-task-1',
      role: 'tool',
      content: '',
      timestamp: Date.now(),
      toolName: 'task',
      toolCallId: 'tc_task_1',
      toolArgs: { tasks: [{ assignment: 'do stuff' }] },
      toolStartTime: Date.now() - 1000,
    };
  }

  it('shows live subagent summary with running count while executing', () => {
    setStoreSubagents({
      'sa-1': agent({ id: 'sa-1', parentToolCallId: 'tc_task_1', status: 'running' }),
      'sa-2': agent({ id: 'sa-2', parentToolCallId: 'tc_task_1', status: 'completed' }),
    });

    render(<ToolCard message={taskMessage()} />);

    expect(screen.getByTestId('tool-card').textContent).toContain('2 个子代理');
    expect(screen.getByTestId('tool-card').textContent).toContain('1 运行中');
  });

  it('renders SubagentCard tiles instead of TaskBody when live data exists', () => {
    setStoreSubagents({
      'sa-1': agent({
        id: 'sa-1',
        parentToolCallId: 'tc_task_1',
        agent: 'coverage-analyzer',
        currentTool: 'Read cov:///uart',
      }),
    });

    render(<ToolCard message={taskMessage()} />);
    fireEvent.click(screen.getByTitle('展开'));

    expect(screen.getByTestId('subagent-card')).toBeInTheDocument();
    expect(screen.getByTestId('subagent-tile-sa-1')).toBeInTheDocument();
    expect(screen.getByTestId('subagent-tile-sa-1').textContent).toContain('coverage-analyzer');
    expect(screen.getByTestId('subagent-tile-sa-1').textContent).toContain('Read cov:///uart');
  });

  it('falls back to TaskBody when no live subagent data (history restore)', () => {
    setStoreSubagents({});

    render(<ToolCard message={taskMessage()} />);

    // 无实时数据：执行中显示默认 dispatching 摘要，不渲染磁贴
    expect(screen.getByTestId('tool-card').textContent).toContain('dispatching sub-agents');
    expect(screen.queryByTestId('subagent-card')).not.toBeInTheDocument();
  });

  it('ignores subagents belonging to other tool calls', () => {
    setStoreSubagents({
      'sa-other': agent({ id: 'sa-other', parentToolCallId: 'tc_other' }),
    });

    render(<ToolCard message={taskMessage()} />);

    expect(screen.queryByTestId('subagent-card')).not.toBeInTheDocument();
  });

  it('renders recentOutput lines in drawer when tile is clicked', () => {
    setStoreSubagents({
      'sa-1': agent({
        id: 'sa-1',
        parentToolCallId: 'tc_task_1',
        agent: 'coverage-analyzer',
        status: 'running',
        recentOutput: ['Analyzing coverage...', 'Found 3 gaps'],
        assignment: 'Analyze coverage for UART module',
      }),
    });

    render(<ToolCard message={taskMessage()} />);
    fireEvent.click(screen.getByTitle('展开'));

    // Click the tile to open the drawer
    fireEvent.click(screen.getByTestId('subagent-tile-sa-1'));

    // Drawer should be open
    expect(screen.getByTestId('subagent-drawer')).toBeInTheDocument();

    // Drawer should show the assignment
    expect(screen.getByTestId('subagent-assignment').textContent).toContain('Analyze coverage for UART module');

    // Drawer should show the recentOutput lines
    const log = screen.getByTestId('subagent-log');
    expect(log.textContent).toContain('Analyzing coverage...');
    expect(log.textContent).toContain('Found 3 gaps');
  });
});

describe('ToolCard task tool — async running fallback', () => {
  function setStoreSubagents(subagents: Record<string, SubagentActivity>): void {
    mockSessionState.sessions = [{ subagents }];
  }

  /**
   * Real task tool result from session_1787196130609:
   * - content[0].text: "Spawned 3 background agents..." (descriptive text, NOT JSON)
   * - details.progress: 3 sub-tasks with status 'pending'
   * - details.async: { state: 'running', jobId: 'ArchAnalysis', type: 'task' }
   */
  function asyncRunningTaskResult(): unknown {
    return {
      content: [{
        type: 'text',
        text: 'Spawned 3 background agents using task. Each result will be delivered when that agent yields.\n- `ArchAnalysis` (job `ArchAnalysis`) — Source code & architecture analysis\n- `PluginAnalysis` (job `PluginAnalysis`) — Plugins & extensibility analysis\n- `DevOpsAnalysis` (job `DevOpsAnalysis`) — DevOps & CI/CD analysis',
      }],
      details: {
        projectAgentsDir: null,
        results: [],
        totalDurationMs: 0,
        progress: [
          { index: 0, id: 'ArchAnalysis', agent: 'task', agentSource: 'bundled', status: 'pending', task: '...', assignment: '...', description: 'Source code & architecture analysis', recentTools: [], recentOutput: [], toolCount: 0, requests: 0, tokens: 0, cost: 0, durationMs: 0 },
          { index: 1, id: 'PluginAnalysis', agent: 'task', agentSource: 'bundled', status: 'pending', task: '...', assignment: '...', description: 'Plugins & extensibility analysis', recentTools: [], recentOutput: [], toolCount: 0, requests: 0, tokens: 0, cost: 0, durationMs: 0 },
          { index: 2, id: 'DevOpsAnalysis', agent: 'task', agentSource: 'bundled', status: 'pending', task: '...', assignment: '...', description: 'DevOps & CI/CD analysis', recentTools: [], recentOutput: [], toolCount: 0, requests: 0, tokens: 0, cost: 0, durationMs: 0 },
        ],
        async: { state: 'running', jobId: 'ArchAnalysis', type: 'task' },
      },
    };
  }

  function taskMessageWithResult(): ChatMessage {
    return {
      id: 'tool-task-async',
      role: 'tool',
      content: '',
      timestamp: Date.now(),
      toolName: 'task',
      toolCallId: 'tc_task_async',
      toolArgs: { tasks: [{ assignment: 'do stuff' }] },
      toolResult: asyncRunningTaskResult(),
      toolStartTime: Date.now() - 5000,
      toolEndTime: Date.now(),
    };
  }

  it('shows running summary (not done) when details.async.state is running', () => {
    setStoreSubagents({});  // No live subagent data — forces fallback path

    render(<ToolCard message={taskMessageWithResult()} />);

    // Should show "3 个子代理 · 3 运行中", NOT "3/3 done"
    const card = screen.getByTestId('tool-card');
    expect(card.textContent).toContain('3 个子代理');
    expect(card.textContent).toContain('运行中');
    expect(card.textContent).not.toContain('done');
  });

  it('renders SubagentCard tiles from details.progress in expanded body', () => {
    setStoreSubagents({});

    render(<ToolCard message={taskMessageWithResult()} />);
    fireEvent.click(screen.getByTitle('展开'));

    // Should render SubagentCard (tile grid), NOT TaskBody (list)
    expect(screen.getByTestId('subagent-card')).toBeInTheDocument();
    // 3 tiles should be rendered
    const tiles = screen.getAllByTestId(/^subagent-tile-/);
    expect(tiles.length).toBe(3);
    // Tile tooltip should contain the description
    expect(tiles[0].getAttribute('title')).toContain('Source code & architecture analysis');
    expect(tiles[1].getAttribute('title')).toContain('Plugins & extensibility analysis');
    expect(tiles[2].getAttribute('title')).toContain('DevOps & CI/CD analysis');
  });

  it('opens drawer on tile click when using static data from details.progress', () => {
    setStoreSubagents({});

    render(<ToolCard message={taskMessageWithResult()} />);
    fireEvent.click(screen.getByTitle('展开'));

    // Click the first tile
    const tiles = screen.getAllByTestId(/^subagent-tile-/);
    expect(tiles.length).toBe(3);
    fireEvent.click(tiles[0]);

    // Drawer should open
    expect(screen.getByTestId('subagent-drawer')).toBeInTheDocument();
  });

  it('falls back to text parsing with pending (not done) for dispatch lines', () => {
    setStoreSubagents({});

    // Task result with only content text (no details.progress) — simulates
    // older omp versions or incomplete result objects
    const message: ChatMessage = {
      id: 'tool-task-text-only',
      role: 'tool',
      content: '',
      timestamp: Date.now(),
      toolName: 'task',
      toolCallId: 'tc_text_only',
      toolArgs: {},
      toolResult: {
        content: [{
          type: 'text',
          text: 'Spawned 2 background agents.\n- `Agent1` (job `Agent1`) — Task one\n- `Agent2` (job `Agent2`) — Task two',
        }],
      },
      toolStartTime: Date.now() - 1000,
      toolEndTime: Date.now(),
    };

    render(<ToolCard message={message} />);

    // Summary should NOT say "done" — dispatch lines should be pending (not done)
    const card = screen.getByTestId('tool-card');
    expect(card.textContent).toContain('子代理');
    expect(card.textContent).not.toContain('2/2 done');
    expect(card.textContent).not.toContain('2 成功');
  });
});
