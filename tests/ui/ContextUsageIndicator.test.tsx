// @vitest-environment jsdom
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { ContextUsageIndicator } from '@renderer/components/chat/ContextUsageIndicator';
import type { SessionEntry } from '@renderer/stores/session';

function session(): SessionEntry {
  return {
    id: 'session-1',
    projectId: 'project-1',
    name: 'Context test',
    status: 'idle',
    messages: [],
    composer: { inputMessage: '', selectedSkills: [], contextFiles: [] },
    createdAt: 1,
    model: { provider: 'openai', id: 'model-1', name: 'Model 1' },
    contextUsage: { tokens: 50000, contextWindow: 200000, percent: 25 },
    contextBreakdown: {
      systemPromptTokens: 5000,
      systemToolsTokens: 10000,
      systemContextTokens: 5000,
      skillsTokens: 2000,
      messagesTokens: 28000,
    },
    autoCompactionEnabled: true,
  };
}

describe('ContextUsageIndicator', () => {
  it('shows usage details and estimated context composition', () => {
    render(<ContextUsageIndicator session={session()} onCompact={vi.fn()} />);

    expect(screen.getByLabelText('上下文已使用 25%')).toBeInTheDocument();
    expect(screen.getByText('50k')).toBeInTheDocument();
    expect(screen.getByText('150k')).toBeInTheDocument();
    expect(screen.getByText('28k')).toBeInTheDocument();
    expect(screen.getByText('Model 1')).toBeInTheDocument();
  });

  it('closes the detail popover after manual compaction succeeds', async () => {
    const onCompact = vi.fn().mockResolvedValue(true);
    render(<ContextUsageIndicator session={session()} onCompact={onCompact} />);

    const trigger = screen.getByRole('button', { name: '上下文已使用 25%' });
    fireEvent.click(trigger);
    expect(trigger).toHaveAttribute('aria-expanded', 'true');
    fireEvent.click(screen.getByRole('button', { name: '手动压缩' }));
    await waitFor(() => expect(trigger).toHaveAttribute('aria-expanded', 'false'));
    expect(onCompact).toHaveBeenCalledOnce();
  });

  it('disables manual compaction until a new message is sent', () => {
    render(
      <ContextUsageIndicator
        session={{ ...session(), contextCompacted: true }}
        onCompact={vi.fn().mockResolvedValue(true)}
      />,
    );

    expect(screen.getByRole('button', { name: '手动压缩' })).toBeDisabled();
  });
});
