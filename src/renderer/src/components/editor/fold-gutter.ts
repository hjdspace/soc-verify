import { type Extension } from '@codemirror/state';
import { foldGutter } from '@codemirror/language';

/**
 * 折叠标记 DOM（导出用于测试）：
 * - SVG chevron（展开=向下 / 折叠=向右），比默认文本 "⌄"/"›" 渲染更稳定、更贴近 VS Code
 * - class 供 CSS 控制显隐：默认隐藏，悬停折叠列显示，已折叠行常显（见 globals.css）
 */
export function foldMarkerDOM(open: boolean): HTMLElement {
  const span = document.createElement('span');
  span.className = open ? 'cm-fold-marker' : 'cm-fold-marker cm-fold-marker--folded';
  span.innerHTML = `<svg width="12" height="12" viewBox="0 0 16 16" fill="none" aria-hidden="true"><path d="${
    open ? 'M4 6l4 4 4-4' : 'M6 4l4 4-4 4'
  }" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/></svg>`;
  return span;
}

/**
 * 创建折叠列扩展（替代 basicSetup 默认 foldGutter）。
 * 点击折叠/展开由 foldGutter 的 gutter 级 click handler 处理，与 marker DOM 无关。
 * 视觉行为（隐藏/悬停显示/间距）由 globals.css 的 .cm-foldGutter 系列规则控制。
 */
export function createFoldGutterExtension(): Extension {
  return foldGutter({ markerDOM: foldMarkerDOM });
}
