/**
 * Follow-up suggestion generator — calls the LLM directly (openai-compatible /
 * anthropic / gemini) using the user's configured credentials, without going
 * through the omp agent process. Same pattern as title-generator.ts.
 *
 * Fired fire-and-forget when a conversation turn ends (agent_end): the caller
 * passes the last user message + assistant response, and gets back 2-3 short
 * follow-up questions the user may want to ask next. Failures resolve to null
 * and are silently ignored by the caller — suggestions are a nice-to-have.
 *
 * @see src/main/agent/title-generator.ts — credential chain + protocol dispatch
 */

import { resolveKbLlmConfig, protocolForProvider, type LlmConfig } from '../kb/llm-config';
import { buildDirectChatRequest, extractOpenAiFamilyContent } from './openai-compatible';

// ── 常量 ──────────────────────────────────────────────────────

const MAX_USER_INPUT_CHARS = 1200;
const MAX_ASSISTANT_INPUT_CHARS = 3000;

/** 最多返回的建议条数。 */
export const MAX_FOLLOW_UPS = 3;

/** 单条建议的最大长度（超出截断）。 */
export const MAX_FOLLOW_UP_LENGTH = 80;

/** Abort timeout for the LLM request. */
const FOLLOW_UP_TIMEOUT_MS = 20_000;

/** Max tokens for the completion. */
const FOLLOW_UP_MAX_TOKENS = 300;

const FOLLOW_UP_SYSTEM_PROMPT = '你是对话建议生成器。根据最近一轮用户提问与助手回答，生成 2-3 条用户最可能继续追问的后续问题。要求：问题必须具体、与对话内容直接相关、可以直接作为用户消息发送；使用与用户提问相同的语言。只输出一个 JSON 字符串数组（例如 ["问题一","问题二","问题三"]），不要输出任何其他文字。如果没有值得追问的内容，返回 []。';

const FOLLOW_UP_USER_TEMPLATE = '用户提问:\n{userMessage}\n\n助手回答:\n{assistantMessage}\n\n请生成后续追问建议（JSON 数组）:';

// ── 输入准备 ──────────────────────────────────────────────────

