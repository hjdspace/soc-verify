// @vitest-environment jsdom
import { render, screen } from '@testing-library/react';
import { describe, it, expect } from 'vitest';
import type { CompileError } from '@shared/types';
import { CompileErrorView } from '@renderer/components/simulation/views/CompileErrorView';

/**
 * CompileErrorView 测试：
 * - 无 runId 时显示"无选中的运行"
 * - 空 errors 显示"无编译错误"
 * - 渲染错误列表（severity badge、文件:行号、消息）
 * - error 和 warning 两种 severity 的样式区分
 */

function makeError(partial: Partial<CompileError> & { file: string; line: number }): CompileError {
  return {
    severity: 'error',
    message: 'Syntax error',
    ...partial,
  };
}

describe('CompileErrorView', () => {
  it('runId 为 null 时显示无选中运行', () => {
    render(<CompileErrorView errors={[]} runId={null} />);
    expect(screen.getByText('无选中的运行')).toBeTruthy();
  });

  it('errors 为空时显示无编译错误', () => {
    render(<CompileErrorView errors={[]} runId="run-1" />);
    expect(screen.getByText('无编译错误')).toBeTruthy();
  });

  it('渲染错误列表并显示计数', () => {
    const errors = [
      makeError({ file: 'top.sv', line: 42, message: 'Syntax error' }),
      makeError({ file: 'mid.sv', line: 10, message: 'Type mismatch' }),
    ];
    render(<CompileErrorView errors={errors} runId="run-abc123" />);
    // Header text is split across elements by JSX whitespace, use getAllByText
    expect(screen.getAllByText((_, node) => !!node?.textContent?.includes('编译错误') && !!node?.textContent?.includes('abc123')).length).toBeGreaterThanOrEqual(1);
    expect(screen.getByText('2 项')).toBeTruthy();
    expect(screen.getByText('top.sv:42')).toBeTruthy();
    expect(screen.getByText('Syntax error')).toBeTruthy();
    expect(screen.getByText('mid.sv:10')).toBeTruthy();
    expect(screen.getByText('Type mismatch')).toBeTruthy();
  });

  it('显示 error severity badge', () => {
    const errors = [makeError({ file: 'top.sv', line: 1, message: 'fail' })];
    render(<CompileErrorView errors={errors} runId="run-1" />);
    expect(screen.getByText('error')).toBeTruthy();
  });

  it('显示 warning severity badge', () => {
    const errors = [makeError({ file: 'top.sv', line: 1, message: 'warn', severity: 'warning' })];
    render(<CompileErrorView errors={errors} runId="run-1" />);
    expect(screen.getByText('warning')).toBeTruthy();
  });

  it('显示 column 信息', () => {
    const errors = [makeError({ file: 'top.sv', line: 1, column: 15, message: 'err' })];
    render(<CompileErrorView errors={errors} runId="run-1" />);
    expect(screen.getByText(':15')).toBeTruthy();
  });
});
