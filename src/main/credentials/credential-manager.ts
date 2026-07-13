import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { app } from 'electron';
import type { CredentialEntry, CredentialInput } from '@shared/types';

const CREDENTIALS_FILE = 'credentials.json';

interface StoredCredential {
  providerId: string;
  label: string;
  apiKey: string;
  baseUrl?: string;
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
      return JSON.parse(content) as StoredCredential[];
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
      createdAt: idx >= 0 ? all[idx].createdAt : Date.now(),
    };

    if (idx >= 0) {
      all[idx] = stored;
    } else {
      all.push(stored);
    }

    await this.persist(all);

    return {
      providerId: stored.providerId,
      label: stored.label,
      apiKeyMasked: stored.apiKey.slice(0, 4) + '***',
      baseUrl: stored.baseUrl,
      createdAt: stored.createdAt,
    };
  }

  async delete(providerId: string): Promise<void> {
    const all = await this.loadAll();
    const filtered = all.filter((c) => c.providerId !== providerId);
    await this.persist(filtered);
  }

  /** Return masked entries for UI display */
  async listMasked(): Promise<CredentialEntry[]> {
    const all = await this.loadAll();
    return all.map((c) => ({
      providerId: c.providerId,
      label: c.label,
      apiKeyMasked: c.apiKey.slice(0, 4) + '***',
      baseUrl: c.baseUrl,
      createdAt: c.createdAt,
    }));
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

  private async persist(credentials: StoredCredential[]): Promise<void> {
    if (!existsSync(this.dataDir)) {
      await mkdir(this.dataDir, { recursive: true });
    }
    await writeFile(this.credentialsPath, JSON.stringify(credentials, null, 2), 'utf-8');
  }
}

export const credentialManager = new CredentialManagerImpl();
