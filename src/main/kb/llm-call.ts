/**
 * KB LLM 统一调用层（issue 08 — 模型调用边界）。
 *
 * 单一拥有者：按凭证 providerId 分派协议（openai chat/responses、
 * anthropic messages、gemini generateContent），返回统一结果：
 *   { text, finishReason, usage }
 *
 * 验收约束：
 *  - usage 只映射 API 实际返回的字段，未知/缺失不伪造（不造 0）；
 *  - 结束状态（finish_reason / stop_reason / finishReason / status）
 *    缺失时为 null；
 *  - 失败以 LlmCallError 表达，retryable 指示是否值得自动重试
 *    （429/5xx/网络/超时/坏响应可重试，4xx 不可）；
 *  - 外部 AbortSignal 可取消（含请求中途取消）；
 *  - 错误消息端点脱敏（gemini key 在查询串中，绝不进入消息/日志）。
 *
 * 分类（indexer.classifyOnce）与编译（compile.ts）共同消费此层。
 *
 * @see docs/prd/knowledge-base-llm-wiki-spec.md §4
 */

import { buildDirectChatRequest, extractOpenAiFamilyContent } from '../agent/openai-compatible';
import { protocolForProvider, type LlmConfig } from './llm-config';

// ── 类型 ────────────────────────────────────────────────────────

/** 模型用量。只保留 API 实际给出的字段；整个 usage 缺失时为 null。 */
export type LlmUsage = {
  inputTokens?: number;
  outputTokens?: number;
  totalTokens?: number;
};

/** 统一调用结果：文本 + 结束状态 + 可获得的 usage。 */
export type LlmCallResult = {
  text: string;
  /** openai finish_reason / anthropic stop_reason / gemini finishReason / responses status */
  finishReason: string | null;
  usage: LlmUsage | null;
};

export type LlmCallRequest = {
  system: string;
  user: string;
  maxTokens?: number;
  temperature?: number;
  /** 外部取消信号（请求中途取消同样生效） */
  signal?: AbortSignal;
  /** 超时毫秒数（默认 120s；0/负数 = 不限时，外部 signal 仍生效） */
  timeoutMs?: number;
};

/** 调用失败。retryable=true 表示超时/网络/429/5xx/坏响应等可自动重试。 */
export class LlmCallError extends Error {
  readonly retryable: boolean;
  constructor(message: string, retryable: boolean) {
    super(message);
    this.name = 'LlmCallError';
    this.retryable = retryable;
  }
}

// ── 内部辅助（自 indexer.classifyOnce 迁移，消息模板保持一致） ──

/** 默认超时（与原分类调用一致：推理模型 + 中转网关 30s 会误杀） */
const DEFAULT_TIMEOUT_MS = 120_000;

function isAbortError(e: unknown): boolean {
  return e instanceof Error && (e.name === 'AbortError' || e.name === 'TimeoutError');
}

function errorWithCause(e: unknown): string {
  if (!(e instanceof Error)) return String(e);
  const cause = (e as Error & { cause?: unknown }).cause;
  if (cause instanceof Error && cause.message && !e.message.includes(cause.message)) {
    return `${e.message}（原因: ${cause.message}）`;
  }
  return e.message;
}

/** 错误信息用端点脱敏 — gemini 的 key 在查询串中，绝不能带进用户可见的错误/日志 */
function safeEndpoint(url: string): string {
  const withoutQuery = url.split('?')[0];
  return withoutQuery.length > 80 ? `${withoutQuery.slice(0, 77)}…` : withoutQuery;
}

/** 从 anthropic /v1/messages 响应提取 content[].text */
function extractAnthropicContent(payload: Record<string, unknown>): string | null {
  const blocks = payload.content as Array<Record<string, unknown>> | undefined;
  if (!Array.isArray(blocks)) return null;
  const text = blocks
    .filter((b) => b.type === 'text' && typeof b.text === 'string')
    .map((b) => b.text as string)
    .join('');
  return text || null;
}

/** 从 gemini generateContent 响应提取 candidates[].content.parts[].text */
function extractGeminiContent(payload: Record<string, unknown>): string | null {
  const candidates = payload.candidates as Array<Record<string, unknown>> | undefined;
  const content = candidates?.[0]?.content as Record<string, unknown> | undefined;
  const parts = content?.parts as Array<Record<string, unknown>> | undefined;
  if (!Array.isArray(parts)) return null;
  const text = parts
    .filter((p) => typeof p.text === 'string')
    .map((p) => p.text as string)
    .join('');
  return text || null;
}

