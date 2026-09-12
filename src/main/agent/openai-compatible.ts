import { DEFAULT_CONTEXT_WINDOW } from '@shared/context-management';
import type { ConfiguredModel, OpenAiApiFormat } from '@shared/types';

export const OPENAI_COMPATIBLE_PROVIDER = 'socverify-openai-compatible';
export const OPENAI_COMPATIBLE_API_KEY_ENV = 'SOCVERIFY_AGENT_API_KEY';

/** 凭据未显式选择 API 格式时的缺省值。 */
export const DEFAULT_OPENAI_API_FORMAT: OpenAiApiFormat = 'openai-completions';

/** 归一化 API 格式：非法/缺省值回落到 openai-completions。 */
export function normalizeApiFormat(api: string | undefined): OpenAiApiFormat {
  return api === 'openai-responses' ? 'openai-responses' : DEFAULT_OPENAI_API_FORMAT;
}

export type OpenAICompatibleModel = {
  id: string;
  name: string;
  /** 推理模型标记（来自凭据配置），透传到 models.json 的 reasoning/thinking 声明。 */
  reasoning?: boolean;
  /** Input modalities advertised by the provider. Unknown models are text-only. */
  input?: ('text' | 'image')[];
};

type FetchModelsOptions = {
  baseUrl: string;
  apiKey: string;
  fetchFn?: typeof fetch;
};

type ModelsConfigOptions = {
  baseUrl: string;
  /** The default/active model ID (used as fallback when no `models` list is provided). */
  modelId: string;
  /** Optional full model list. When provided, ALL models are written to
   *  models.json so the omp engine's `set_model` RPC can switch to any of
   *  them at runtime (instead of being locked to a single model). */
  models?: OpenAICompatibleModel[];
  apiKeyEnvVar: string;
  contextWindow?: number;
  /** OpenAI 兼容端点的 API wire 格式，写入 provider 级 `api` 字段。 */
  api?: OpenAiApiFormat;
};

function normalizeBaseUrl(baseUrl: string): string {
  return baseUrl.trim().replace(/\/+$/, '');
}

/**
 * pi models.json 单模型条目（omp → pi 迁移后，models.yml 的消费方是 pi-ai，
 * 其模型 schema 与 omp 不同：omp 的 `thinking {mode, efforts}` 与
 * `compat.reasoningContentField` 等字段 pi 不识别（静默忽略），必须改写为
 * pi 的 `compat`（OpenAICompletionsCompat）字段。
 *
 * 所有模型统一声明保守 compat —— 这些内部 OpenAI 兼容端点只认经典
 * chat/completions 参数，而 pi 对未识别端点的自动探测会按 OpenAI 新版行为
 * 发请求，逐项对应：
 *  - maxTokensField: 'max_tokens' —— pi 默认发 `max_completion_tokens`，
 *    端点不认该字段 → 400 "inference request is invalid"
 *  - supportsStore: false —— 不发送 `store` 字段
 *  - supportsDeveloperRole: false —— 系统提示词保持 `system` 角色
 *    （pi 对推理模型默认改用 OpenAI 的 `developer` 角色，端点不认）
 *  - supportsStrictMode: false —— 工具定义不携带 `strict` 字段
 *
 * 推理模型额外声明 requiresReasoningContentOnAssistantMessages：deepseek 系
 * 端点（如 SenseNova deepseek-v4、DeepSeek 官方 API）在 thinking 模式下校验
 * 历史，要求带 tool_calls 的 assistant 消息回传 `reasoning_content`，否则
 * 第二轮请求报 400。pi 已把流式 reasoning_content 存为 thinking 块，声明该
 * compat 后 openai-completions 编码器会回传真实值（无 thinking 块时回传空串）。
 * 思考强度经默认 thinkingFormat "openai" 下发为 `reasoning_effort`
 * （与 omp models.yml 的 thinking mode "effort" 等价），无需额外声明。
 */
const PI_OPENAI_COMPAT_BASE = {
  maxTokensField: 'max_tokens' as const,
  supportsStore: false,
  supportsDeveloperRole: false,
  supportsStrictMode: false,
};

function toOmpModelEntry(model: OpenAICompatibleModel, contextWindow: number) {
  const reasoning = model.reasoning === true;
  return {
    id: model.id,
    name: model.name,
    contextWindow,
    maxTokens: 8192,
    reasoning,
    ...(reasoning
      ? {
          compat: {
            ...PI_OPENAI_COMPAT_BASE,
            requiresReasoningContentOnAssistantMessages: true,
          },
        }
      : {
          compat: { ...PI_OPENAI_COMPAT_BASE },
        }),
    // Unknown models are text-only. This also lets the engine remove historical
    // image frames before sending them to text-only models.
    input: model.input ?? ['text'],
  };
}

