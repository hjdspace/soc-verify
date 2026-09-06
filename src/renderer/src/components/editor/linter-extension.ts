/**
 * CodeMirror 6 Linter Extension — 桥接 slang-server LSP 诊断与 verible lint 到编辑器波浪线。
 *
 * 设计：
 *   - 用 @codemirror/lint 的 setDiagnosticsEffect 推送诊断到编辑器（波浪线 + gutter 标记）
 *   - 诊断来源：slang-server LSP（publishDiagnostics）+ verible lint（文本解析）
 *   - 两源合并：同文件 URI 的诊断去重后一起推送（spec 决策 28：互补不冗余）
 *
 * 参考：ADR 0032 主题 5 决策 20（slang-server LSP）/ 决策 21（verible lint）。
 */

import { type Extension } from '@codemirror/state';
import { EditorView } from '@codemirror/view';
import { lintGutter, setDiagnosticsEffect, type Diagnostic as CMDiagnostic, linter } from '@codemirror/lint';

/** 统一诊断类型（LSP 与 verible 共用） */
export type EditorDiagnostic = {
  line: number;        // 0-based
  character: number;   // 0-based
  endLine: number;     // 0-based
  endCharacter: number; // 0-based
  severity: 'error' | 'warning' | 'info' | 'hint';
  message: string;
  source?: string;
  code?: number | string;
};

/** CM6 lint Diagnostic severity 映射 */
function toCMSeverity(sev: EditorDiagnostic['severity']): CMDiagnostic['severity'] {
  switch (sev) {
    case 'error': return 'error';
    case 'warning': return 'warning';
    case 'info': return 'info';
    case 'hint': return 'hint';
  }
}

/** 将 EditorDiagnostic[] 转为 CM6 Diagnostic[]（行/列 → 文档偏移） */
function toCMDiagnostics(diagnostics: EditorDiagnostic[], view: EditorView): CMDiagnostic[] {
  const doc = view.state.doc;
  return diagnostics.map((d) => {
    const startLine = doc.lineAt(Math.max(0, d.line));
    const endLine = doc.lineAt(Math.max(0, d.endLine));
    const from = Math.min(startLine.from + Math.max(0, d.character), startLine.to);
    const to = Math.min(endLine.from + Math.max(0, d.endCharacter), endLine.to);
    return {
      from,
      to: Math.max(from, to),
      severity: toCMSeverity(d.severity),
      message: d.source ? `${d.source}: ${d.message}` : d.message,
    } satisfies CMDiagnostic;
  });
}

/**
 * 推送诊断到 CodeMirror 编辑器（波浪线 + gutter 标记）。
 *
 * 使用 @codemirror/lint 的 setDiagnosticsEffect 直接 dispatch，
 * 配合 linter() extension 的 forceLinting 实现。
 *
 * @param view CodeMirror EditorView 实例
 * @param diagnostics 诊断列表（0-based 行号）
 */
export function pushDiagnostics(view: EditorView, diagnostics: EditorDiagnostic[]): void {
  const cms = toCMDiagnostics(diagnostics, view);
  view.dispatch({
    effects: setDiagnosticsEffect.of(cms),
  });
}

/**
 * linter 基础扩展：
 *   - lintGutter：在行号旁显示错误/警告标记
 *   - linter(() => [])：占位 linter（实际诊断由 pushDiagnostics 外部推送）
 */
export function linterExtension(): Extension {
  return [
    lintGutter(),
    linter(() => []),
  ];
}
