import { describe, it, expect, vi, beforeEach } from 'vitest';

const resolveKbLlmConfig = vi.fn();

vi.mock('../../src/main/kb/llm-config', () => ({
  resolveKbLlmConfig: (...args: unknown[]) => resolveKbLlmConfig(...args),
  protocolForProvider: (providerId: string) => {
    if (providerId === 'anthropic') return 'anthropic';
    if (providerId === 'google') return 'gemini';
    return 'openai';
  },
}));

import {
  parseFollowUpSuggestions,
  generateFollowUpSuggestions,
  MAX_FOLLOW_UPS,
} from '../../src/main/agent/followup-generator';

describe('parseFollowUpSuggestions 建议解析', () => {
  it('解析纯 JSON 数组并去重', () => {
    expect(parseFollowUpSuggestions('["把失败用例加入回归","打开对应波形","把失败用例加入回归"]')).toEqual([
      '把失败用例加入回归',
      '打开对应波形',
    ]);
  });

  it('容忍 markdown 围栏与前后多余文字', () => {
    const raw = '好的，以下是建议：\n```json\n["查看覆盖率报告","对比两次仿真结果"]\n```\n以上。';
    expect(parseFollowUpSuggestions(raw)).toEqual(['查看覆盖率报告', '对比两次仿真结果']);
  });

  it('JSON 解析失败时回退到引号字符串提取', () => {
    const raw = '建议如下：\n- "先检查复位时序"\n- "再看时钟域交叉"';
    expect(parseFollowUpSuggestions(raw)).toEqual(['先检查复位时序', '再看时钟域交叉']);
  });

  it('过滤非字符串与空白项，上限 3 条，超长截断', () => {
    const long = '这'.repeat(120);
    const raw = JSON.stringify([null, '  ', long, '短建议', 'a', 'b', 'c']);
    const result = parseFollowUpSuggestions(raw);
    expect(result).toHaveLength(MAX_FOLLOW_UPS);
    expect(result[0]).toBe(`${'这'.repeat(80)}…`);
    expect(result[1]).toBe('短建议');
  });

  it('空输入与无效输出返回空数组', () => {
    expect(parseFollowUpSuggestions(null)).toEqual([]);
    expect(parseFollowUpSuggestions('')).toEqual([]);
    expect(parseFollowUpSuggestions('模型拒绝回答，没有数组也没有引号字符串')).toEqual([]);
  });
});

describe('generateFollowUpSuggestions 轻量生成', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  function makeFetchReturning(content: string) {
    return vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ choices: [{ message: { content } }] }),
    });
  }

  it('通过 openai 兼容协议调用并解析建议', async () => {
    const fetchFn = makeFetchReturning('["追问一","追问二"]');
    resolveKbLlmConfig.mockResolvedValue({
      providerId: 'openai',
      baseUrl: 'https://api.example.com/v1/',
      apiKey: 'sk-test',
      model: 'gpt-test',
      fetchFn,
    });

    const result = await generateFollowUpSuggestions('第一问', '第一答');

    expect(result).toEqual(['追问一', '追问二']);
    expect(fetchFn).toHaveBeenCalledTimes(1);
    const [url, init] = fetchFn.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('https://api.example.com/v1/chat/completions');
    const body = JSON.parse(String(init.body)) as { messages: Array<{ content: string }> };
    expect(JSON.stringify(body.messages)).toContain('第一问');
  });

  it('无可用凭证配置时返回空数组', async () => {
    resolveKbLlmConfig.mockResolvedValue(null);
    const result = await generateFollowUpSuggestions('问', '答');
    expect(result).toEqual([]);
  });

  it('请求失败时返回空数组（不抛错）', async () => {
    resolveKbLlmConfig.mockResolvedValue({
      providerId: 'openai',
      baseUrl: 'https://api.example.com/v1',
      apiKey: 'sk-test',
      model: 'gpt-test',
      fetchFn: vi.fn().mockRejectedValue(new Error('network down')),
    });
    const result = await generateFollowUpSuggestions('问', '答');
    expect(result).toEqual([]);
  });

  it('HTTP 非 2xx 响应返回空数组', async () => {
    resolveKbLlmConfig.mockResolvedValue({
      providerId: 'openai',
      baseUrl: 'https://api.example.com/v1',
      apiKey: 'sk-test',
      model: 'gpt-test',
      fetchFn: vi.fn().mockResolvedValue({ ok: false, status: 500, text: async () => 'boom' }),
    });
    const result = await generateFollowUpSuggestions('问', '答');
    expect(result).toEqual([]);
  });
});