function parseModelInput(value: unknown): ('text' | 'image')[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const values = value.filter((item): item is 'text' | 'image' => item === 'text' || item === 'image');
  return values.includes('image') ? ['text', 'image'] : ['text'];
}

function advertisedModelInput(model: Record<string, unknown>): ('text' | 'image')[] | undefined {
  const direct = parseModelInput(model.input)
    ?? parseModelInput(model.modalities)
    ?? parseModelInput(model.input_modalities);
  if (direct) return direct;

  const capabilities = model.capabilities;
  if (typeof capabilities === 'object' && capabilities !== null) {
    const caps = capabilities as Record<string, unknown>;
    if (caps.vision === true || caps.image === true || caps.image_input === true) return ['text', 'image'];
  }
  if (model.vision === true || model.supports_vision === true || model.image_input === true) {
    return ['text', 'image'];
  }
  return undefined;
}

/**
 * Ensure the baseUrl ends with `/v1` — the standard OpenAI-compatible API
 * version prefix.  The omp engine's `openai-completions` provider appends
 * `/chat/completions` directly to `baseUrl`, so if the URL is missing `/v1`
 * the request goes to e.g. `http://host:8557/chat/completions` instead of
 * `http://host:8557/v1/chat/completions`, resulting in an empty response.
 */
export function ensureV1Prefix(baseUrl: string): string {
  const normalized = normalizeBaseUrl(baseUrl);
  try {
    const parsed = new URL(normalized);
    const trimmedPath = parsed.pathname.replace(/\/+$/, '');
    if (trimmedPath.endsWith('/v1')) {
      return normalized;
    }
    parsed.pathname = trimmedPath ? `${trimmedPath}/v1` : '/v1';
    return `${parsed.protocol}//${parsed.host}${parsed.pathname}`;
  } catch {
    // Not a valid URL — fall back to simple string check
    return normalized.endsWith('/v1') ? normalized : `${normalized}/v1`;
  }
}

export async function fetchOpenAICompatibleModels({
  baseUrl,
  apiKey,
  fetchFn = fetch,
}: FetchModelsOptions): Promise<OpenAICompatibleModel[]> {
  const base = normalizeBaseUrl(baseUrl);
  const modelsUrl = base.endsWith('/v1') ? `${base}/models` : `${base}/v1/models`;
  const response = await fetchFn(modelsUrl, {
    headers: { Authorization: `Bearer ${apiKey}` },
  });

  if (!response.ok) {
    const details = (await response.text()).slice(0, 200);
    throw new Error(`API returned ${response.status}: ${details}`);
  }

  const payload = await response.json() as Record<string, unknown>;
  const data = Array.isArray(payload.data) ? payload.data : [payload.data];
  const models: OpenAICompatibleModel[] = [];

  for (const item of data) {
    if (typeof item !== 'object' || item === null) continue;
    const model = item as Record<string, unknown>;
    if (typeof model.id !== 'string' || !model.id) continue;
    const input = advertisedModelInput(model);
    models.push({
      id: model.id,
      name: typeof model.name === 'string' && model.name ? model.name : model.id,
      ...(input ? { input } : {}),
    });
  }

  return models;
}

export function buildOpenAICompatibleModelsConfig({
  baseUrl,
  modelId,
  models,
  apiKeyEnvVar,
  contextWindow = DEFAULT_CONTEXT_WINDOW,
  api,
}: ModelsConfigOptions) {
  // Use the full model list when provided; otherwise fall back to a single-model
  // config. Writing all models is essential for runtime model switching via the
  // omp engine's `set_model` RPC — if a model isn't in models.json, `set_model`
  // silently fails and messages are still sent with the old model.
  const allModels = models && models.length > 0
    ? models
    : [{ id: modelId, name: modelId }];
  return {
    providers: {
      [OPENAI_COMPATIBLE_PROVIDER]: {
        baseUrl: ensureV1Prefix(baseUrl),
        api: api ?? DEFAULT_OPENAI_API_FORMAT,
        apiKey: apiKeyEnvVar,
        authHeader: true,
        disableStrictTools: true,
        models: allModels.map((m) => toOmpModelEntry(m, contextWindow)),
      },
    },
  } as const;
}

/**
 * Build a models.json config where each model has its own contextWindow.
 * Used when the user has configured models with individual context window sizes
 * in the settings UI — no global contextWindow is applied.
 */
export function buildOpenAICompatibleModelsWithPerModelContext({
  baseUrl,
  models,
  apiKeyEnvVar,
  api,
}: {
  baseUrl: string;
  models: ConfiguredModel[];
  apiKeyEnvVar: string;
  /** OpenAI 兼容端点的 API wire 格式，写入 provider 级 `api` 字段。 */
  api?: OpenAiApiFormat;
}) {
  return {
    providers: {
      [OPENAI_COMPATIBLE_PROVIDER]: {
        baseUrl: ensureV1Prefix(baseUrl),
        api: api ?? DEFAULT_OPENAI_API_FORMAT,
        apiKey: apiKeyEnvVar,
        authHeader: true,
        disableStrictTools: true,
        models: models.map((m) => toOmpModelEntry(m, m.contextWindow)),
      },
    },
  } as const;
}

