export const DEFAULT_CONTEXT_WINDOW = 200_000;
export const MIN_CONTEXT_WINDOW = 16_000;
export const MAX_CONTEXT_WINDOW = 2_000_000;

export type ContextUsage = {
  tokens: number;
  contextWindow: number;
  percent: number;
};

export type ContextBreakdown = {
  systemPromptTokens: number;
  systemToolsTokens: number;
  systemContextTokens: number;
  skillsTokens: number;
  messagesTokens: number;
};
