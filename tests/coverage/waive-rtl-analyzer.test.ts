/**
 * RTL 静态分析引擎测试（docs/coverage_auto_waive.md §2）。
 *
 * 覆盖：
 * - stripComments：行注释/块注释剥离 + 行号保持
 * - const_assign：`assign X = 1'b0;` 识别（含位选、四进制常数）
 * - input_tie：`.y(1'b0)` 常量连接识别（跨文件端口索引）
 * - output_floating：`.c()` 显式悬空 + named 连接省略的 output
 * - 关键字黑名单：always/task 等不误判为例化点
 * - positional 连接不解析；参数化例化 `#(...)` 识别
 */

import { describe, it, expect } from 'vitest';
import {
  stripComments,
  isVerilogConst,
  scanFilePortDirs,
  mergeIntoPortIndex,
  analyzeModuleInstance,
  type PortIndex,
} from '../../src/main/coverage/waive/rtl-analyzer';

const FILE = '/proj/rtl/dut.v';

function buildIndex(...texts: string[]): PortIndex {
  const index: PortIndex = new Map();
  for (const t of texts) mergeIntoPortIndex(index, scanFilePortDirs(t));
  return index;
}

describe('stripComments', () => {
  it('剥离行注释并保留换行数', () => {
    const src = 'assign a = 1\'b0; // tie low\nassign b = 1\'b1;';
    const out = stripComments(src);
    expect(out).not.toContain('// tie low');
    expect(out).toContain("assign b = 1'b1;");
    // 行号保持：第 2 行的 assign 仍可匹配
    expect(out.split('\n').length).toBe(2);
  });

  it('剥离跨行块注释', () => {
    const src = 'wire x;\n/* multi\n line comment assign fake = 1\'b0; */\nwire y;';
    const out = stripComments(src);
    expect(out).not.toContain('fake');
    expect(out).toContain('wire y;');
    // 行号保持：块注释占的 3 行还在
    expect(out.split('\n').length).toBe(4);
  });
});

describe('isVerilogConst', () => {
  it('接受各类 Verilog 常数形式', () => {
    expect(isVerilogConst("1'b0")).toBe(true);
    expect(isVerilogConst("4'hF")).toBe(true);
    expect(isVerilogConst("8'd42")).toBe(true);
    expect(isVerilogConst("3'o7")).toBe(true);
    expect(isVerilogConst("4'b10xz")).toBe(true);
    expect(isVerilogConst("2'b01")).toBe(true);
    expect(isVerilogConst("'b1")).toBe(true);
  });

  it('拒绝信号名与非常数表达式', () => {
    expect(isVerilogConst('sel_signal')).toBe(false);
    expect(isVerilogConst("{a, b}")).toBe(false);
    expect(isVerilogConst('')).toBe(false);
  });
});

describe('analyzeModuleInstance — assign 固定值', () => {
  const RTL = [
    'module dut (input clk, output [3:0] q);',
    "  assign q = 4'b0000;",       // 命中
    "  wire [1:0] sel;",
    '  assign sel = 2\'b01;',      // 命中（注释行后的正确行号）
    '  // assign commented = 1\'b0; // 注释里的 assign 不命中',
    '  assign dynamic = sel;',    // 非常数，不命中
    'endmodule',
  ].join('\n');
  const stripped = stripComments(RTL);
  const index = buildIndex(stripped);

  it('识别常数 assign 并给出行号', () => {
    const result = analyzeModuleInstance(stripped, 'dut', 'tb.dut', FILE, index);
    expect(result.signals.length).toBe(2);
    const q = result.signals.find((s) => s.signal === 'q');
    expect(q?.kind).toBe('const_assign');
    expect(q?.hier).toBe('tb.dut');
    expect(q?.line).toBe(2);
    expect(q?.file).toBe(FILE);
    const sel = result.signals.find((s) => s.signal === 'sel');
    expect(sel?.line).toBe(4);
  });

  it('注释内的 assign 被剥离不命中', () => {
    const result = analyzeModuleInstance(stripped, 'dut', 'tb.dut', FILE, index);
    expect(result.signals.find((s) => s.signal === 'commented')).toBeUndefined();
    expect(result.signals.find((s) => s.signal === 'dynamic')).toBeUndefined();
  });

  it('module 找不到时返回 warning', () => {
    const result = analyzeModuleInstance(stripped, 'nope', 'tb.dut', FILE, index);
    expect(result.signals).toHaveLength(0);
    expect(result.warnings.length).toBeGreaterThan(0);
  });
});

