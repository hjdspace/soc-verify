import { describe, expect, it, vi } from 'vitest';
import {
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
