import { syntaxHighlighting, HighlightStyle } from '@codemirror/language';
import { tags } from '@lezer/highlight';
import type { Extension } from '@codemirror/state';

// ── 语法高亮 HighlightStyle ────────────────────────────────────
//
// 使用 CSS 变量引用 globals.css 中各主题定义的 --syn-* 变量。
// 切换主题时 CSS 变量联动，无需重载编辑器。

const themedHighlightStyle = HighlightStyle.define([
  // 关键字 (module, always, assign, wire, reg, input, output, begin, end, endmodule)
  { tag: tags.keyword, color: 'var(--syn-keyword)', fontWeight: '500' },
  { tag: tags.controlKeyword, color: 'var(--syn-keyword)' },
  { tag: tags.definitionKeyword, color: 'var(--syn-keyword)' },
  { tag: tags.moduleKeyword, color: 'var(--syn-keyword)' },
  { tag: tags.modifier, color: 'var(--syn-keyword)' },

  // 字符串
  { tag: tags.string, color: 'var(--syn-string)' },
  { tag: tags.special(tags.string), color: 'var(--syn-string)' },

  // 数字
  { tag: tags.number, color: 'var(--syn-number)' },

  // 注释 — 斜体灰色
  { tag: tags.comment, color: 'var(--syn-comment)', fontStyle: 'italic' },
  { tag: tags.lineComment, color: 'var(--syn-comment)', fontStyle: 'italic' },
  { tag: tags.blockComment, color: 'var(--syn-comment)', fontStyle: 'italic' },
  { tag: tags.docComment, color: 'var(--syn-comment)', fontStyle: 'italic' },

  // 函数名
  { tag: tags.function(tags.variableName), color: 'var(--syn-function)' },
  { tag: tags.function(tags.propertyName), color: 'var(--syn-function)' },

  // 类型名
  { tag: tags.typeName, color: 'var(--syn-type)' },
  { tag: tags.className, color: 'var(--syn-type)' },
  { tag: tags.namespace, color: 'var(--syn-type)' },

  // 属性名
  { tag: tags.propertyName, color: 'var(--syn-property)' },
  { tag: tags.attributeName, color: 'var(--syn-property)' },

  // 变量名 — 使用前景色
  { tag: tags.variableName, color: 'var(--foreground)' },

  // 运算符
  { tag: tags.operator, color: 'var(--muted-foreground)' },
  { tag: tags.arithmeticOperator, color: 'var(--muted-foreground)' },
  { tag: tags.logicOperator, color: 'var(--muted-foreground)' },
  { tag: tags.bitwiseOperator, color: 'var(--muted-foreground)' },

  // 括号
  { tag: tags.bracket, color: 'var(--muted-foreground)' },
  { tag: tags.paren, color: 'var(--muted-foreground)' },
]);

/**
 * 创建语法高亮 extension。
 * 高亮色引用 CSS 变量，切换主题时自动联动。
 */
export function createSyntaxHighlightExtension(): Extension {
  return syntaxHighlighting(themedHighlightStyle);
}
