export const OPENAI_COMPATIBLE_PROVIDER = 'socverify-openai-compatible';
export const OPENAI_COMPATIBLE_API_KEY_ENV = 'SOCVERIFY_AGENT_API_KEY';

export type OpenAICompatibleModel = {
  id: string;
  name: string;
};

type FetchModelsOptions = {
  baseUrl: string;
  apiKey: string;
  fetchFn?: typeof fetch;
};

type ModelsConfigOptions = {
  baseUrl: string;
  modelId: string;
  apiKeyEnvVar: string;
};

function normalizeBaseUrl(baseUrl: string): string {
  return baseUrl.trim().replace(/\/+$/, '');
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
    models.push({
      id: model.id,
      name: typeof model.name === 'string' && model.name ? model.name : model.id,
    });
  }

  return models;
}

export function buildOpenAICompatibleModelsConfig({
  baseUrl,
  modelId,
  apiKeyEnvVar,
}: ModelsConfigOptions) {
  return {
    providers: {
      [OPENAI_COMPATIBLE_PROVIDER]: {
        baseUrl: normalizeBaseUrl(baseUrl),
        api: 'openai-completions',
        apiKey: apiKeyEnvVar,
        authHeader: true,
        disableStrictTools: true,
        models: [{
          id: modelId,
          name: modelId,
          supportsTools: true,
          contextWindow: 128000,
          maxTokens: 8192,
          // Default to text+image so screenshots and pasted images are sent
          // to the LLM as multimodal content. Without "image" in the input
          // list, omp silently replaces images with a placeholder text
          // ("[image omitted: model does not support vision]"), causing the
          // LLM to respond as if no image was attached.
          input: ['text', 'image'],
        }],
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
