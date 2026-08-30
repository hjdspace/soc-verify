import { cloneElement, isValidElement, memo, useEffect, useState, useMemo, type ComponentProps, type ReactNode } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import hljs from 'highlight.js';
import { trpc } from '@renderer/lib/trpc';
import { MermaidDiagram } from './MermaidDiagram';
import { openReviewAwareFile } from '@renderer/stores/diff-review';

interface MarkdownRendererProps {
  content: string;
  onUriClick?: (uri: string) => void;
  /**
   * 流式渲染中：对最后一个块级元素的末尾文本应用「模糊尾缘」并内联渲染实心光标
   * （效果参考 beautiful-ui 的 StreamText：写入中的字符从 blur 中凝聚成形，
   * 光标紧贴最后一个字符而不是独立成行）。
   */
  streaming?: boolean;
}

type MarkdownComponents = NonNullable<ComponentProps<typeof ReactMarkdown>['components']>;

/**
 * Maps markdown code-fence language labels to highlight.js language names.
 * Covers SystemVerilog, Verilog, and common languages used in SoC verification.
 */
const LANG_ALIAS_MAP: Record<string, string> = {
  // SystemVerilog / Verilog
  sv: 'sv',
  svh: 'sv',
  systemverilog: 'sv',
  v: 'verilog',
  vh: 'verilog',
  verilog: 'verilog',
  // Web
  js: 'javascript',
  jsx: 'javascript',
  mjs: 'javascript',
  cjs: 'javascript',
  ts: 'typescript',
  tsx: 'typescript',
  html: 'xml',
  htm: 'xml',
  vue: 'xml',
  xml: 'xml',
  css: 'css',
  scss: 'scss',
  less: 'less',
  // Systems
  c: 'c',
  h: 'c',
  cpp: 'cpp',
  cc: 'cpp',
  cxx: 'cpp',
  hpp: 'cpp',
  hxx: 'cpp',
  rust: 'rust',
  rs: 'rust',
  go: 'go',
  java: 'java',
  // Scripting
  py: 'python',
  pyw: 'python',
  python: 'python',
  sh: 'bash',
  bash: 'bash',
  zsh: 'bash',
  shell: 'bash',
  tcl: 'tcl',
  rb: 'ruby',
  ruby: 'ruby',
  php: 'php',
  // Data
  json: 'json',
  yaml: 'yaml',
  yml: 'yaml',
  toml: 'ini',
  ini: 'ini',
  sql: 'sql',
  // Docs
  md: 'markdown',
  markdown: 'markdown',
  diff: 'diff',
};

/**
 * Resolves a code-fence language label to a highlight.js language name.
 * Returns '' if no matching language is found.
 */
function resolveHljsLanguage(lang: string): string {
  if (!lang) return '';
  const lower = lang.toLowerCase();
  const mapped = LANG_ALIAS_MAP[lower];
  if (mapped && hljs.getLanguage(mapped)) return mapped;
  // Pass through if hljs knows it directly (e.g. 'python', 'javascript')
  if (hljs.getLanguage(lower)) return lower;
  return '';
}

/**
 * Highlight code using highlight.js and return HTML string.
 * Falls back to auto-detection when language is unknown.
 */
function highlightCode(code: string, language: string): string {
  try {
    const lang = resolveHljsLanguage(language);
    if (lang) {
      return hljs.highlight(code, { language: lang }).value;
    }
    // Auto-detect — but only when content looks like code (has multiple lines)
    if (code.split('\n').length > 1) {
      return hljs.highlightAuto(code).value;
    }
    return escapeHtml(code);
  } catch {
    return escapeHtml(code);
  }
}

function escapeHtml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

// ── Relative path + line number linkifier ───────────────────────────

