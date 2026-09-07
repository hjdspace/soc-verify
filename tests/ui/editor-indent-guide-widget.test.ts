// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';
import { IndentGuideWidget, getIndentLevel } from '@renderer/components/editor/indent-guides';

// 回归测试：缩进指南线 widget 必须零宽、不占布局空间。
// 此前 widget 使用 marginLeft 定位画线，导致行内容被向右推开——
// tab 缩进的日志（如 irun_compile.log 第 4 行一个 tab）显示成约 14 列的巨大缩进，
// 与 gvim (ts=4) 的 4 列严重不一致。

describe('IndentGuideWidget.toDOM', () => {
  it('不设置 marginLeft（margin 会把行内容向右推开）', () => {
    const el = new IndentGuideWidget(4).toDOM();
    expect(el.className).toBe('cm-indent-guide');
    expect(el.style.marginLeft).toBe('');
  });

  it('通过 --guide-col 指定画线列位置：(level-1)*2ch', () => {
    expect(new IndentGuideWidget(1).toDOM().style.getPropertyValue('--guide-col')).toBe('0ch');
    expect(new IndentGuideWidget(2).toDOM().style.getPropertyValue('--guide-col')).toBe('2ch');
    expect(new IndentGuideWidget(4).toDOM().style.getPropertyValue('--guide-col')).toBe('6ch');
  });

  it('事件被忽略，指南线不参与交互', () => {
    expect(new IndentGuideWidget(1).ignoreEvent(new Event('click'))).toBe(true);
  });
});

describe('getIndentLevel', () => {
  it('无前导空白为 0 级', () => {
    expect(getIndentLevel('-c')).toBe(0);
    expect(getIndentLevel('xrun(64): 25.04-a072')).toBe(0);
  });

  it('空格缩进：每 2 列 = 1 级', () => {
    expect(getIndentLevel('  code')).toBe(1);
    expect(getIndentLevel('    code')).toBe(2);
  });

  it('tab 按 tabSize=2 折算：1 个 tab = 1 级（与编辑器渲染一致）', () => {
    expect(getIndentLevel('\t-c')).toBe(1);
  });

  it('tab 对齐 tab stop：空格后 tab 只补齐到偶数列', () => {
    // 1 空格（列 1）+ tab 补 1 列 = 2 列 → 1 级
    expect(getIndentLevel(' \t-c')).toBe(1);
    // 2 空格（列 2）+ tab 补 2 列 + 2 空格 = 6 列 → 3 级
    expect(getIndentLevel('  \t  x')).toBe(3);
  });

  it('非空白字符终止计数', () => {
    expect(getIndentLevel('  a\tb')).toBe(1);
  });
});
