export const DEFAULT_CONTEXT_WINDOW = 200_000;
export const MIN_CONTEXT_WINDOW = 16_000;
export const MAX_CONTEXT_WINDOW = 2_000_000;

export type ContextUsage = {
  tokens: number;
  contextWindow: number;
  percent: number;
  /**
   * true 表示 tokens 为 runner 估算值而非引擎原生统计（issue 06：
   * context_usage 优先展示 pi 原生值；计算值明确标记为近似）。
   * 缺省视为原生值。
   */
  approximate?: boolean;
};

export type ContextBreakdown = {
  systemPromptTokens: number;
  systemToolsTokens: number;
  systemContextTokens: number;
  skillsTokens: number;
  messagesTokens: number;
};
