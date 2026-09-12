/**
 * runner-pi/context-usage.ts —— context_usage 事件组装纯函数。
 *
 * spec（issue 06）：context_usage 优先展示 pi 原生值；无原生值（pi 返回
 * tokens=null，如压缩后/首轮回复前）时由 runner 估算并标记为近似。
 */
import { describe, expect, it } from 'vitest';
import {
  estimateTokensFromMessages,
  mapPiContextUsage,
  shouldSendContextUsage,
} from '../../runner-pi/context-usage';

// ─── shouldSendContextUsage ─────────────────────────────

describe('shouldSendContextUsage', () => {
  it('在每个上下文增长边界推送（与 omp runner 相同的边界集）', () => {
    expect(shouldSendContextUsage('message_end')).toBe(true);
    expect(shouldSendContextUsage('agent_end')).toBe(true);
    expect(shouldSendContextUsage('compaction_start')).toBe(true);
    expect(shouldSendContextUsage('compaction_end')).toBe(true);
    expect(shouldSendContextUsage('auto_compaction_start')).toBe(true);
    expect(shouldSendContextUsage('auto_compaction_end')).toBe(true);
  });

  it('在无增长事件上不推送', () => {
    expect(shouldSendContextUsage('message_update')).toBe(false);
    expect(shouldSendContextUsage('message_start')).toBe(false);
    expect(shouldSendContextUsage('tool_execution_start')).toBe(false);
    expect(shouldSendContextUsage('tool_execution_end')).toBe(false);
    expect(shouldSendContextUsage('agent_start')).toBe(false);
    expect(shouldSendContextUsage('notice')).toBe(false);
    expect(shouldSendContextUsage('')).toBe(false);
  });
});

// ─── estimateTokensFromMessages ─────────────────────────

describe('estimateTokensFromMessages', () => {
  it('字符串内容按 chars/4 估算', () => {
    expect(estimateTokensFromMessages([{ role: 'user', content: 'a'.repeat(400) }])).toBe(100);
  });

  it('content 块数组按 text 块累加', () => {
    const messages = [
      {
        role: 'user',
        content: [
          { type: 'text', text: 'x'.repeat(200) },
          { type: 'image', data: 'ignored' },
          { type: 'text', text: 'y'.repeat(200) },
        ],
      },
    ];
    expect(estimateTokensFromMessages(messages)).toBe(100);
  });

  it('非文本内容与空输入估算为 0', () => {
    expect(estimateTokensFromMessages([])).toBe(0);
    expect(estimateTokensFromMessages(undefined)).toBe(0);
    expect(estimateTokensFromMessages([{ role: 'user', content: null }])).toBe(0);
    expect(estimateTokensFromMessages('not-an-array')).toBe(0);
  });
});

// ─── mapPiContextUsage ──────────────────────────────────

describe('mapPiContextUsage', () => {
  it('pi 原生值（tokens 为数字）优先透传，approximate=false', () => {
    const mapped = mapPiContextUsage(
      { tokens: 12_000, contextWindow: 128_000, percent: 9.375 },
      { messages: [] },
    );
    expect(mapped).toEqual({
      tokens: 12_000,
      contextWindow: 128_000,
      percent: 9.375,
      approximate: false,
    });
  });

  it('pi 原生 percent 缺失时按 tokens/window 计算，仍为原生值', () => {
    const mapped = mapPiContextUsage(
      { tokens: 32_000, contextWindow: 128_000, percent: null },
      { messages: [] },
    );
    expect(mapped).toMatchObject({ tokens: 32_000, percent: 25, approximate: false });
  });

  it('窗口未知（0/缺失）时即使 tokens 为原生值也标记近似（percent 不可信）', () => {
    const mapped = mapPiContextUsage(
      { tokens: 32_000, contextWindow: 0, percent: null },
      { messages: [] },
    );
    expect(mapped).toMatchObject({ tokens: 32_000, contextWindow: 0, percent: 0, approximate: true });
  });

  it('pi 原生 tokens=null（未知）时回退到消息估算并标记近似', () => {
    const messages = [{ role: 'user', content: 'a'.repeat(4000) }];
    const mapped = mapPiContextUsage(
      { tokens: null, contextWindow: 128_000, percent: null },
      { messages },
    );
    expect(mapped).toMatchObject({ tokens: 1000, contextWindow: 128_000, approximate: true });
    expect(mapped?.percent).toBeCloseTo((1000 / 128_000) * 100, 5);
  });

  it('无原生值且无消息时返回 null（跳过推送）', () => {
    expect(mapPiContextUsage(undefined, { messages: [] })).toBeNull();
    expect(mapPiContextUsage(undefined)).toBeNull();
  });

  it('无原生值但有消息时仍可估算（窗口未知记 0）', () => {
    const mapped = mapPiContextUsage(undefined, {
      messages: [{ role: 'assistant', content: 'b'.repeat(800) }],
    });
    expect(mapped).toMatchObject({ tokens: 200, contextWindow: 0, approximate: true });
    expect(mapped?.percent).toBe(0);
  });
});
