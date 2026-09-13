/**
 * kb-token-budget.test.ts — 编译预算估算（issue 10，spec §4）。
 *
 * 验收：
 *  - 总预算包含规则、已有知识、输入与输出预留（可分解、可解释）；
 *  - 中文不沿用固定英文 token 比例：同一字符数下中文占用远高于英文；
 *  - 预算不足时的「最小原子证据」判定有明确下界。
 */

import { describe, it, expect } from 'vitest';
import {
  estimateTokens,
  computeCompileBudget,
  chunkTargetTokens,
  chunkOverlapTokens,
  formatBudgetSummary,
  CJK_TOKENS_PER_CHAR,
  NON_CJK_CHARS_PER_TOKEN,
  MIN_ATOMIC_EVIDENCE_TOKENS,
  MIN_CHUNK_TOKENS,
  MAX_CHUNK_TOKENS,
  DEFAULT_COMPILE_CONTEXT_TOKENS,
} from '../src/main/kb/token-budget';

describe('estimateTokens — 中文与英文分别估算', () => {
  it('英文按约 4 字符/token 估算', () => {
    expect(estimateTokens('a'.repeat(400))).toBe(400 / NON_CJK_CHARS_PER_TOKEN);
    expect(estimateTokens('')).toBe(0);
  });

  it('中文按 CJK 字符数估算，不使用英文的 4:1 比例', () => {
    const zh = '寄存器位宽约束'.repeat(50); // 350 个 CJK 字符
    expect(estimateTokens(zh)).toBe(350 * CJK_TOKENS_PER_CHAR);
    // 同字符数的英文远小于中文 → 证明两者不是同一个 chars/token 比例
    expect(estimateTokens(zh)).toBeGreaterThan(estimateTokens('a'.repeat(350)) * 3);
  });

  it('中英混排分别累加（CJK 含中文标点与全角字符）', () => {
    // 4 个 CJK（协议手册）+ 8 个 ASCII（"ping-pong" 含连字符）
    expect(estimateTokens('协议手册xxx')).toBe(4 * CJK_TOKENS_PER_CHAR + Math.ceil(3 / NON_CJK_CHARS_PER_TOKEN));
    expect(estimateTokens('AXI outstanding 上限')).toBe(2 * CJK_TOKENS_PER_CHAR + Math.ceil(16 / NON_CJK_CHARS_PER_TOKEN));
  });
});

describe('computeCompileBudget — 规则/已有知识/输入/输出预留', () => {
  it('可用输入 = 上下文 − 规则 − 已有知识 − 输出预留', () => {
    const budget = computeCompileBudget({
      contextTokens: 32_000,
      rulesText: 'a'.repeat(4_000), // 1000 tokens
      knowledgeText: '规则'.repeat(500), // 1000 tokens
      outputReserveTokens: 8_192,
    });
    expect(budget.rulesTokens).toBe(1_000);
    expect(budget.knowledgeTokens).toBe(1_000);
    expect(budget.outputReserveTokens).toBe(8_192);
    expect(budget.availableInputTokens).toBe(32_000 - 1_000 - 1_000 - 8_192);
  });

  it('中文规则/知识占用更多预算，可用输入随之减少（不按英文比例）', () => {
    const base = { contextTokens: 32_000, outputReserveTokens: 4_096 };
    const en = computeCompileBudget({ ...base, rulesText: 'a'.repeat(1_200), knowledgeText: '' });
    const zh = computeCompileBudget({ ...base, rulesText: '协议'.repeat(600), knowledgeText: '' });
    expect(zh.rulesTokens).toBe(1_200);
    expect(zh.availableInputTokens).toBeLessThan(en.availableInputTokens);
  });

  it('预留超过上下文 → 可用输入为 0（不出现负预算）', () => {
    const budget = computeCompileBudget({
      contextTokens: 1_000,
      rulesText: '中文规则'.repeat(10),
      knowledgeText: 'a'.repeat(400),
      outputReserveTokens: 4_096,
    });
    expect(budget.availableInputTokens).toBe(0);
  });

  it('默认上下文为 128k，最小原子证据有明确下界', () => {
    expect(DEFAULT_COMPILE_CONTEXT_TOKENS).toBe(128_000);
    expect(MIN_ATOMIC_EVIDENCE_TOKENS).toBeGreaterThan(0);
    expect(MIN_ATOMIC_EVIDENCE_TOKENS).toBeLessThan(MIN_CHUNK_TOKENS);
    expect(MIN_CHUNK_TOKENS).toBeLessThan(MAX_CHUNK_TOKENS);
  });
});

describe('分段目标与重叠', () => {
  it('分段目标是可用输入的比例，并被 MIN/MAX 夹住', () => {
    expect(chunkTargetTokens(10_000)).toBe(6_000); // 中段：直接用比例
    expect(chunkTargetTokens(10)).toBe(MIN_CHUNK_TOKENS);
    expect(chunkTargetTokens(100_000)).toBe(MAX_CHUNK_TOKENS);
    expect(chunkTargetTokens(10_000_000)).toBe(MAX_CHUNK_TOKENS);
  });

  it('重叠窗口随目标增长但有上下界（不超过目标本身）', () => {
    expect(chunkOverlapTokens(MAX_CHUNK_TOKENS)).toBeLessThan(MAX_CHUNK_TOKENS);
    expect(chunkOverlapTokens(MIN_CHUNK_TOKENS)).toBeGreaterThan(0);
    expect(chunkOverlapTokens(10_000_000)).toBeGreaterThan(chunkOverlapTokens(2_000));
  });
});

describe('formatBudgetSummary', () => {
  it('给出可读分解（规则/知识/输出预留/可用输入）', () => {
    const s = formatBudgetSummary(computeCompileBudget({
      contextTokens: 20_000,
      rulesText: 'a'.repeat(400),
      knowledgeText: 'a'.repeat(800),
      outputReserveTokens: 1_000,
    }));
    expect(s).toContain('20000');
    expect(s).toContain('100');
    expect(s).toContain('1000');
  });
});
