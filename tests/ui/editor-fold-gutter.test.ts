// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';
import { createFoldGutterExtension, foldMarkerDOM } from '@renderer/components/editor/fold-gutter';

// 折叠列扩展回归测试：
// 1. 折叠按钮默认隐藏（opacity: 0，由 globals.css 控制），仅在悬停折叠列时显示；
// 2. marker 使用 SVG chevron 替代默认文本 "⌄"/"›"，渲染更稳定；
// 3. 已折叠行（--folded）在 CSS 中常显，保证折叠后仍可展开。

describe('foldMarkerDOM', () => {
  it('展开态渲染 cm-fold-marker，chevron 向下', () => {
    const el = foldMarkerDOM(true);
    expect(el.className).toBe('cm-fold-marker');
    expect(el.querySelector('svg')).not.toBeNull();
    expect(el.innerHTML).toContain('M4 6l4 4 4-4');
  });

  it('折叠态带 cm-fold-marker--folded（CSS 中常显），chevron 向右', () => {
    const el = foldMarkerDOM(false);
    expect(el.className).toBe('cm-fold-marker cm-fold-marker--folded');
    expect(el.innerHTML).toContain('M6 4l4 4-4 4');
  });

  it('marker 为无障碍隐藏（aria-hidden 的 svg）', () => {
    const el = foldMarkerDOM(true);
    expect(el.querySelector('svg')?.getAttribute('aria-hidden')).toBe('true');
  });
});

describe('createFoldGutterExtension', () => {
  it('返回有效的 foldGutter 扩展', () => {
    expect(createFoldGutterExtension()).toBeTruthy();
  });
});
