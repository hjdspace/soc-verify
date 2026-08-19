/**
 * 多目录支持 — AI system prompt 注入测试。
 *
 * 覆盖场景（来自 issue acceptance criteria）：
 * - system prompt 包含所有额外目录的路径
 * - system prompt 包含分组信息（验证 / 设计）
 * - system prompt 包含 cwd 标记
 * - system prompt 包含使用绝对路径提示
 * - 无额外目录时不追加多目录说明
 */
import { describe, it, expect } from 'vitest';
import { buildMultiDirSystemPrompt } from '../../src/main/agent/multi-dir-prompt';
import type { ExtraDirEntry, ProjectInfo } from '@shared/types';

function makeProject(overrides: Partial<ProjectInfo> = {}): ProjectInfo {
  return {
    id: 'proj_test',
    name: 'test-project',
    rootPath: '/home/user/verify-env',
    createdAt: Date.now(),
    lastOpenedAt: Date.now(),
    ...overrides,
  };
}

function makeDir(overrides: Partial<ExtraDirEntry> = {}): ExtraDirEntry {
  return {
    id: `dir_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
    path: '/home/user/some-dir',
    group: 'verify',
    isCwd: false,
    order: 0,
    createdAt: Date.now(),
    ...overrides,
  };
}

describe('multi-dir system prompt: buildMultiDirSystemPrompt', () => {
  it('returns null when project has no extraDirs', () => {
    const project = makeProject();
    const result = buildMultiDirSystemPrompt(project, '');
    expect(result).toBeNull();
  });

  it('returns null when extraDirs is empty array', () => {
    const project = makeProject({ extraDirs: [] });
    const result = buildMultiDirSystemPrompt(project, '');
    expect(result).toBeNull();
  });

  it('includes all extra dir paths in the prompt', () => {
    const dir1 = makeDir({ id: 'dir_1', path: '/home/user/ip2soc', group: 'verify', order: 0 });
    const dir2 = makeDir({ id: 'dir_2', path: '/home/user/soc-rtl', group: 'design', order: 0 });
    const project = makeProject({
      rootPath: '/home/user/verify-env',
      extraDirs: [dir1, dir2],
    });

    const result = buildMultiDirSystemPrompt(project, '');
    expect(result).not.toBeNull();
    expect(result!).toContain('/home/user/ip2soc');
    expect(result!).toContain('/home/user/soc-rtl');
  });

  it('includes verify group section with rootPath', () => {
    const dir1 = makeDir({ id: 'dir_1', path: '/home/user/ip2soc', group: 'verify', order: 0 });
    const project = makeProject({
      rootPath: '/home/user/verify-env',
      extraDirs: [dir1],
    });

    const result = buildMultiDirSystemPrompt(project, '');
    expect(result).not.toBeNull();
    expect(result!).toContain('验证');
    expect(result!).toContain('/home/user/verify-env');
    expect(result!).toContain('/home/user/ip2soc');
  });

  it('includes design group section', () => {
    const dir1 = makeDir({ id: 'dir_1', path: '/home/user/soc-rtl', group: 'design', order: 0 });
    const project = makeProject({
      rootPath: '/home/user/verify-env',
      extraDirs: [dir1],
    });

    const result = buildMultiDirSystemPrompt(project, '');
    expect(result).not.toBeNull();
    expect(result!).toContain('设计');
    expect(result!).toContain('/home/user/soc-rtl');
  });

  it('marks cwd directory with [cwd] tag', () => {
    const dir1 = makeDir({ id: 'dir_1', path: '/home/user/ip2soc', group: 'verify', isCwd: true, order: 0 });
    const project = makeProject({
      rootPath: '/home/user/verify-env',
      extraDirs: [dir1],
    });

    const result = buildMultiDirSystemPrompt(project, '/home/user/ip2soc');
    expect(result).not.toBeNull();
    expect(result!).toContain('[cwd]');
    expect(result!).toContain('/home/user/ip2soc');
  });

  it('marks rootPath as cwd when no extraDir has isCwd=true', () => {
    const dir1 = makeDir({ id: 'dir_1', path: '/home/user/ip2soc', group: 'verify', isCwd: false, order: 0 });
    const project = makeProject({
      rootPath: '/home/user/verify-env',
      extraDirs: [dir1],
    });

    const result = buildMultiDirSystemPrompt(project, '/home/user/verify-env');
    expect(result).not.toBeNull();
    expect(result!).toContain('[cwd]');
    expect(result!).toContain('/home/user/verify-env');
  });

  it('includes absolute path access hint', () => {
    const dir1 = makeDir({ id: 'dir_1', path: '/home/user/ip2soc', group: 'verify', order: 0 });
    const project = makeProject({
      rootPath: '/home/user/verify-env',
      extraDirs: [dir1],
    });

    const result = buildMultiDirSystemPrompt(project, '');
    expect(result).not.toBeNull();
    expect(result!).toMatch(/绝对路径|absolute path/i);
  });

  it('appends to existing user systemPrompt', () => {
    const dir1 = makeDir({ id: 'dir_1', path: '/home/user/ip2soc', group: 'verify', order: 0 });
    const project = makeProject({
      rootPath: '/home/user/verify-env',
      extraDirs: [dir1],
    });

    const userPrompt = 'You are a helpful SoC verification assistant.';
    const result = buildMultiDirSystemPrompt(project, userPrompt);
    expect(result).not.toBeNull();
    expect(result!).toContain(userPrompt);
    expect(result!).toContain('/home/user/ip2soc');
  });

  it('uses label when available instead of raw path in listing', () => {
    const dir1 = makeDir({ id: 'dir_1', path: '/home/user/ip2soc', group: 'verify', label: 'IP2SOC', order: 0 });
    const project = makeProject({
      rootPath: '/home/user/verify-env',
      extraDirs: [dir1],
    });

    const result = buildMultiDirSystemPrompt(project, '');
    expect(result).not.toBeNull();
    expect(result!).toContain('IP2SOC');
    expect(result!).toContain('/home/user/ip2soc');
  });
});
