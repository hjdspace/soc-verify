// @vitest-environment jsdom
import { describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import type { ChatMessage } from '@renderer/stores/session';

vi.mock('@renderer/stores/diff-review', () => ({
  openReviewAwareFile: vi.fn(),
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

describe('ToolCard file tools', () => {
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

    // The status dot should have the warning color class
    const dot = screen.getByTestId('tool-card').querySelector('.bg-warning-foreground');
    expect(dot).not.toBeNull();
  });

  it('shows green status dot for successful edit without warnings', () => {
    render(<ToolCard message={completedMessage(
      'edit',
      { path: 'src/demo.ts', oldText: 'old', newText: 'new' },
      'Edit applied',
    )} />);

    const dot = screen.getByTestId('tool-card').querySelector('.bg-status-pass-foreground');
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
