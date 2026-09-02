/**
 * Log Scanner Paths 模块测试。
 *
 * 测试缝：路径解析函数（纯函数，无副作用）。
 * 验证 claude-code / codex 日志路径探测逻辑，包括环境变量覆盖。
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { normalize } from 'node:path';

// ─── Import ─────────────────────────────────────────────────

import {
  resolveClaudeLogDir,
  resolveCodexLogDir,
  discoverJsonlFiles,
} from '../../src/main/token-monitor/log-scanner-paths';

// ─── Tests ─────────────────────────────────────────────────

describe('log-scanner-paths — resolveClaudeLogDir', () => {
  const originalEnv = process.env;

  beforeEach(() => {
    process.env = { ...originalEnv };
    delete process.env.CLAUDE_CONFIG_DIR;
  });

  afterEach(() => {
    process.env = originalEnv;
  });

  it('默认返回 ~/.claude/projects', () => {
    const dir = resolveClaudeLogDir();
    expect(dir).toBe(join(homedir(), '.claude', 'projects'));
  });

  it('CLAUDE_CONFIG_DIR 环境变量覆盖', () => {
    process.env.CLAUDE_CONFIG_DIR = '/custom/claude-config';
    const dir = resolveClaudeLogDir();
    expect(dir).toBe(normalize('/custom/claude-config/projects'));
  });
});

describe('log-scanner-paths — resolveCodexLogDir', () => {
  const originalEnv = process.env;

  beforeEach(() => {
    process.env = { ...originalEnv };
    delete process.env.CODEX_HOME;
  });

  afterEach(() => {
    process.env = originalEnv;
  });

  it('默认返回 ~/.codex/sessions', () => {
    const dir = resolveCodexLogDir();
    expect(dir).toBe(join(homedir(), '.codex', 'sessions'));
  });

  it('CODEX_HOME 环境变量覆盖', () => {
    process.env.CODEX_HOME = '/custom/codex-home';
    const dir = resolveCodexLogDir();
    expect(dir).toBe(normalize('/custom/codex-home/sessions'));
  });
});

describe('log-scanner-paths — discoverJsonlFiles', () => {
  it('空目录返回空数组', () => {
    const result = discoverJsonlFiles('/nonexistent/path/that/does/not/exist');
    expect(result).toEqual([]);
  });

  it('返回空数组而非抛出异常（静默降级）', () => {
    expect(() => discoverJsonlFiles('/definitely/not/real')).not.toThrow();
  });
});
