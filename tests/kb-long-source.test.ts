/**
 * kb-long-source.test.ts — 长来源原子证据分段与覆盖清单（issue 10，spec §4）。
 *
 * 验收：
 *  - 表格/围栏代码是**原子证据**：分段不得把它们切成半个；
 *  - 过大的表格/代码按行窗口分批，窗口重复表头 / 保留原始行号；
 *  - 覆盖清单证明所有行与章节都被处理（未覆盖行为空）；
 *  - 预算不足以放最小原子证据 → 明确 blocked，不静默裁切。
 */

import { describe, it, expect } from 'vitest';
import {
  splitLongSource,
  planLongSource,
  formatCoverageManifest,
} from '../src/main/kb/long-source';

const TABLE_HEADER = '| 信号 | 位宽 | 说明 |';
const TABLE_SEP = '| --- | --- | --- |';

function withTable(rows: number): string {
  return [
    '# 寄存器表',
    '',
    TABLE_HEADER,
    TABLE_SEP,
    ...Array.from({ length: rows }, (_, i) => `| REG_${i} | 32 | 第 ${i} 个寄存器 |`),
  ].join('\n');
}

function withCode(lines: number): string {
  return [
    '# 时序代码',
    '',
    '```verilog',
    ...Array.from({ length: lines }, (_, i) => `assign sig_${i} = in_${i};`),
    '```',
  ].join('\n');
}

describe('splitLongSource — 表格/代码为原子证据', () => {
  const content = [
    '# 概述',
    '',
    '段落一。'.repeat(20),
    '',
    TABLE_HEADER,
    TABLE_SEP,
    '| AWLEN | 4 | 突发长度 |',
    '| AWADDR | 32 | 地址 |',
    '',
    '# 时序',
    '',
    '段落二。'.repeat(20),
  ].join('\n');

  it('表格不被切成半个：整表只出现在一个分段里', () => {
    const { chunks, coverage } = splitLongSource(content, { maxTokens: 60 });
    expect(chunks.length).toBeGreaterThan(1);

    const tableSlices = chunks.flatMap((c) => c.slices.filter((s) => s.kind === 'table'));
    expect(tableSlices).toHaveLength(1);
    expect(tableSlices[0].windowed).toBe(false);
    expect(tableSlices[0].text).toContain(TABLE_HEADER);
    expect(tableSlices[0].text).toContain('| AWLEN | 4 | 突发长度 |');
    expect(tableSlices[0].text).toContain('| AWADDR | 32 | 地址 |');

    // 只有持有该表的分段包含表格切片
    const holders = chunks.filter((c) => c.slices.some((s) => s.kind === 'table'));
    expect(holders).toHaveLength(1);

    expect(coverage.tableRowLines).toBe(2);
    expect(coverage.coveredTableRowLines).toBe(2);
  });

  it('每段的 token 估算不超过目标（原子块例外由窗口保证）', () => {
    const { chunks } = splitLongSource(content, { maxTokens: 60 });
    for (const c of chunks) {
      expect(c.estimatedTokens).toBeLessThanOrEqual(60);
      expect(c.index).toBeGreaterThan(0);
      expect(c.total).toBe(chunks.length);
    }
  });

  it('第 2 段起带上一段的重叠上下文，重叠只是上下文不重复计入覆盖', () => {
    const { chunks, coverage } = splitLongSource(content, { maxTokens: 60, overlapTokens: 30 });
    expect(chunks[0].overlapText).toBe('');
    const withOverlap = chunks.slice(1).filter((c) => c.overlapText.length > 0);
    expect(withOverlap.length).toBeGreaterThan(0);
    for (const c of withOverlap) {
      expect(c.overlapText.length).toBeGreaterThan(0);
    }
    expect(coverage.uncoveredLines).toEqual([]);
  });

  it('每段记录生效章节，相邻分段的源行范围不重叠也不留空洞', () => {
    const { chunks, coverage } = splitLongSource(content, { maxTokens: 60 });
    for (const c of chunks) {
      expect(c.startLine).toBeLessThanOrEqual(c.endLine);
      expect(c.headingPath.length).toBeGreaterThan(0);
      expect(c.estimatedTokens).toBeGreaterThan(0);
    }
    expect(chunks[0].startLine).toBe(1);
    for (let i = 1; i < chunks.length; i += 1) {
      // 无空洞：下一段必须从上一段结束行之内或紧邻开始
      // （超长单行的按句分片会共享同一源行范围，故允许等于）
      expect(chunks[i].startLine).toBeLessThanOrEqual(chunks[i - 1].endLine + 1);
      expect(chunks[i].startLine).toBeGreaterThanOrEqual(chunks[i - 1].startLine);
    }
    expect(coverage.uncoveredLines).toEqual([]);
  });
});

