/**
 * kb-llm-call.test.ts — 统一 LLM 调用层行为测试（issue 08）。
 *
 * 验收：调用结果统一表达文本、结束状态与可获得的 usage；
 * 未知字段不伪造；取消可观察；协议分派（openai chat/responses、
 * anthropic、gemini）与既有分类行为一致。
 */

import { describe, it, expect, vi } from 'vitest';
import { callLlm, LlmCallError, type LlmCallResult } from '../src/main/kb/llm-call';
import type { LlmConfig } from '../src/main/kb/llm-config';

const config: LlmConfig = {
  baseUrl: 'http://localhost:8557',
  apiKey: 'sk-test',
  model: 'test-model',
};

function okResponse(payload: unknown): Response {
  return {
    ok: true,
    status: 200,
    json: async () => payload,
    text: async () => JSON.stringify(payload),
  } as unknown as Response;
}

/** 常量等价：usage 只断言 API 给出的字段，未给出的为 undefined（不伪造 0） */
function expectUsage(
  usage: LlmCallResult['usage'],
  expected: Record<string, number | undefined>,
): void {
  expect(usage).not.toBeNull();
  for (const [key, value] of Object.entries(expected)) {
    if (value === undefined) {
      expect((usage as Record<string, unknown>)[key]).toBeUndefined();
    } else {
      expect((usage as Record<string, unknown>)[key]).toBe(value);
    }
  }
}

describe('callLlm — openai chat/completions', () => {
  it('返回文本、结束状态与 usage', async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      okResponse({
        choices: [{ message: { content: '你好' }, finish_reason: 'stop' }],
        usage: { prompt_tokens: 11, completion_tokens: 7, total_tokens: 18 },
      }),
    );
    const r = await callLlm({ ...config, fetchFn: fetchMock as unknown as typeof fetch }, {
      system: 'sys',
      user: 'user-prompt',
    });
    expect(r.text).toBe('你好');
    expect(r.finishReason).toBe('stop');
    expectUsage(r.usage, { inputTokens: 11, outputTokens: 7, totalTokens: 18 });

    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('http://localhost:8557/chat/completions');
    const headers = init.headers as Record<string, string>;
    expect(headers['Authorization']).toBe('Bearer sk-test');
    const body = JSON.parse(init.body as string) as Record<string, unknown>;
    expect(body['model']).toBe('test-model');
    expect(body['max_tokens']).toBeTypeOf('number');
  });

  it('apiFormat=openai-responses 请求 /responses 并解析 output_text 与 status', async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      okResponse({
        status: 'completed',
        output: [{ type: 'message', content: [{ type: 'output_text', text: '结果文本' }] }],
        usage: { input_tokens: 5, output_tokens: 3 },
      }),
    );
    const r = await callLlm(
      { ...config, apiFormat: 'openai-responses', fetchFn: fetchMock as unknown as typeof fetch },
      { system: 'sys', user: 'p' },
    );
    expect(r.text).toBe('结果文本');
    expect(r.finishReason).toBe('completed');
    expectUsage(r.usage, { inputTokens: 5, outputTokens: 3, totalTokens: undefined });
    expect((fetchMock.mock.calls[0] as unknown[])[0]).toBe('http://localhost:8557/responses');
  });

  it('usage 缺失时为 null，finishReason 缺失时为 null（未知字段不伪造）', async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      okResponse({ choices: [{ message: { content: 'x' } }] }),
    );
    const r = await callLlm({ ...config, fetchFn: fetchMock as unknown as typeof fetch }, {
      system: 's',
      user: 'u',
    });
    expect(r.text).toBe('x');
    expect(r.finishReason).toBeNull();
    expect(r.usage).toBeNull();
  });
});

describe('callLlm — anthropic', () => {
  it('走 /messages + x-api-key，返回 stop_reason 与 usage', async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      okResponse({
        content: [{ type: 'text', text: 'claude 回复' }],
        stop_reason: 'end_turn',
        usage: { input_tokens: 9, output_tokens: 4 },
      }),
    );
    const r = await callLlm(
      { ...config, providerId: 'anthropic', fetchFn: fetchMock as unknown as typeof fetch },
      { system: 'sys', user: 'p' },
    );
    expect(r.text).toBe('claude 回复');
    expect(r.finishReason).toBe('end_turn');
    expectUsage(r.usage, { inputTokens: 9, outputTokens: 4, totalTokens: undefined });

    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('http://localhost:8557/messages');
    const headers = init.headers as Record<string, string>;
    expect(headers['x-api-key']).toBe('sk-test');
    expect(headers['anthropic-version']).toBe('2023-06-01');
  });
});

