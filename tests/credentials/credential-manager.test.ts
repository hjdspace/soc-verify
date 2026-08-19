import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtemp, rm, readFile, writeFile, mkdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

// ─── Mock electron app.getPath to return a temp directory ───────────
let tempDataDir: string;

vi.mock('electron', () => ({
  app: {
    getPath: vi.fn(() => tempDataDir),
  },
}));

// Import AFTER mock so the module picks up the mocked electron.
const { credentialManager } = await import('../../src/main/credentials/credential-manager');

// CredentialManagerImpl uses app.getPath('userData') → join(..., 'socverify-data')
// So credentialsPath = <tempDataDir>/socverify-data/credentials.json

describe('CredentialManager — CRUD operations', () => {
  beforeEach(async () => {
    tempDataDir = await mkdtemp(join(tmpdir(), 'socverify-cred-test-'));
  });

  afterEach(async () => {
    if (tempDataDir) await rm(tempDataDir, { recursive: true, force: true });
  });

  it('returns empty list when no credentials file exists', async () => {
    const all = await credentialManager.listRaw();
    expect(all).toEqual([]);
    const masked = await credentialManager.listMasked();
    expect(masked).toEqual([]);
  });

  it('saves a new credential and returns a masked entry', async () => {
    const entry = await credentialManager.save({
      providerId: 'openai',
      label: 'OpenAI',
      apiKey: 'sk-secret-key-12345',
      baseUrl: 'https://api.openai.com/v1',
    });

    expect(entry).toMatchObject({
      providerId: 'openai',
      label: 'OpenAI',
      apiKeyMasked: 'sk-s***',
      baseUrl: 'https://api.openai.com/v1',
    });
    expect(entry.createdAt).toBeGreaterThan(0);
    // Must NOT expose the full key
    expect(entry.apiKeyMasked).not.toContain('secret-key');
  });

  it('updates an existing credential (upsert by providerId)', async () => {
    await credentialManager.save({
      providerId: 'openai',
      label: 'OpenAI',
      apiKey: 'sk-old-key',
    });

    const updated = await credentialManager.save({
      providerId: 'openai',
      label: 'OpenAI Pro',
      apiKey: 'sk-new-key',
      baseUrl: 'https://api.openai.com/v2',
    });

    expect(updated.label).toBe('OpenAI Pro');
    expect(updated.apiKeyMasked).toBe('sk-n***');

    // Only one entry, not duplicated
    const all = await credentialManager.listRaw();
    expect(all).toHaveLength(1);
    expect(all[0].apiKey).toBe('sk-new-key');
  });

  it('preserves createdAt on update, sets new on create', async () => {
    const created = await credentialManager.save({
      providerId: 'anthropic',
      label: 'Claude',
      apiKey: 'sk-ant-key',
    });
    const originalCreatedAt = created.createdAt;

    // Wait a tiny bit to ensure Date.now() would differ
    await new Promise((r) => setTimeout(r, 5));

    const updated = await credentialManager.save({
      providerId: 'anthropic',
      label: 'Claude Pro',
      apiKey: 'sk-ant-new',
    });

    expect(updated.createdAt).toBe(originalCreatedAt);
  });

  it('gets a credential by providerId', async () => {
    await credentialManager.save({
      providerId: 'google',
      label: 'Gemini',
      apiKey: 'AIza-xyz',
    });

    const cred = await credentialManager.get('google');
    expect(cred).not.toBeNull();
    expect(cred?.apiKey).toBe('AIza-xyz');

    const missing = await credentialManager.get('nonexistent');
    expect(missing).toBeNull();
  });

  it('partially updates a credential, preserving omitted fields', async () => {
    await credentialManager.save({
      providerId: 'openai',
      label: 'OpenAI',
      apiKey: 'sk-original',
      baseUrl: 'https://api.openai.com/v1',
      model: 'gpt-4',
    });

    // Update only the label
    const updated = await credentialManager.update({
      providerId: 'openai',
      label: 'My OpenAI',
    });

    expect(updated.label).toBe('My OpenAI');
    expect(updated.baseUrl).toBe('https://api.openai.com/v1');
    expect(updated.model).toBe('gpt-4');

    // API key should be preserved
    const raw = await credentialManager.get('openai');
    expect(raw?.apiKey).toBe('sk-original');
  });

  it('preserves the existing API key when update omits apiKey', async () => {
    await credentialManager.save({
      providerId: 'openai',
      label: 'OpenAI',
      apiKey: 'sk-preserve-me',
    });

    await credentialManager.update({
      providerId: 'openai',
      label: 'Renamed',
      // apiKey intentionally omitted
    });

    const raw = await credentialManager.get('openai');
    expect(raw?.apiKey).toBe('sk-preserve-me');
  });

  it('throws when updating a non-existent credential', async () => {
    await expect(
      credentialManager.update({ providerId: 'ghost', label: 'Ghost' }),
    ).rejects.toThrow('Credential not found: ghost');
  });

  it('deletes a credential by providerId', async () => {
    await credentialManager.save({
      providerId: 'openai',
      label: 'OpenAI',
      apiKey: 'sk-to-delete',
    });
    await credentialManager.save({
      providerId: 'anthropic',
      label: 'Claude',
      apiKey: 'sk-keep-me',
    });

    await credentialManager.delete('openai');

    const all = await credentialManager.listRaw();
    expect(all).toHaveLength(1);
    expect(all[0].providerId).toBe('anthropic');
  });

  it('delete is idempotent (no error on missing providerId)', async () => {
    await expect(credentialManager.delete('nonexistent')).resolves.toBeUndefined();
  });

  it('getDefaultCredential returns the first stored credential', async () => {
    await credentialManager.save({
      providerId: 'openai',
      label: 'OpenAI',
      apiKey: 'sk-first',
    });
    await credentialManager.save({
      providerId: 'anthropic',
      label: 'Claude',
      apiKey: 'sk-second',
    });

    const default_ = await credentialManager.getDefaultCredential();
    expect(default_).not.toBeNull();
    expect(default_?.providerId).toBe('openai');
  });

  it('getDefaultCredential returns null when empty', async () => {
    const default_ = await credentialManager.getDefaultCredential();
    expect(default_).toBeNull();
  });

  it('listMasked masks all API keys', async () => {
    await credentialManager.save({
      providerId: 'openai',
      label: 'OpenAI',
      apiKey: 'sk-1234567890abcdef',
    });
    await credentialManager.save({
      providerId: 'anthropic',
      label: 'Claude',
      apiKey: 'sk-ant-abcdef',
    });

    const masked = await credentialManager.listMasked();
    expect(masked).toHaveLength(2);
    for (const entry of masked) {
      expect(entry.apiKeyMasked).toMatch(/^.{4}\*\*\*$/);
      expect(entry.apiKeyMasked).not.toContain('abcdef');
    }
  });

  it('persists credentials to disk as JSON', async () => {
    await credentialManager.save({
      providerId: 'openai',
      label: 'OpenAI',
      apiKey: 'sk-persisted',
    });

    const credPath = join(tempDataDir, 'socverify-data', 'credentials.json');
    expect(existsSync(credPath)).toBe(true);

    const raw = JSON.parse(await readFile(credPath, 'utf-8'));
    expect(raw).toHaveLength(1);
    expect(raw[0].apiKey).toBe('sk-persisted');
  });

  it('creates the data directory if it does not exist', async () => {
    // The socverify-data subdirectory should be created on first save
    await credentialManager.save({
      providerId: 'openai',
      label: 'OpenAI',
      apiKey: 'sk-mkdir-test',
    });

    const dataDir = join(tempDataDir, 'socverify-data');
    expect(existsSync(dataDir)).toBe(true);
  });

  it('loads credentials from an existing file', async () => {
    // Pre-populate the credentials file
    const dataDir = join(tempDataDir, 'socverify-data');
    await mkdir(dataDir, { recursive: true });
    const credPath = join(dataDir, 'credentials.json');
    await writeFile(credPath, JSON.stringify([
      {
        providerId: 'preloaded',
        label: 'Preloaded',
        apiKey: 'sk-preloaded-key',
        createdAt: 12345,
      },
    ]), 'utf-8');

    const all = await credentialManager.listRaw();
    expect(all).toHaveLength(1);
    expect(all[0].providerId).toBe('preloaded');
    expect(all[0].apiKey).toBe('sk-preloaded-key');
  });

  it('returns empty array when credentials file is invalid JSON', async () => {
    const dataDir = join(tempDataDir, 'socverify-data');
    await mkdir(dataDir, { recursive: true });
    await writeFile(join(dataDir, 'credentials.json'), 'not valid json', 'utf-8');

    const all = await credentialManager.listRaw();
    expect(all).toEqual([]);
  });
});

