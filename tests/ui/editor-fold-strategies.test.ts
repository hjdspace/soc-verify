// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';
import { EditorState } from '@codemirror/state';
import { foldable } from '@codemirror/language';
import { javascript } from '@codemirror/lang-javascript';
import { css } from '@codemirror/lang-css';
import {
  createFoldStrategiesExtension,
  foldBlockComment,
  foldRegionMarker,
  foldIndentRange,
  foldSvKeywordBlock,
} from '@renderer/components/editor/fold-strategies';

// VSCode 风格折叠策略测试：所有策略是 EditorState 上的纯函数，
// 用真实文档 + 语言扩展验证（与 CodeMirror foldable() 相同的输入约定）。
// 辅助函数：按行号调用策略（foldable/foldGutter 均以 lineStart/lineEnd 调用 foldService）

/** 对 doc 的第 lineNum 行调用策略，返回折叠区间（null=不可折叠） */
function foldAt(
  state: EditorState,
  strategy: (s: EditorState, from: number, to: number) => { from: number; to: number } | null,
  lineNum: number,
): { from: number; to: number } | null {
  const line = state.doc.line(lineNum);
  return strategy(state, line.from, line.to);
}

/** 区间覆盖的行号 [起, 止]（起行=折叠起始行，止行=区间末尾所在行） */
function rangeLines(state: EditorState, r: { from: number; to: number }): [number, number] {
  return [state.doc.lineAt(r.from).number, state.doc.lineAt(r.to).number];
}

// ── 块注释折叠 ────────────────────────────────────────────────

describe('foldBlockComment', () => {
  const doc = [
    '/* header comment', // 1
    '   spanning lines', // 2
    '*/', // 3
    'body', // 4
  ].join('\n');
  const state = EditorState.create({ doc });

  it('多行块注释从起始行折叠到结束符行末尾', () => {
    const r = foldAt(state, foldBlockComment, 1);
    expect(r).not.toBeNull();
    const [startLine, endLine] = rangeLines(state, r!);
    expect(startLine).toBe(1);
    expect(endLine).toBe(3); // 结束符所在行整体可见（VSCode 行为）
  });

  it('单行注释不折叠', () => {
    const single = EditorState.create({ doc: '/* one line */\ncode\n' });
    expect(foldAt(single, foldBlockComment, 1)).toBeNull();
  });

  it('未闭合注释不折叠', () => {
    const unclosed = EditorState.create({ doc: '/* never closed\ncode\n' });
    expect(foldAt(unclosed, foldBlockComment, 1)).toBeNull();
  });

  it('HTML 注释变体（<!-- -->）可折叠', () => {
    const html = EditorState.create({ doc: '<!-- comment\nmore\n-->\n<div/>\n' });
    const r = foldAt(html, foldBlockComment, 1);
    expect(r).not.toBeNull();
    expect(rangeLines(html, r!)).toEqual([1, 3]);
  });

  it('起始行非注释不折叠', () => {
    expect(foldAt(state, foldBlockComment, 4)).toBeNull();
  });
});

// ── Marker 折叠（#region）────────────────────────────────────

