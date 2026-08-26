// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createElement } from 'react';
import { render, screen, fireEvent } from '@testing-library/react';
import type { ApprovalRequest } from '@renderer/stores/session-types';

// Mock BorderBeam via the visual wrapper
vi.mock('@renderer/components/visual', () => ({
  BorderBeam: ({ children, ...props }: { children?: React.ReactNode } & Record<string, unknown>) =>
    createElement('div', {
      'data-testid': 'border-beam',
      'data-active': String(props.active ?? true),
      'data-size': props.size ?? 'md',
      'data-colorvariant': props.colorVariant ?? 'colorful',
      'data-theme': props.theme ?? 'dark',
    }, children),
}));

import { ApprovalCard } from '@renderer/components/chat/ApprovalCard';

function makeRequest(overrides: Partial<ApprovalRequest> = {}): ApprovalRequest {
  return {
    requestId: 'req-1',
    sessionId: 's1',
    toolName: 'bash',
    args: { command: 'echo hello' },
    timestamp: Date.now(),
    ...overrides,
  };
}

describe('ApprovalCard BorderBeam 集成', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('BorderBeam 使用 size=pulse-outside, colorVariant=sunset, theme=dark', () => {
    render(<ApprovalCard request={makeRequest()} onResolve={vi.fn()} />);
    const beam = screen.getByTestId('border-beam');
    expect(beam.getAttribute('data-size')).toBe('pulse-outside');
    expect(beam.getAttribute('data-colorvariant')).toBe('sunset');
    expect(beam.getAttribute('data-theme')).toBe('dark');
  });

  it('未审批时 BorderBeam active=true', () => {
    render(<ApprovalCard request={makeRequest()} onResolve={vi.fn()} />);
    const beam = screen.getByTestId('border-beam');
    expect(beam.getAttribute('data-active')).toBe('true');
  });

  it('点击允许后 BorderBeam active=false（光晕淡出）', () => {
    const onResolve = vi.fn();
    render(<ApprovalCard request={makeRequest()} onResolve={onResolve} />);
    const beam = screen.getByTestId('border-beam');
    // Before resolving: active
    expect(beam.getAttribute('data-active')).toBe('true');
    // Click allow button
    fireEvent.click(screen.getByText('允许'));
    // After resolving: inactive (pulse-outside fades out)
    expect(beam.getAttribute('data-active')).toBe('false');
  });

  it('点击拒绝后 BorderBeam active=false（光晕淡出）', () => {
    const onResolve = vi.fn();
    render(<ApprovalCard request={makeRequest()} onResolve={onResolve} />);
    const beam = screen.getByTestId('border-beam');
    expect(beam.getAttribute('data-active')).toBe('true');
    fireEvent.click(screen.getByText('拒绝'));
    expect(beam.getAttribute('data-active')).toBe('false');
  });
});
