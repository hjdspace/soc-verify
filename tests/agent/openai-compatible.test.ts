import { describe, expect, it, vi } from 'vitest';
import {
  buildDirectChatRequest,
  buildModelInputOverrideConfig,
  buildOpenAICompatibleModelsWithPerModelContext,
  buildOpenAICompatibleModelsConfig,
  ensureV1Prefix,
  extractOpenAiFamilyContent,
  fetchOpenAICompatibleModels,
  normalizeApiFormat,
} from '../../src/main/agent/openai-compatible';

describe('OpenAI-compatible Agent configuration', () => {
  it('fetches models from a base URL that already includes /v1', async () => {
    const fetchFn = vi.fn().mockResolvedValue(new Response(JSON.stringify({
      data: [{ id: 'chat-model', owned_by: 'gateway' }],
    }), { status: 200 }));

    const models = await fetchOpenAICompatibleModels({
      baseUrl: 'https://gateway.example/v1/',
      apiKey: 'test-secret',
      fetchFn,
    });

    expect(fetchFn).toHaveBeenCalledWith('https://gateway.example/v1/models', {
      headers: { Authorization: 'Bearer test-secret' },
    });
    expect(models).toEqual([{ id: 'chat-model', name: 'chat-model' }]);
  });

  it('builds a chat/completions provider without persisting the API key', () => {
    const config = buildOpenAICompatibleModelsConfig({
      baseUrl: 'https://gateway.example/v1',
      modelId: 'chat-model',
      apiKeyEnvVar: 'SOCVERIFY_AGENT_API_KEY',
    });

    expect(config).toMatchObject({
      providers: {
        'socverify-openai-compatible': {
          baseUrl: 'https://gateway.example/v1',
          api: 'openai-completions',
          apiKey: 'SOCVERIFY_AGENT_API_KEY',
          models: [{ id: 'chat-model' }],
        },
      },
    });
    expect(JSON.stringify(config)).not.toContain('test-secret');
  });

  it('appends /v1 to baseUrl when missing so omp constructs the correct chat/completions URL', () => {
    // Without /v1, the omp engine's openai-completions provider would construct
    // `http://host:8557/chat/completions` instead of the correct
    // `http://host:8557/v1/chat/completions`, resulting in an empty LLM response.
    const config = buildOpenAICompatibleModelsConfig({
      baseUrl: 'http://ai-u.unisoc.com:8557',
      modelId: 'unisoc-code-max',
      apiKeyEnvVar: 'SOCVERIFY_AGENT_API_KEY',
    });

    expect(config.providers['socverify-openai-compatible'].baseUrl).toBe(
      'http://ai-u.unisoc.com:8557/v1',
    );
  });

  it('preserves a custom path prefix before /v1', () => {
    const config = buildOpenAICompatibleModelsConfig({
      baseUrl: 'https://gateway.example/api/v1/',
      modelId: 'chat-model',
      apiKeyEnvVar: 'SOCVERIFY_AGENT_API_KEY',
    });

    expect(config.providers['socverify-openai-compatible'].baseUrl).toBe(
      'https://gateway.example/api/v1',
    );
  });

  it('appends /v1 after a custom path prefix when missing', () => {
    const config = buildOpenAICompatibleModelsConfig({
      baseUrl: 'https://gateway.example/api/',
      modelId: 'chat-model',
      apiKeyEnvVar: 'SOCVERIFY_AGENT_API_KEY',
    });

    expect(config.providers['socverify-openai-compatible'].baseUrl).toBe(
      'https://gateway.example/api/v1',
    );
  });

  it('configures the model with text+image input so screenshots are not silently dropped', () => {
    const config = buildOpenAICompatibleModelsConfig({
      baseUrl: 'https://gateway.example/v1',
      modelId: 'vision-model',
      apiKeyEnvVar: 'SOCVERIFY_AGENT_API_KEY',
    });

    const model = config.providers['socverify-openai-compatible'].models[0];
    expect(model.input).toEqual(['text', 'image']);
    expect(model.contextWindow).toBe(200000);
  });

  it('uses the configured context window for an OpenAI-compatible model', () => {
    const config = buildOpenAICompatibleModelsConfig({
      baseUrl: 'https://gateway.example/v1',
      modelId: 'long-context-model',
      apiKeyEnvVar: 'SOCVERIFY_AGENT_API_KEY',
      contextWindow: 256000,
    });

    expect(config.providers['socverify-openai-compatible'].models[0].contextWindow).toBe(256000);
  });
});

