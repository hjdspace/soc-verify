/**
 * .vRefine XML 生成器测试（docs/coverage_auto_waive.md §3）。
 *
 * 覆盖：
 * - 单条 toggle rule 属性顺序/转义/entityName 的 `/` 分隔符
 * - top_scope 越界过滤（module 名补前缀 / 越界丢弃）
 * - 完整 XML 骨架（information / rules / cache-map）
 * - rule 顺序：const_assign → input_tie → output_floating
 * - 文件末尾单个换行
 */

import { describe, it, expect } from 'vitest';
import {
  escapeXmlAttr,
  buildToggleRule,
  renderVrefineXml,
} from '../../src/main/coverage/waive/vrefine-generator';
import type { WaiveSignal } from '@shared/types';

const OPTS = {
  topScope: 'tb_top',
  creator: 'tester',
  now: new Date(Date.UTC(2026, 8, 11, 10, 30, 0)), // 2026-09-11 10:30:00 UTC
  toolVersion: 'Cadence Verisium Manager24.09',
};

describe('escapeXmlAttr', () => {
  it('转义 5 个 XML 特殊字符', () => {
    expect(escapeXmlAttr('a&b<c>d"e\'f')).toBe('a&amp;b&lt;c&gt;d&quot;e&apos;f');
  });
  it('普通路径与信号名原样保留', () => {
    expect(escapeXmlAttr('/proj/rtl/a.v')).toBe('/proj/rtl/a.v');
  });
});

describe('buildToggleRule', () => {
  it('生成属性有序的 toggle rule，entityName 用 / 分隔', () => {
    const line = buildToggleRule(
      { hier: 'tb_top.chip.dut.u_a', signal: 'AVDD', fileId: 3, line: 42 },
      OPTS,
    );
    expect(line).toBe(
      `        <rule ccType="inst" domain="icc" entityName="tb_top/chip/dut/u_a/AVDD" ` +
      `entityType="toggle" excTime="${Math.floor(OPTS.now.getTime() / 1000)}" ` +
      `name="exclude_covered" reviewer="1" user="0" vscope="default" file="3" line="42"></rule>`,
    );
  });

  it('hier 为 module 名（不含点）时补 top_scope 前缀', () => {
    const line = buildToggleRule({ hier: 'dut', signal: 'sig', fileId: 0, line: 0 }, OPTS);
    expect(line).toContain('entityName="tb_top/dut/sig"');
    // fileId=0 不写 file 属性；line=0 不写 line 属性
    expect(line).not.toContain('file=');
    expect(line).not.toContain('line=');
  });

  it('越界 hier（含点但不以 top_scope 开头）返回 null', () => {
    expect(buildToggleRule({ hier: 'other.top.dut', signal: 'x', fileId: 1, line: 1 }, OPTS)).toBeNull();
  });

  it('signal 为空返回 null', () => {
    expect(buildToggleRule({ hier: 'tb_top', signal: '  ', fileId: 1, line: 1 }, OPTS)).toBeNull();
  });

  it('topScope 为空时不过滤', () => {
    const line = buildToggleRule(
      { hier: 'any.path.here', signal: 'x', fileId: 0, line: 0 },
      { ...OPTS, topScope: '' },
    );
    expect(line).toContain('entityName="any/path/here/x"');
  });
});

describe('renderVrefineXml', () => {
  const signals: WaiveSignal[] = [
    { kind: 'output_floating', hier: 'tb_top.dut.u_b', signal: 'OUT', file: '/proj/rtl/b.v', line: 9 },
    { kind: 'const_assign', hier: 'tb_top.dut.u_a', signal: 'AVDD', file: '/proj/rtl/a.v', line: 2 },
    { kind: 'input_tie', hier: 'tb_top.dut.u_a.u_sub', signal: 'y', file: '/proj/rtl/a.v', line: 4, tieValue: "1'b0" },
  ];
  const fileMap = new Map<number, string>([
    [2, '/proj/rtl/a.v'],
    [3, '/proj/rtl/b.v'],
  ]);

  it('完整骨架：XML 头 + information + rules + cache-map，文件以单个换行结尾', () => {
    const { xml, ruleCount } = renderVrefineXml(signals, fileMap, OPTS);
    expect(ruleCount).toBe(3);
    expect(xml.startsWith('<?xml version="1.0" encoding="UTF-8" standalone="no"?>\n<refinement-file-root>')).toBe(true);
    expect(xml).toContain('<information comment-version="2" creation-time="Fri 11 Sep 2026 10:30:00 CST" creator="tester"');
    expect(xml).toContain('tool-version="Cadence Verisium Manager24.09"');
    expect(xml).toContain('<rules>');
    // cache-map：key 0 → creator、key 1 → unknown、再全量 file_map
    expect(xml).toContain('<cache-entry key="0" value="tester"></cache-entry>');
    expect(xml).toContain('<cache-entry key="1" value="unknown"></cache-entry>');
    expect(xml).toContain('<cache-entry key="2" value="/proj/rtl/a.v"></cache-entry>');
    expect(xml).toContain('<cache-entry key="3" value="/proj/rtl/b.v"></cache-entry>');
    expect(xml.endsWith('</refinement-file-root>\n')).toBe(true);
    // 末尾恰好一个换行
    expect(xml.endsWith('\n\n')).toBe(false);
  });

  it('rule 顺序：const_assign → input_tie → output_floating', () => {
    const { xml } = renderVrefineXml(signals, fileMap, OPTS);
    const iConst = xml.indexOf('tb_top/dut/u_a/AVDD');
    const iTie = xml.indexOf('tb_top/dut/u_a/u_sub/y');
    const iFloat = xml.indexOf('tb_top/dut/u_b/OUT');
    expect(iConst).toBeGreaterThan(-1);
    expect(iTie).toBeGreaterThan(iConst);
    expect(iFloat).toBeGreaterThan(iTie);
  });

  it('越界信号丢弃且不计入 ruleCount', () => {
    const outOfRange: WaiveSignal[] = [
      { kind: 'const_assign', hier: 'other_tb.dut', signal: 'X', file: '/proj/rtl/c.v', line: 1 },
    ];
    const { xml, ruleCount, droppedOutOfRange } = renderVrefineXml(outOfRange, fileMap, OPTS);
    expect(ruleCount).toBe(0);
    expect(droppedOutOfRange).toBe(1);
    expect(xml).not.toContain('other_tb');
  });

  it('creator 含 XML 特殊字符时转义', () => {
    const { xml } = renderVrefineXml([], new Map(), { ...OPTS, creator: 'a<b>&c' });
    expect(xml).toContain('creator="a&lt;b&gt;&amp;c"');
    expect(xml).toContain('value="a&lt;b&gt;&amp;c"');
  });
});
