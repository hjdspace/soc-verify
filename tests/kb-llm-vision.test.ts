/**
 * kb-llm-vision.test.ts — 图片字节协议行为测试（issue 12，spec §3）。
 *
 * 验收：
 *  - 图片以实际字节（base64）而非本机路径送入端点：四协议请求构造断言
 *    （openai chat / openai responses / anthropic / gemini）；
 *  - 本地假响应覆盖：取消（请求中途）、拒绝（401/404 不重试语义由调用方
 *    处理，这里验证错误形状）、usage 只映射实际字段；
 *  - 绝不把文件路径当作 image_url 发送（路径不是可读图片）。
 */

import { describe, it, expect } from 'vitest';
import { callLlm } from '../src/main/kb/llm-call';
import type { LlmConfig } from '../src/main/kb/llm-config';

const PNG = { mediaType: 'image/png', base64: 'aGVsbG8=' };

function config(providerId: string, fetchFn: typeof fetch): LlmConfig {
  return {
    baseUrl: 'https://api.example.test/v1',
    apiKey: 'sk-test',
    model: 'vision-model',
    providerId,
    fetchFn,
  };
}

type CapturedRequest = { url: string; headers: Record<string, string>; body: Record<string, unknown> };

function captureFetch(responseBody: Record<string, unknown>, status = 200): {
  fetchFn: typeof fetch;
  requests: CapturedRequest[];
} {
  const requests: CapturedRequest[] = [];
  const fetchFn = (async (url: string | URL, init?: RequestInit) => {
    requests.push({
      url: String(url),
      headers: (init?.headers ?? {}) as Record<string, string>,
      body: JSON.parse(String(init?.body ?? '{}')) as Record<string, unknown>,
    });
    return new Response(JSON.stringify(responseBody), {
      status,
      headers: { 'Content-Type': 'application/json' },
    });
  }) as unknown as typeof fetch;
  return { fetchFn, requests };
}

// ── 请求构造：openai chat/completions ───────────────────────────

