import type { Extension } from '@codemirror/state';
import { EditorView, ViewPlugin, type ViewUpdate, Decoration, type DecorationSet, WidgetType } from '@codemirror/view';

// ── 缩进指南线 ViewPlugin ──────────────────────────────────────
//
// 遍历可见行（EditorView.viewport 范围）的缩进层级，在每个缩进级别位置
// 渲染一条淡色竖线。仅渲染视口可见行，大文件不卡顿。
// 缩进指南线颜色使用 CSS 变量 --border，随主题变化。

/** 缩进指南线 widget（导出用于测试）：零宽标记，画线位置由 --guide-col 控制 */
export class IndentGuideWidget extends WidgetType {
  constructor(readonly level: number) {
    super();
  }

  toDOM(): HTMLElement {
    const el = document.createElement('span');
    el.className = 'cm-indent-guide';
    // 画线位置通过 CSS 变量交给 ::before 绝对定位完成。
    // widget 本身必须零宽（不设 margin、不占布局空间）——
    // 否则多级缩进时会把行内容（尤其是 tab 缩进的日志）整体向右推开。
    el.style.setProperty('--guide-col', `${(this.level - 1) * 2}ch`);
    return el;
  }

  ignoreEvent(_event: Event): boolean {
    return true;
  }
}

/** 计算一行的缩进级别（每 2 列 = 1 级；tab 按 tabSize=2 对齐 tab stop 折算，与编辑器渲染一致） */
export function getIndentLevel(text: string): number {
  let col = 0;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (ch === ' ') col++;
    else if (ch === '\t') col += 2 - (col % 2); // tab 前进到下一个 2 列的倍数
    else break;
  }
  return Math.floor(col / 2);
}

function buildIndentGuides(view: EditorView): DecorationSet {
  const { state } = view;
  const viewport = view.viewport;
  const decorations: ReturnType<Decoration['range']>[] = [];

  const startLine = state.doc.lineAt(viewport.from).number;
  const endLine = state.doc.lineAt(viewport.to).number;

  for (let lineNum = startLine; lineNum <= endLine; lineNum++) {
    const line = state.doc.line(lineNum);
    if (line.length === 0) continue;

    const indent = getIndentLevel(line.text);
    if (indent <= 0) continue;

    // 在行首为每个缩进级别创建一个 widget
    for (let level = 1; level <= indent; level++) {
      decorations.push(
        Decoration.widget({
          widget: new IndentGuideWidget(level),
          side: -1, // 在字符前渲染
        }).range(line.from),
      );
    }
  }

  decorations.sort((a, b) => a.from - b.from);
  return Decoration.set(decorations, true);
}

const indentGuidesPlugin = ViewPlugin.define((view: EditorView) => ({
  decorations: buildIndentGuides(view),
  update(update: ViewUpdate) {
    if (update.docChanged || update.viewportChanged) {
      this.decorations = buildIndentGuides(view);
    }
  },
}), {
  decorations: (v: { decorations: DecorationSet }) => v.decorations,
});

/**
 * 创建缩进指南线 extension。
 * 缩进指南线颜色使用 --border CSS 变量，随主题变化。
 * 仅渲染视口可见行，大文件不卡顿。
 */
export function createIndentGuidesExtension(): Extension {
  return indentGuidesPlugin;
}