describe('OpenAI API wire format in models config', () => {
  it('writes the selected Responses format to the provider-level api field', () => {
    const config = buildOpenAICompatibleModelsConfig({
      baseUrl: 'https://gateway.example/v1',
      modelId: 'reasoning-model',
      apiKeyEnvVar: 'SOCVERIFY_AGENT_API_KEY',
      api: 'openai-responses',
    });

    expect(config.providers['socverify-openai-compatible'].api).toBe('openai-responses');
  });

  it('defaults the provider-level api to openai-completions when omitted', () => {
    const config = buildOpenAICompatibleModelsWithPerModelContext({
      baseUrl: 'https://gateway.example/v1',
      models: [{ id: 'm', name: 'm', contextWindow: 128000 }],
      apiKeyEnvVar: 'SOCVERIFY_AGENT_API_KEY',
    });

    expect(config.providers['socverify-openai-compatible'].api).toBe('openai-completions');
  });

  it('writes the Responses format in the per-model-context variant too', () => {
    const config = buildOpenAICompatibleModelsWithPerModelContext({
      baseUrl: 'https://gateway.example/v1',
      models: [{ id: 'm', name: 'm', contextWindow: 128000 }],
      apiKeyEnvVar: 'SOCVERIFY_AGENT_API_KEY',
      api: 'openai-responses',
    });

    expect(config.providers['socverify-openai-compatible'].api).toBe('openai-responses');
  });
});

describe('normalizeApiFormat', () => {
  it('keeps openai-responses', () => {
    expect(normalizeApiFormat('openai-responses')).toBe('openai-responses');
  });

  it('falls back to openai-completions for undefined and unknown values', () => {
    expect(normalizeApiFormat(undefined)).toBe('openai-completions');
    expect(normalizeApiFormat('bogus')).toBe('openai-completions');
    expect(normalizeApiFormat('openai-completions')).toBe('openai-completions');
  });
});

describe('reasoning / thinking capability declaration', () => {
  it('declares thinking efforts for a reasoning model so omp honors thinking levels', () => {
    const config = buildOpenAICompatibleModelsWithPerModelContext({
      baseUrl: 'https://gateway.example/v1',
      models: [{ id: 'glm-5.3', name: 'GLM-5.3', contextWindow: 128000, reasoning: true }],
      apiKeyEnvVar: 'SOCVERIFY_AGENT_API_KEY',
    });

    const model = config.providers['socverify-openai-compatible'].models[0];
    expect(model.reasoning).toBe(true);
    expect(model.thinking).toEqual({
      mode: 'effort',
      efforts: ['minimal', 'low', 'medium', 'high', 'xhigh', 'max'],
    });
  });

  it('declares reasoning_content replay compat for a reasoning model (deepseek-style thinking-mode validation)', () => {
    const config = buildOpenAICompatibleModelsWithPerModelContext({
      baseUrl: 'https://gateway.example/v1',
      models: [{ id: 'deepseek-v4-flash', name: 'deepseek-v4-flash', contextWindow: 128000, reasoning: true }],
      apiKeyEnvVar: 'SOCVERIFY_AGENT_API_KEY',
    });

    const model = config.providers['socverify-openai-compatible'].models[0];
    expect(model.compat).toEqual({
      reasoningContentField: 'reasoning_content',
      requiresReasoningContentForToolCalls: true,
      allowsSyntheticReasoningContentForToolCalls: false,
    });
  });

  it('omits compat for a non-reasoning model (no thinking-mode replay field on the wire)', () => {
    const config = buildOpenAICompatibleModelsWithPerModelContext({
      baseUrl: 'https://gateway.example/v1',
      models: [{ id: 'chat-model', name: 'chat-model', contextWindow: 128000 }],
      apiKeyEnvVar: 'SOCVERIFY_AGENT_API_KEY',
    });

    const model = config.providers['socverify-openai-compatible'].models[0];
    expect(model.compat).toBeUndefined();
  });

  it('declares non-reasoning explicitly and omits thinking for a plain model', () => {
    const config = buildOpenAICompatibleModelsWithPerModelContext({
      baseUrl: 'https://gateway.example/v1',
      models: [{ id: 'chat-model', name: 'chat-model', contextWindow: 128000 }],
      apiKeyEnvVar: 'SOCVERIFY_AGENT_API_KEY',
    });

    const model = config.providers['socverify-openai-compatible'].models[0];
    expect(model.reasoning).toBe(false);
    expect(model.thinking).toBeUndefined();
  });

  it('treats an unmarked model as non-reasoning in the single-model variant too', () => {
    const config = buildOpenAICompatibleModelsConfig({
      baseUrl: 'https://gateway.example/v1',
      modelId: 'chat-model',
      apiKeyEnvVar: 'SOCVERIFY_AGENT_API_KEY',
      models: [{ id: 'chat-model', name: 'chat-model' }],
    });

    const model = config.providers['socverify-openai-compatible'].models[0];
    expect(model.reasoning).toBe(false);
    expect(model.thinking).toBeUndefined();
  });

  it('propagates the reasoning flag per model when several models are configured', () => {
    const config = buildOpenAICompatibleModelsWithPerModelContext({
      baseUrl: 'https://gateway.example/v1',
      models: [
        { id: 'glm-5.3', name: 'GLM-5.3', contextWindow: 128000, reasoning: true },
        { id: 'chat-turbo', name: 'Chat Turbo', contextWindow: 128000, reasoning: false },
      ],
      apiKeyEnvVar: 'SOCVERIFY_AGENT_API_KEY',
    });

    const models = config.providers['socverify-openai-compatible'].models;
    expect(models[0].reasoning).toBe(true);
    expect(models[1].reasoning).toBe(false);
  });
});

