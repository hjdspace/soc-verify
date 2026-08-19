// @vitest-environment jsdom
import { describe, expect, it, vi, beforeAll, afterEach } from 'vitest';
import { EditorView } from '@codemirror/view';
import { StateEffect } from '@codemirror/state';
import { planReviewMarkers, createInlineReviewExtension, type InlineReviewSpec } from '@renderer/components/editor/inline-review';
import type { FileDiffResult } from '@shared/types';

// jsdom 缺少真实布局 API，mock 掉 CodeMirror 依赖的测量接口
// （与 @uiw/react-codemirror 自身测试的 jsdom 设置一致）
beforeAll(() => {
  const rect = { bottom: 16, height: 16, left: 0, right: 100, top: 0, width: 100 };
  Object.defineProperty(global.Range.prototype, 'getClientRects', {
    writable: true,
    value: () => ({ length: 1, item: () => rect, [Symbol.iterator]: function* () { yield rect; } }),
  });
  Object.defineProperty(global.Range.prototype, 'getBoundingClientRect', {
    writable: true,
    value: () => rect,
  });
});

afterEach(() => {
  document.body.innerHTML = '';
});

/** 构造一个包含 hunk1（替换）与 hunk2（尾部追加）的 diff */
function sampleDiff(): FileDiffResult {
  return {
    filePath: 'D:/project/rtl/core.sv',
    isNewFile: false,
    lines: [
      { type: 'ctx', content: 'module alu;', oldLine: 1, newLine: 1 },
      { type: 'del', content: '  wire x;', oldLine: 2, hunkId: 1 },
      { type: 'add', content: '  wire y;', newLine: 2, hunkId: 1 },
      { type: 'ctx', content: 'endmodule', oldLine: 3, newLine: 3 },
      { type: 'add', content: '// tail', newLine: 4, hunkId: 2 },
    ],
    hunks: [
      { id: 1, toolCallId: 't1', toolName: 'edit', overwritten: false, startLineIndex: 1, endLineIndex: 3, addCount: 1, delCount: 1 },
      { id: 2, toolCallId: 't2', toolName: 'edit', overwritten: false, startLineIndex: 4, endLineIndex: 5, addCount: 1, delCount: 0 },
    ],
    totalAdd: 2,
    totalDel: 1,
  };
}

describe('planReviewMarkers', () => {
  it('maps add lines to document lines and groups del lines into blocks', () => {
    const plan = planReviewMarkers(sampleDiff(), 4, {});

    expect(plan.addLines).toEqual([
      { line: 2, rejected: false },
      { line: 4, rejected: false },
    ]);
    // 删除行块锚定到其后第一个存在于文档中的行（add 行 newLine=2）
    expect(plan.delBlocks).toEqual([{ lines: ['  wire x;'], anchor: 2 }]);
    expect(plan.hunkBars.map((b) => b.hunkId)).toEqual([1, 2]);
    expect(plan.hunkBars[0]).toMatchObject({ anchor: 2, state: 'pending', addCount: 1, delCount: 1 });
    expect(plan.hunkBars[1]).toMatchObject({ anchor: 4, state: 'pending', addCount: 1, delCount: 0 });
  });

  it('collapses accepted hunks entirely', () => {
    const plan = planReviewMarkers(sampleDiff(), 4, { 1: 'accepted', 2: 'accepted' });

    expect(plan.addLines).toEqual([]);
    expect(plan.delBlocks).toEqual([]);
    expect(plan.hunkBars).toEqual([]);
  });

  it('marks rejected add lines and hides rejected del blocks', () => {
    const plan = planReviewMarkers(sampleDiff(), 4, { 1: 'rejected' });

    expect(plan.addLines).toEqual([
      { line: 2, rejected: true },
      { line: 4, rejected: false },
    ]);
    // 拒绝的 hunk：删除行即将回滚，不再展示
    expect(plan.delBlocks).toEqual([]);
    expect(plan.hunkBars[0]).toMatchObject({ state: 'rejected' });
  });

  it('anchors a pure-deletion hunk to the next existing line', () => {
    const diff: FileDiffResult = {
      filePath: 'D:/project/a.sv',
      isNewFile: false,
      lines: [
        { type: 'ctx', content: 'line1', oldLine: 1, newLine: 1 },
        { type: 'del', content: 'line2', oldLine: 2, hunkId: 1 },
        { type: 'ctx', content: 'line3', oldLine: 3, newLine: 2 },
      ],
      hunks: [
        { id: 1, toolCallId: 't1', toolName: 'edit', overwritten: false, startLineIndex: 1, endLineIndex: 2, addCount: 0, delCount: 1 },
      ],
      totalAdd: 0,
      totalDel: 1,
    };

    const plan = planReviewMarkers(diff, 2, {});

    expect(plan.delBlocks).toEqual([{ lines: ['line2'], anchor: 2 }]);
    expect(plan.hunkBars[0]?.anchor).toBe(2);
  });

  it('anchors a trailing pure-deletion hunk to the document end', () => {
    const diff: FileDiffResult = {
      filePath: 'D:/project/a.sv',
      isNewFile: false,
      lines: [
        { type: 'ctx', content: 'line1', oldLine: 1, newLine: 1 },
        { type: 'del', content: 'line2', oldLine: 2, hunkId: 1 },
      ],
      hunks: [
        { id: 1, toolCallId: 't1', toolName: 'edit', overwritten: false, startLineIndex: 1, endLineIndex: 2, addCount: 0, delCount: 1 },
      ],
      totalAdd: 0,
      totalDel: 1,
    };

    const plan = planReviewMarkers(diff, 1, {});

    expect(plan.delBlocks).toEqual([{ lines: ['line2'], anchor: 'end' }]);
    expect(plan.hunkBars[0]?.anchor).toBe('end');
  });

  it('clamps line numbers beyond the document length', () => {
    const plan = planReviewMarkers(sampleDiff(), 2, {});

    // newLine=4 超出 2 行文档 → 钳制到第 2 行
    expect(plan.addLines.some((l) => l.line > 2)).toBe(false);
    expect(plan.hunkBars[1]?.anchor).toBe(2);
  });

  it('keeps overwritten hunks visible with their badge flag', () => {
    const diff = sampleDiff();
    diff.hunks[0] = { ...diff.hunks[0], overwritten: true };

    const plan = planReviewMarkers(diff, 4, {});

    const overwrittenBar = plan.hunkBars.find((b) => b.hunkId === 1);
    expect(overwrittenBar).toMatchObject({ overwritten: true });
    // overwritten hunk 的 hunk 状态按 accepted 处理（del 不再展示）
    expect(plan.delBlocks).toEqual([]);
  });
});

