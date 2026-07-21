export interface CredentialEntry {
  providerId: string;
  label: string;
  apiKeyMasked: string;
  baseUrl?: string;
  createdAt: number;
}

export interface CredentialInput {
  providerId: string;
  label: string;
  apiKey: string;
  baseUrl?: string;
}

/**
 * Partial credential update — used when editing an existing credential.
 * `apiKey` is optional: when omitted, the existing key is preserved.
 */
export interface CredentialUpdateInput {
  providerId: string;
  label?: string;
  apiKey?: string;
  baseUrl?: string;
}