describe('foldRegionMarker', () => {
  it('#region → #endregion 折叠且结束标记行保持可见', () => {
    const doc = [
      '#region imports', // 1
      'const a = 1;', // 2
      '#endregion', // 3
      'rest', // 4
    ].join('\n');
    const state = EditorState.create({ doc });
    const r = foldAt(state, foldRegionMarker, 1);
    expect(r).not.toBeNull();
    const [startLine, endLine] = rangeLines(state, r!);
    expect(startLine).toBe(1);
    expect(endLine).toBe(3); // to 指向 #endregion 行行首——该行保持可见
    expect(state.doc.lineAt(r!.to).text).toBe('#endregion');
  });

  it('// #region（JS/TS 风格）同样可折叠', () => {
    const doc = ['// #region helpers', 'function f() {}', '// #endregion', ''].join('\n');
    const state = EditorState.create({ doc });
    expect(foldAt(state, foldRegionMarker, 1)).not.toBeNull();
  });

  it('// region 与 // endregion（无 # 前缀）同样可折叠', () => {
    const doc = ['// region main', 'code', '// endregion', ''].join('\n');
    const state = EditorState.create({ doc });
    expect(foldAt(state, foldRegionMarker, 1)).not.toBeNull();
  });

  it('未闭合 region 不折叠', () => {
    const doc = ['#region x', 'code', ''].join('\n');
    const state = EditorState.create({ doc });
    expect(foldAt(state, foldRegionMarker, 1)).toBeNull();
  });

  it('非 region 行不折叠', () => {
    const doc = ['const a = 1;', ''].join('\n');
    const state = EditorState.create({ doc });
    expect(foldAt(state, foldRegionMarker, 1)).toBeNull();
  });
});

// ── 连续 import / export 组折叠 ──────────────────────────────

describe('连续 import/export 组折叠（javascript 策略）', () => {
  const doc = [
    'import x from "./x";', // 1
    'import y from "./y";', // 2
    'import z from "./z";', // 3
    '', // 4
    'export const a = 1;', // 5
    'export { b, c } from "./m";', // 6
    '', // 7
    'const single = "not in group";', // 8
  ].join('\n');
  const state = EditorState.create({
    doc,
    extensions: [javascript({ jsx: true, typescript: true }), createFoldStrategiesExtension('typescript')],
  });

  /** 用完整链路（foldService 注入后走 CodeMirror foldable）验证 */
  function foldableLines(s: EditorState): Map<number, [number, number]> {
    const result = new Map<number, [number, number]>();
    // 直接复用扩展创建时闭包的策略链（通过 createFoldStrategiesExtension 注入后，
    // 用 CodeMirror 的 foldable 逐行探测）
    for (let i = 1; i <= s.doc.lines; i++) {
      const line = s.doc.line(i);
      const r = foldable(s, line.from, line.to);
      if (r) result.set(i, [s.doc.lineAt(r.from).number, s.doc.lineAt(r.to).number]);
    }
    return result;
  }

  it('import 组：首条 import 折叠整组（1→3）', () => {
    const folds = foldableLines(state);
    expect(folds.get(1)).toEqual([1, 3]);
  });

  it('import 组中间行不重复起始折叠（2、3 是组内行）', () => {
    const folds = foldableLines(state);
    expect(folds.has(2)).toBe(false);
    expect(folds.has(3)).toBe(false);
  });

  it('export 组：连续 export 语句折叠（5→6）', () => {
    const folds = foldableLines(state);
    expect(folds.get(5)).toEqual([5, 6]);
  });

  it('孤立的 import（后面是空行/其它语句）不折叠', () => {
    const single = EditorState.create({
      doc: 'import x from "./x";\n\nconst a = 1;\n',
      extensions: [javascript(), createFoldStrategiesExtension('javascript')],
    });
    const folds = foldableLines(single);
    expect(folds.has(1)).toBe(false);
  });
});

// ── export { a, b } 花括号折叠 ───────────────────────────────

describe('export/import 花括号折叠（javascript 策略）', () => {
  const doc = [
    'export {', // 1
    '  b,', // 2
    '  c,', // 3
    '} from "./m";', // 4
    '', // 5
  ].join('\n');
  const state = EditorState.create({
    doc,
    extensions: [javascript(), createFoldStrategiesExtension('javascript')],
  });

  it('多行 export { ... } 花括号内容可折叠', () => {
    const line = state.doc.line(1);
    const r = foldable(state, line.from, line.to);
    expect(r).not.toBeNull();
    // 折叠内容在花括号内部（from 在 `{` 之后）
    expect(r!.from).toBeGreaterThan(line.from + 'export'.length);
    expect(r!.to).toBeLessThanOrEqual(state.doc.line(4).from); // 收尾行保持可读
  });
});