// ── usage / 结束状态提取（只映射实际给出的字段） ──────────────

function num(v: unknown): number | undefined {
  return typeof v === 'number' && Number.isFinite(v) ? v : undefined;
}

function anthropicUsage(payload: Record<string, unknown>): LlmUsage | null {
  const u = payload.usage as Record<string, unknown> | undefined;
  if (!u || typeof u !== 'object') return null;
  const usage: LlmUsage = { inputTokens: num(u.input_tokens), outputTokens: num(u.output_tokens) };
  return usage;
}

function openAiChatUsage(payload: Record<string, unknown>): LlmUsage | null {
  const u = payload.usage as Record<string, unknown> | undefined;
  if (!u || typeof u !== 'object') return null;
  return { inputTokens: num(u.prompt_tokens), outputTokens: num(u.completion_tokens), totalTokens: num(u.total_tokens) };
}

function openAiResponsesUsage(payload: Record<string, unknown>): LlmUsage | null {
  const u = payload.usage as Record<string, unknown> | undefined;
  if (!u || typeof u !== 'object') return null;
  return { inputTokens: num(u.input_tokens), outputTokens: num(u.output_tokens), totalTokens: num(u.total_tokens) };
}

function geminiUsage(payload: Record<string, unknown>): LlmUsage | null {
  const u = payload.usageMetadata as Record<string, unknown> | undefined;
  if (!u || typeof u !== 'object') return null;
  return { inputTokens: num(u.promptTokenCount), outputTokens: num(u.candidatesTokenCount), totalTokens: num(u.totalTokenCount) };
}

function openAiChatFinishReason(payload: Record<string, unknown>): string | null {
  const choices = payload.choices as Array<Record<string, unknown>> | undefined;
  const fr = choices?.[0]?.finish_reason;
  return typeof fr === 'string' && fr.length > 0 ? fr : null;
}

function geminiFinishReason(payload: Record<string, unknown>): string | null {
  const candidates = payload.candidates as Array<Record<string, unknown>> | undefined;
  const fr = candidates?.[0]?.finishReason;
  return typeof fr === 'string' && fr.length > 0 ? fr : null;
}

// ── 协议分派（请求构造） ────────────────────────────────────────

type RequestPlan = { url: string; headers: Record<string, string>; body: Record<string, unknown> };

