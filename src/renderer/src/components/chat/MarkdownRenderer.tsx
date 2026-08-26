import { memo, useState, useMemo, type ComponentProps, type ReactNode } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import hljs from 'highlight.js';
import { trpc } from '@renderer/lib/trpc';
import { MermaidDiagram } from './MermaidDiagram';
import { openReviewAwareFile } from '@renderer/stores/diff-review';

interface MarkdownRendererProps {
  content: string;
  onUriClick?: (uri: string) => void;
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

// ── MarkdownRenderer ─────────────────────────────────────────────────

/**
 * Renders markdown content with GitHub-flavored markdown support.
 * Handles case:///, log:///, cov:/// URIs as clickable links.
 * Provides syntax highlighting for code blocks and clickable file paths.
 */
export const MarkdownRenderer = memo(function MarkdownRenderer({ content, onUriClick }: MarkdownRendererProps) {
  // 排版细节（字号/间距/颜色）由 ai-panel.css 的 .ai-panel .markdown-body 规则承载；
  // 此处只保留结构与交互行为（树视图检测、URI 白名单、高亮代码块）。
  const components = useMemo<MarkdownComponents>(() => ({
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
      return <CodeBlock language={lang}>{text}</CodeBlock>;
    },
    pre: ({ children }) => <>{children}</>,
    table: ({ children }) => (
      <div className="ap-tblwrap">
        <table>{children}</table>
      </div>
    ),
    ul: ({ children }) => <ul>{children}</ul>,
    ol: ({ children }) => <ol>{children}</ol>,
    p: ({ children }) => {
      // Detect tree-view / ASCII-art paragraphs and render as <pre>
      // to preserve whitespace alignment.
      const rawText = extractText(children);
      if (isTreeViewText(rawText)) {
        const treeText = reconstructTreeLines(rawText);
        return (
          <pre className="ap-treeview">
            <code>{treeText}</code>
          </pre>
        );
      }
      return <p><FileRefTextWrapper>{children}</FileRefTextWrapper></p>;
    },
  }), [onUriClick]);

  return (
    <div className="markdown-body">
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        components={components}
      >
        {content}
      </ReactMarkdown>
    </div>
  );
});

// ── Code block with syntax highlighting + copy button ─────────────────────────

function CodeBlock({ language, children }: { language: string; children: ReactNode }) {
  const [copied, setCopied] = useState(false);
  const codeText = String(children);

  const highlightedHtml = useMemo(
    () => highlightCode(codeText, language),
    [codeText, language],
  );

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
