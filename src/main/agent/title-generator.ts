/**
 * Title generator — calls the LLM directly (openai-compatible / anthropic /
 * gemini) using the user's configured credentials, without going through the
 * omp agent process.
 *
 * Inspired by omp's `title-generator.ts`:
 * - Title is generated from the **first user message only** — no need to wait
 *   for the assistant's response.
 * - Low-signal input (greetings, acknowledgements, empty, etc.) is skipped
 *   deterministically before any model is invoked.
 * - Short messages (≤ SHORT_TITLE_THRESHOLD chars, single line) are used as-is
 *   as the session name — no model call needed.
 *
 * Credential resolution reuses the KB LLM config chain (KB settings →
 * credential model → Agent session model → API-fetched → provider default),
 * which handles built-in providers (openai, anthropic, google) and
 * custom OpenAI-compatible gateways uniformly.
 *
 * Falls back gracefully (returns null) when credentials are unavailable or
 * the API call fails — the session keeps its immediate placeholder name.
 *
 * @see src/main/kb/llm-config.ts — credential resolution chain
 * @see src/main/kb/indexer.ts   — multi-protocol LLM call pattern
 */

import { resolveKbLlmConfig, protocolForProvider, type LlmConfig } from '../kb/llm-config';

// ── 常量 ──────────────────────────────────────────────────────

/**
 * Maximum input length sent to the model. Longer messages are truncated.
 * Mirrors omp's `MAX_TITLE_INPUT_CHARS`.
 */
const MAX_TITLE_INPUT_CHARS = 2000;

/**
 * Messages at or below this character count (single line) are short enough to
 * serve as their own session title — no model call needed.  The caller checks
 * `isShortTitleInput` before invoking the LLM.
 */
const SHORT_TITLE_THRESHOLD = 40;

/** Maximum length of a generated title (truncated with ellipsis). */
const MAX_TITLE_LENGTH = 40;

/** Abort timeout for the LLM request. */
const TITLE_TIMEOUT_MS = 15_000;

/** Max tokens for the title completion. */
const TITLE_MAX_TOKENS = 100;

const TITLE_SYSTEM_PROMPT = '你是一个会话标题生成器。根据用户的第一条消息，生成一个简短、准确的中文标题（不超过20个字）。只返回标题文本，不要包含引号或其他标点符号。如果消息只是打招呼或无实质内容，返回"none"。';

const TITLE_USER_TEMPLATE = '用户消息:\n{userMessage}\n\n请生成一个简短的会话标题:';

// ── 低信号输入过滤（参考 omp isLowSignalTitleInput）────────────

/**
 * Filler / greeting / acknowledgement tokens that carry no concrete task.
 * A first user message composed entirely of these (or bare numbers /
 * punctuation / emoji) is deferred — titling is skipped.
 */
const FILLER_TITLE_TOKENS = new Set<string>([
  // greetings
  'hi', 'hii', 'hiii', 'hiya', 'hey', 'heya', 'hello', 'helo', 'hullo',
  'yo', 'ya', 'sup', 'wassup', 'whatsup', 'howdy', 'greetings',
  'hola', 'ciao', 'aloha', 'gm', 'gn',
  'good', 'morning', 'afternoon', 'evening', 'night', 'day',
  // politeness / acknowledgement
  'thanks', 'thank', 'thx', 'ty', 'tysm', 'cheers',
  'please', 'pls', 'plz',
  'ok', 'okay', 'okey', 'k', 'kk',
  'yep', 'yes', 'yeah', 'yup', 'nope', 'no', 'nah',
  'sure', 'cool', 'nice', 'great', 'awesome', 'perfect',
  'lol', 'lmao', 'haha', 'hehe',
  // poking / fillers
  'test', 'tests', 'testing', 'ping', 'pong',
  'there', 'you', 'u',
  'hmm', 'hmmm', 'um', 'uh', 'so', 'well', 'anyway',
  // Chinese equivalents
  '你好', '嗨', '哈喽', '早', '晚', '在吗', '在不在',
  '谢谢', '感谢', '谢了', '辛苦了',
  '好的', '好吧', '嗯', '哦', '啊', '额',
  '收到', '了解', '明白', '知道', '知道了',
  '可以', '行', '没问题', 'ok的',
  '测试', '试一下', '看看',
]);

