/**
 * Embedding Endpoint — HTTP 调用 + 错误分类（spec §8/§11，issue 21）。
 *
 * 职责：
 *  1. 向 OpenAI 兼容嵌入端点发 POST 请求
 *  2. 正确区分 401/403 (auth)、404 (modelNotFound)、429 (rateLimited)、
 *     超时、网络失败、未配置、维度不符、oversize
 *  3. oversize 错误自动减半重试
 *  4. 假响应覆盖：空向量、NaN/Infinity、维度与配置不符
 *
 * @see docs/prd/knowledge-base-llm-wiki-spec.md §8/§11
 */

import type { EmbeddingError, EmbeddingErrorKind, EmbeddingRuntimeConfig } from '@shared/kb-types';

export type EmbeddingResult =
  | { ok: true; value: number[] }
  | { ok: false; error: EmbeddingError };

/** 请求超时（5 分钟，与参考实现一致） */
const REQUEST_TIMEOUT_MS = 300_000;

/** 最大 auto-halve 重试次数 */
const DEFAULT_MAX_RETRIES = 3;

/**
 * 判断错误响应是否是"输入过长"类错误。
 * 覆盖 OpenAI / LM Studio / llama.cpp / Ollama / Azure 等常见措辞。
 */
export function looksLikeOversizeError(httpStatus: number, body: string): boolean {
  if (httpStatus === 413) return true;
  const lower = body.toLowerCase();
  return (
    lower.includes('too long') ||
    lower.includes('maximum context') ||
    lower.includes('max_tokens') ||
    lower.includes('max tokens') ||
    lower.includes('context length') ||
    lower.includes('token limit') ||
    lower.includes('exceeds') ||
    lower.includes('input length')
  );
}

/**
 * 根据 HTTP 状态码和错误体分类嵌入错误。
 */
export function classifyEmbeddingError(
  statusCode: number | undefined,
  body: string,
): EmbeddingError {
  // 网络层错误（无状态码）
  if (statusCode === undefined) {
    const lower = body.toLowerCase();
    if (
      lower.includes('timeout') ||
      lower.includes('timed out') ||
      lower.includes('aborted')
    ) {
      return { kind: 'timeout', message: body };
    }
    return { kind: 'network', message: body };
  }

  // HTTP 状态码分类
  let kind: EmbeddingErrorKind;
  switch (statusCode) {
    case 401:
    case 403:
      kind = 'auth';
      break;
    case 404:
      kind = 'modelNotFound';
      break;
    case 429:
      kind = 'rateLimited';
      break;
    case 413:
      kind = 'oversizedInput';
      break;
    default:
      if (looksLikeOversizeError(statusCode, body)) {
        kind = 'oversizedInput';
      } else if (statusCode >= 500) {
        kind = 'provider';
      } else {
        kind = 'provider';
      }
  }

  return { kind, message: body, statusCode };
}

/**
 * 向嵌入端点发送单次请求。
 */
async function singleRequest(
  text: string,
  cfg: EmbeddingRuntimeConfig,
  signal: AbortSignal,
): Promise<EmbeddingResult> {
  const body = JSON.stringify({
    model: cfg.model,
    input: text,
  });

  const headers: Record<string, string> = {
    'content-type': 'application/json',
    authorization: `Bearer ${cfg.apiKey}`,
    ...cfg.extraHeaders,
  };

  const response = await fetch(cfg.endpoint, {
    method: 'POST',
    headers,
    body,
    signal,
  });

  const responseText = await response.text();

  if (!response.ok) {
    return { ok: false, error: classifyEmbeddingError(response.status, responseText) };
  }

  // 解析响应体
  let parsed: unknown;
  try {
    parsed = JSON.parse(responseText);
  } catch {
    return {
      ok: false,
      error: { kind: 'provider', message: `Invalid JSON response: ${responseText.slice(0, 200)}` },
    };
  }

  // 提取嵌入向量（OpenAI 兼容格式：{ data: [{ embedding: number[] }] }）
  const data = parsed as { data?: Array<{ embedding?: number[] }> };
  const embedding = data?.data?.[0]?.embedding;

  if (!Array.isArray(embedding) || embedding.length === 0) {
    return {
      ok: false,
      error: { kind: 'provider', message: 'Response missing embedding array' },
    };
  }

  // 假响应覆盖：NaN / Infinity
  for (const v of embedding) {
    if (typeof v !== 'number' || !Number.isFinite(v)) {
      return {
        ok: false,
        error: { kind: 'provider', message: `Embedding contains non-finite value: ${v}` },
      };
    }
  }

  // 维度校验
  if (cfg.expectedDimensions !== undefined && embedding.length !== cfg.expectedDimensions) {
    return {
      ok: false,
      error: {
        kind: 'dimensionMismatch',
        message: `Expected ${cfg.expectedDimensions} dimensions, got ${embedding.length}`,
      },
    };
  }

  return { ok: true, value: embedding };
}

/**
 * 向嵌入端点发送请求，oversize 时自动减半文本重试。
 *
 * @param text 待嵌入的文本
 * @param cfg 嵌入运行时配置
 * @param maxRetries 最大 auto-halve 重试次数
 */
export async function fetchEmbedding(
  text: string,
  cfg: EmbeddingRuntimeConfig,
  maxRetries: number = DEFAULT_MAX_RETRIES,
): Promise<EmbeddingResult> {
  // 未配置检查
  if (!cfg.endpoint || !cfg.apiKey || !cfg.model) {
    return {
      ok: false,
      error: { kind: 'notConfigured', message: 'Embedding endpoint not configured' },
    };
  }

  let currentText = text;
  let lastError: EmbeddingError | null = null;

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);

    try {
      const result = await singleRequest(currentText, cfg, controller.signal);
      clearTimeout(timeoutId);

      if (result.ok) return result;

      lastError = result.error;

      // 仅对 oversize 错误重试
      if (result.error.kind !== 'oversizedInput') {
        return result;
      }

      // 减半文本
      const halfLen = Math.floor(currentText.length / 2);
      if (halfLen < 1) {
        return result; // 已经无法再缩短
      }
      currentText = currentText.slice(0, halfLen);
    } catch (err) {
      clearTimeout(timeoutId);
      const message = err instanceof Error ? err.message : String(err);
      // AbortError → timeout
      if (err instanceof Error && err.name === 'AbortError') {
        lastError = { kind: 'timeout', message: `Request timed out after ${REQUEST_TIMEOUT_MS}ms` };
      } else {
        lastError = classifyEmbeddingError(undefined, message);
      }
      // 网络错误不重试（不同于 oversize）
      return { ok: false, error: lastError };
    }
  }

  return { ok: false, error: lastError ?? { kind: 'provider', message: 'Unknown error' } };
}
