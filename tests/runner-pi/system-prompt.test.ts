/**
 * runner-pi/system-prompt.ts —— Effective System Prompt 组装（issue 06）。
 *
 * pi 的默认系统提示词由 DefaultResourceLoader 提供；SoC Verify 的应用规则
 * 与用户自定义提示词通过 loader.appendSystemPrompt 附加在其后。
 * 顺序：pi 默认 prompt → 用户自定义提示词 → SoC Verify 应用规则。
 */
import { describe, expect, it } from 'vitest';
import { buildAppendSystemPrompt, SOCVERIFY_APPEND_SYSTEM_PROMPT } from '../../runner-pi/system-prompt';

describe('buildAppendSystemPrompt', () => {
  it('无自定义提示词时只附加 SoC Verify 应用规则', () => {
    const parts = buildAppendSystemPrompt();
    expect(parts).toEqual([SOCVERIFY_APPEND_SYSTEM_PROMPT]);
    // 规则包含文件编辑约束（与 omp runner 一致的行为约定）
    expect(SOCVERIFY_APPEND_SYSTEM_PROMPT).toContain('edit');
    expect(SOCVERIFY_APPEND_SYSTEM_PROMPT).toContain('write');
  });

  it('有自定义提示词时组合为 [用户提示词, 应用规则]', () => {
    const parts = buildAppendSystemPrompt('总是用中文回复');
    expect(parts).toEqual(['总是用中文回复', SOCVERIFY_APPEND_SYSTEM_PROMPT]);
  });

  it('空白自定义提示词视为未提供', () => {
    expect(buildAppendSystemPrompt('   ')).toEqual([SOCVERIFY_APPEND_SYSTEM_PROMPT]);
    expect(buildAppendSystemPrompt(undefined)).toEqual([SOCVERIFY_APPEND_SYSTEM_PROMPT]);
  });
});