/**
 * Recognized source file extensions.
 *
 * Extension matching uses `lastIndexOf('.')` + `slice()` to extract the
 * *complete* final extension segment (e.g. `html` from `foo.html`), so
 * shorter extensions like `h` never "shadow" longer ones like `html`.
 * The regex `\.\w+` is also greedy, matching as many word characters as
 * possible, so `.html` is matched as a whole, not truncated to `.h`.
 *
 * The file-path detection regex matches patterns like:
 *   src/module.sv:42
 *   tests/tb_top.v:100-105
 *   foo/bar.py:42
 *   ./include/header.vh:15
 *   rtl/dsp_unit.sv
 *
 * Constraints to avoid false positives:
 * - Path must contain at least one `/` OR a known code extension
 * - Extension must be a recognized source file extension
 * - No leading `http`, `https`, or URL scheme
 * - Not preceded by `:` (to avoid matching inside URLs)
 */
const SOURCE_FILE_EXTENSIONS = new Set([
  // SoC verification HDL
  'systemverilog', 'verilog', 'vhdl',
  'sv', 'svh', 'v', 'vh', 'vhd',
  'sdc', 'xdc', 'do',
  // Web
  'html', 'htm', 'vue', 'xml',
  'css', 'scss', 'less',
  'js', 'jsx', 'mjs', 'cjs', 'ts', 'tsx',
  // Systems
  'cpp', 'cxx', 'hpp', 'hxx',
  'cc', 'java', 'rust',
  'rs', 'go',
  'c', 'h',
  // Scripting
  'python', 'bash', 'zsh', 'shell', 'ruby',
  'py', 'pyw', 'sh', 'tcl', 'rb', 'php',
  // Data
  'json', 'yaml', 'yml', 'toml', 'ini',
  'sql', 'diff',
  // Docs
  'markdown',
  'md',
  // Fortran / Build
  'makefile', 'cmake',
  'f', 'f90', 'f95',
  'mk', 'txt',
]);

/**
 * Known code file extensions for bare-file detection (no directory separator).
 * Subset of SOURCE_FILE_EXTENSIONS that are common in SoC verification.
 */
const BARE_FILE_EXTENSIONS = new Set([
  'systemverilog', 'verilog',
  'markdown', 'makefile',
  'python', 'javascript',
  'svh', 'cpp', 'hpp', 'hxx', 'cxx',
  'json', 'yaml',
  'java', 'rust',
  'sv', 'vh',
  'py', 'js', 'ts',
  'go', 'rs',
  'c', 'h',
  'md',
  'yml',
]);

/**
 * Check if a string looks like a project-relative file path with optional line number.
 * Returns the parsed { path, line, endLine } or null.
 */
type ParsedFileRef = { path: string; line?: number; endLine?: number };

