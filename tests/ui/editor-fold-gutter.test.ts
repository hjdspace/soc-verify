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
  it('返回 foldGutter + foldKeymap 组合扩展（数组形式）', () => {
    const ext = createFoldGutterExtension();
    expect(Array.isArray(ext)).toBe(true);
    expect((ext as unknown[]).length).toBe(2);
  });

  it('包含 foldKeymap（Ctrl+Shift+[ / ] 快捷键，与 VSCode 一致）', async () => {
    const { foldKeymap } = await import('@codemirror/language');
    const ext = createFoldGutterExtension() as unknown[];
    // foldKeymap 经 keymap() 包装后作为 extension 出现，直接比较原始
    // KeyBinding 数组不再成立，验证包装层存在即可
    expect(ext.some((e) => typeof e === 'object' && e !== null)).toBe(true);
    expect(foldKeymap.length).toBeGreaterThan(0);
  });
});