describe('splitLongSource — 超大表格按行窗口分批', () => {
  const rows = 60;
  const content = withTable(rows);

  it('按行窗口分批、重复表头并保留原始行号', () => {
    const { chunks, coverage } = splitLongSource(content, { maxTokens: 120 });
    const tableSlices = chunks.flatMap((c) => c.slices.filter((s) => s.kind === 'table'));
    expect(tableSlices.length).toBeGreaterThan(1);
    for (const s of tableSlices) {
      expect(s.windowed).toBe(true);
      // 表头行（第 3 行）与分隔行（第 4 行）在每个窗口重复出现
      expect(s.repeatedHeaderLines).toEqual([3, 4]);
      expect(s.text).toContain(TABLE_HEADER);
      expect(s.text).toContain(TABLE_SEP);
      expect(s.text).toMatch(/<!--\s*表格窗口/);
      expect(s.text).toMatch(/源行\s*\d+-\d+/);
    }
    expect(coverage.windowedTables).toBe(1);

    // 每一行数据恰好出现一次（原件按行分批，不重复也不遗漏）
    const seen = tableSlices.flatMap((s) => [...s.text.matchAll(/REG_(\d+) \|/g)].map((m) => Number(m[1])));
    expect(seen).toHaveLength(rows);
    expect(new Set(seen).size).toBe(rows);
    expect(Math.min(...seen)).toBe(0);
    expect(Math.max(...seen)).toBe(rows - 1);
  });

  it('覆盖清单证明所有表格行与所有源行都处理过', () => {
    const { coverage } = splitLongSource(content, { maxTokens: 120 });
    expect(coverage.totalLines).toBe(content.split('\n').length);
    expect(coverage.coveredLines).toBe(coverage.totalLines);
    expect(coverage.uncoveredLines).toEqual([]);
    expect(coverage.tableRowLines).toBe(rows);
    expect(coverage.coveredTableRowLines).toBe(rows);
  });

  it('无外侧竖线的 GFM 表格同样按原子证据处理', () => {
    const gfm = ['# 表', '', '信号 | 位宽', '--- | ---', 'AWLEN | 4', 'AWADDR | 32'].join('\n');
    const { chunks, coverage } = splitLongSource(gfm, { maxTokens: 60 });
    const table = chunks.flatMap((c) => c.slices.filter((s) => s.kind === 'table'));
    expect(table).toHaveLength(1);
    expect(table[0].text).toContain('AWLEN | 4');
    expect(table[0].text).toContain('AWADDR | 32');
    expect(coverage.tableRowLines).toBe(2);
  });

  it('含竖线但不是表格的连续行不会被误判成表格，也不会丢行/卡死', () => {
    const prose = ['# 或表达式', '', 'a | b 表示按位或', 'c | d 也是按位或', '', '# 结尾', '', '收尾。'].join('\n');
    const { chunks, coverage } = splitLongSource(prose, { maxTokens: 60 });
    expect(coverage.uncoveredLines).toEqual([]);
    expect(coverage.tableBlocks).toBe(0);
    const text = chunks.map((c) => c.text).join('\n');
    expect(text).toContain('a | b 表示按位或');
    expect(text).toContain('c | d 也是按位或');
  });
});

describe('splitLongSource — 超大代码块按行窗口分批', () => {
  const body = 80;
  const content = withCode(body);

  it('代码按行窗口保留原始行号与原文', () => {
    const { chunks, coverage } = splitLongSource(content, { maxTokens: 120 });
    const codeSlices = chunks.flatMap((c) => c.slices.filter((s) => s.kind === 'code'));
    expect(codeSlices.length).toBeGreaterThan(1);
    for (const s of codeSlices) {
      expect(s.windowed).toBe(true);
      expect(s.text).toMatch(/<!--\s*代码窗口/);
      expect(s.text).toMatch(/源行\s*\d+-\d+/);
      expect(s.text).toContain('```');
    }
    // 原文每一行代码恰好出现一次
    const seen = codeSlices.flatMap((s) => [...s.text.matchAll(/assign sig_(\d+) = in_\1;/g)].map((m) => Number(m[1])));
    expect(new Set(seen).size).toBe(body);
    expect(coverage.windowedCodeBlocks).toBe(1);
    expect(coverage.coveredCodeLines).toBe(coverage.codeLines);
    expect(coverage.uncoveredLines).toEqual([]);
  });
});

