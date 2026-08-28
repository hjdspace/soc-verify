/**
 * OpenAI 兼容端点的 API wire 格式：
 *  - openai-completions → POST {baseUrl}/chat/completions（默认，兼容大多数网关）
 *  - openai-responses   → POST {baseUrl}/responses（仅当后端实现了 Responses API）
 */
export type OpenAiApiFormat = 'openai-completions' | 'openai-responses';

/**
 * A model configured under a credential/provider. Each model has its own
 * context window size — there is no global context window anymore.
 */
export interface ConfiguredModel {
  /** Model ID as returned by the API (e.g. "gpt-4o-mini"). */
  id: string;
  /** Display name (falls back to id when not set). */
  name: string;
  /** Context window size in tokens for this specific model. */
  contextWindow: number;
  /**
   * 是否为推理模型（支持思考强度控制）。写入 models.json 的 `reasoning` +
   * `thinking.efforts` 声明，omp 引擎据此决定是否在请求里下发
   * `reasoning_effort`。缺省视为 false —— 引擎不会发送思考强度参数。
   */
  reasoning?: boolean;
}

export interface CredentialEntry {
  providerId: string;
  label: string;
  apiKeyMasked: string;
  baseUrl?: string;
  /** API wire 格式（openai 兼容协议专用），缺省为 openai-completions。 */
  api?: OpenAiApiFormat;
  /** Models configured for this provider. Each has its own contextWindow. */
  models: ConfiguredModel[];
  createdAt: number;
}

export interface CredentialInput {
  providerId: string;
  label: string;
  apiKey: string;
  baseUrl?: string;
  api?: OpenAiApiFormat;
  models?: ConfiguredModel[];
}

/**
 * Partial credential update — used when editing an existing credential.
 * `apiKey` is optional: when omitted, the existing key is preserved.
 * `models` is optional: when omitted, the existing models are preserved.
 */
export interface CredentialUpdateInput {
  providerId: string;
  label?: string;
  apiKey?: string;
  baseUrl?: string;
  api?: OpenAiApiFormat;
  models?: ConfiguredModel[];
}
