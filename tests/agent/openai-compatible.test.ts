import { describe, expect, it, vi } from 'vitest';
import {
  buildModelInputOverrideConfig,
  buildOpenAICompatibleModelsConfig,
  fetchOpenAICompatibleModels,
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
