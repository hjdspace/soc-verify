/**
 * KB 编译预算估算（issue 10，spec §4）— CJK 感知的 token 估计与预算分解。
 *
 * spec §4：「预算按输入、system/schema/purpose、已有页、输出预留统一计算；
 * 优先使用实际 token 估计器，**不以同一 chars/token 比例同时处理中文和英文**」。
 *
 * 因此本模块对 CJK 与非 CJK 分别估算：
 *  - CJK（中/日/韩/全角/CJK 标点）按 1 字符 ≈ 1 token（保守上界：宁可多分段，
 *    也不把「按英文 4:1 折算」的中文长文塞进超预算的单次调用）；
 *  - 非 CJK 按 ~4 字符 ≈ 1 token。
 *
 * 估计值是**预算用途的上界**，不是模型分词的精确复现；用于决定
 * 「单次够不够 / 分几段 / 是否 blocked」，不用于对外宣称用量。
 */

// ── 常量 ────────────────────────────────────────────────────────

/** CJK 字符的 token 估算（保守上界） */
export const CJK_TOKENS_PER_CHAR = 1;
/** 非 CJK 字符的 token 估算比例 */
export const NON_CJK_CHARS_PER_TOKEN = 4;

/** 默认模型上下文窗口（token）。调用方可按配置覆盖（CompileLlm.contextTokens）。 */
export const DEFAULT_COMPILE_CONTEXT_TOKENS = 128_000;

/**
 * 输出预留：按**最大的单次输出**预留（生成阶段 FILE 提案 8192 tokens；
 * 分析阶段 4096 已被它覆盖），因此预算分解只需要这一项。
 */
export const GENERATION_OUTPUT_RESERVE_TOKENS = 8_192;

/** 单段最小目标 token：再小就放不下「表头 + 若干行」这类最小原子证据 */
export const MIN_CHUNK_TOKENS = 2_000;
/** 单段最大目标 token（过大反而降低逐段分析的定位精度） */
export const MAX_CHUNK_TOKENS = 24_000;
/** 分段目标占可用输入的比例（余量留给重叠上下文与提示词包装） */
export const CHUNK_TARGET_RATIO = 0.6;

/**
 * 每次分段调用中「跨段累计摘要」占用的 token 上限。
 *
 * 预算必须为它留位：分段调用的输入 = 规则 + 已有知识 + 累计摘要 + 重叠上下文
 * + 本段原文，五项相加不得超过可用输入。
 */
export const CHUNK_DIGEST_RESERVE_TOKENS = 1_500;
/** 累计摘要最多占可用输入的比例（预算小的时候按比例收敛，而不是撑爆单次调用） */
export const CHUNK_DIGEST_BUDGET_RATIO = 0.25;

/**
 * 最小可发送原子证据：一段（表头 + 数据行 / 代码窗口）低于此值即
 * 无法形成可分析证据 —— 预算再小就应 blocked，而不是裁掉参数表继续。
 */
export const MIN_ATOMIC_EVIDENCE_TOKENS = 300;

/** 段间重叠上下文的上下界（token） */
export const MIN_CHUNK_OVERLAP_TOKENS = 120;
export const MAX_CHUNK_OVERLAP_TOKENS = 600;
const CHUNK_OVERLAP_RATIO = 0.08;

// ── CJK 判定 ────────────────────────────────────────────────────

/**
 * 是否按 CJK 计（逐字符 1 token）。
 * 覆盖：CJK 标点、平假名/片假名、CJK 扩展 A、CJK 统一表意、兼容表意、
 * 全角形式、谚文音节。
 */
function isCjkCodePoint(cp: number): boolean {
  return (
    (cp >= 0x3000 && cp <= 0x303f)
    || (cp >= 0x3040 && cp <= 0x30ff)
    || (cp >= 0x3400 && cp <= 0x4dbf)
    || (cp >= 0x4e00 && cp <= 0x9fff)
    || (cp >= 0xac00 && cp <= 0xd7af)
    || (cp >= 0xf900 && cp <= 0xfaff)
    || (cp >= 0xff00 && cp <= 0xffef)
  );
}

/**
 * 估算文本 token 数（预算用途上界）。
 *
 * CJK 逐字符计 1，其余按 4 字符计 1 后向上取整 —— 中文与英文不使用
 * 同一个 chars/token 比例。
 */