function truncate(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max)}…` : text;
}

/** Strip a markdown data-URL image payload (never useful as prompt context). */
const DATA_URL_RE = /!?\[[^\]]*\]\(data:[^)]+\)|data:[a-z]+\/[a-z0-9.+-]+;base64,[A-Za-z0-9+/=]+/g;

function prepareUserInput(text: string): string {
  return truncate(text.replace(DATA_URL_RE, '[图片]'), MAX_USER_INPUT_CHARS);
}

function prepareAssistantInput(text: string): string {
  return truncate(text.replace(DATA_URL_RE, '[图片]'), MAX_ASSISTANT_INPUT_CHARS);
}

// ── 响应解析 ──────────────────────────────────────────────────

/** 匹配 JSON 字符串字面量的兜底正则（模型不守约输出纯数组时使用）。 */
const QUOTED_STRING_RE = /"((?:[^"\\]|\\.)+)"/g;

/**
 * Parse the model's raw completion into a list of follow-up suggestions.
 * Tolerates markdown fences and surrounding prose; falls back to extracting
 * quoted strings when the JSON array cannot be parsed. Exported for tests.
 */
export function parseFollowUpSuggestions(raw: string | null | undefined): string[] {
  if (!raw) return [];
  const text = raw.replace(/```(?:json)?/gi, '').trim();
  const start = text.indexOf('[');
  const end = text.lastIndexOf(']');
  const candidates: string[] = [];

  if (start !== -1 && end > start) {
    try {
      const parsed = JSON.parse(text.slice(start, end + 1)) as unknown;
      if (Array.isArray(parsed)) {
        candidates.push(...parsed.filter((v): v is string => typeof v === 'string'));
      }
    } catch {
      // fall through to quoted-string extraction
    }
  }

  if (candidates.length === 0) {
    QUOTED_STRING_RE.lastIndex = 0;
    let match: RegExpExecArray | null;
    while ((match = QUOTED_STRING_RE.exec(text)) !== null) {
      candidates.push(match[1].replace(/\\"/g, '"'));
    }
  }

  const seen = new Set<string>();
  const suggestions: string[] = [];
  for (const candidate of candidates) {
    const value = candidate.trim();
    if (!value) continue;
    const normalized = value.length > MAX_FOLLOW_UP_LENGTH ? `${value.slice(0, MAX_FOLLOW_UP_LENGTH)}…` : value;
    if (seen.has(normalized)) continue;
    seen.add(normalized);
    suggestions.push(normalized);
    if (suggestions.length >= MAX_FOLLOW_UPS) break;
  }
  return suggestions;
}

// ── LLM 调用 ──────────────────────────────────────────────────

async function callLlmForFollowUps(config: LlmConfig, userMessage: string, assistantMessage: string): Promise<string | null> {
  const prompt = FOLLOW_UP_USER_TEMPLATE
    .replace('{userMessage}', prepareUserInput(userMessage))
    .replace('{assistantMessage}', prepareAssistantInput(assistantMessage));

  const base = config.baseUrl.replace(/\/+$/, '');
  const protocol = protocolForProvider(config.providerId);
  const fetchFn = config.fetchFn ?? fetch;

  let url: string;
  let headers: Record<string, string>;
  let body: Record<string, unknown>;

  if (protocol === 'anthropic') {
    url = `${base}/messages`;
    headers = {
      'Content-Type': 'application/json',
      'x-api-key': config.apiKey,
      'anthropic-version': '2023-06-01',
    };
    body = {
      model: config.model,
      max_tokens: FOLLOW_UP_MAX_TOKENS,
      system: FOLLOW_UP_SYSTEM_PROMPT,
      messages: [{ role: 'user', content: prompt }],
    };
  } else if (protocol === 'gemini') {
    const vbase = base.includes('/v1beta') ? base : `${base}/v1beta`;
    url = `${vbase}/models/${config.model}:generateContent?key=${config.apiKey}`;
    headers = { 'Content-Type': 'application/json' };
    body = {
      systemInstruction: { parts: [{ text: FOLLOW_UP_SYSTEM_PROMPT }] },
      contents: [{ role: 'user', parts: [{ text: prompt }] }],
      generationConfig: { temperature: 0.5, maxOutputTokens: FOLLOW_UP_MAX_TOKENS },
    };
  } else {
    // openai 兼容协议 — 按凭证的 apiFormat 分派 /chat/completions 或 /responses
    const request = buildDirectChatRequest({
      baseUrl: base,
      apiFormat: config.apiFormat,
      model: config.model,
      system: FOLLOW_UP_SYSTEM_PROMPT,
      user: prompt,
      maxTokens: FOLLOW_UP_MAX_TOKENS,
      temperature: 0.5,
    });
    url = request.url;
    headers = {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${config.apiKey}`,
    };
    body = request.body;
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), FOLLOW_UP_TIMEOUT_MS);

  try {
    const response = await fetchFn(url, {
      method: 'POST',
      headers,
      body: JSON.stringify(body),
      signal: controller.signal,
    });

    if (!response.ok) {
      console.warn(`[followup-generator] API returned ${response.status}: ${(await response.text()).slice(0, 200)}`);
      return null;
    }

    const payload = await response.json() as Record<string, unknown>;
    const content = protocol === 'anthropic'
      ? extractAnthropicContent(payload)
      : protocol === 'gemini'
        ? extractGeminiContent(payload)
        : extractOpenAiFamilyContent(payload);

    if (!content) {
      console.warn('[followup-generator] no content extracted from response');
      return null;
    }

    return content;
  } catch (err) {
    if (err instanceof Error && err.name === 'AbortError') {
      console.warn('[followup-generator] request timed out');
    } else {
      console.warn(`[followup-generator] request failed: ${err instanceof Error ? err.message : String(err)}`);
    }
    return null;
  } finally {
    clearTimeout(timeout);
  }
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

/**
 * Generate follow-up question suggestions for the last conversation turn.
 * Returns 0-3 suggestions; resolves to an empty array on any failure
 * (no credentials, API error, timeout, unparseable output).
 */
export async function generateFollowUpSuggestions(
  userMessage: string,
  assistantMessage: string,
): Promise<string[]> {
  const config = await resolveKbLlmConfig();
  if (!config) {
    console.log('[followup-generator] no LLM config available — skipping');
    return [];
  }

  const raw = await callLlmForFollowUps(config, userMessage, assistantMessage);
  if (!raw) return [];
  return parseFollowUpSuggestions(raw);
}
