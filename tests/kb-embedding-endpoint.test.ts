/**
 * embedding-endpoint 测试（issue 21，spec §8/§11）。
 *
 * 验收映射 A16/A22：
 *  - 正确区分 401/403 (auth)、404 (modelNotFound)、429 (rateLimited)、超时、网络失败
 *  - 未配置返回 notConfigured
 *  - 维度不符返回 dimensionMismatch
 *  - 假响应覆盖：向量数量不足、NaN/Infinity、维度与配置不符
 *  - oversize 错误自动减半重试
 *  - 正常请求返回 Float32Array
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { fetchEmbedding, classifyEmbeddingError, looksLikeOversizeError } from '../src/main/kb/embedding-endpoint';
import type { EmbeddingRuntimeConfig } from '@shared/kb-types';

function baseConfig(overrides: Partial<EmbeddingRuntimeConfig> = {}): EmbeddingRuntimeConfig {
  return {
    endpoint: 'https://api.example.com/v1/embeddings',
    apiKey: 'test-key',
    model: 'text-embedding-3-small',
    expectedDimensions: 4,
    maxChunkChars: 1000,
    overlapChunkChars: 200,
    concurrency: 1,
    ...overrides,
  };
}

/** 构造一个 mock Response */
function mockResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

describe('classifyEmbeddingError', () => {
  it('401 → auth', () => {
    const err = classifyEmbeddingError(401, 'Unauthorized');
    expect(err.kind).toBe('auth');
    expect(err.statusCode).toBe(401);
  });

  it('403 → auth', () => {
    const err = classifyEmbeddingError(403, 'Forbidden');
    expect(err.kind).toBe('auth');
  });

  it('404 → modelNotFound', () => {
    const err = classifyEmbeddingError(404, 'model not found');
    expect(err.kind).toBe('modelNotFound');
  });

  it('429 → rateLimited', () => {
    const err = classifyEmbeddingError(429, 'Too Many Requests');
    expect(err.kind).toBe('rateLimited');
  });

  it('413 → oversizedInput', () => {
    const err = classifyEmbeddingError(413, 'Payload Too Large');
    expect(err.kind).toBe('oversizedInput');
  });

  it('500 → provider', () => {
    const err = classifyEmbeddingError(500, 'Internal Server Error');
    expect(err.kind).toBe('provider');
  });

  it('网络错误字符串 → network', () => {
    const err = classifyEmbeddingError(undefined, 'fetch failed: ECONNREFUSED');
    expect(err.kind).toBe('network');
  });

  it('超时字符串 → timeout', () => {
    const err = classifyEmbeddingError(undefined, 'Request timed out after 30000ms');
    expect(err.kind).toBe('timeout');
  });
});

describe('looksLikeOversizeError', () => {
  it('413 → true', () => {
    expect(looksLikeOversizeError(413, '')).toBe(true);
  });

  it('"too long" body → true', () => {
    expect(looksLikeOversizeError(400, 'input is too long')).toBe(true);
  });

  it('"context length" body → true', () => {
    expect(looksLikeOversizeError(400, 'maximum context length exceeded')).toBe(true);
  });

  it('正常 401 → false', () => {
    expect(looksLikeOversizeError(401, 'Unauthorized')).toBe(false);
  });

  it('正常 500 → false', () => {
    expect(looksLikeOversizeError(500, 'Internal Server Error')).toBe(false);
  });
});

