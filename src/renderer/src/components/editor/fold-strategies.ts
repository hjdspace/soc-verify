/**
 * VSCode 风格代码折叠策略（foldService 扩展）。
 *
 * CodeMirror 的折叠判定链是：foldService facet（自定义策略，优先）→
 * 语法树 foldNodeProp（语言包内置）。现有编辑器只依赖后者，导致大量
 * VSCode 支持的折叠场景缺失。本模块参考 VSCode 的折叠分层实现补齐：
 *
 *   1. 块注释折叠（slash-star 注释）— JS/CPP 有内置但 CSS/SV 等缺失，统一补齐
 *   2. Marker 折叠（region/endregion 标记、HTML 注释内 region）
 *   3. 连续 import/export 块折叠（VSCode 的 "Fold imports" 行为）
 *   4. 缩进折叠（VSCode IndentRangeProvider 的无语法树回退，任何语言生效）
 *   5. SystemVerilog 关键字对折叠（module/endmodule、begin/end 等，
 *      StreamLanguage 语法树扁平，完全没有内置折叠）
 *
 * 每个 foldService 只应在"当前行是折叠起始行"时返回区间（区间起点须落在
 * lineStart..lineEnd 内、终点超出该行），与 foldable() 的约定一致。
 */

import { type EditorState } from '@codemirror/state';
import { syntaxTree, foldService } from '@codemirror/language';
import type { SyntaxNode } from '@lezer/common';

/** 单行折叠策略：给定行范围，返回起始于该行的折叠区间 */
type FoldStrategy = (state: EditorState, lineStart: number, lineEnd: number) => { from: number; to: number } | null;

// ── 通用辅助 ──────────────────────────────────────────────────

/** 行首（忽略缩进）是否匹配给定正则；返回 null 或匹配结果 */
function matchAtLineStart(lineText: string, re: RegExp): RegExpMatchArray | null {
  const trimmed = lineText.trimStart();
  if (!trimmed) return null;
  // 构造锚定行首（跳过缩进）的正则，避免逐行全文扫描
  const anchored = new RegExp(`^(?:${re.source})`, re.flags.includes('i') ? 'i' : '');
  const m = trimmed.match(anchored);
  return m;
}

// ── 1. 块注释折叠 ─────────────────────────────────────────────

/**
 * 块注释折叠：行以 `/*`（或 Markdown/HTML 变体）开头时，折叠到注释结束符所在行。
 * 折叠区间从注释起始行的行尾开始（VSCode 行为：折叠标记行保持可见），
 * 到结束符行末尾。嵌套内容整体收起，未闭合的注释不折叠。
 */
function foldBlockComment(
  state: EditorState,
  lineStart: number,
  lineEnd: number,
): { from: number; to: number } | null {
  const line = state.doc.lineAt(lineStart);
  const text = line.text;
  // 行首（缩进后）必须是块注释开始符；同一行内先出现结束符的（如 /* x */ 单行注释）不折叠
  const indentEnd = text.length - text.trimStart().length;
  const rest = text.slice(indentEnd);
  const openTokens = ['/*', '<!--'];
  const open = openTokens.find((t) => rest.startsWith(t));
  if (!open) return null;
  const close = open === '/*' ? '*/' : '-->';
  const closeIdxOnOpenLine = text.indexOf(close, indentEnd + open.length);
  if (closeIdxOnOpenLine >= 0) return null; // 单行注释，无需折叠
  // 向后搜索结束符（从起始行之后开始）
  const searchFrom = line.to;
  const closeIdx = state.doc.sliceString(searchFrom, state.doc.length).indexOf(close);
  if (closeIdx < 0) return null; // 未闭合
  const closePos = searchFrom + closeIdx;
  const closeLine = state.doc.lineAt(closePos);
  return { from: lineEnd, to: closeLine.to };
}

// ── 2. Marker 折叠（#region / #endregion）────────────────────