describe('callLlm — gemini', () => {
  it('走 v1beta generateContent + key 查询参数，返回 finishReason 与 usageMetadata', async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      okResponse({
        candidates: [{ content: { parts: [{ text: 'gemini 回复' }] }, finishReason: 'STOP' }],
        usageMetadata: { promptTokenCount: 8, candidatesTokenCount: 2, totalTokenCount: 10 },
      }),
    );
    const r = await callLlm(
      { ...config, providerId: 'google', fetchFn: fetchMock as unknown as typeof fetch },
      { system: 'sys', user: 'p' },
    );
    expect(r.text).toBe('gemini 回复');
    expect(r.finishReason).toBe('STOP');
    expectUsage(r.usage, { inputTokens: 8, outputTokens: 2, totalTokens: 10 });
    expect((fetchMock.mock.calls[0] as unknown[])[0]).toContain('/v1beta/models/test-model:generateContent?key=sk-test');
  });
});

describe('callLlm — 失败与取消', () => {
  it('非 200 抛 LlmCallError：429/5xx 可重试，4xx 不可重试，错误含状态码', async () => {
    for (const [status, retryable] of [[429, true], [500, true], [400, false]] as const) {
      const fetchMock = vi.fn().mockResolvedValue({
        ok: false,
        status,
        text: async () => 'boom',
      } as unknown as Response);
      const err = await callLlm({ ...config, fetchFn: fetchMock as unknown as typeof fetch }, {
        system: 's',
        user: 'u',
      }).catch((e: unknown) => e);
      expect(err).toBeInstanceOf(LlmCallError);
      expect((err as LlmCallError).retryable).toBe(retryable);
      expect((err as LlmCallError).message).toContain(String(status));
    }
  });

  it('200 但非 JSON（网关 HTML 错误页）抛可重试错误', async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      text: async () => '<html>Bad Gateway</html>',
    } as unknown as Response);
    const err = await callLlm({ ...config, fetchFn: fetchMock as unknown as typeof fetch }, {
      system: 's',
      user: 'u',
    }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(LlmCallError);
    expect((err as LlmCallError).retryable).toBe(true);
    expect((err as LlmCallError).message).toContain('不是有效 JSON');
  });

  it('无法提取文本时抛格式异常错误（可重试）', async () => {
    const fetchMock = vi.fn().mockResolvedValue(okResponse({ choices: [] }));
    const err = await callLlm({ ...config, fetchFn: fetchMock as unknown as typeof fetch }, {
      system: 's',
      user: 'u',
    }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(LlmCallError);
    expect((err as LlmCallError).retryable).toBe(true);
    expect((err as LlmCallError).message).toContain('格式异常');
  });

  it('外部 signal 已中止时直接取消，不发起请求', async () => {
    const fetchMock = vi.fn();
    const controller = new AbortController();
    controller.abort();
    await expect(
      callLlm({ ...config, fetchFn: fetchMock as unknown as typeof fetch }, {
        system: 's',
        user: 'u',
        signal: controller.signal,
      }),
    ).rejects.toThrow();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('请求中途取消（外部 signal）→ 抛可重试取消错误', async () => {
    const controller = new AbortController();
    const fetchMock = vi.fn().mockImplementation(
      (_url: string, init: RequestInit) =>
        new Promise((_resolve, reject) => {
          init.signal?.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')));
        }),
    );
    const pending = callLlm({ ...config, fetchFn: fetchMock as unknown as typeof fetch }, {
      system: 's',
      user: 'u',
      signal: controller.signal,
    });
    controller.abort();
    const err = await pending.catch((e: unknown) => e);
    expect(err).toBeInstanceOf(LlmCallError);
    expect((err as LlmCallError).retryable).toBe(true);
  });
});