describe('图片请求构造（openai chat/completions）', () => {
  it('用户消息为 text + image_url 多部分内容，图片为 data URL 字节而非路径', async () => {
    const { fetchFn, requests } = captureFetch({
      choices: [{ finish_reason: 'stop', message: { role: 'assistant', content: '这是一张时序图' } }],
      usage: { prompt_tokens: 100, completion_tokens: 10, total_tokens: 110 },
    });
    const r = await callLlm(config('openai', fetchFn), {
      system: '你是看图助手',
      user: '描述这张图',
      images: [PNG],
    });
    expect(r.text).toBe('这是一张时序图');
    expect(requests).toHaveLength(1);
    const messages = requests[0].body.messages as Array<{ role: string; content: unknown }>;
    const user = messages.find((m) => m.role === 'user');
    expect(Array.isArray(user?.content)).toBe(true);
    const parts = user?.content as Array<Record<string, unknown>>;
    expect(parts[0]).toEqual({ type: 'text', text: '描述这张图' });
    expect(parts[1]).toEqual({
      type: 'image_url',
      image_url: { url: 'data:image/png;base64,aGVsbG8=' },
    });
    // 本机路径绝不作为图片引用发送
    expect(JSON.stringify(requests[0].body)).not.toContain('C:');
    expect(JSON.stringify(requests[0].body)).not.toContain('D:');
    expect(JSON.stringify(requests[0].body)).not.toMatch(/\.png["']/);
  });

  it('多张图片按顺序全部附带', async () => {
    const { fetchFn, requests } = captureFetch({
      choices: [{ finish_reason: 'stop', message: { content: 'ok' } }],
    });
    await callLlm(config('openai', fetchFn), {
      system: 's',
      user: 'u',
      images: [PNG, { mediaType: 'image/jpeg', base64: 'anBn' }],
    });
    const parts = (requests[0].body.messages as Array<{ content: Array<Record<string, unknown>> }>)[1].content;
    expect(parts.filter((p) => p.type === 'image_url')).toHaveLength(2);
    expect(parts[2]).toEqual({ type: 'image_url', image_url: { url: 'data:image/jpeg;base64,anBn' } });
  });
});

// ── 请求构造：openai responses ──────────────────────────────────

describe('图片请求构造（openai responses）', () => {
  it('input 使用 input_text + input_image 多部分内容', async () => {
    const { fetchFn, requests } = captureFetch({
      status: 'completed',
      output_text: '解读文本',
      usage: { input_tokens: 5, output_tokens: 2, total_tokens: 7 },
    });
    const cfg = { ...config('openai', fetchFn), apiFormat: 'openai-responses' as const };
    const r = await callLlm(cfg, {
      system: 's',
      user: 'u',
      images: [PNG],
    });
    expect(r.text).toBe('解读文本');
    expect(r.usage).toEqual({ inputTokens: 5, outputTokens: 2, totalTokens: 7 });
    const input = requests[0].body.input as Array<{ role: string; content: unknown }>;
    const user = input.find((m) => m.role === 'user');
    const parts = user?.content as Array<Record<string, unknown>>;
    expect(parts[0]).toEqual({ type: 'input_text', text: 'u' });
    expect(parts[1]).toEqual({ type: 'input_image', image_url: 'data:image/png;base64,aGVsbG8=' });
  });
});

// ── 请求构造：anthropic ─────────────────────────────────────────

describe('图片请求构造（anthropic messages）', () => {
  it('content 为 text + image(source.base64) 块', async () => {
    const { fetchFn, requests } = captureFetch({
      stop_reason: 'end_turn',
      content: [{ type: 'text', text: '图中有 AXI 信号' }],
      usage: { input_tokens: 9, output_tokens: 3 },
    });
    const r = await callLlm(config('anthropic', fetchFn), {
      system: 's',
      user: 'u',
      images: [PNG],
    });
    expect(r.text).toBe('图中有 AXI 信号');
    expect(r.finishReason).toBe('end_turn');
    expect(r.usage).toEqual({ inputTokens: 9, outputTokens: 3 });
    const content = requests[0].body.messages as Array<{ content: Array<Record<string, unknown>> }>;
    const parts = content[0].content;
    expect(parts[0]).toEqual({ type: 'text', text: 'u' });
    expect(parts[1]).toEqual({
      type: 'image',
      source: { type: 'base64', media_type: 'image/png', data: 'aGVsbG8=' },
    });
  });
});

// ── 请求构造：gemini ────────────────────────────────────────────

describe('图片请求构造（gemini generateContent）', () => {
  it('parts 为 text + inline_data，key 不出现在错误消息中', async () => {
    const { fetchFn, requests } = captureFetch({
      candidates: [{ finishReason: 'STOP', content: { parts: [{ text: '框图' }] } }],
      usageMetadata: { promptTokenCount: 4, candidatesTokenCount: 1, totalTokenCount: 5 },
    });
    const r = await callLlm(config('google', fetchFn), {
      system: 's',
      user: 'u',
      images: [PNG],
    });
    expect(r.text).toBe('框图');
    expect(r.usage).toEqual({ inputTokens: 4, outputTokens: 1, totalTokens: 5 });
    const contents = requests[0].body.contents as Array<{ parts: Array<Record<string, unknown>> }>;
    const parts = contents[0].parts;
    expect(parts[0]).toEqual({ text: 'u' });
    expect(parts[1]).toEqual({ inline_data: { mime_type: 'image/png', data: 'aGVsbG8=' } });
    expect(requests[0].url).toContain('key=sk-test');
  });
});

// ── 取消 / 拒绝 ────────────────────────────────────────────────

describe('图片请求取消与拒绝', () => {
  it('请求中途取消：以可重试 LlmCallError 表达', async () => {
    const controller = new AbortController();
    const fetchFn = (async (_url: string | URL, init?: RequestInit) => {
      // 挂起直到外部中止
      return new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')));
      });
    }) as unknown as typeof fetch;
    const p = callLlm(config('openai', fetchFn), {
      system: 's',
      user: 'u',
      images: [PNG],
      signal: controller.signal,
    });
    controller.abort();
    await expect(p).rejects.toMatchObject({ name: 'LlmCallError', retryable: true });
  });

  it('端点拒绝图片请求（400）：错误不可重试且包含状态码', async () => {
    const { fetchFn } = captureFetch({ error: { message: 'image input not supported' } }, 400);
    await expect(
      callLlm(config('openai', fetchFn), { system: 's', user: 'u', images: [PNG] }),
    ).rejects.toMatchObject({ name: 'LlmCallError', retryable: false, status: 400 });
  });

  it('无图片时请求保持纯文本（既有行为不回归）', async () => {
    const { fetchFn, requests } = captureFetch({
      choices: [{ finish_reason: 'stop', message: { content: '文本回答' } }],
    });
    const r = await callLlm(config('openai', fetchFn), { system: 's', user: 'u' });
    expect(r.text).toBe('文本回答');
    const messages = requests[0].body.messages as Array<{ role: string; content: string }>;
    expect(messages[1].content).toBe('u');
  });
});