describe('analyzeModuleInstance — 例化 tie / 悬空（文档 §4 场景）', () => {
  const SUB = [
    'module module_b (',
    '  input x,',
    '  input y,',
    '  input z,',
    '  output c',
    ');',
    'endmodule',
  ].join('\n');
  const PARENT = [
    'module module_a (input a, input b, output c);',
    '  module_b u_module_b(',
    '    .x(a),',
    "    .y(   1'b0 ),",
    "    .z(  1'b1 ),",
    '    .c(c)',
    '  );',
    'endmodule',
  ].join('\n');
  const strippedParent = stripComments(PARENT);
  const strippedSub = stripComments(SUB);
  // 跨文件：父/子模块定义在不同文件
  const index = buildIndex(strippedParent, strippedSub);

  it('识别跨文件的 input tie（y/z 接常量）', () => {
    const result = analyzeModuleInstance(
      strippedParent, 'module_a', 'tb.chip.u_module_a', '/proj/rtl/a.v', index,
    );
    const ties = result.signals.filter((s) => s.kind === 'input_tie');
    expect(ties.map((t) => t.signal).sort()).toEqual(['y', 'z']);
    expect(ties.every((t) => t.hier === 'tb.chip.u_module_a.u_module_b')).toBe(true);
    expect(ties.find((t) => t.signal === 'y')?.tieValue).toBe("1'b0");
    // tie 行号指向例化行
    expect(ties.find((t) => t.signal === 'y')?.line).toBe(4);
  });

  it('识别显式悬空 .c() 与省略的 output', () => {
    const parent = stripComments([
      'module p2 (input a, output c);',
      '  module_b u_b(',
      '    .x(a),',
      "    .y(1'b0),",
      '    .c()',
      '  );',
      'endmodule',
    ].join('\n'));
    const idx = buildIndex(parent, strippedSub);
    const result = analyzeModuleInstance(parent, 'p2', 'tb.u_p2', '/proj/rtl/p2.v', idx);
    const floats = result.signals.filter((s) => s.kind === 'output_floating');
    // .c() 显式悬空（c 是 output → floating）
    expect(floats.map((f) => f.signal).sort()).toEqual(['c']);
    // x 未连接（input 不算 floating）、z 被省略但 z 是 input 也不算
    const ties = result.signals.filter((s) => s.kind === 'input_tie');
    expect(ties.map((t) => t.signal).sort()).toEqual(['y']);
  });

  it('named 连接省略的 output 算悬空（用户决策）', () => {
    // module_b 有 output c 但例化处只连了 x/y/z
    // PARENT 中 .c(c) 已连接 → 不悬空。构造省略场景：
    const parent2 = stripComments([
      'module p3 (input a);',
      '  module_b u_b(',
      '    .x(a),',
      "    .y(1'b0),",
      "    .z(1'b1)",
      '  );',
      'endmodule',
    ].join('\n'));
    const idx2 = buildIndex(parent2, strippedSub);
    const r2 = analyzeModuleInstance(parent2, 'p3', 'tb.u_p3', '/proj/rtl/p3.v', idx2);
    const floats = r2.signals.filter((s) => s.kind === 'output_floating');
    expect(floats.map((f) => f.signal)).toEqual(['c']); // output c 被省略 → 悬空
  });

  it('子模块定义不可见时降级：仅常量连接仍报 tie，方向不明按 floating', () => {
    const emptyIndex = buildIndex(strippedParent); // 无 module_b 定义
    const result = analyzeModuleInstance(
      strippedParent, 'module_a', 'tb.u_module_a', '/proj/rtl/a.v', emptyIndex,
    );
    expect(result.warnings.join(' ')).toContain('module_b definition not found');
    // 方向不可见时：常量连接报 tie（宁多勿漏）
    const ties = result.signals.filter((s) => s.kind === 'input_tie');
    expect(ties.map((t) => t.signal).sort()).toEqual(['y', 'z']);
    // 省略 output 的判定依赖方向表，方向不可见不追加
    expect(result.signals.filter((s) => s.kind === 'output_floating')).toHaveLength(0);
  });
});

describe('analyzeModuleInstance — 误匹配防护', () => {
  it('关键字黑名单：always/task/case 等不误判为例化点', () => {
    const rtl = stripComments([
      'module m (input clk);',
      '  always @(posedge clk) begin',
      '    if (clk) $display("hi");',
      '  end',
      '  task my_task (input a);',
      '    begin : b',
      '    end',
      '  endtask',
      'endmodule',
    ].join('\n'));
    const index = buildIndex(rtl);
    const result = analyzeModuleInstance(rtl, 'm', 'tb.m', FILE, index);
    expect(result.signals).toHaveLength(0);
    expect(result.warnings).toHaveLength(0);
  });

  it('参数化例化 #(...) 正确解析', () => {
    const sub = stripComments('module s # (parameter W = 8) (input [W-1:0] d, output q); endmodule');
    const parent = stripComments([
      'module pp (input a, output q);',
      '  s #(.W(4)) u_s (',
      "    .d(4'h0),",
      '    .q(q)',
      '  );',
      'endmodule',
    ].join('\n'));
    const index = buildIndex(sub, parent);
    const result = analyzeModuleInstance(parent, 'pp', 'tb.pp', '/proj/rtl/pp.v', index);
    const ties = result.signals.filter((s) => s.kind === 'input_tie');
    expect(ties.map((t) => t.signal)).toEqual(['d']);
    expect(ties[0].hier).toBe('tb.pp.u_s');
  });

  it('positional 连接不解析端口名', () => {
    const sub = stripComments('module s2 (input a, output b); endmodule');
    const parent = stripComments([
      'module pp2 (input a, output b);',
      "  s2 u_s2 (1'b0, b);",
      'endmodule',
    ].join('\n'));
    const index = buildIndex(sub, parent);
    const result = analyzeModuleInstance(parent, 'pp2', 'tb.pp2', '/proj/rtl/pp2.v', index);
    expect(result.signals).toHaveLength(0);
  });
});