describe('CredentialManager — mapProviderForAgent', () => {
  it('maps "openai" to "openai"', () => {
    expect(credentialManager.mapProviderForAgent('openai')).toBe('openai');
  });

  it('maps "openai-compatible" to "openai"', () => {
    expect(credentialManager.mapProviderForAgent('openai-compatible')).toBe('openai');
  });

  it('maps "anthropic" to "anthropic"', () => {
    expect(credentialManager.mapProviderForAgent('anthropic')).toBe('anthropic');
  });

  it('maps "claude" to "anthropic"', () => {
    expect(credentialManager.mapProviderForAgent('claude')).toBe('anthropic');
  });

  it('maps "google" to "google"', () => {
    expect(credentialManager.mapProviderForAgent('google')).toBe('google');
  });

  it('maps "gemini" to "google"', () => {
    expect(credentialManager.mapProviderForAgent('gemini')).toBe('google');
  });

  it('passes through unknown providers in lowercase', () => {
    expect(credentialManager.mapProviderForAgent('Ollama')).toBe('ollama');
    expect(credentialManager.mapProviderForAgent('MyCustomProvider')).toBe('mycustomprovider');
  });
});

describe('CredentialManager — buildEnvForAgent', () => {
  beforeEach(async () => {
    tempDataDir = await mkdtemp(join(tmpdir(), 'socverify-cred-env-'));
  });

  afterEach(async () => {
    if (tempDataDir) await rm(tempDataDir, { recursive: true, force: true });
  });

  it('builds env vars for an OpenAI-compatible provider', async () => {
    await credentialManager.save({
      providerId: 'openai',
      label: 'OpenAI',
      apiKey: 'sk-test-key',
      baseUrl: 'https://api.openai.com/v1',
    });

    const env = await credentialManager.buildEnvForAgent();

    expect(env.OPENAI_API_KEY).toBe('sk-test-key');
    expect(env.OPENAI_BASE_URL).toBe('https://api.openai.com/v1');
  });

  it('builds generic env vars for any provider', async () => {
    await credentialManager.save({
      providerId: 'anthropic',
      label: 'Claude',
      apiKey: 'sk-ant-key',
      baseUrl: 'https://api.anthropic.com',
    });

    const env = await credentialManager.buildEnvForAgent();

    expect(env.ANTHROPIC_API_KEY).toBe('sk-ant-key');
    expect(env.ANTHROPIC_BASE_URL).toBe('https://api.anthropic.com');
  });

  it('sets generic API_KEY and API_BASE_URL for the first credential', async () => {
    await credentialManager.save({
      providerId: 'openai',
      label: 'OpenAI',
      apiKey: 'sk-generic-test',
      baseUrl: 'https://api.openai.com/v1',
    });

    const env = await credentialManager.buildEnvForAgent();

    expect(env.API_KEY).toBe('sk-generic-test');
    expect(env.API_BASE_URL).toBe('https://api.openai.com/v1');
  });

  it('handles multiple credentials without overwriting first-set env vars', async () => {
    await credentialManager.save({
      providerId: 'openai',
      label: 'OpenAI',
      apiKey: 'sk-first',
      baseUrl: 'https://api.openai.com/v1',
    });
    await credentialManager.save({
      providerId: 'anthropic',
      label: 'Claude',
      apiKey: 'sk-second',
      baseUrl: 'https://api.anthropic.com',
    });

    const env = await credentialManager.buildEnvForAgent();

    // First credential wins for generic vars
    expect(env.API_KEY).toBe('sk-first');
    expect(env.API_BASE_URL).toBe('https://api.openai.com/v1');

    // Provider-specific vars are set for both
    expect(env.OPENAI_API_KEY).toBe('sk-first');
    expect(env.ANTHROPIC_API_KEY).toBe('sk-second');
  });

  it('returns empty env when no credentials exist', async () => {
    const env = await credentialManager.buildEnvForAgent();
    expect(env).toEqual({});
  });

  it('handles credentials without baseUrl', async () => {
    await credentialManager.save({
      providerId: 'ollama',
      label: 'Ollama',
      apiKey: 'no-key-needed',
    });

    const env = await credentialManager.buildEnvForAgent();

    expect(env.OLLAMA_API_KEY).toBe('no-key-needed');
    expect(env.OLLAMA_BASE_URL).toBeUndefined();
    expect(env.API_KEY).toBe('no-key-needed');
    expect(env.API_BASE_URL).toBeUndefined();
  });

  it('replaces hyphens with underscores in env var names', async () => {
    await credentialManager.save({
      providerId: 'my-custom-provider',
      label: 'Custom',
      apiKey: 'sk-custom',
      baseUrl: 'https://custom.api/v1',
    });

    const env = await credentialManager.buildEnvForAgent();

    expect(env.MY_CUSTOM_PROVIDER_API_KEY).toBe('sk-custom');
    expect(env.MY_CUSTOM_PROVIDER_BASE_URL).toBe('https://custom.api/v1');
  });
});