type ModelInputOverrideOptions = {
  provider: string;
  modelId: string;
};

/**
 * Build a models.json that patches the `input` field of a catalog model via
 * `modelOverrides`, leaving all other catalog properties (api, baseUrl, cost,
 * contextWindow, ...) intact.
 *
 * Used for built-in providers (e.g. "openai", "anthropic", "google") where
 * the user supplies only an API key (no baseUrl). Without this override,
 * omp's vision-guard silently replaces images with a placeholder text when
 * the catalog marks the model as text-only — even when the model actually
 * supports vision.
 */
export function buildModelInputOverrideConfig({
  provider,
  modelId,
}: ModelInputOverrideOptions) {
  return {
    providers: {
      [provider]: {
        modelOverrides: {
          [modelId]: {
            input: ['text', 'image'],
          },
        },
      },
    },
  } as const;
}

// ── 直连 LLM 调用 helper（不经 omp 引擎的调用方复用：标题生成 / KB / SCM）──

export type DirectChatRequest = {
  url: string;
  body: Record<string, unknown>;
};

/**
 * 构建非流式对话请求，按 apiFormat 分派端点与请求体：
 *  - openai-completions → POST {base}/chat/completions（messages + max_tokens）
 *  - openai-responses   → POST {base}/responses（input 角色消息 + max_output_tokens）
 *
 * `baseUrl` 需已含 `/v1` 前缀（可先过 ensureV1Prefix）。
 */
export function buildDirectChatRequest(options: {
  baseUrl: string;
  apiFormat?: OpenAiApiFormat;
  model: string;
  system: string;
  user: string;
  maxTokens: number;
  temperature?: number;
}): DirectChatRequest {
  const base = options.baseUrl.replace(/\/+$/, '');
  const temperature = options.temperature !== undefined
    ? { temperature: options.temperature }
    : {};

  if (normalizeApiFormat(options.apiFormat) === 'openai-responses') {
    return {
      url: `${base}/responses`,
      body: {
        model: options.model,
        input: [
          { role: 'system', content: options.system },
          { role: 'user', content: options.user },
        ],
        max_output_tokens: options.maxTokens,
        ...temperature,
        stream: false,
      },
    };
  }

  return {
    url: `${base}/chat/completions`,
    body: {
      model: options.model,
      messages: [
        { role: 'system', content: options.system },
        { role: 'user', content: options.user },
      ],
      max_tokens: options.maxTokens,
      ...temperature,
      stream: false,
    },
  };
}

/**
 * 从 openai 兼容响应（chat/completions 或 responses 两种格式）提取助手指令文本。
 *  - chat/completions：choices[0].message.content（字符串或 content parts 数组）
 *  - responses：顶层 output_text 或 output[] 中 message 项的 output_text part
 * 形状不冲突，可安全地按顺序尝试。
 */
export function extractOpenAiFamilyContent(payload: Record<string, unknown>): string | null {
  // ── chat/completions 形状 ──
  const choices = payload.choices as Array<Record<string, unknown>> | undefined;
  const message = choices?.[0]?.message as Record<string, unknown> | undefined;
  if (message) {
    if (typeof message.content === 'string' && message.content.trim()) {
      return message.content;
    }
    if (Array.isArray(message.content)) {
      const texts: string[] = [];
      for (const part of message.content) {
        if (typeof part === 'object' && part !== null) {
          const text = (part as Record<string, unknown>).text;
          if (typeof text === 'string') texts.push(text);
        }
      }
      const joined = texts.join('').trim();
      if (joined) return joined;
    }
  }

  // ── responses 形状：顶层 output_text（官方 SDK 的便捷字段） ──
  if (typeof payload.output_text === 'string' && payload.output_text.trim()) {
    return payload.output_text;
  }

  // ── responses 形状：output[] 中的 message 项 ──
  const output = payload.output;
  if (Array.isArray(output)) {
    const texts: string[] = [];
    for (const item of output) {
      if (typeof item !== 'object' || item === null) continue;
      const record = item as Record<string, unknown>;
      if (record.type !== 'message' || !Array.isArray(record.content)) continue;
      for (const part of record.content) {
        if (typeof part === 'object' && part !== null) {
          const p = part as Record<string, unknown>;
          if (p.type === 'output_text' && typeof p.text === 'string') texts.push(p.text);
        }
      }
    }
    const joined = texts.join('').trim();
    if (joined) return joined;
  }

  return null;
}