describe('fetchEmbedding', () => {
  const originalFetch = globalThis.fetch;

  beforeEach(() => {
    vi.restoreAllMocks();
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it('正常请求返回向量数组', async () => {
    const cfg = baseConfig();
    globalThis.fetch = vi.fn(async () =>
      mockResponse(200, {
        data: [{ embedding: [0.1, 0.2, 0.3, 0.4] }],
      }),
    ) as unknown as typeof fetch;

    const result = await fetchEmbedding('hello world', cfg);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value).toHaveLength(4);
      expect(result.value).toEqual([0.1, 0.2, 0.3, 0.4]);
    }
  });

  it('未配置端点 → notConfigured', async () => {
    const cfg = baseConfig({ endpoint: '' });
    const result = await fetchEmbedding('hello', cfg);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.kind).toBe('notConfigured');
    }
  });

  it('401 → auth 错误', async () => {
    const cfg = baseConfig();
    globalThis.fetch = vi.fn(async () =>
      mockResponse(401, { error: { message: 'Invalid API key' } }),
    ) as unknown as typeof fetch;

    const result = await fetchEmbedding('hello', cfg);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.kind).toBe('auth');
      expect(result.error.statusCode).toBe(401);
    }
  });

  it('404 → modelNotFound', async () => {
    const cfg = baseConfig();
    globalThis.fetch = vi.fn(async () =>
      mockResponse(404, { error: { message: 'model text-embedding-3-small not found' } }),
    ) as unknown as typeof fetch;

    const result = await fetchEmbedding('hello', cfg);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.kind).toBe('modelNotFound');
    }
  });

  it('429 → rateLimited', async () => {
    const cfg = baseConfig();
    globalThis.fetch = vi.fn(async () =>
      mockResponse(429, { error: { message: 'Rate limit exceeded' } }),
    ) as unknown as typeof fetch;

    const result = await fetchEmbedding('hello', cfg);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.kind).toBe('rateLimited');
    }
  });

  it('返回维度与 expectedDimensions 不符 → dimensionMismatch', async () => {
    const cfg = baseConfig({ expectedDimensions: 4 });
    globalThis.fetch = vi.fn(async () =>
      mockResponse(200, {
        data: [{ embedding: [0.1, 0.2, 0.3] }], // 只返回 3 维
      }),
    ) as unknown as typeof fetch;

    const result = await fetchEmbedding('hello', cfg);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.kind).toBe('dimensionMismatch');
    }
  });

  it('返回包含 NaN → provider 错误', async () => {
    const cfg = baseConfig({ expectedDimensions: 4 });
    globalThis.fetch = vi.fn(async () =>
      mockResponse(200, {
        data: [{ embedding: [0.1, NaN, 0.3, 0.4] }],
      }),
    ) as unknown as typeof fetch;

    const result = await fetchEmbedding('hello', cfg);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.kind).toBe('provider');
    }
  });

  it('返回包含 Infinity → provider 错误', async () => {
    const cfg = baseConfig({ expectedDimensions: 4 });
    globalThis.fetch = vi.fn(async () =>
      mockResponse(200, {
        data: [{ embedding: [0.1, Infinity, 0.3, 0.4] }],
      }),
    ) as unknown as typeof fetch;

    const result = await fetchEmbedding('hello', cfg);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.kind).toBe('provider');
    }
  });

  it('空向量数组 → provider 错误', async () => {
    const cfg = baseConfig();
    globalThis.fetch = vi.fn(async () =>
      mockResponse(200, { data: [{ embedding: [] }] }),
    ) as unknown as typeof fetch;

    const result = await fetchEmbedding('hello', cfg);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.kind).toBe('provider');
    }
  });

  it('网络失败 → network 错误', async () => {
    const cfg = baseConfig();
    globalThis.fetch = vi.fn(async () => {
      throw new TypeError('fetch failed: ECONNREFUSED');
    }) as unknown as typeof fetch;

    const result = await fetchEmbedding('hello', cfg);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.kind).toBe('network');
    }
  });

  it('oversize 错误自动减半重试', async () => {
    const cfg = baseConfig({ expectedDimensions: 4 });
    let callCount = 0;
    globalThis.fetch = vi.fn(async () => {
      callCount++;
      if (callCount === 1) {
        return mockResponse(400, { error: { message: 'input is too long' } });
      }
      return mockResponse(200, { data: [{ embedding: [0.1, 0.2, 0.3, 0.4] }] });
    }) as unknown as typeof fetch;

    const result = await fetchEmbedding('a'.repeat(2000), cfg);
    expect(result.ok).toBe(true);
    expect(callCount).toBe(2);
  });

  it('oversize 重试耗尽仍失败 → 返回 oversizeInput 错误', async () => {
    const cfg = baseConfig({ expectedDimensions: 4 });
    globalThis.fetch = vi.fn(async () =>
      mockResponse(413, { error: { message: 'Payload Too Large' } }),
    ) as unknown as typeof fetch;

    const result = await fetchEmbedding('hello', cfg, 1);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.kind).toBe('oversizedInput');
    }
  });

  it('正确发送 OpenAI 兼容格式请求体', async () => {
    const cfg = baseConfig();
    let capturedBody: unknown;
    globalThis.fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      capturedBody = init?.body ? JSON.parse(init.body as string) : null;
      return mockResponse(200, { data: [{ embedding: [0.1, 0.2, 0.3, 0.4] }] });
    }) as unknown as typeof fetch;

    await fetchEmbedding('test text', cfg);
    expect(capturedBody).toEqual({
      model: 'text-embedding-3-small',
      input: 'test text',
    });
  });
});