export function estimateTokens(text: string): number {
  if (!text) return 0;
  let cjk = 0;
  let other = 0;
  for (const ch of text) {
    const cp = ch.codePointAt(0) ?? 0;
    if (isCjkCodePoint(cp)) cjk += 1;
    else other += 1;
  }
  return cjk * CJK_TOKENS_PER_CHAR + Math.ceil(other / NON_CJK_CHARS_PER_TOKEN);
}

// ── 预算分解 ────────────────────────────────────────────────────

export type CompileBudgetInput = {
  /** 模型上下文窗口（token） */
  contextTokens: number;
  /** 规则与固定指令：system 提示 + schema + purpose + 输出格式约束 */
  rulesText: string;
  /** 已有知识：库目录（index）与读取的既有页正文 */
  knowledgeText: string;
  /** 输出预留（token） */
  outputReserveTokens: number;
};

/** 预算分解（对外只读诊断，不含任何来源正文） */
export type CompileBudget = {
  contextTokens: number;
  rulesTokens: number;
  knowledgeTokens: number;
  outputReserveTokens: number;
  /** 可用于本次来源输入的 token（不足为 0，不出现负数） */
  availableInputTokens: number;
};

/**
 * 计算统一预算分解：context − 规则 − 已有知识 − 输出预留 = 可用输入。
 * 任何一项预留超过上下文时，可用输入收敛为 0（由调用方判定 blocked）。
 */
export function computeCompileBudget(input: CompileBudgetInput): CompileBudget {
  const rulesTokens = estimateTokens(input.rulesText);
  const knowledgeTokens = estimateTokens(input.knowledgeText);
  const reserved = rulesTokens + knowledgeTokens + input.outputReserveTokens;
  const availableInputTokens = Math.max(0, input.contextTokens - reserved);
  return {
    contextTokens: input.contextTokens,
    rulesTokens,
    knowledgeTokens,
    outputReserveTokens: input.outputReserveTokens,
    availableInputTokens,
  };
}

/** 单段目标的 token 预算（可用输入的比例，被 MIN/MAX 夹住） */
export function chunkTargetTokens(availableInputTokens: number): number {
  const raw = Math.floor(availableInputTokens * CHUNK_TARGET_RATIO);
  return Math.min(MAX_CHUNK_TOKENS, Math.max(MIN_CHUNK_TOKENS, raw));
}

/** 段间重叠上下文的 token 预算（随目标增长，有上下界） */
export function chunkOverlapTokens(targetTokens: number): number {
  const raw = Math.floor(targetTokens * CHUNK_OVERLAP_RATIO);
  return Math.min(MAX_CHUNK_OVERLAP_TOKENS, Math.max(MIN_CHUNK_OVERLAP_TOKENS, raw));
}

/** 每次分段调用中累计摘要可占用的 token（预算小时按比例收敛） */
export function chunkDigestReserveTokens(availableInputTokens: number): number {
  return Math.min(
    CHUNK_DIGEST_RESERVE_TOKENS,
    Math.max(0, Math.floor(availableInputTokens * CHUNK_DIGEST_BUDGET_RATIO)),
  );
}

/** 可读预算分解（错误消息与诊断共用） */
export function formatBudgetSummary(budget: CompileBudget): string {
  return `上下文 ${budget.contextTokens} tokens = 规则 ${budget.rulesTokens} + 已有知识 ${budget.knowledgeTokens}`
    + ` + 输出预留 ${budget.outputReserveTokens} + 可用输入 ${budget.availableInputTokens}`;
}

/**
 * 按 token 上界截断文本（用于**提示词内上下文**的裁剪：逐段分析结论、累计摘要、
 * 目录摘要）。绝不用于裁剪来源原文 —— 来源要么整段送入，要么明确 blocked。
 */
export function truncateToTokens(text: string, maxTokens: number): string {
  if (!text || maxTokens <= 0) return '';
  if (estimateTokens(text) <= maxTokens) return text;
  let current = '';
  let used = 0;
  for (const ch of text) {
    const t = isCjkCodePoint(ch.codePointAt(0) ?? 0) ? CJK_TOKENS_PER_CHAR : 1 / NON_CJK_CHARS_PER_TOKEN;
    if (used + t > maxTokens) break;
    used += t;
    current += ch;
  }
  return `${current.trimEnd()}\n\n[...已按预算裁剪上下文...]`;
}