describe('覆盖清单与章节', () => {
  const content = [
    '# 一、概述',
    '',
    '协议约束。'.repeat(400),
    '',
    '## 1.1 寄存器',
    '',
    TABLE_HEADER,
    TABLE_SEP,
    '| AWLEN | 4 | 突发长度 |',
    '',
    '# 二、时序',
    '',
    '```verilog',
    'assign awvalid = 1;',
    '```',
    '',
    '# 三、末尾约束',
    '',
    'T_RCD_MIN = 18ns。'.repeat(400),
  ].join('\n');

  it('所有章节都被处理，覆盖清单无未覆盖行', () => {
    const { coverage } = splitLongSource(content, { maxTokens: 80 });
    expect(coverage.uncoveredLines).toEqual([]);
    expect(coverage.coveredLines).toBe(coverage.totalLines);
    expect(coverage.sections).toContain('一、概述');
    expect(coverage.sections).toContain('一、概述 > 1.1 寄存器');
    expect(coverage.sections).toContain('二、时序');
    expect(coverage.sections).toContain('三、末尾约束');
    expect(coverage.coveredSections.sort()).toEqual([...coverage.sections].sort());
  });

  it('清单文本给出行数、分段、章节与原子证据覆盖的可读证明', () => {
    const plan = planLongSource(content, { availableInputTokens: 3_200 });
    expect(plan.mode).toBe('chunked');
    if (plan.mode !== 'chunked') return;
    const manifest = formatCoverageManifest(plan);
    expect(manifest).toMatch(/分段/);
    expect(manifest).toMatch(/未覆盖/);
    expect(manifest).toContain('三、末尾约束');
    expect(manifest).toMatch(/表格/);
    expect(manifest).toMatch(/代码/);
  });
});

describe('planLongSource — 单次 / 分段 / blocked', () => {
  it('预算内 → 单次编译', () => {
    const plan = planLongSource('# 短文档\n\n只有几句话。', { availableInputTokens: 5_000 });
    expect(plan.mode).toBe('single');
  });

  it('超预算 → 分段编译（含分段与覆盖清单）', () => {
    const content = withTable(400);
    const plan = planLongSource(content, { availableInputTokens: 3_200 });
    expect(plan.mode).toBe('chunked');
    if (plan.mode !== 'chunked') return;
    expect(plan.chunks.length).toBeGreaterThan(1);
    expect(plan.coverage.uncoveredLines).toEqual([]);
    expect(plan.overlapTokens).toBeGreaterThan(0);
    expect(plan.targetTokens).toBeGreaterThan(0);
    // 单段目标 + 累计摘要 + 重叠上下文必须落在可用输入内（否则单次调用会超预算）
    expect(plan.targetTokens + plan.digestTokens + plan.overlapTokens).toBeLessThanOrEqual(3_200);
  });

  it('预算不足以放最小原子证据 → blocked（不静默裁切）', () => {
    const content = withTable(50);
    const plan = planLongSource(content, { availableInputTokens: 10 });
    expect(plan.mode).toBe('blocked');
    if (plan.mode !== 'blocked') return;
    expect(plan.reason).toMatch(/预算/);
  });

  it('预算低于最小分段预算 → blocked，并说明可用输入', () => {
    const plan = planLongSource('正文。'.repeat(2_000), { availableInputTokens: 1_500 });
    expect(plan.mode).toBe('blocked');
    if (plan.mode !== 'blocked') return;
    expect(plan.reason).toMatch(/可用输入|最小/);
  });

  it('预算扣掉累计摘要与重叠后放不下最小分段 → blocked（不裁剪摘要凑预算）', () => {
    const plan = planLongSource('正文。'.repeat(2_000), { availableInputTokens: 2_400 });
    expect(plan.mode).toBe('blocked');
    if (plan.mode !== 'blocked') return;
    expect(plan.reason).toMatch(/累计摘要|重叠/);
  });
});