function parseFileRef(text: string): ParsedFileRef | null {
  // Must not be a URL scheme
  if (/^[a-z]+:\/\//i.test(text)) return null;
  // Must not start with @ (mention) or # (anchor)
  if (text.startsWith('@') || text.startsWith('#')) return null;

  // Split path and line part: `path:line` or `path:line-endLine`
  // Also handle `path:line` where path contains dots (e.g. `foo.sv:42`)
  const match = text.match(/^(.+?)(?::(\d+)(?:-(\d+))?)?$/);
  if (!match) return null;

  const [, rawPath, lineStr, endLineStr] = match;
  if (!rawPath) return null;

  // Normalize path separators
  const normalizedPath = rawPath.replace(/\\/g, '/').replace(/^\.\//, '');

  // Must have a file extension
  const lastDot = normalizedPath.lastIndexOf('.');
  if (lastDot === -1) return null;
  const ext = normalizedPath.slice(lastDot + 1).toLowerCase();
  if (!ext || !/^[a-z0-9]+$/.test(ext)) return null;

  // Must be a recognized source extension, OR path contains a directory separator
  const hasDirSeparator = normalizedPath.includes('/');
  if (!SOURCE_FILE_EXTENSIONS.has(ext) && !BARE_FILE_EXTENSIONS.has(ext)) {
    // Not a recognized extension — only accept if it has a directory separator
    // and the extension looks like a code file (at least 2 chars)
    if (!hasDirSeparator || ext.length < 2) return null;
    // 所有段都以大写字母开头的是名称罗列（如 Tavily/Exa/Firecrawl/Z.AI），不是项目内路径
    if (normalizedPath.split('/').every((seg) => /^[A-Z]/.test(seg))) return null;
  }

  // If it's just a bare filename without directory separator,
  // require a line number to avoid turning every word that looks like a filename into a link
  if (!hasDirSeparator && !lineStr) return null;

  // Reject if path starts with a dot (hidden files like .gitignore) or is too short
  if (normalizedPath.startsWith('.') && !normalizedPath.startsWith('./')) return null;
  if (normalizedPath.length < 3) return null;

  // Reject paths that look like they have spaces (not valid file paths)
  if (normalizedPath.includes(' ')) return null;

  return {
    path: normalizedPath,
    line: lineStr ? parseInt(lineStr, 10) : undefined,
    endLine: endLineStr ? parseInt(endLineStr, 10) : undefined,
  };
}

/**
 * Split text into segments: plain text and file references (as clickable elements).
 * Uses a regex to find potential file-path:line patterns, then validates each
 * match with parseFileRef.
 */
type TextSegment =
  | { type: 'text'; content: string }
  | { type: 'fileRef'; path: string; line?: number; endLine?: number; display: string };

// Tokenize text looking for file path patterns.
// Pattern: optional `./` or `../` prefix, then path segments with /, ending in .ext, optionally :line or :line-line
const FILE_REF_RE = /(?:\.?\/)?(?:[\w.-]+(?:\/[\w.-]+)*\.\w+(?::\d+(?:-\d+)?)?)/g;

function tokenizeFileRefs(text: string): TextSegment[] {
  const segments: TextSegment[] = [];
  let lastIndex = 0;

  FILE_REF_RE.lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = FILE_REF_RE.exec(text)) !== null) {
    const candidate = match[0];
    const start = match.index;

    // Skip if preceded by a word character or ':' (likely part of a URL or identifier)
    if (start > 0) {
      const prevChar = text[start - 1];
      // Allow if preceded by whitespace, opening bracket, quote, backtick, or start of string
      if (/[\w:@#/.]/.test(prevChar) && prevChar !== '/' && prevChar !== '.') {
        continue;
      }
      // Specifically reject if preceded by :// (URL)
      if (start >= 2 && text[start - 2] === ':' && text[start - 1] === '/' && text[start] === '/') {
        continue;
      }
    }

    const parsed = parseFileRef(candidate);
    if (!parsed) continue;

    // Push preceding text
    if (start > lastIndex) {
      segments.push({ type: 'text', content: text.slice(lastIndex, start) });
    }

    segments.push({
      type: 'fileRef',
      path: parsed.path,
      line: parsed.line,
      endLine: parsed.endLine,
      display: candidate,
    });
    lastIndex = start + candidate.length;
  }

  // Push remaining text
  if (lastIndex < text.length) {
    segments.push({ type: 'text', content: text.slice(lastIndex) });
  }

  return segments;
}

// ── 消息引用提取（回合收尾"引用来源"列表用）─────────────────────────

export type MessageReference =
  | { kind: 'file'; display: string; path: string; line?: number; endLine?: number }
  | { kind: 'uri'; display: string; uri: string };

// case:/// log:/// cov:/// host URI——遇空白/CJK 标点/右括号终止
const HOST_URI_RE = /\b(?:case|log|cov):\/\/[^\s)\]}，。；、]+/g;

/**
 * Extract the "sources" referenced by an assistant message: host URIs
 * (case:/// log:/// cov:///) and project file references (path/file.sv:42).
 * Uses the same file-ref recognition as inline rendering (tokenizeFileRefs),
 * deduplicated in order of first appearance.
 */