// ── 缩进折叠（回退策略）───────────────────────────────────────

describe('foldIndentRange', () => {
  const doc = [
    'def outer():', // 1
    '    inner_1()', // 2
    '    inner_2()', // 3
    'next_top_level()', // 4
  ].join('\n');

  it('缩进更深的后续行被折叠（1 → 3 行尾）', () => {
    const state = EditorState.create({ doc });
    const r = foldAt(state, foldIndentRange, 1);
    expect(r).not.toBeNull();
    const [, endLine] = rangeLines(state, r!);
    expect(endLine).toBe(3);
  });

  it('浅缩进行不产生折叠', () => {
    const state = EditorState.create({ doc });
    expect(foldAt(state, foldIndentRange, 4)).toBeNull();
  });

  it('跨越空行/注释行继续折叠，但不吞尾部悬挂行', () => {
    const doc2 = [
      'section:', // 1
      '  a: 1', // 2
      '', // 3
      '  # comment', // 4
      '  b: 2', // 5
      '', // 6
      'other:', // 7
    ].join('\n');
    const state = EditorState.create({ doc: doc2 });
    const r = foldAt(state, foldIndentRange, 1);
    expect(r).not.toBeNull();
    const [, endLine] = rangeLines(state, r!);
    expect(endLine).toBe(5); // 尾部空行(6)不并入
  });

  it('组内最后一个内容行是折叠终点（后续同级行截断）', () => {
    const doc3 = 'parent:\n  child1: 1\n  child2: 2\nsibling:\n  other: 1\n';
    const state = EditorState.create({ doc: doc3 });
    const r = foldAt(state, foldIndentRange, 1);
    const [, endLine] = rangeLines(state, r!);
    expect(endLine).toBe(3);
  });

  it('没有更深缩进时返回 null', () => {
    const flat = EditorState.create({ doc: 'a: 1\nb: 2\n' });
    expect(foldAt(flat, foldIndentRange, 1)).toBeNull();
  });

  it('tab 缩进按 2 列折算参与比较', () => {
    const tabbed = EditorState.create({ doc: 'parent:\n\tchild: 1\nsibling:\n' });
    const r = foldAt(tabbed, foldIndentRange, 1);
    expect(r).not.toBeNull();
  });
});

// ── SystemVerilog 关键字对折叠 ────────────────────────────────

describe('foldSvKeywordBlock', () => {
  const doc = [
    'module foo (', // 1
    '  input a,', // 2
    '  output b', // 3
    ');', // 4
    'always_comb begin', // 5
    '  if (a) begin', // 6
    '    b = 1;', // 7
    '  end', // 8
    'end', // 9
    'endmodule', // 10
  ].join('\n');
  const state = EditorState.create({ doc });

  it('module 折叠到 endmodule（结束行保持可见）', () => {
    const r = foldAt(state, foldSvKeywordBlock, 1);
    expect(r).not.toBeNull();
    const [startLine, endLine] = rangeLines(state, r!);
    expect(startLine).toBe(1);
    expect(endLine).toBe(10); // to 指向 endmodule 行首——该行保持可见
  });

  it('begin 嵌套配对：外层 begin 折到外层 end', () => {
    const r = foldAt(state, foldSvKeywordBlock, 5);
    expect(r).not.toBeNull();
    const [, endLine] = rangeLines(state, r!);
    expect(endLine).toBe(9); // to 指向外层 end 行首
  });

  it('内层 begin 折到最近的 end', () => {
    const r = foldAt(state, foldSvKeywordBlock, 6);
    expect(r).not.toBeNull();
    const [, endLine] = rangeLines(state, r!);
    expect(endLine).toBe(8); // to 指向内层 end 行首
  });

  it('endmodule 不会被 end 误配对（token 级匹配）', () => {
    // endmodule 行若被当作 end，line 5 的 begin 会配到 line 10
    const r = foldAt(state, foldSvKeywordBlock, 5);
    const [, endLine] = rangeLines(state, r!);
    expect(endLine).toBe(9);
    expect(state.doc.lineAt(r!.to).text.trim()).toBe('end');
  });

  it('未闭合块不折叠', () => {
    const unclosed = EditorState.create({ doc: 'module foo;\n  logic a;\n' });
    expect(foldAt(unclosed, foldSvKeywordBlock, 1)).toBeNull();
  });

  it('case/casex/casez → endcase 折叠', () => {
    const caseDoc = [
      'always_comb begin', // 1
      '  case (a)', // 2
      '    x = 1;', // 3
      '  endcase', // 4
      'end', // 5
    ].join('\n');
    const caseState = EditorState.create({ doc: caseDoc });
    const r = foldAt(caseState, foldSvKeywordBlock, 2);
    expect(r).not.toBeNull();
    const [, endLine] = rangeLines(caseState, r!);
    expect(endLine).toBe(4); // to 指向 endcase 行首——该行保持可见
  });

  it('fork → join/join_any/join_none 折叠', () => {
    const forkDoc = 'initial begin\n  fork\n    run();\n  join_none\nend\n';
    const forkState = EditorState.create({ doc: forkDoc });
    const r = foldAt(forkState, foldSvKeywordBlock, 2);
    expect(r).not.toBeNull();
    const [, endLine] = rangeLines(forkState, r!);
    expect(endLine).toBe(4); // to 指向 join_none 行首——该行保持可见
  });
});