describe('buildDirectChatRequest', () => {
  it('builds a /chat/completions request by default with messages and max_tokens', () => {
    const request = buildDirectChatRequest({
      baseUrl: 'https://gateway.example/v1',
      model: 'chat-model',
      system: 'sys',
      user: 'usr',
      maxTokens: 100,
      temperature: 0.3,
    });

    expect(request.url).toBe('https://gateway.example/v1/chat/completions');
    expect(request.body).toMatchObject({
      model: 'chat-model',
      messages: [
        { role: 'system', content: 'sys' },
        { role: 'user', content: 'usr' },
      ],
      max_tokens: 100,
      temperature: 0.3,
      stream: false,
    });
    expect(request.body).not.toHaveProperty('max_output_tokens');
  });

  it('builds a /responses request with input role messages and max_output_tokens', () => {
    const request = buildDirectChatRequest({
      baseUrl: 'https://gateway.example/v1',
      apiFormat: 'openai-responses',
      model: 'reasoning-model',
      system: 'sys',
      user: 'usr',
      maxTokens: 100,
    });

    expect(request.url).toBe('https://gateway.example/v1/responses');
    expect(request.body).toMatchObject({
      model: 'reasoning-model',
      input: [
        { role: 'system', content: 'sys' },
        { role: 'user', content: 'usr' },
      ],
      max_output_tokens: 100,
      stream: false,
    });
    expect(request.body).not.toHaveProperty('messages');
    expect(request.body).not.toHaveProperty('max_tokens');
  });

  it('omits temperature when not provided', () => {
    const request = buildDirectChatRequest({
      baseUrl: 'https://gateway.example/v1',
      model: 'm',
      system: 's',
      user: 'u',
      maxTokens: 10,
    });

    expect(request.body).not.toHaveProperty('temperature');
  });
});

describe('extractOpenAiFamilyContent', () => {
  it('extracts choices[0].message.content (chat/completions)', () => {
    expect(extractOpenAiFamilyContent({
      choices: [{ message: { content: 'hello' } }],
    })).toBe('hello');
  });

  it('extracts and joins content parts when content is an array', () => {
    expect(extractOpenAiFamilyContent({
      choices: [{ message: { content: [{ type: 'text', text: 'a' }, { type: 'text', text: 'b' }] } }],
    })).toBe('ab');
  });

  it('extracts the top-level output_text shortcut (responses)', () => {
    expect(extractOpenAiFamilyContent({ output_text: 'summary text' })).toBe('summary text');
  });

  it('extracts output_text parts from output[] message items (responses)', () => {
    expect(extractOpenAiFamilyContent({
      output: [
        { type: 'reasoning', summary: [] },
        { type: 'message', content: [{ type: 'output_text', text: 'part1' }] },
        { type: 'message', content: [{ type: 'output_text', text: 'part2' }] },
      ],
    })).toBe('part1part2');
  });

  it('ignores non-message output items and returns null when no text exists', () => {
    expect(extractOpenAiFamilyContent({
      output: [{ type: 'reasoning', summary: [] }],
    })).toBeNull();
    expect(extractOpenAiFamilyContent({})).toBeNull();
  });
});

describe('ensureV1Prefix', () => {
  it('leaves a /v1 URL untouched', () => {
    expect(ensureV1Prefix('https://gw.example/v1')).toBe('https://gw.example/v1');
  });

  it('appends /v1 to a bare host', () => {
    expect(ensureV1Prefix('https://gw.example')).toBe('https://gw.example/v1');
  });
});

describe('buildModelInputOverrideConfig', () => {
  it('patches only the input field via modelOverrides for a built-in provider', () => {
    const config = buildModelInputOverrideConfig({
      provider: 'anthropic',
      modelId: 'claude-sonnet-4-5',
    });

    expect(config).toEqual({
      providers: {
        anthropic: {
          modelOverrides: {
            'claude-sonnet-4-5': {
              input: ['text', 'image'],
            },
          },
        },
      },
    });
  });

  it('does not redefine the provider (no baseUrl/api/models keys)', () => {
    const config = buildModelInputOverrideConfig({
      provider: 'openai',
      modelId: 'gpt-4o',
    });

    const providerEntry = config.providers.openai;
    expect(providerEntry).toHaveProperty('modelOverrides');
    expect(providerEntry).not.toHaveProperty('models');
    expect(providerEntry).not.toHaveProperty('baseUrl');
    expect(providerEntry).not.toHaveProperty('api');
    expect(providerEntry).not.toHaveProperty('apiKey');
  });

  it('forces input to include image so vision-guard keeps images', () => {
    const config = buildModelInputOverrideConfig({
      provider: 'google',
      modelId: 'gemini-2.0-flash',
    });

    const override = config.providers.google.modelOverrides['gemini-2.0-flash'];
    expect(override.input).toEqual(['text', 'image']);
  });
});