const TITLE_WORD = /[\p{L}\p{N}]+/gu;

/**
 * Strip fenced code blocks (3+ backticks) from a message before titling.
 * Small title models latch onto literal text inside code blocks. Falls back
 * to the original message when stripping leaves too little to title.
 */
const FENCED_CODE_BLOCK = /```+[\s\S]*?(?:```+|$)/g;
const MIN_STRIPPED_TITLE_CHARS = 12;

function stripCodeBlocks(message: string): string {
  const cleaned = message
    .replace(FENCED_CODE_BLOCK, ' ')
    .replace(/[ \t]+/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
  return cleaned.length >= MIN_STRIPPED_TITLE_CHARS ? cleaned : message;
}

/**
 * Truncate input to the maximum character count for the title model.
 */
function truncateTitleInput(message: string): string {
  return message.length > MAX_TITLE_INPUT_CHARS
    ? `${message.slice(0, MAX_TITLE_INPUT_CHARS)}…`
    : message;
}

/**
 * Prepare a raw user message for titling: drop code blocks, then bound length.
 */
function prepareTitleInput(message: string): string {
  return truncateTitleInput(stripCodeBlocks(message));
}

/**
 * True when a first user message is too low-signal to title (greeting, ack,
 * bare number, or empty once code/punctuation/emoji are stripped).
 *
 * Deterministic pre-filter: avoids wasting a model call on messages that
 * carry no concrete task.  Mirrors omp's `isLowSignalTitleInput`.
 */
export function isLowSignalTitleInput(message: string): boolean {
  const tokens = stripCodeBlocks(message).toLowerCase().match(TITLE_WORD);
  if (!tokens) return true;
  return tokens.every(token => FILLER_TITLE_TOKENS.has(token) || /^\d+$/.test(token));
}

/**
 * True when a message is short enough (≤ threshold chars, single line) to
 * serve as its own session title — no model call needed.
 */
export function isShortTitleInput(message: string): boolean {
  const trimmed = message.trim();
  return trimmed.length <= SHORT_TITLE_THRESHOLD && !trimmed.includes('\n');
}

// ── 响应提取（按协议分派）──────────────────────────────────────

/** 从 openai-compatible 响应提取 message.content */
function extractOpenAiContent(payload: Record<string, unknown>): string | null {
  const choices = payload.choices as Array<Record<string, unknown>> | undefined;
  const message = choices?.[0]?.message as Record<string, unknown> | undefined;
  const content = message?.content;
  return typeof content === 'string' ? content : null;
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

/** Sentinel the model may emit when a message carries no concrete task. */
const NO_TITLE_SENTINEL = 'none';

/**
 * Normalize a generated title: take the first line, strip surrounding
 * quotes/punctuation, and reject the "none" sentinel.
 */
function normalizeGeneratedTitle(value: string | null | undefined): string | null {
  const firstLine = value?.trim().split(/\r?\n/, 1)[0]?.trim();
  if (!firstLine) return null;
  const title = firstLine
    .replace(/^["'""\s]+|["'""\s]+$/g, '')
    .replace(/[.!?]$/, '')
    .trim();
  if (!title || title.toLowerCase() === NO_TITLE_SENTINEL) return null;
  return title;
}

// ── LLM 调用 ──────────────────────────────────────────────────

/**
 * Call the LLM to generate a title, dispatching by provider protocol.
 * Returns the raw title text, or null if the call fails.
 */
async function callLlmForTitle(config: LlmConfig, userMessage: string): Promise<string | null> {
  const prompt = TITLE_USER_TEMPLATE.replace('{userMessage}', prepareTitleInput(userMessage));

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
      max_tokens: TITLE_MAX_TOKENS,
      system: TITLE_SYSTEM_PROMPT,
      messages: [{ role: 'user', content: prompt }],
    };
  } else if (protocol === 'gemini') {
    const vbase = base.includes('/v1beta') ? base : `${base}/v1beta`;
    url = `${vbase}/models/${config.model}:generateContent?key=${config.apiKey}`;
    headers = { 'Content-Type': 'application/json' };
    body = {
      systemInstruction: { parts: [{ text: TITLE_SYSTEM_PROMPT }] },
      contents: [{ role: 'user', parts: [{ text: prompt }] }],
      generationConfig: { temperature: 0.3, maxOutputTokens: TITLE_MAX_TOKENS },
    };
  } else {
    url = `${base}/chat/completions`;
    headers = {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${config.apiKey}`,
    };
    body = {
      model: config.model,
      messages: [
        { role: 'system', content: TITLE_SYSTEM_PROMPT },
        { role: 'user', content: prompt },
      ],
      max_tokens: TITLE_MAX_TOKENS,
      temperature: 0.3,
      stream: false,
    };
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), TITLE_TIMEOUT_MS);

  try {
    const response = await fetchFn(url, {
      method: 'POST',
      headers,
      body: JSON.stringify(body),
      signal: controller.signal,
    });

    if (!response.ok) {
      console.warn(`[title-generator] API returned ${response.status}: ${(await response.text()).slice(0, 200)}`);
      return null;
    }

    const payload = await response.json() as Record<string, unknown>;
    console.log('[title-generator] API response', { status: response.status, hasPayload: !!payload });

    const content = protocol === 'anthropic'
      ? extractAnthropicContent(payload)
      : protocol === 'gemini'
        ? extractGeminiContent(payload)
        : extractOpenAiContent(payload);

    if (!content) {
      console.warn('[title-generator] no content extracted from response');
      return null;
    }

    console.log('[title-generator] raw content', { content: content.slice(0, 100) });

    const title = normalizeGeneratedTitle(content);
    if (!title) {
      console.log('[title-generator] normalized title is null (sentinel or empty)');
      return null;
    }

    return title.length > MAX_TITLE_LENGTH ? title.slice(0, MAX_TITLE_LENGTH) + '...' : title;
  } catch (err) {
    if (err instanceof Error && err.name === 'AbortError') {
      console.warn('[title-generator] request timed out');
    } else {
      console.warn(`[title-generator] request failed: ${err instanceof Error ? err.message : String(err)}`);
    }
    return null;
  } finally {
    clearTimeout(timeout);
  }
}

/**
 * Generate a concise session title from the first user message.
 *
 * Only the user's first message is used — the assistant's response is NOT
 * needed.  Low-signal input (greetings, acknowledgements, etc.) is skipped
 * deterministically.
 *
 * Resolves credentials via the KB LLM config chain (KB settings → credential
 * model → Agent session model → API-fetched → provider default), which
 * handles built-in providers (openai, anthropic, google) and custom
 * OpenAI-compatible gateways.
 *
 * @param userMessage The user's first message
 * @returns A generated title string, or null if generation failed
 */
export async function generateSessionTitle(
  userMessage: string,
): Promise<string | null> {
  // Skip low-signal input (greetings, acks, empty, etc.) before any model call.
  if (isLowSignalTitleInput(userMessage)) {
    console.log('[title-generator] skipped low-signal input');
    return null;
  }

  console.log('[title-generator] start', {
    messagePreview: userMessage.slice(0, 80),
    messageLength: userMessage.length,
  });

  const config = await resolveKbLlmConfig();
  if (!config) {
    console.log('[title-generator] no LLM config available for title generation');
    return null;
  }

  console.log('[title-generator] LLM config resolved', {
    provider: config.providerId,
    model: config.model,
    baseUrl: config.baseUrl,
  });

  const title = await callLlmForTitle(config, userMessage);
  console.log('[title-generator] done', { title, hasTitle: !!title });
  return title;
}