export function extractMessageReferences(content: string): MessageReference[] {
  type Positioned = { start: number; key: string; ref: MessageReference };
  const items: Positioned[] = [];

  // 收集 host URI 及其位置
  HOST_URI_RE.lastIndex = 0;
  const uriSpans: Array<[number, number]> = [];
  let match: RegExpExecArray | null;
  while ((match = HOST_URI_RE.exec(content)) !== null) {
    const uri = match[0];
    uriSpans.push([match.index, match.index + uri.length]);
    items.push({ start: match.index, key: uri, ref: { kind: 'uri', display: uri.replace(/^[a-z]+:\/\//, ''), uri } });
  }

  // 文件引用：复用与正文渲染一致的识别规则；位置通过顺序 indexOf 恢复，
  // 落在 URI span 内的（如 case:///run/123/main.log 的 run/123/main.log）跳过
  let cursor = 0;
  for (const seg of tokenizeFileRefs(content)) {
    if (seg.type !== 'fileRef') continue;
    const at = content.indexOf(seg.display, cursor);
    if (at === -1) continue;
    cursor = at + seg.display.length;
    const end = at + seg.display.length;
    if (uriSpans.some(([s, e]) => at < e && end > s)) continue;
    items.push({
      start: at,
      key: `file:${seg.path}:${seg.line ?? ''}:${seg.endLine ?? ''}`,
      ref: { kind: 'file', display: seg.display, path: seg.path, line: seg.line, endLine: seg.endLine },
    });
  }

  items.sort((a, b) => a.start - b.start);
  const refs: MessageReference[] = [];
  const seen = new Set<string>();
  for (const item of items) {
    if (seen.has(item.key)) continue;
    seen.add(item.key);
    refs.push(item.ref);
  }
  return refs;
}

/**
 * Renders text that may contain project-relative file paths as clickable links.
 * Clicking opens the file in the center editor panel, optionally at a specific line.
 */
function FileRefText({ text }: { text: string }) {
  const segments = useMemo(() => tokenizeFileRefs(text), [text]);

  if (segments.length === 1 && segments[0].type === 'text') {
    return <>{text}</>;
  }

  const handleClick = (path: string, line?: number) => {
    const fileName = path.split('/').pop() ?? path;
    openReviewAwareFile(path, fileName);
    // Note: line navigation is handled by the FileEditor via a future enhancement.
    // For now we open the file; the user can navigate to the line manually.
    // The line number is stored for potential future use.
    void line;
  };

  return (
    <>
      {segments.map((seg, idx) => {
        if (seg.type === 'text') {
          return <span key={idx}>{seg.content}</span>;
        }
        return (
          <button
            key={idx}
            onClick={() => handleClick(seg.path, seg.line)}
            className="ap-chip font-mono"
            title={`点击打开: ${seg.path}${seg.line ? `:${seg.line}` : ''}`}
          >
            {seg.display}
          </button>
        );
      })}
    </>
  );
}

// ── Tree-view detection ──────────────────────────────────────────────
//
// When the AI outputs a directory-tree or ASCII-art structure without
// wrapping it in a code fence, the Markdown parser renders it as a normal
// paragraph.  Browsers collapse whitespace inside <p>, so box-drawing
// characters (├ │ └ ─) lose their alignment.
//
// We detect paragraphs that look like tree views (contain box-drawing
// characters) and render them as <pre> blocks with a monospace font so
// the alignment is preserved.
//
// IMPORTANT: The AI sometimes generates tree-view text WITHOUT newlines
// (all on one line, separated by spaces).  In that case we reconstruct
// line breaks before each box-drawing branch character (├, └, ┌) so the
// tree structure is visible.

const BOX_DRAWING_RE = /[\u2500-\u257F]/;

/**
 * Check if a string looks like an ASCII tree-view that should be rendered
 * in a <pre> block.  Returns true when the text contains box-drawing
 * characters (├ │ └ ─ ┌ ┐ ┘ └ etc.).
 */
function isTreeViewText(text: string): boolean {
  return BOX_DRAWING_RE.test(text);
}

/**
 * Reconstruct line breaks for tree-view text that has been flattened to
 * a single line (no \n separators).  When the text already contains \n
 * it is returned unchanged.
 *
 * In a properly-formatted tree, every line after the first starts with
 * box-drawing characters (├ └ ┌ │).  When the text is flattened to one
 * line, these characters are preceded by spaces from the previous
 * line's trailing whitespace.
 *
 * We split on "space(s) + box-drawing char" boundaries, then reassemble
 * lines: a standalone "│" is a vertical connector that belongs to the
 * indentation of the next content line.  We accumulate consecutive
 * "│" connectors and prepend them to the next content line.
 */
function reconstructTreeLines(text: string): string {
  // If the text already has newlines, leave it alone
  if (text.includes('\n')) return text;

  // Split before any box-drawing character preceded by spaces
  const lines = text.replace(/ +(?=[├└┌┐┘│])/g, '\n').split('\n');

  // Reassemble: collect consecutive "│"-only lines as indentation prefix
  const merged: string[] = [];
  let connectorPrefix = '';

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const trimmed = line.trim();

    if (trimmed === '│') {
      // This is a vertical connector — accumulate it
      connectorPrefix += '│ ';
    } else {
      // Content line — prepend accumulated connectors
      if (connectorPrefix) {
        merged.push(connectorPrefix + line);
        connectorPrefix = '';
      } else {
        merged.push(line);
      }
    }
  }

  // If there are trailing connectors (shouldn't happen in valid trees),
  // append them as-is
  if (connectorPrefix) {
    merged.push(connectorPrefix.trimEnd());
  }

  return merged.join('\n');
}

/**
 * Extract the raw text content from React children (which may be a mix of
 * strings, arrays, and elements).  Used for tree-view detection.
 */
function extractText(children: ReactNode): string {
  if (typeof children === 'string') return children;
  if (typeof children === 'number') return String(children);
  if (Array.isArray(children)) {
    return children.map(extractText).join('');
  }
  if (children && typeof children === 'object' && 'props' in children) {
    const props = (children as { props?: { children?: ReactNode } }).props;
    if (props?.children) return extractText(props.children);
  }
  return '';
}

// ── 流式尾缘（参考 beautiful-ui StreamText）─────────────────────────

/**
 * 流式尾缘覆盖的字符数：末尾 N 个字符以 blur + 渐变 mask 呈现，
 * 随下一次快照更新逐渐「凝聚成形」，模拟真实 token 流的 leading-edge 视觉。
 */
const STREAM_TAIL_CHARS = 6;

type TailResult = { node: ReactNode; handled: boolean };

// ── 流式尾缘的块级仲裁（rehype 标记）────────────────────────────
//
// withTail 由各块级组件（p/li/h*/…）分别调用，hasStreamTail 守卫只能防
// 嵌套重复，防不住兄弟块级各自应用——若不仲裁，每个块的末尾 6 个字符都会
// 被打上尾缘且该块内容不再变化，导致整条消息出现多处永久模糊字与多个光标。
// 因此流式解析时用 rehype 插件在 hast 树上找到**全文最后一个非空白文本
// 节点**，并给它所在的祖先链打 dataStreamTail 标记；withTail 只在带标记
// 的组件上应用尾缘。这样全文最多一个尾缘 + 一个光标，且始终位于正在
// 增长的最后一个块上；已完成的块自然保持清晰。

type HastNode = {
  type: string;
  value?: string | undefined;
  children?: HastNode[] | undefined;
  properties?: Record<string, unknown> | undefined;
};

const STREAM_TAIL_MARK = 'dataStreamTail';

/**
 * 返回 node 内最后一个非空白文本节点的祖先链（不含 node 自身为 root 的
 * 情形：链从 node 的子孙元素开始）。找不到返回 null。
 */
function findLastTextChain(node: HastNode): HastNode[] | null {
  if (node.type === 'text') {
    return (node.value ?? '').trim().length > 0 ? [] : null;
  }
  if (node.type !== 'element' && node.type !== 'root') return null;
  const children = node.children ?? [];
  for (let i = children.length - 1; i >= 0; i--) {
    const chain = findLastTextChain(children[i]);
    if (chain) return node.type === 'root' ? chain : [node, ...chain];
  }
  return null;
}

/** rehype 插件：给最后一个文本节点的祖先链打 STREAM_TAIL_MARK。 */
function rehypeMarkStreamTail() {
  return (tree: HastNode): void => {
    const children = tree.children ?? [];
    for (let i = children.length - 1; i >= 0; i--) {
      const chain = findLastTextChain(children[i]);
      if (chain) {
        for (const el of chain) {
          el.properties = { ...el.properties, [STREAM_TAIL_MARK]: 'true' };
        }
        return;
      }
    }
  };
}

const REHYPE_STREAM_TAIL = [rehypeMarkStreamTail];

function isTailMarked(node: unknown): boolean {
  const props = (node as { properties?: Record<string, unknown> } | null | undefined)?.properties;
  return props?.[STREAM_TAIL_MARK] === 'true';
}

/**
 * 判断 children 树中是否已包含流式尾缘/光标标记。
 * 用于保证嵌套块级元素（如列表嵌套列表）重复调用 applyStreamTail 时只应用一次。
 */
function hasStreamTail(node: ReactNode): boolean {
  if (Array.isArray(node)) return node.some(hasStreamTail);
  if (node && typeof node === 'object' && 'props' in node) {
    const props = (node as { props?: { className?: string; children?: ReactNode } }).props;
    if (props?.className === 'ap-stream-tail' || props?.className === 'ap-cursor') {
      return true;
    }
    return hasStreamTail(props?.children);
  }
  return false;
}

/**
 * 在 React children 树中找到**最后一个文本叶子**，把其末尾 STREAM_TAIL_CHARS
 * 个字符切分为 `.ap-stream-tail`（模糊尾缘），并在其后追加行内实心光标。
 *
 * 切分产物为平铺数组 [settled 字符串, tailSpan, caret]：settled 保持为普通
 * 字符串节点，下游的 FileRefTextWrapper 等照常处理（文件引用 chip 化、行内
 * code 等不受影响）。代码块结尾时无文本叶子可切（handled=false），该块无
 * 尾缘/光标，可接受——流式信号由内容增长本身承载。
 */
function applyStreamTail(children: ReactNode, caret: boolean): TailResult {
  if (typeof children === 'string') {
    // 纯空白文本节点（react-markdown 在块级子元素间插入的 "\n"）不是可见
    // 文本叶子——跳过并继续向前找，否则会在空白上切分出多余的光标
    if (children.trim().length === 0) return { node: children, handled: false };
    const cut = Math.max(0, children.length - STREAM_TAIL_CHARS);
    return {
      node: [
        children.slice(0, cut),
        <span key="ap-tail" className="ap-stream-tail">{children.slice(cut)}</span>,
        ...(caret ? [<span key="ap-caret" aria-hidden className="ap-cursor" />] : []),
      ],
      handled: true,
    };
  }
  if (Array.isArray(children)) {
    for (let i = children.length - 1; i >= 0; i--) {
      const result = applyStreamTail(children[i], caret);
      if (result.handled) {
        const next = children.slice();
        next[i] = result.node;
        return { node: next, handled: true };
      }
    }
    return { node: children, handled: false };
  }
  if (isValidElement(children)) {
    const props = children.props as { children?: ReactNode } | undefined;
    if (props?.children !== undefined) {
      const result = applyStreamTail(props.children, caret);
      if (result.handled) {
        return { node: cloneElement(children, undefined, result.node), handled: true };
      }
    }
  }
  return { node: children, handled: false };
}

// ── MarkdownRenderer ─────────────────────────────────────────────────

/**
 * Renders markdown content with GitHub-flavored markdown support.
 * Handles case:///, log:///, cov:/// URIs as clickable links.
 * Provides syntax highlighting for code blocks and clickable file paths.
 * 流式渲染时（streaming）在末尾文本上应用模糊尾缘与行内光标。
 */
export const MarkdownRenderer = memo(function MarkdownRenderer({
  content,
  onUriClick,
  streaming = false,
}: MarkdownRendererProps) {
  // 排版细节（字号/间距/颜色）由 ai-panel.css 的 .ai-panel .markdown-body 规则承载；
  // 此处只保留结构与交互行为（树视图检测、URI 白名单、高亮代码块、流式尾缘）。
  const components = useMemo<MarkdownComponents>(() => {
    // hasStreamTail 守卫保证嵌套块级（li 套 li / li 套 p）只应用一次尾缘；
    // isTailMarked 保证只有全文最后一个文本块应用（兄弟块级不各自为政）
    const withTail = (node: unknown, children: ReactNode): ReactNode => {
      if (!streaming || !isTailMarked(node) || hasStreamTail(children)) return children;
      return applyStreamTail(children, true).node;
    };
    const headingWithTail = (Tag: 'h1' | 'h2' | 'h3' | 'h4' | 'h5' | 'h6') =>
      function HeadingWithTail({ children, node }: { children?: ReactNode; node?: unknown }) {
        return <Tag>{withTail(node, children)}</Tag>;
      };
    return {
      a: ({ href, children }) => {
        if (!href) return <span>{children}</span>;
        const isHostUri = href.startsWith('case:///') || href.startsWith('log:///') || href.startsWith('cov:///');
        if (isHostUri) {
          return (
            <button
              onClick={() => onUriClick?.(href)}
              className="ap-chip"
            >
              {children}
            </button>
          );
        }
        return (
          <a
            href={href}
            onClick={(e) => {
              e.preventDefault();
              void trpc.system.openExternal.mutate(href);
            }}
          >
            {children}
          </a>
        );
      },
      code: ({ className, children }) => {
        // react-markdown v9+ 移除了 inline prop，无法直接区分行内/块级代码。
        // 无语言标记的 fenced code block（如 LLM 输出的目录树）同样没有
        // className，但其内容包含换行——CommonMark 规定 inline code span
        // 内的换行会被规范化为空格，据此区分是安全的。
        const text = extractText(children);
        const isInline = !className && !text.includes('\n');
        if (isInline) {
          return <code className="ap-icode">{children}</code>;
        }
        const lang = className?.replace('language-', '') ?? '';
        if (lang === 'mermaid') {
          return <MermaidDiagram code={text.trim()} />;
        }
        return <CodeBlock language={lang} streaming={streaming}>{text}</CodeBlock>;
      },
      pre: ({ children }) => <>{children}</>,
      table: ({ children }) => (
        <div className="ap-tblwrap">
          <table>{children}</table>
        </div>
      ),
      ul: ({ children }) => <ul>{children}</ul>,
      ol: ({ children }) => <ol>{children}</ol>,
      li: ({ children, node }) => <li>{withTail(node, children)}</li>,
      h1: headingWithTail('h1'),
      h2: headingWithTail('h2'),
      h3: headingWithTail('h3'),
      h4: headingWithTail('h4'),
      h5: headingWithTail('h5'),
      h6: headingWithTail('h6'),
      p: ({ children, node }) => {
        // Detect tree-view / ASCII-art paragraphs and render as <pre>
        // to preserve whitespace alignment.
        const rawText = extractText(children);
        if (isTreeViewText(rawText)) {
          const treeText = reconstructTreeLines(rawText);
          return (
            <pre className="ap-treeview">
              <code>{withTail(node, treeText)}</code>
            </pre>
          );
        }
        return <p><FileRefTextWrapper>{withTail(node, children)}</FileRefTextWrapper></p>;
      },
    };
  }, [onUriClick, streaming]);

  return (
    <div className="markdown-body">
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        rehypePlugins={streaming ? REHYPE_STREAM_TAIL : []}
        components={components}
      >
        {content}
      </ReactMarkdown>
    </div>
  );
});

// ── Code block with syntax highlighting + copy button ─────────────────────────

/**
 * 流式期间代码着色的补算间隔。流式快照约 50ms 一次，若每次快照都对整个
 * 增长中的代码块重新 highlight，累计成本 O(n²)（未知语言还会触发
 * highlightAuto 全语言探测，实测 22ms/快照、峰值 256ms，把主线程打成卡顿，
 * 模糊尾缘因提交变慢而长时间停留在模糊态）。流式期间文本实时渲染、着色
 * 至多每 300ms 追赶一次；落定后一次性同步全量高亮。
 */
const STREAM_HIGHLIGHT_INTERVAL_MS = 300;

/**
 * 流式期间的代码高亮：文本实时、着色延迟节流。
 *
 * - 返回值永远对应当前 codeText：着色未追上时退化为转义纯文本，保证
 *   流式增长的内容不被延迟显示（只是暂无颜色）
 * - 已知语言至多每 STREAM_HIGHLIGHT_INTERVAL_MS 重高亮一次
 * - 未知语言流式期间完全跳过（highlightAuto 极贵，目录树/日志类内容
 *   本就几乎无着色收益）；落定后的渲染不走此 hook，仍做一次自动检测
 */
function useDeferredCodeHighlight(codeText: string, language: string, streaming: boolean): string {
  const [deferred, setDeferred] = useState<{ text: string; html: string } | null>(null);

  useEffect(() => {
    if (!streaming || !resolveHljsLanguage(language)) return undefined;
    let cancelled = false;
    const timer = setTimeout(() => {
      if (!cancelled) setDeferred({ text: codeText, html: highlightCode(codeText, language) });
    }, STREAM_HIGHLIGHT_INTERVAL_MS);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [streaming, codeText, language]);

  if (!streaming) return '';
  return deferred && deferred.text === codeText ? deferred.html : escapeHtml(codeText);
}

function CodeBlock({
  language,
  children,
  streaming = false,
}: {
  language: string;
  children: ReactNode;
  streaming?: boolean;
}) {
  const [copied, setCopied] = useState(false);
  const codeText = String(children);

  // 落定态高亮：streaming 变 false 时同步执行一次（含未知语言自动检测）
  const settledHtml = useMemo(
    () => (streaming ? '' : highlightCode(codeText, language)),
    [streaming, codeText, language],
  );
  const streamHtml = useDeferredCodeHighlight(codeText, language, streaming);
  const highlightedHtml = streaming ? streamHtml : settledHtml;

  const handleCopy = () => {
    void navigator.clipboard.writeText(codeText).then(() => {
      setCopied(true);
      // DSH 规范：复制反馈 1000ms 后复原
      setTimeout(() => setCopied(false), 1000);
    });
  };

  // Display a friendly label for the language
  const langLabel = language
    ? LANG_ALIAS_MAP[language.toLowerCase()] ?? language
    : 'code';

  return (
    <div className="my-2.5 overflow-hidden rounded-[10px] border border-[var(--dsw-border-l1)] bg-[var(--dsw-code-block)]">
      <div className="ap-banner">
        <span className="truncate">{langLabel}</span>
        <button onClick={handleCopy} className="ap-copybtn">
          {copied ? '已复制' : '复制'}
        </button>
      </div>
      {/* DSH：围栏代码折行（pre-wrap + break-all），与工具卡横滚相反 */}
      <pre
        className="overflow-x-auto p-2.5 font-mono text-[11px] leading-[17px] text-[var(--dsw-label-primary)]"
        style={{ whiteSpace: 'pre-wrap', wordBreak: 'break-all' }}
      >
        <code className="hljs" dangerouslySetInnerHTML={{ __html: highlightedHtml }} />
      </pre>
    </div>
  );
}

// ── FileRefTextWrapper ──────────────────────────────────────────────

/**
 * Wraps React children that may contain text nodes with file-reference linkification.
 * ReactMarkdown passes children as React nodes (mix of strings, elements, arrays).
 * We extract text content from string children and replace them with FileRefText,
 * while passing through non-string children unchanged.
 */
function FileRefTextWrapper({ children }: { children: ReactNode }) {
  // If children is a plain string, process it directly
  if (typeof children === 'string') {
    return <FileRefText text={children} />;
  }

  // If children is an array, process each string element individually
  if (Array.isArray(children)) {
    return (
      <>
        {children.map((child, idx) => {
          if (typeof child === 'string') {
            return <FileRefText key={idx} text={child} />;
          }
          return <span key={idx}>{child}</span>;
        })}
      </>
    );
  }

  // Non-string children (e.g., <strong>, <em>) — pass through
  return <>{children}</>;
}