// ── 完整链路：foldService 与语法折叠的回退协作 ───────────────

describe('createFoldStrategiesExtension（链路集成）', () => {
  it('SV 文件全链路：module/begin/块注释均可折叠（verilog 策略链）', () => {
    const doc = [
      '/* header', // 1
      '*/', // 2
      'module m ();', // 3
      '  task t();', // 4
      '    begin', // 5
      '      x = 1;', // 6
      '    end', // 7
      '  endtask', // 8
      'endmodule', // 9
    ].join('\n');
    const state = EditorState.create({
      doc,
      extensions: [createFoldStrategiesExtension('verilog')],
    });
    const foldLines = new Set<number>();
    for (let i = 1; i <= state.doc.lines; i++) {
      const line = state.doc.line(i);
      if (foldable(state, line.from, line.to)) foldLines.add(i);
    }
    expect(foldLines.has(1)).toBe(true); // 块注释
    expect(foldLines.has(3)).toBe(true); // module
    expect(foldLines.has(4)).toBe(true); // task
    expect(foldLines.has(5)).toBe(true); // begin（嵌套）
  });

  it('未知语言回落到缩进折叠（plaintext/default）', () => {
    const doc = 'root:\n  child: 1\n  child2: 2\n';
    const state = EditorState.create({
      doc,
      extensions: [createFoldStrategiesExtension('some-unknown-lang')],
    });
    const line = state.doc.line(1);
    expect(foldable(state, line.from, line.to)).not.toBeNull();
  });

  it('CSS 块注释补齐（lang-css 无内置注释折叠）', () => {
    const doc = '/* css header\n   lines\n*/\n.a { color: red; }\n';
    const state = EditorState.create({
      doc,
      extensions: [css(), createFoldStrategiesExtension('css')],
    });
    const line = state.doc.line(1);
    const r = foldable(state, line.from, line.to);
    expect(r).not.toBeNull();
    expect(state.doc.lineAt(r!.to).number).toBe(3);
  });

  it('不改变已有语法折叠（JS 函数体 Block 折叠仍在）', () => {
    const doc = 'function foo() {\n  return 1;\n}\n';
    const state = EditorState.create({
      doc,
      extensions: [javascript(), createFoldStrategiesExtension('javascript')],
    });
    const line = state.doc.line(1);
    expect(foldable(state, line.from, line.to)).not.toBeNull(); // 由语法树 foldNodeProp 提供
  });
});
