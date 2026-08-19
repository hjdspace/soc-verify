/**
 * Title generator — uses the OpenAI-compatible chat completions API to generate
 * a concise session title from the user's first message and the assistant's
 * first response.
 *
 * This is a lightweight LLM call (separate from the omp agent process) to avoid
 * the overhead of a full agent turn just for naming. Falls back gracefully when
 * the API is unavailable or returns an error.
 */

import { ensureV1Prefix } from './openai-compatible';
import { credentialManager } from '../credentials/credential-manager';

const TITLE_SYSTEM_PROMPT = '你是一个会话标题生成器。根据用户的提问和 AI 的回答，生成一个简短、准确的中文标题（不超过20个字）。只返回标题文本，不要包含引号或其他标点符号。';

const TITLE_USER_TEMPLATE = '用户提问: {userMessage}\n\nAI回答（前500字）: {assistantMessage}\n\n请生成一个简短的会话标题:';

const MAX_ASSISTANT_SNIPPET = 500;
const MAX_USER_SNIPPET = 500;
const MAX_TITLE_LENGTH = 40;

/**
 * Resolve credentials and model for a given session's provider.
 * Returns { apiKey, baseUrl, model } or null if credentials are unavailable.
 */
async function resolveSessionCredentials(
  providerId?: string,
  modelId?: string,
): Promise<{ apiKey: string; baseUrl: string; model: string } | null> {
  // Try the explicit providerId first, then fall back to the default credential
  const cred = providerId
    ? await credentialManager.get(providerId)
    : await credentialManager.getDefaultCredential();
  if (!cred?.apiKey) return null;
  const baseUrl = cred.baseUrl ? ensureV1Prefix(cred.baseUrl) : null;
  const model = modelId ?? cred.model;
  if (!baseUrl || !model) return null;
  return { apiKey: cred.apiKey, baseUrl, model };
}

/**
 * Call the OpenAI-compatible chat completions API to generate a title.
 * Returns the generated title, or null if the call fails.
 */
async function callChatCompletions(
  apiKey: string,
  baseUrl: string,
  model: string,
  userMessage: string,
  assistantMessage: string,
): Promise<string | null> {
  const url = `${baseUrl}/chat/completions`;
  const body = JSON.stringify({
    model,
    messages: [
      { role: 'system', content: TITLE_SYSTEM_PROMPT },
      {
        role: 'user',
        content: TITLE_USER_TEMPLATE
          .replace('{userMessage}', userMessage.slice(0, MAX_USER_SNIPPET))
          .replace('{assistantMessage}', assistantMessage.slice(0, MAX_ASSISTANT_SNIPPET)),
      },
    ],
    max_tokens: 50,
    temperature: 0.3,
    stream: false,
  });

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 15000);

  try {
    const response = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${apiKey}`,
      },
      body,
      signal: controller.signal,
    });

    if (!response.ok) {
      console.warn(`[title-generator] API returned ${response.status}: ${(await response.text()).slice(0, 200)}`);
      return null;
    }

    const payload = await response.json() as Record<string, unknown>;
    const choices = payload.choices;
    if (!Array.isArray(choices) || choices.length === 0) return null;
    const message = (choices[0] as Record<string, unknown>)?.message as Record<string, unknown> | undefined;
    const content = typeof message?.content === 'string' ? message.content : null;
    if (!content) return null;

    // Clean up: strip quotes, newlines, and excessive whitespace
    const cleaned = content.trim().replace(/^["'""\s]+|["'""\s]+$/g, '').replace(/\n/g, ' ').trim();
    if (!cleaned) return null;
    return cleaned.length > MAX_TITLE_LENGTH ? cleaned.slice(0, MAX_TITLE_LENGTH) + '...' : cleaned;
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
 * Generate a concise session title from the conversation's first exchange.
 *
 * @param userMessage      The user's first message
 * @param assistantMessage The assistant's first response
 * @param providerId       The credential providerId used by the session
 * @param modelId          The model ID used by the session
 * @returns A generated title string, or null if generation failed
 */
export async function generateSessionTitle(
  userMessage: string,
  assistantMessage: string,
  providerId?: string,
  modelId?: string,
): Promise<string | null> {
  if (!userMessage.trim() || !assistantMessage.trim()) return null;

  const creds = await resolveSessionCredentials(providerId, modelId);
  if (!creds) {
    console.log('[title-generator] no credentials available for title generation');
    return null;
  }

  return callChatCompletions(
    creds.apiKey,
    creds.baseUrl,
    creds.model,
    userMessage,
    assistantMessage,
  );
}