function planRequest(config: LlmConfig, req: LlmCallRequest): RequestPlan {
  const base = config.baseUrl.replace(/\/+$/, '');
  const protocol = protocolForProvider(config.providerId);
  const maxTokens = req.maxTokens ?? 2000;

  if (protocol === 'anthropic') {
    const body: Record<string, unknown> = {
      model: config.model,
      max_tokens: maxTokens,
      system: req.system,
      messages: [{ role: 'user', content: req.user }],
    };
    return {
      url: `${base}/messages`,
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': config.apiKey,
        'anthropic-version': '2023-06-01',
      },
      body,
    };
  }

  if (protocol === 'gemini') {
    const vbase = base.includes('/v1beta') ? base : `${base}/v1beta`;
    return {
      url: `${vbase}/models/${config.model}:generateContent?key=${config.apiKey}`,
      headers: { 'Content-Type': 'application/json' },
      body: {
        systemInstruction: { parts: [{ text: req.system }] },
        contents: [{ role: 'user', parts: [{ text: req.user }] }],
        generationConfig: {
          ...(req.temperature !== undefined ? { temperature: req.temperature } : {}),
          maxOutputTokens: maxTokens,
        },
      },
    };
  }

  // openai 兼容协议 — 按凭证的 apiFormat 分派 /chat/completions 或 /responses
  const request = buildDirectChatRequest({
    baseUrl: base,
    apiFormat: config.apiFormat,
    model: config.model,
    system: req.system,
    user: req.user,
    maxTokens,
    temperature: req.temperature,
  });
  return {
    url: request.url,
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${config.apiKey}`,
    },
    body: request.body,
  };
}

// ── 公开接口 ────────────────────────────────────────────────────

/**
 * 单次 LLM 调用：协议分派 + 请求 + 统一结果提取。
 *
 * 失败抛 LlmCallError（retryable 指示可否自动重试）；
 * 取消（外部 signal 或超时）同样以可重试的 LlmCallError 表达。
 * 不含重试循环 — 由调用方（分类/编译）决定重试策略。
 */
export async function callLlm(config: LlmConfig, req: LlmCallRequest): Promise<LlmCallResult> {
  const fetchFn = config.fetchFn ?? fetch;
  const protocol = protocolForProvider(config.providerId);
  const plan = planRequest(config, req);

  // 外部 signal + 超时合并：任一触发即中止
  const controller = new AbortController();
  const timeoutMs = req.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const timer = timeoutMs > 0 ? setTimeout(() => controller.abort(), timeoutMs) : undefined;
  const onExternalAbort = () => controller.abort();
  if (req.signal) {
    if (req.signal.aborted) {
      if (timer) clearTimeout(timer);
      throw new LlmCallError('LLM 请求已取消（外部中止）', true);
    }
    req.signal.addEventListener('abort', onExternalAbort, { once: true });
  }

  try {
    const response = await fetchFn(plan.url, {
      method: 'POST',
      headers: plan.headers,
      body: JSON.stringify(plan.body),
      signal: controller.signal,
    });

    if (!response.ok) {
      const details = await response.text().catch(() => '');
      const retryable = response.status === 429 || response.status >= 500;
      throw new LlmCallError(
        `LLM API 返回 ${response.status}: ${details.slice(0, 200)}（模型 ${config.model} @ ${safeEndpoint(plan.url)}）`,
        retryable,
      );
    }

    // 先取文本再解析：部分网关出错时返回 200 + HTML 错误页，直接 response.json()
    // 会抛出晦涩的 SyntaxError，这里给出可读的网关异常提示
    const raw = await response.text();
    let payload: Record<string, unknown>;
    try {
      payload = JSON.parse(raw) as Record<string, unknown>;
    } catch {
      throw new LlmCallError(
        `LLM 响应不是有效 JSON（网关异常或返回了 HTML 错误页）: ${raw.slice(0, 150)}（模型 ${config.model} @ ${safeEndpoint(plan.url)}）`,
        true,
      );
    }

    const text = protocol === 'anthropic'
      ? extractAnthropicContent(payload)
      : protocol === 'gemini'
        ? extractGeminiContent(payload)
        : extractOpenAiFamilyContent(payload);

    if (text === null) {
      throw new LlmCallError(
        `LLM 返回格式异常：无法从 ${protocol} 响应中提取文本（模型 ${config.model}，常见原因：max_tokens 耗尽或推理模型未产出内容）`,
        true,
      );
    }

    const finishReason = protocol === 'anthropic'
      ? typeof payload.stop_reason === 'string' && payload.stop_reason.length > 0 ? payload.stop_reason : null
      : protocol === 'gemini'
        ? geminiFinishReason(payload)
        : config.apiFormat === 'openai-responses'
          ? typeof payload.status === 'string' && payload.status.length > 0 ? payload.status : null
          : openAiChatFinishReason(payload);

    const usage = protocol === 'anthropic'
      ? anthropicUsage(payload)
      : protocol === 'gemini'
        ? geminiUsage(payload)
        : config.apiFormat === 'openai-responses'
          ? openAiResponsesUsage(payload)
          : openAiChatUsage(payload);

    return { text, finishReason, usage };
  } catch (e) {
    if (e instanceof LlmCallError) throw e;
    if (isAbortError(e)) {
      throw new LlmCallError(
        req.signal?.aborted
          ? `LLM 请求已取消: 模型 ${config.model} @ ${safeEndpoint(plan.url)}`
          : `AI 请求超时（${timeoutMs / 1000} 秒）: 模型 ${config.model} @ ${safeEndpoint(plan.url)} 未在时限内返回。建议在设置中换用更快的模型后重试`,
        true,
      );
    }
    throw new LlmCallError(
      `网络错误: ${errorWithCause(e)}（模型 ${config.model} @ ${safeEndpoint(plan.url)}）。请检查网络连接及凭证 baseUrl 是否可达`,
      true,
    );
  } finally {
    if (timer) clearTimeout(timer);
    req.signal?.removeEventListener('abort', onExternalAbort);
  }
}
