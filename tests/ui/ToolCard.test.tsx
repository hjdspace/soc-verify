// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import type { ChatMessage } from '@renderer/stores/session';

vi.mock('@renderer/stores/diff-review', () => ({
  useDiffReviewStore: (selector: (state: { queue: never[] }) => unknown) => selector({ queue: [] }),
}));

import { ToolCard } from '@renderer/components/chat/ToolCard';

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
});
