import type { Extension } from '@codemirror/state';
import { EditorView, ViewPlugin, type ViewUpdate, Decoration, type DecorationSet, WidgetType } from '@codemirror/view';

// ── 缩进指南线 ViewPlugin ──────────────────────────────────────
//
// 遍历可见行（EditorView.viewport 范围）的缩进层级，在每个缩进级别位置
// 渲染一条淡色竖线。仅渲染视口可见行，大文件不卡顿。
// 缩进指南线颜色使用 CSS 变量 --border，随主题变化。

class IndentGuideWidget extends WidgetType {
  constructor(readonly level: number) {
    super();
  }

  toDOM(): HTMLElement {
    const el = document.createElement('span');
    el.className = 'cm-indent-guide';
    el.style.marginLeft = `${(this.level - 1) * 2}ch`;
    return el;
  }

  ignore(): boolean {
    return true;
  }
}

/** 计算一行的缩进级别（每 2 空格 = 1 级，tab = 8 空格） */
function getIndentLevel(text: string): number {
  let count = 0;
  for (let i = 0; i < text.length; i++) {
    if (text[i] === ' ') count++;
    else if (text[i] === '\t') count += 8;
    else break;
  }
  return Math.floor(count / 2);
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
