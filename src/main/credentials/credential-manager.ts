import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { app } from 'electron';
import type { CredentialEntry, CredentialInput, CredentialUpdateInput, ConfiguredModel, OpenAiApiFormat } from '@shared/types';

const CREDENTIALS_FILE = 'credentials.json';

interface StoredCredential {
  providerId: string;
  label: string;
  apiKey: string;
  baseUrl?: string;
  /** OpenAI 兼容端点的 API wire 格式，缺省 openai-completions。 */
  api?: OpenAiApiFormat;
  models: ConfiguredModel[];
  createdAt: number;
}

class CredentialManagerImpl {
  private get dataDir(): string {
    return join(app.getPath('userData'), 'socverify-data');
  }

  private get credentialsPath(): string {
    return join(this.dataDir, CREDENTIALS_FILE);
  }

  async loadAll(): Promise<StoredCredential[]> {
    try {
      const content = await readFile(this.credentialsPath, 'utf-8');
      const parsed = JSON.parse(content) as StoredCredential[];
      // Migration: ensure all entries have a models array (old entries may not).
      return parsed.map((c) => ({
        ...c,
        models: Array.isArray(c.models) ? c.models : [],
      }));
    } catch {
      return [];
    }
  }

  async get(providerId: string): Promise<StoredCredential | null> {
    const all = await this.loadAll();
    return all.find((c) => c.providerId === providerId) ?? null;
  }

  async save(input: CredentialInput): Promise<CredentialEntry> {
    const all = await this.loadAll();
    const idx = all.findIndex((c) => c.providerId === input.providerId);

    const stored: StoredCredential = {
      providerId: input.providerId,
      label: input.label || input.providerId,
      apiKey: input.apiKey,
      baseUrl: input.baseUrl,
      api: input.api,
      models: input.models ?? [],
      createdAt: idx >= 0 ? all[idx].createdAt : Date.now(),
    };

    if (idx >= 0) {
      all[idx] = stored;
    } else {
      all.push(stored);
    }

    await this.persist(all);

    return this.toMasked(stored);
  }

  /**
   * Partially update an existing credential.
   * Only the provided fields are changed; omitted fields keep their current value.
   * `apiKey` is optional — when omitted, the existing key is preserved.
   * `models` is optional — when omitted, the existing models are preserved.
   * Throws if the credential does not exist.
   */
  async update(input: CredentialUpdateInput): Promise<CredentialEntry> {
    const all = await this.loadAll();
    const idx = all.findIndex((c) => c.providerId === input.providerId);
    if (idx < 0) {
      throw new Error(`Credential not found: ${input.providerId}`);
    }

    const existing = all[idx];
    const updated: StoredCredential = {
      providerId: existing.providerId,
      label: input.label !== undefined ? (input.label || existing.providerId) : existing.label,
      apiKey: input.apiKey !== undefined && input.apiKey !== '' ? input.apiKey : existing.apiKey,
      baseUrl: input.baseUrl !== undefined ? (input.baseUrl || undefined) : existing.baseUrl,
      api: input.api !== undefined ? input.api : existing.api,
      models: input.models !== undefined ? input.models : existing.models,
      createdAt: existing.createdAt,
    };
    all[idx] = updated;
    await this.persist(all);

    return this.toMasked(updated);
  }

  async delete(providerId: string): Promise<void> {
    const all = await this.loadAll();
    const filtered = all.filter((c) => c.providerId !== providerId);
    await this.persist(filtered);
  }

  /** Return masked entries for UI display */
  async listMasked(): Promise<CredentialEntry[]> {
    const all = await this.loadAll();
    return all.map((c) => this.toMasked(c));
  }

  /** Return raw credentials for internal use (passing to agent runner etc.) */
  async listRaw(): Promise<StoredCredential[]> {
    return this.loadAll();
  }

  /**
   * Return the first stored credential (raw) for internal use.
   * Used to determine which provider to pass to the agent at session creation.
   */
  async getDefaultCredential(): Promise<StoredCredential | null> {
    const all = await this.loadAll();
    return all[0] ?? null;
  }

  /**
   * Map a credential providerId to an agent-compatible provider name.
   * The agent supports: openai, anthropic, google, ollama, cursor, devin, bedrock, etc.
   * "openai-compatible" maps to "openai" since the agent uses the same OpenAI client.
   */
  mapProviderForAgent(providerId: string): string {
    const lower = providerId.toLowerCase();
    if (lower === 'openai' || lower === 'openai-compatible') return 'openai';
    if (lower === 'anthropic' || lower === 'claude') return 'anthropic';
    if (lower === 'google' || lower === 'gemini') return 'google';
    return lower;
  }

  /** Build environment variables for agent process from stored credentials */
  async buildEnvForAgent(): Promise<Record<string, string>> {
    const all = await this.loadAll();
    const env: Record<string, string> = {};

    for (const cred of all) {
      const provider = cred.providerId.toLowerCase();

      // Map common provider IDs to env var names
      if (provider === 'openai' || provider === 'openai-compatible') {
        if (!env.OPENAI_API_KEY) env.OPENAI_API_KEY = cred.apiKey;
        if (cred.baseUrl && !env.OPENAI_BASE_URL) env.OPENAI_BASE_URL = cred.baseUrl;
      }

      // Generic env vars that the agent might use
      const apiKeyVar = `${provider.toUpperCase().replace(/-/g, '_')}_API_KEY`;
      const baseUrlVar = `${provider.toUpperCase().replace(/-/g, '_')}_BASE_URL`;
      if (!env[apiKeyVar]) env[apiKeyVar] = cred.apiKey;
      if (cred.baseUrl && !env[baseUrlVar]) env[baseUrlVar] = cred.baseUrl;

      // Also set generic API_KEY and API_BASE_URL for the first credential
      if (!env.API_KEY) env.API_KEY = cred.apiKey;
      if (cred.baseUrl && !env.API_BASE_URL) env.API_BASE_URL = cred.baseUrl;
    }

    return env;
  }

  /**
   * Find a specific model's context window from stored credentials.
   * Returns the configured contextWindow for the given providerId + modelId,
   * or undefined if not found.
   */
  async getModelContextWindow(providerId: string, modelId: string): Promise<number | undefined> {
    const cred = await this.get(providerId);
    if (!cred) return undefined;
    const model = cred.models.find((m) => m.id === modelId);
    return model?.contextWindow;
  }

  private toMasked(c: StoredCredential): CredentialEntry {
    return {
      providerId: c.providerId,
      label: c.label,
      apiKeyMasked: c.apiKey.slice(0, 4) + '***',
      baseUrl: c.baseUrl,
      api: c.api,
      models: c.models,
      createdAt: c.createdAt,
    };
  }

  private async persist(credentials: StoredCredential[]): Promise<void> {
    if (!existsSync(this.dataDir)) {
      await mkdir(this.dataDir, { recursive: true });
    }
    await writeFile(this.credentialsPath, JSON.stringify(credentials, null, 2), 'utf-8');
  }
}

export const credentialManager = new CredentialManagerImpl();