describe('createInlineReviewExtension', () => {
  /** 与 sampleDiff 的 newLine 映射一致的文档（4 行） */
  const DOC = 'module alu;\n  wire y;\nendmodule\n// tail';

  function mountView(spec: InlineReviewSpec): EditorView {
    return new EditorView({
      doc: DOC,
      parent: document.body,
      extensions: [createInlineReviewExtension(spec)],
    });
  }

  // 回归：block 装饰（hunk 操作条 / 删除行块）必须由 StateField 提供，
  // ViewPlugin 提供会在 DocView 构建时抛
  // "Block decorations may not be specified via plugins"（白屏）
  it('mounts block widgets without throwing RangeError', () => {
    const onAccept = vi.fn();
    const onReject = vi.fn();

    let view: EditorView | undefined;
    expect(() => {
      view = mountView({ diff: sampleDiff(), hunkStates: {}, onAccept, onReject });
    }).not.toThrow();

    // 2 个 hunk 操作条 + 1 个删除行块 + 2 行新增高亮
    expect(document.querySelectorAll('.cm-review-bar')).toHaveLength(2);
    expect(document.querySelectorAll('.cm-review-del-block')).toHaveLength(1);
    expect(document.querySelectorAll('.cm-line.cm-review-add')).toHaveLength(2);

    view?.destroy();
  });

  it('wires accept/reject buttons to spec callbacks', () => {
    const onAccept = vi.fn();
    const onReject = vi.fn();
    const view = mountView({ diff: sampleDiff(), hunkStates: {}, onAccept, onReject });

    // DOM 顺序 = 文档顺序：第一个操作条属于 hunk1（锚定第 2 行）
    document.querySelector<HTMLButtonElement>('.cm-review-btn-accept')?.click();
    expect(onAccept).toHaveBeenCalledWith(1);

    document.querySelector<HTMLButtonElement>('.cm-review-btn-reject')?.click();
    expect(onReject).toHaveBeenCalledWith(1);

    view.destroy();
  });

  it('renders generated file content as additions with review actions', () => {
    const onAccept = vi.fn();
    const onReject = vi.fn();
    const diff: FileDiffResult = {
      filePath: '/generated.sv',
      isNewFile: true,
      lines: [
        { type: 'add', content: 'module alu;', newLine: 1, hunkId: 1 },
        { type: 'add', content: '  wire y;', newLine: 2, hunkId: 1 },
        { type: 'add', content: 'endmodule', newLine: 3, hunkId: 1 },
        { type: 'add', content: '// tail', newLine: 4, hunkId: 1 },
      ],
      hunks: [{
        id: 1,
        toolCallId: 'write-new-file',
        toolName: 'write',
        overwritten: false,
        startLineIndex: 0,
        endLineIndex: 4,
        addCount: 4,
        delCount: 0,
      }],
      totalAdd: 4,
      totalDel: 0,
    };
    const view = mountView({ diff, hunkStates: {}, onAccept, onReject });

    expect(document.querySelectorAll('.cm-line.cm-review-add')).toHaveLength(4);
    expect(document.querySelectorAll('.cm-review-bar')).toHaveLength(1);
    expect(document.querySelector('.cm-review-btn-accept')).toBeTruthy();
    expect(document.querySelector('.cm-review-btn-reject')).toBeTruthy();

    view.destroy();
  });

  it('rebuilds decorations when reconfigured with a new spec', () => {
    const view = mountView({ diff: sampleDiff(), hunkStates: {}, onAccept: vi.fn(), onReject: vi.fn() });
    expect(document.querySelectorAll('.cm-review-bar')).toHaveLength(2);

    // spec 变化 → 调用方重建 extension → StateEffect.reconfigure
    // （@uiw/react-codemirror 更新 extensions prop 的同一路径）
    view.dispatch({
      effects: StateEffect.reconfigure.of([
        createInlineReviewExtension({
          diff: sampleDiff(),
          hunkStates: { 1: 'accepted', 2: 'accepted' },
          onAccept: vi.fn(),
          onReject: vi.fn(),
        }),
      ]),
    });

    // 全部接受：所有审阅标记折叠
    expect(document.querySelectorAll('.cm-review-bar')).toHaveLength(0);
    expect(document.querySelectorAll('.cm-review-del-block')).toHaveLength(0);
    expect(document.querySelectorAll('.cm-line.cm-review-add')).toHaveLength(0);

    view.destroy();
  });
});
