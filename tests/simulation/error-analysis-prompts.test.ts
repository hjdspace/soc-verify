import { describe, it, expect } from 'vitest';
import { getSystemPrompt, buildPromptMessage } from '../../src/main/simulation/error-analysis-prompts';

describe('error-analysis-prompts', () => {
  describe('getSystemPrompt', () => {
    it('returns compile error prompt for compile_error type', () => {
      const prompt = getSystemPrompt('compile_error');
      expect(prompt).toContain('compilation errors');
      expect(prompt).toContain('runsim_retry');
    });

    it('returns simulation error prompt for sim_error type', () => {
      const prompt = getSystemPrompt('sim_error');
      expect(prompt).toContain('simulation errors');
      expect(prompt).toContain('Do NOT modify any files');
    });
  });

  describe('buildPromptMessage', () => {
    it('includes case name and error type in the message', () => {
      const msg = buildPromptMessage({
        caseName: 'test_uart_tx',
        errorType: 'compile_error',
        errorContext: 'Error: undefined variable foo',
        maxRetries: 3,
      });
      expect(msg).toContain('test_uart_tx');
      expect(msg).toContain('编译错误');
      expect(msg).toContain('undefined variable foo');
    });

    it('includes command when provided', () => {
      const msg = buildPromptMessage({
        caseName: 'test_case',
        errorType: 'sim_error',
        errorContext: 'UVM_ERROR found',
        command: './run.sh -case test_case',
        maxRetries: 3,
      });
      expect(msg).toContain('./run.sh -case test_case');
    });

    it('includes retry instruction for compile errors', () => {
      const msg = buildPromptMessage({
        caseName: 'test_case',
        errorType: 'compile_error',
        errorContext: 'some error',
        maxRetries: 3,
      });
      expect(msg).toContain('runsim_retry');
      expect(msg).toContain('最多重试 3 次');
    });

    it('includes analysis-only instruction for sim errors', () => {
      const msg = buildPromptMessage({
        caseName: 'test_case',
        errorType: 'sim_error',
        errorContext: 'UVM_ERROR found',
        maxRetries: 3,
      });
      expect(msg).toContain('修复建议');
      expect(msg).toContain('不需要修改文件');
    });
  });
});
