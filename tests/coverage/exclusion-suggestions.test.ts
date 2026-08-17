/**
 * AI Exclusion 建议解析测试（ADR 0026 决策 1 / 工单 07）。
 *
 * 覆盖：
 * - parseExclusionSuggestions：正常块解析（file/line 与 bin 两种 selector 形态）/
 *   缺 reason 跳过 / 无代码块返回空 / 畸形 JSON 容错 / confidence 越界跳过 /
 *   状态与来源固定 pending + ai-triage
 * - buildExclusionPromptSection：包含输出约定（dead_code 条件、reason 必填、
 *   只建议不排除的安全底线、代码块格式）
 */

import { describe, it, expect } from 'vitest';
import {
  parseExclusionSuggestions,
  buildExclusionPromptSection,
  EXCLUSION_REQUESTED_BY,
} from '../../src/main/coverage/exclusion-suggestions';

const VALID_BLOCK = `
triage 结论：连续两轮 delta 低于阈值，根因为 dead_code。

\`\`\`exclusion-suggestions
[
  {
    "module": "top/cpu_core",
    "metric": "line",
    "file": "rtl/cpu_core.sv",
    "line": 142,
    "reason": "该分支受 power-down 门控，正常功能模式下不可达",
    "confidence": 0.86
  },
  {
    "module": "top/memory_ctrl",
    "metric": "functional",
    "bin": "err_inject.bin_backdoor",
    "reason": "backdoor 注入路径仅验证平台自检使用",
    "confidence": 0.92
  }
]
\`\`\`

以上建议等待人工审批。
`;

describe('parseExclusionSuggestions', () => {
  it('解析正常块：file/line 与 bin 两种 selector 形态', () => {
    const result = parseExclusionSuggestions(VALID_BLOCK);
    expect(result).toHaveLength(2);

    expect(result[0].module).toBe('top/cpu_core');
    expect(result[0].metric).toBe('line');
    expect(result[0].file).toBe('rtl/cpu_core.sv');
    expect(result[0].line).toBe(142);
    expect(result[0].reason).toContain('不可达');
    expect(result[0].confidence).toBeCloseTo(0.86);

    expect(result[1].module).toBe('top/memory_ctrl');
    expect(result[1].metric).toBe('functional');
    expect(result[1].bin).toBe('err_inject.bin_backdoor');
    expect(result[1].file).toBeUndefined();
    expect(result[1].confidence).toBeCloseTo(0.92);
  });

  it('解析结果状态固定 pending、来源固定 ai-triage', () => {
    const result = parseExclusionSuggestions(VALID_BLOCK);
    for (const s of result) {
      expect(s.status).toBe('pending');
      expect(s.requestedBy).toBe('ai-triage');
      expect(EXCLUSION_REQUESTED_BY).toBe('ai-triage');
    }
  });

  it('缺 reason 的条目被跳过，其余正常保留', () => {
    const text = `
\`\`\`exclusion-suggestions
[
  { "module": "top/a", "metric": "line", "file": "a.sv", "line": 10, "confidence": 0.9 },
  { "module": "top/b", "metric": "branch", "file": "b.sv", "line": 20, "reason": "dead code", "confidence": 0.8 }
]
\`\`\`
`;
    const result = parseExclusionSuggestions(text);
    expect(result).toHaveLength(1);
    expect(result[0].module).toBe('top/b');
  });

  it('reason 为空白字符串同样跳过', () => {
    const text = `
\`\`\`exclusion-suggestions
[
  { "module": "top/a", "metric": "line", "file": "a.sv", "line": 1, "reason": "   ", "confidence": 0.9 }
]
\`\`\`
`;
    expect(parseExclusionSuggestions(text)).toEqual([]);
  });

  it('无 exclusion-suggestions 块返回空数组', () => {
    expect(parseExclusionSuggestions('没有建议的普通 AI 回复')).toEqual([]);
    expect(parseExclusionSuggestions('')).toEqual([]);
    // 普通代码块不算
    expect(parseExclusionSuggestions('```json\n[{"module": "x"}]\n```')).toEqual([]);
  });

  it('块内畸形 JSON 容错返回空数组（不抛错）', () => {
    const text = `
\`\`\`exclusion-suggestions
[{ "module": "top/a", "metric":
\`\`\`
`;
    expect(parseExclusionSuggestions(text)).toEqual([]);
  });

  it('JSON 非数组（对象）容错返回空数组', () => {
    const text = `
\`\`\`exclusion-suggestions
{ "module": "top/a" }
\`\`\`
`;
    expect(parseExclusionSuggestions(text)).toEqual([]);
  });

  it('confidence 越界（>1 / <0 / 非数值）跳过该条', () => {
    const text = `
\`\`\`exclusion-suggestions
[
  { "module": "top/a", "metric": "line", "file": "a.sv", "line": 1, "reason": "r", "confidence": 1.5 },
  { "module": "top/b", "metric": "line", "file": "b.sv", "line": 2, "reason": "r", "confidence": -0.1 },
  { "module": "top/c", "metric": "line", "file": "c.sv", "line": 3, "reason": "r", "confidence": "high" },
  { "module": "top/ok", "metric": "line", "file": "ok.sv", "line": 4, "reason": "r", "confidence": 1 }
]
\`\`\`
`;
    const result = parseExclusionSuggestions(text);
    expect(result).toHaveLength(1);
    expect(result[0].module).toBe('top/ok');
    expect(result[0].confidence).toBe(1);
  });

  it('metric 非法 / selector 两种形态均缺失跳过该条', () => {
    const text = `
\`\`\`exclusion-suggestions
[
  { "module": "top/a", "metric": "coverage", "file": "a.sv", "line": 1, "reason": "r", "confidence": 0.5 },
  { "module": "top/b", "metric": "line", "reason": "r", "confidence": 0.5 },
  { "module": "top/c", "metric": "line", "file": "c.sv", "reason": "r", "confidence": 0.5 },
  { "module": "top/ok", "metric": "toggle", "bin": "b1", "reason": "r", "confidence": 0.5 }
]
\`\`\`
`;
    const result = parseExclusionSuggestions(text);
    expect(result).toHaveLength(1);
    expect(result[0].module).toBe('top/ok');
  });
});

describe('buildExclusionPromptSection', () => {
  it('包含输出条件（仅 dead_code / 不可达根因）与 reason 必填约束', () => {
    const section = buildExclusionPromptSection();
    expect(section).toContain('dead_code');
    expect(section).toContain('不可达');
    expect(section).toContain('必填');
    expect(section).toContain('reason');
  });

  it('包含代码块格式约定（exclusion-suggestions）与字段说明', () => {
    const section = buildExclusionPromptSection();
    expect(section).toContain('exclusion-suggestions');
    expect(section).toContain('module');
    expect(section).toContain('metric');
    expect(section).toContain('confidence');
    expect(section).toContain('"confidence"');
  });

  it('包含安全底线：AI 只能建议、不能自称已排除', () => {
    const section = buildExclusionPromptSection();
    expect(section).toContain('只能提出建议');
    expect(section).toContain('不能声称已完成排除');
    expect(section).toContain('人工审批');
  });
});
