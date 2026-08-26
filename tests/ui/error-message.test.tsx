// @vitest-environment jsdom
import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { ErrorMessage } from '@renderer/components/chat/ErrorMessage';

describe('ErrorMessage', () => {
  it('renders a structured error card with summary and detail', () => {
    render(
      <ErrorMessage
        content={'[错误] API 请求频率超限（429）：请稍后重试\n\n错误详情：429 inference tpm exhausted'}
      />,
    );

    expect(screen.getByRole('alert')).toBeInTheDocument();
    expect(screen.getByText('请求失败')).toBeInTheDocument();
    expect(screen.getByText('API 请求频率超限（429）：请稍后重试')).toBeInTheDocument();
    expect(screen.getByText('429 inference tpm exhausted')).toBeInTheDocument();
  });

  it('falls back to a readable summary when no detail block exists', () => {
    render(<ErrorMessage content="[错误] 请求失败" />);

    expect(screen.getByTestId('assistant-error-message')).toHaveTextContent('请求失败');
    expect(screen.queryByText('错误详情')).not.toBeInTheDocument();
  });
});