/** 各语言的 region 标记：start 正则捕获起始行，end 正则匹配结束行 */
const REGION_MARKERS: ReadonlyArray<{ start: RegExp; end: RegExp }> = [
  // C/C++/C#/JS/TS/Python/Shell 风格：#region、// region、# pragma region
  { start: /^#region\b|^\/\/\s*#?region\b|^\/\/\s*region\b/i, end: /^#endregion\b|^\/\/\s*#?endregion\b|^\/\/\s*endregion\b/i },
  // 风格变体：// #region（XML doc 注释下）
  { start: /^\/\/\s*<region\b/i, end: /^\/\/\s*<\/region\b/i },
  // Verilog/SystemVerilog：`// region` 之外还有synthesis 风格不常用，不展开
];

function foldRegionMarker(
  state: EditorState,
  lineStart: number,
  lineEnd: number,
): { from: number; to: number } | null {
  const line = state.doc.lineAt(lineStart);
  const marker = REGION_MARKERS.find((m) => matchAtLineStart(line.text, m.start));
  if (!marker) return null;
  // 向后逐行搜索结束标记行（line.to 是 \n 位置，+1 才是下一行起点；
  // 直接 lineAt(line.to) 会解析回当前行造成死循环）
  for (let num = line.number + 1; num <= state.doc.lines; num++) {
    const nextLine = state.doc.line(num);
    const text = nextLine.text.trimStart();
    if (new RegExp(marker.end.source, 'i').test(text)) {
      return { from: lineEnd, to: nextLine.from }; // 结束标记行保持可见（VSCode 行为）
    }
  }
  return null; // 未闭合
}

// ── 3. 连续 import / export 块折叠 ───────────────────────────

/**
 * 连续语句块折叠（VSCode "Fold imports"）：从当前行起，把连续的
 * import/export（或 Python import、Tcl package require）语句折叠为一行。
 * 中间不允许出现空行或其它语句——VSCode 同样只折叠紧邻组。
 * 组必须 ≥ 2 条语句才有折叠意义。
 */
const GROUP_STATEMENT_RE = /^\s*(?:import\b|export\b)/;

/** Python 单行 import 检测（lang-python 语法树无 ImportStatement fold 支持） */
function isPythonImportLine(lineText: string): boolean {
  return /^\s*(?:import\s|from\s+\S+\s+import\b)/.test(lineText);
}

function foldImportGroup(
  state: EditorState,
  lineStart: number,
  lineEnd: number,
  isGroupLine: (text: string) => boolean,
): { from: number; to: number } | null {
  const firstLine = state.doc.lineAt(lineStart);
  if (!isGroupLine(firstLine.text)) return null;
  // 组首判定：前一行已是组内语句则本行是组内续行，不再产生折叠
  // （VSCode 连续 import 只有第一条显示折叠 chevron）
  if (firstLine.number > 1) {
    const prev = state.doc.line(firstLine.number - 1);
    if (isGroupLine(prev.text)) return null;
  }
  // 向后找连续同组语句（逐行推进；line.to 是 \n 位置，不能用 lineAt(line.to)）
  let last = firstLine;
  for (let num = firstLine.number + 1; num <= state.doc.lines; num++) {
    const next = state.doc.line(num);
    if (next.text.trim() === '') break; // 空行终止组
    if (!isGroupLine(next.text)) break;
    last = next;
  }
  if (last.number === firstLine.number) return null; // 单条不折叠
  return { from: lineEnd, to: last.to };
}

// ── 4. 缩进折叠（VSCode IndentRangeProvider 回退）─────────────

/** 计算一行的缩进列数（tab 按 2 折算，与编辑器 tabSize=2 一致） */
function indentColumn(lineText: string): number {
  let col = 0;
  for (const ch of lineText) {
    if (ch === ' ') col++;
    else if (ch === '\t') col += 2 - (col % 2);
    else break;
  }
  return col;
}

/** 判断一行是否"空或仅注释"——VSCode 缩进折叠会跨越空白/注释行寻找同级行 */
function isBlankOrComment(lineText: string): boolean {
  const t = lineText.trim();
  return t === '' || t.startsWith('//') || t.startsWith('#') || t.startsWith('*') || t.startsWith('/*') || t.startsWith('*/');
}

/**
 * 缩进折叠（VSCode 的通用回退策略）：
 * 当前行的缩进列比后续行严格大时，折叠到"下一个缩进 ≤ 当前行"的行。
 * VSCode 允许区间内包含空行/注释行（它们不参与缩进比较），
 * 尾部悬挂的空行/注释行不并入折叠区间。
 * 至少需要一行更深缩进的内容才返回区间。
 */
function foldIndentRange(
  state: EditorState,
  lineStart: number,
  lineEnd: number,
): { from: number; to: number } | null {
  const doc = state.doc;
  const startLine = doc.lineAt(lineStart);
  const baseIndent = indentColumn(startLine.text);
  const startText = startLine.text.trim();
  if (startText === '' || startText === '//') return null; // 空行/纯注释行本身不作为折叠起点
  // 行尾已经是对界符收尾的行（如 `} else {`、`)`），VSCode 不在此产生缩进折叠——
  // 这类行通常已有语法折叠，避免双层 chevron

  let lastContentLine: number | null = null; // 区间内最后一个非空非注释行
  let sawDeeper = false;
  for (let num = startLine.number + 1; num <= doc.lines; num++) {
    const line = doc.line(num);
    const text = line.text;
    if (isBlankOrComment(text)) continue;
    const indent = indentColumn(text);
    if (indent > baseIndent) {
      sawDeeper = true;
      lastContentLine = num;
    } else {
      break;
    }
  }
  if (!sawDeeper || lastContentLine === null) return null;
  // 折叠到区间内最后一个内容行的行尾（不含尾部悬挂空行）
  const endLine = doc.line(lastContentLine);
  if (endLine.to <= lineEnd) return null; // 至少要折叠掉一行
  return { from: lineEnd, to: endLine.to };
}

// ── 5. SystemVerilog 关键字对折叠 ─────────────────────────────

/**
 * SystemVerilog 块关键字对（IEEE 1800）：开关键字 → 闭关键字。
 * 嵌套由"最近未闭合"配对决定：向后逐行扫描时用栈匹配，
 * 遇到同族开关键字则入栈，闭关键字弹栈；栈弹空时即区间终点。
 */
const SV_BLOCK_PAIRS: ReadonlyArray<{ open: string; close: string[] }> = [
  { open: 'module', close: ['endmodule'] },
  { open: 'macromodule', close: ['endmodule'] },
  { open: 'program', close: ['endprogram'] },
  { open: 'class', close: ['endclass'] },
  { open: 'interface', close: ['endinterface'] },
  { open: 'package', close: ['endpackage'] },
  { open: 'checker', close: ['endchecker'] },
  { open: 'config', close: ['endconfig'] },
  { open: 'primitive', close: ['endprimitive'] },
  { open: 'table', close: ['endtable'] },
  { open: 'function', close: ['endfunction'] },
  { open: 'task', close: ['endtask'] },
  { open: 'clocking', close: ['endclocking'] },
  { open: 'covergroup', close: ['endgroup'] },
  { open: 'property', close: ['endproperty'] },
  { open: 'sequence', close: ['endsequence'] },
  { open: 'specify', close: ['endspecify'] },
  { open: 'generate', close: ['endgenerate'] },
  { open: 'begin', close: ['end'] },
  { open: 'case', close: ['endcase'] },
  { open: 'casex', close: ['endcase'] },
  { open: 'casez', close: ['endcase'] },
  { open: 'fork', close: ['join', 'join_any', 'join_none'] },
];

/** 提取一行内所有标识符 token（`endmodule` 是一个 token，不会误匹配 `end`） */
function lineTokens(lineText: string): string[] {
  return lineText.match(/[a-zA-Z_][a-zA-Z0-9_$]*/g) ?? [];
}

/** token 集合查找（Map 比 includes 链更快，模块加载时预构建） */
const SV_OPEN_MAP = new Map(SV_BLOCK_PAIRS.map((p) => [p.open, p]));
const SV_CLOSE_MAP = new Map<string, string>();
for (const pair of SV_BLOCK_PAIRS) {
  for (const close of pair.close) SV_CLOSE_MAP.set(close, pair.open);
}

function foldSvKeywordBlock(
  state: EditorState,
  lineStart: number,
  lineEnd: number,
): { from: number; to: number } | null {
  const startLine = state.doc.lineAt(lineStart);
  // 起始行判定：行内含未配对的开关键字（`always_comb begin` 行也是合法起始行，
  // 这与 VSCode 对 SV 的 "begin" 折叠一致）。同一行的既有闭关键字先抵扣。
  let openKeyword: string | null = null;
  let depth = 0;
  for (const token of lineTokens(startLine.text)) {
    if (SV_OPEN_MAP.has(token)) {
      if (depth === 0) openKeyword = token;
      depth++;
    } else if (SV_CLOSE_MAP.has(token) && depth > 0) {
      depth--;
      if (depth === 0) openKeyword = null;
    }
  }
  if (!openKeyword || depth === 0) return null;

  const pair = SV_OPEN_MAP.get(openKeyword)!;
  for (let num = startLine.number + 1; num <= state.doc.lines; num++) {
    const text = state.doc.line(num).text;
    for (const token of lineTokens(text)) {
      if (token === openKeyword) depth++;
      else if (pair.close.includes(token)) {
        depth--;
        if (depth === 0) {
          const closeLine = state.doc.line(num);
          if (closeLine.number === startLine.number) return null;
          return { from: lineEnd, to: closeLine.from }; // 结束关键字行保持可见（VSCode 行为）
        }
      }
    }
  }
  return null; // 未闭合
}

// ── 6. JS/TS import/export 花括号折叠 ─────────────────────────

/**
 * JS/TS `export { a, b }` / `import { a } from` 的花括号折叠。
 * 语法树上花括号是 ExportGroup/ImportGroup 节点（lezer grammar 无
 * foldNodeProp 支持），无内置折叠——通过节点定位补充 foldInside 语义：
 * 折叠花括号内部，起始行（`export {`）与闭合花括号所在内容保持可读。
 * 单行 `export { a, b }` 不折叠（n.from 与 n.to 在同一行）。
 */
function foldJsGroup(
  state: EditorState,
  _lineStart: number,
  lineEnd: number,
): { from: number; to: number } | null {
  const tree = syntaxTree(state);
  if (tree.length < lineEnd) return null;
  // 行尾向上找覆盖本行的 ExportGroup/ImportGroup 节点
  // （resolveInner 边界处可能返回 null）
  const start = tree.resolveInner(lineEnd, 1);
  if (!start) return null;
  for (let n: SyntaxNode | null = start; n; n = n.parent) {
    if (n.name === 'ExportGroup' || n.name === 'ImportGroup') {
      if (n.to > lineEnd) return { from: n.from + 1, to: n.to - 1 };
      return null;
    }
    if (n.name === 'Script' || n.name === 'StyleSheet') break;
  }
  return null;
}

// ── 语言策略注册 ──────────────────────────────────────────────

/**
 * 每种语言的折叠策略链（顺序即优先级）。
 * 所有策略都失败时回落到语法树 foldNodeProp（foldable 内建行为），
 * 因此这里只补充缺失场景，不复制已有的语法折叠。
 *
 * 原则（与 VSCode 一致）：
 * - 有结构化语法折叠的语言（JS/Python/CSS/HTML/YAML/MD）：只补缺失场景，
 *   缩进折叠不启用（避免与语法折叠叠加产生双层 chevron）
 * - 无语法折叠的语言（StreamLanguage：SV/Shell/Tcl）：关键字对/缩进折叠
 * - JSON：对象/数组已有内置（lang-json ArrayExpression/ObjectExpression foldInside）
 * - 未知/纯文本：仅缩进折叠（VSCode 默认行为）
 */
const STRATEGIES: Record<string, FoldStrategy[]> = {
  // JS/TS/JSX：块注释已有内置（BlockComment foldNodeProp），补 region/import/export
  javascript: [foldRegionMarker, foldJsGroup, foldImportGroupCurly],
  typescript: [foldRegionMarker, foldJsGroup, foldImportGroupCurly],
  // CPP：块注释/花括号已有内置（lang-cpp foldNodeProp），补 region
  cpp: [foldRegionMarker],
  // JSON：数组/对象已有内置，无其它策略
  json: [],
  // CSS/SCSS/LESS：块注释缺失（lang-css 无 BlockComment foldNodeProp），补注释
  css: [foldRegionMarker, foldBlockComment],
  // HTML：Element 已有内置，补块注释与 #region（<!--#region-->）
  html: [foldRegionMarker, foldBlockComment],
  // Python：文档字符串/函数已有内置，补连续 import 组
  python: [foldRegionMarker, foldPythonImportGroup],
  // Shell/Tcl：StreamLanguage 完全无折叠，补缩进回退 + region
  shell: [foldRegionMarker, foldIndentRange],
  tcl: [foldRegionMarker, foldIndentRange],
  // SystemVerilog/Verilog：StreamLanguage 语法树扁平，关键字对折叠 + region + 注释 + 缩进
  verilog: [foldSvKeywordBlock, foldRegionMarker, foldBlockComment, foldIndentRange],
  // Markdown：标题折叠已有内置（lang-markdown foldService），无补充
  markdown: [],
  // YAML：键下子节点已有内置（lang-yaml foldNodeProp），无补充
  yaml: [],
  // 无语言（纯文本）及其它：仅缩进折叠
  plaintext: [foldIndentRange],
};

/** 未知语言回落策略（与 plaintext 一致） */
const DEFAULT_STRATEGIES: FoldStrategy[] = [foldIndentRange];

/** JS/TS import/export 组判定（首词是 import/export 即视为组内语句） */
function foldImportGroupCurly(state: EditorState, lineStart: number, lineEnd: number) {
  return foldImportGroup(state, lineStart, lineEnd, (text) => GROUP_STATEMENT_RE.test(text));
}

/** Python import 组判定 */
function foldPythonImportGroup(state: EditorState, lineStart: number, lineEnd: number) {
  return foldImportGroup(state, lineStart, lineEnd, isPythonImportLine);
}

/**
 * 为指定语言 id 创建折叠扩展。
 * languageId 来自 FileEditor 的语言映射；未知语言回落到缩进折叠（VSCode 默认）。
 *
 * 注意：foldService 对 gutter 可见的每行都调用，实现必须为纯文档查询
 * （无副作用、无 DOM）。单行起点向后扫描为线性复杂度，与 CodeMirror
 * 内建 syntaxFolding 相当；深嵌套的 SV 关键字配对也只是 O(行数)。
 */
export function createFoldStrategiesExtension(languageId: string) {
  const strategies = STRATEGIES[languageId] ?? DEFAULT_STRATEGIES;
  return foldService.of((state, lineStart, lineEnd) => {
    for (const strategy of strategies) {
      const result = strategy(state, lineStart, lineEnd);
      if (result && result.from < result.to) return result;
    }
    return null; // 回退到语法树 foldNodeProp
  });
}

// ── 导出用于测试 ──────────────────────────────────────────────
export {
  foldBlockComment,
  foldRegionMarker,
  foldIndentRange,
  foldSvKeywordBlock,
  foldJsGroup,
  type FoldStrategy,
  SV_BLOCK_PAIRS,
};
