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
}

export interface CredentialEntry {
  providerId: string;
  label: string;
  apiKeyMasked: string;
  baseUrl?: string;
  /** Models configured for this provider. Each has its own contextWindow. */
  models: ConfiguredModel[];
  createdAt: number;
}

export interface CredentialInput {
  providerId: string;
  label: string;
  apiKey: string;
  baseUrl?: string;
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
  models?: ConfiguredModel[];
}
