import { useState, useEffect, useCallback, useMemo, useRef, type ReactNode } from 'react';
import { ZoomIn, ZoomOut, Expand } from 'lucide-react';
import CodeMirror from '@uiw/react-codemirror';
import { StreamLanguage } from '@codemirror/language';
import { EditorView, type ViewUpdate, keymap } from '@codemirror/view';
import { EditorSelection, type Extension } from '@codemirror/state';
import { javascript } from '@codemirror/lang-javascript';
import { python } from '@codemirror/lang-python';
import { cpp } from '@codemirror/lang-cpp';
import { json } from '@codemirror/lang-json';
import { markdown } from '@codemirror/lang-markdown';
import { yaml } from '@codemirror/lang-yaml';
import { html } from '@codemirror/lang-html';
import { css } from '@codemirror/lang-css';
import { verilog } from '@codemirror/legacy-modes/mode/verilog';
import { shell } from '@codemirror/legacy-modes/mode/shell';
import { tcl } from '@codemirror/legacy-modes/mode/tcl';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import rehypeRaw from 'rehype-raw';
import { Save, Eye, Pencil, Loader2, AlertCircle, ExternalLink, Check, X, ArrowRight, GitCompare } from 'lucide-react';
import { trpc } from '@renderer/lib/trpc';
import { useThemeStore } from '@renderer/stores/theme';
import { useWorkbenchStore, openFileTab } from '@renderer/stores/workbench';
import { useToastStore } from '@renderer/stores/toast';
import { useEditorStore } from '@renderer/stores/editor';
import { useDiffReviewStore, useReviewSnapshot, type ReviewEntry } from '@renderer/stores/diff-review';
import { useKbStore } from '@renderer/stores/kb';
import { isManagedWikiPath } from '@shared/kb-wiki-guard';
import type { FileDiffResult } from '@shared/types';
import { cn } from '@renderer/lib/utils';
import { createVimExtensions, resetVimMode } from './vim-extension';
import { createFoldGutterExtension } from './fold-gutter';
import { createFoldStrategiesExtension } from './fold-strategies';
import { VimStatusBar } from './VimStatusBar';
import { createSyntaxHighlightExtension } from './syntax-highlight';
import { createIndentGuidesExtension } from './indent-guides';
import { createInlineReviewExtension } from './inline-review';
import { linterExtension, pushDiagnostics, type EditorDiagnostic } from './linter-extension';
import { search, searchKeymap, openSearchPanel } from '@codemirror/search';
import { Breadcrumb } from './Breadcrumb';
import { EditorStatusBar, type CursorPosition } from './EditorStatusBar';
import { Minimap } from './Minimap';
import { MermaidDiagram } from '@renderer/components/chat/MermaidDiagram';
import { SelectionActionsHost } from '@renderer/components/chat/SelectionActionsHost';

// ── Markdown 预览辅助 ──────────────────────────────────────────

/**
 * Extract raw text content from React children (strings, arrays, elements).
 * Used to extract the source code from react-markdown's <code> children.
 */
function extractText(children: ReactNode): string {
  if (typeof children === 'string') return children;
  if (typeof children === 'number') return String(children);
  if (Array.isArray(children)) return children.map(extractText).join('');
  if (children && typeof children === 'object' && 'props' in children) {
    const props = (children as { props?: { children?: ReactNode } }).props;
    if (props?.children) return extractText(props.children);
  }
  return '';
}

// ── 语言扩展映射 ──────────────────────────────────────────────

/** 语言 id（供折叠策略选择；与 getLanguageExtension 的扩展映射一一对应） */
function getLanguageId(filename: string): string {
  const ext = filename.split('.').pop()?.toLowerCase() ?? '';
  switch (ext) {
    case 'js': case 'jsx': case 'mjs': case 'cjs':
      return 'javascript';
    case 'ts': case 'tsx':
      return 'typescript';
    case 'py': case 'pyw':
      return 'python';
    case 'c': case 'h':
    case 'cpp': case 'cc': case 'cxx': case 'hpp': case 'hxx':
      return 'cpp';
    case 'json':
      return 'json';
    case 'md': case 'markdown':
      return 'markdown';
    case 'yaml': case 'yml':
      return 'yaml';
    case 'html': case 'htm':
    case 'vue':
      return 'html';
    case 'css': case 'scss': case 'less':
      return 'css';
    case 'sv': case 'svh': case 'v': case 'vh':
      return 'verilog';
    case 'sh': case 'bash': case 'zsh':
      return 'shell';
    case 'tcl':
      return 'tcl';
    default:
      return 'plaintext';
  }
}

function getLanguageExtension(filename: string) {
  const ext = filename.split('.').pop()?.toLowerCase() ?? '';
  switch (ext) {
    case 'js': case 'jsx': case 'mjs': case 'cjs':
      return javascript({ jsx: true });
    case 'ts': case 'tsx':
      return javascript({ jsx: true, typescript: true });
    case 'py': case 'pyw':
      return python();
    case 'c': case 'h':
    case 'cpp': case 'cc': case 'cxx': case 'hpp': case 'hxx':
      return cpp();
    case 'json':
      return json();
    case 'md': case 'markdown':
      return markdown();
    case 'yaml': case 'yml':
      return yaml();
    case 'html': case 'htm':
      return html();
    case 'vue':
      return html({ matchClosingTags: true, selfClosingTags: true });
    case 'css': case 'scss': case 'less':
      return css();
    case 'sv': case 'svh': case 'v': case 'vh':
      return StreamLanguage.define(verilog);
    case 'sh': case 'bash': case 'zsh':
      return StreamLanguage.define(shell);
    case 'tcl':
      return StreamLanguage.define(tcl);
    default:
      return undefined;
  }
}

function isMarkdownFile(filename: string): boolean {
  const ext = filename.split('.').pop()?.toLowerCase() ?? '';
  return ext === 'md' || ext === 'markdown';
}

/** SystemVerilog / Verilog 文件检测（LSP + verible lint 触发条件） */
function isSystemVerilogFile(filename: string): boolean {
  const ext = filename.split('.').pop()?.toLowerCase() ?? '';
  return ext === 'sv' || ext === 'svh' || ext === 'v' || ext === 'vh';
}

/** 将本地文件路径转为 file:// URI（LSP textDocument URI 格式） */
function filePathToUri(filePath: string): string {
  // Windows: D:\path\to\file.sv → file:///D:/path/to/file.sv
  // Linux: /path/to/file.sv → file:///path/to/file.sv
  const normalized = filePath.replace(/\\/g, '/');
  // 不编码路径分隔符，只编码空格等特殊字符
  const encoded = normalized.replace(/ /g, '%20');
  return normalized.startsWith('/') ? `file://${encoded}` : `file:///${encoded}`;
}

function isHtmlFile(filename: string): boolean {
  const ext = filename.split('.').pop()?.toLowerCase() ?? '';
  return ext === 'html' || ext === 'htm';
}

/** 图片扩展名集合 */
const IMAGE_EXTENSIONS = new Set([
  'png', 'jpg', 'jpeg', 'gif', 'bmp', 'webp', 'ico', 'svg', 'avif', 'tiff', 'tif',
]);

function isImageFile(filename: string): boolean {
  const ext = filename.split('.').pop()?.toLowerCase() ?? '';
  return IMAGE_EXTENSIONS.has(ext);
}

/**
 * 将本地文件路径转换为 `local-resource://` URL，用于在渲染进程中安全加载本地资源。
 * 主进程通过 `protocol.handle` 注册的 handler 会读取对应文件并返回。
 *
 * 路径中的反斜杠统一转为正斜杠后再编码，避免 Chromium URL 规范化问题。
 * Windows 的 fs API 兼容正斜杠路径。
 */
function toLocalResourceUrl(filePath: string): string {
  const normalized = filePath.replace(/\\/g, '/');
  const encoded = encodeURIComponent(normalized);
  return `local-resource://app/${encoded}`;
}

/**
 * 将相对路径 href 解析为 `local-resource://` URL。
 * 用于 Markdown 预览中图片 src 的重写：将相对于 markdown 文件的路径
 * 解析为绝对路径后编码为 local-resource URL。
 * 外部链接（http/https/data）直接返回原值。
 */
function resolveImageSrc(baseFilePath: string, src: string | undefined): string | undefined {
  if (!src) return undefined;
  // 外部链接不重写
  if (/^(https?:|data:|blob:|local-resource:)/i.test(src)) return src;
  // 锚点链接不重写（图片一般不会有，但防御性处理）
  if (src.startsWith('#')) return src;
  // 去掉 anchor 和 query
  const cleanHref = src.split('#')[0].split('?')[0];
  // 解析为绝对路径
  const resolvedPath = resolveRelativePath(baseFilePath, cleanHref);
  return toLocalResourceUrl(resolvedPath);
}

// ── Markdown 预览链接处理 ─────────────────────────────────────

/** 判断 href 是否为外部链接（http、mailto、锚点等） */
function isExternalLink(href: string): boolean {
  if (!href) return true;
  return /^(https?:|mailto:|tel:|ftp:|file:|data:)/i.test(href) || href.startsWith('#');
}

/**
 * 将相对路径 href 解析为基于当前文件目录的绝对路径。
 * 处理 `./`、`../`、裸文件名等各种相对路径写法。
 * 同时兼容 `/` 和 `\` 作为分隔符。
 */
function resolveRelativePath(baseFilePath: string, href: string): string {
  // 去掉 anchor 和 query
  const cleanHref = href.split('#')[0].split('?')[0];

  // 确定基础目录（去掉文件名）
  const sep = baseFilePath.includes('\\') ? '\\' : '/';
  const parts = baseFilePath.split(/[/\\]/);
  parts.pop(); // 移除文件名，保留目录

  // 逐段处理 href
  for (const segment of cleanHref.split(/[/\\]/)) {
    if (segment === '.' || segment === '') continue;
    if (segment === '..') {
      parts.pop();
    } else {
      parts.push(segment);
    }
  }

  return parts.join(sep);
}

/** 从路径中提取文件名 */
function basename(filePath: string): string {
  const parts = filePath.split(/[/\\]/);
  return parts[parts.length - 1] || filePath;
}

// ── FileEditor 组件 ───────────────────────────────────────────

interface FileEditorProps {
  projectId: string;
  filePath: string;
  fileName: string;
  /** 打开后定位到的起始行（1-based），来自路径 `:line[-end]` 后缀 */
  line?: number;
  /** 定位区间的结束行（含）；缺省与 line 相同 */
  endLine?: number;
  /** 每次携带行号打开时递增，驱动同一区间重复定位（重复点击同一路径） */
  revealSeq?: number;
}

export function FileEditor({ projectId, filePath, fileName, line, endLine, revealSeq }: FileEditorProps) {
  const [content, setContent] = useState('');
  const [originalContent, setOriginalContent] = useState('');
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [previewMode, setPreviewMode] = useState(false);
  const [imgZoom, setImgZoom] = useState(1);
  const [imgDragging, setImgDragging] = useState(false);
  const imgScrollRef = useRef<HTMLDivElement>(null);
  const imgDragState = useRef({ startX: 0, startY: 0, scrollLeft: 0, scrollTop: 0 });
  const [cursorPos, setCursorPos] = useState<CursorPosition>({ line: 1, col: 1 });

  const currentTheme = useThemeStore((s) => s.currentTheme);
  const themes = useThemeStore((s) => s.themes);
  const themeMode = themes.find((t) => t.id === currentTheme)?.mode ?? 'dark';
  const openDestination = useWorkbenchStore((s) => s.open);
  const vimEnabled = useEditorStore((s) => s.vimEnabled);
  const minimapEnabled = useEditorStore((s) => s.minimapEnabled);

  // ── 内联 code review 状态（Cursor / VSCode 风格） ─────────────
  // 文件在审阅队列中时，编辑器叠加 diff 装饰并进入只读模式；
  // 无论从目录树、工具卡片还是浮动按钮打开，都走同一套内联审阅逻辑。
  // 通过 useReviewSnapshot 获取 per-file 审阅快照，不再直接访问 store 的内部 map。
  const reviewSnapshot = useReviewSnapshot(filePath);
  const { entry: reviewEntry, diff: reviewDiff, hunkStates: reviewStates, loading: reviewLoading, error: reviewError, active: reviewActive, contentVersion } = reviewSnapshot;

  // ── 受管 Wiki 页面只读（spec §2） ─────────────────────────────
  // 挂载 wiki 布局库时，其 wiki/** 与 schema/purpose 属受管范围：
  // 编辑器进入只读态，保存被拒（主进程写入口同样强制）。
  const kbMounted = useKbStore((s) => s.kbStatus?.mounted);
  const wikiReadOnly = useMemo(
    () => kbMounted?.format === 'wiki' && isManagedWikiPath(kbMounted.path, filePath),
    [kbMounted, filePath],
  );

  // EditorView ref，用于 Vim 扩展获取 CodeMirror 实例
  const editorViewRef = useRef<import('@codemirror/view').EditorView | null>(null);

  const isMd = isMarkdownFile(fileName);
  const isHtml = isHtmlFile(fileName);
  const isImage = isImageFile(fileName);
  const isSv = isSystemVerilogFile(fileName);
  const fileUri = useMemo(() => filePathToUri(filePath), [filePath]);

  // ── LSP + verible lint 诊断合并 ──────────────────────────────
  // 两个来源的 diagnostic 按 source 区分（slang / verible），
  // 合并后一起 push 到 CodeMirror（spec 决策 28：互补不冗余）
  const lspDiagnosticsRef = useRef<EditorDiagnostic[]>([]);
  const veribleDiagnosticsRef = useRef<EditorDiagnostic[]>([]);
  const docVersionRef = useRef(0);
  const imageUrl = useMemo(() => (isImage ? toLocalResourceUrl(filePath) : ''), [isImage, filePath]);
  const languageExtension = useMemo(() => {
    const ext = getLanguageExtension(fileName);
    return ext ? [ext] : [];
  }, [fileName]);

  // Vim 扩展集，仅在 vimEnabled 时包含 vim() 扩展
  const vimExtensions = useMemo(() => {
    if (!vimEnabled) return [];
    return createVimExtensions(
      () => editorViewRef.current,
      () => { void handleSave(); },
    );
  }, [vimEnabled]); // eslint-disable-line react-hooks/exhaustive-deps -- handleSave 依赖 content 等，不需要每次变化都重建 vim 扩展

  // 语法高亮扩展，引用 CSS 变量，随主题联动
  const syntaxHighlightExtension = useMemo(() => createSyntaxHighlightExtension(), []);

  // 缩进指南线扩展，使用 --border CSS 变量，随主题变化
  const indentGuidesExtension = useMemo(() => createIndentGuidesExtension(), []);

  // 搜索替换面板扩展，绑定 searchKeymap（Ctrl+F 搜索）+ Ctrl+H 替换
  const searchExtension = useMemo<Extension[]>(() => [
    search({ top: true }),
    EditorView.domEventHandlers({
      keydown(event: KeyboardEvent) {
        // Ctrl+H / Cmd+H 打开搜索面板（替换模式）
        if ((event.ctrlKey || event.metaKey) && event.key === 'h') {
          event.preventDefault();
          const view = editorViewRef.current;
          if (view) {
            openSearchPanel(view);
          }
          return true;
        }
        return false;
      },
    }) as Extension,
    keymap.of(searchKeymap),
  ], []);

  // 光标位置监听 extension，通过 updateListener 实时更新行列号
  const cursorListenerExtension = useMemo(
    () =>
      EditorView.updateListener.of((update: ViewUpdate) => {
        if (update.selectionSet || update.docChanged) {
          const head = update.state.selection.main.head;
          const line = update.state.doc.lineAt(head);
          setCursorPos({ line: line.number, col: head - line.from + 1 });
        }
      }),
    [],
  );

  // 换行符检测：从原始内容判断 LF/CRLF
  const lineEnding = useMemo<'LF' | 'CRLF'>(() => {
    if (originalContent.includes('\r\n')) return 'CRLF';
    return 'LF';
  }, [originalContent]);

  // Vim 关闭时重置内部模式状态
  useEffect(() => {
    if (!vimEnabled) {
      resetVimMode();
    }
  }, [vimEnabled]);
  useEffect(() => {
    if (isImage) {
      setLoading(false);
      setContent('');
      setOriginalContent('');
      return;
    }
    let cancelled = false;
    setLoading(true);
    setSaveError(null);
    trpc.project.readFile
      .query({ projectId, filePath })
      .then((data) => {
        if (!cancelled) {
          setContent(data);
          setOriginalContent(data);
        }
      })
      .catch((err) => {
        if (!cancelled) {
          const msg = err instanceof Error ? err.message : String(err);
          setContent(`// 加载文件失败: ${msg}`);
          setOriginalContent('');
        }
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => { cancelled = true; };
  }, [projectId, filePath, isImage]);

  // ── slang-server LSP 桥接 + verible lint ──────────────────────
  // SV 文件打开时：启动 LSP → didOpen → 订阅诊断推送 → 合并 verible lint → 波浪线
  // 内容变更时：didChange（全量文本替换，slang-server 不支持增量 range）
  const lspStartedRef = useRef(false);

  /** 合并 LSP + verible 诊断并推送到 CodeMirror */
  const flushDiagnostics = useCallback(() => {
    const view = editorViewRef.current;
    if (!view || !view.dom.isConnected) return;
    const merged = [...lspDiagnosticsRef.current, ...veribleDiagnosticsRef.current];
    pushDiagnostics(view, merged);
  }, []);

  // LSP 启动 + didOpen + 诊断订阅
  useEffect(() => {
    if (!isSv || isImage) return;
    let unsub: (() => void) | undefined;
    let cancelled = false;

    // 启动 LSP 进程
    trpc.rtl.lspStart.mutate({ projectId }).then((status) => {
      if (cancelled || !status) return;
      if (!status.running && !status.initialized) return;
      lspStartedRef.current = true;

      // didOpen
      docVersionRef.current += 1;
      trpc.rtl.lspOpen.mutate({
        projectId,
        uri: fileUri,
        text: content,
        version: docVersionRef.current,
      });

      // 订阅 LSP 诊断推送
      if (window.eventBridge) {
        unsub = window.eventBridge.onLspDiagnostics((data) => {
          if (data.projectId !== projectId || data.uri !== fileUri) return;
          lspDiagnosticsRef.current = data.diagnostics.map((d) => ({
            line: d.range.start.line,
            character: d.range.start.character,
            endLine: d.range.end.line,
            endCharacter: d.range.end.character,
            severity: d.severity,
            message: d.message,
            source: d.source,
            code: d.code,
          }));
          flushDiagnostics();
        });
      }
    }).catch(() => {
      // LSP 不可用时静默降级（verible lint 仍可用）
    });

    return () => {
      cancelled = true;
      unsub?.();
      lspStartedRef.current = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- content 初始加载后 didOpen 不重发
  }, [projectId, filePath, isSv, isImage, fileUri]);

  // 内容变更 → didChange（防抖 500ms，避免每次击键都发）
  useEffect(() => {
    if (!isSv || !lspStartedRef.current || !content) return;
    const timer = setTimeout(() => {
      docVersionRef.current += 1;
      trpc.rtl.lspChange.mutate({
        projectId,
        uri: fileUri,
        text: content,
        version: docVersionRef.current,
      }).catch(() => { /* LSP 不可用时静默 */ });
    }, 500);
    return () => clearTimeout(timer);
  }, [content, isSv, projectId, fileUri]);

  // verible lint：打开/保存时后台自动跑（spec 决策 21/25）
  useEffect(() => {
    if (!isSv || !content) return;
    let cancelled = false;
    const timer = setTimeout(() => {
      if (cancelled) return;
      trpc.rtl.lintFile.query({ projectId, filePath, content }).then((result) => {
        if (cancelled) return;
        veribleDiagnosticsRef.current = result.diagnostics;
        flushDiagnostics();
      }).catch(() => {
        // verible 不可用时静默降级
      });
    }, 300);
    return () => { cancelled = true; clearTimeout(timer); };
  }, [content, isSv, projectId, filePath, flushDiagnostics]);

  // 文件在审阅队列中时确保 diff 已加载（覆盖目录树直开等不经 openFile 的入口）
  useEffect(() => {
    if (reviewEntry) {
      void useDiffReviewStore.getState().ensureDiffLoaded(reviewEntry.filePath);
    }
  }, [reviewEntry]);

  // 内容重载：diff 加载/拒绝回滚后 contentVersions 递增，从磁盘重读内容，
  // 保证内联装饰的行号与磁盘上的最新内容对齐（覆盖"文件已打开时 AI 再编辑"的场景）
  const lastContentVersionRef = useRef(contentVersion);
  useEffect(() => {
    if (contentVersion === lastContentVersionRef.current) return;
    lastContentVersionRef.current = contentVersion;
    if (contentVersion === 0) return;
    let cancelled = false;
    trpc.project.readFile.query({ projectId, filePath })
      .then((data) => {
        if (!cancelled) {
          setContent(data);
          setOriginalContent(data);
        }
      })
      .catch(() => {
        // 文件可能已被删除（拒绝新建文件的写入）——保留当前内容
      });
    return () => { cancelled = true; };
  }, [contentVersion, projectId, filePath]);

  // 行号定位：路径带 `:line[-end]` 后缀打开时（工具卡片/Markdown 链接），
  // 内容加载完成后滚动到指定行并选中区间；revealSeq 变化时（重复点击同一路径）重新定位
  const appliedRevealSeqRef = useRef<number | null>(null);
  useEffect(() => {
    if (revealSeq === undefined || line === undefined) return;
    if (appliedRevealSeqRef.current === revealSeq) return;
    if (loading) return; // 等内容加载完成后由 loading 变化再次触发本 effect
    appliedRevealSeqRef.current = revealSeq;
    const view = editorViewRef.current;
    // 预览模式下 CodeMirror 已卸载，ref 指向已销毁的视图，跳过定位
    if (!view || !view.dom.isConnected) return;
    const total = view.state.doc.lines;
    const startLine = Math.max(1, Math.min(line, total));
    const stopLine = Math.max(startLine, Math.min(endLine ?? line, total));
    const anchor = view.state.doc.line(startLine).from;
    const head = view.state.doc.line(stopLine).to;
    const range = EditorSelection.range(anchor, head);
    view.dispatch({
      selection: range,
      effects: EditorView.scrollIntoView(range, { y: 'center' }),
    });
    view.focus();
  }, [revealSeq, line, endLine, loading]);

  // 内联审阅 extension：diff 数据或 hunk 状态变化时重建（@uiw 会触发 reconfigure）
  const inlineReviewExtensions = useMemo<Extension[]>(() => {
    if (!reviewEntry || !reviewDiff) return [];
    return [createInlineReviewExtension({
      diff: reviewDiff,
      hunkStates: reviewStates,
      onAccept: (hunkId) => {
        useDiffReviewStore.getState().setHunkState(reviewEntry.filePath, hunkId, 'accepted');
      },
      onReject: (hunkId) => {
        void useDiffReviewStore.getState().rejectHunk(reviewEntry.filePath, hunkId);
      },
    })];
  }, [reviewEntry, reviewDiff, reviewStates]);

  // linter extension（lint gutter 显示错误/警告标记）
  const linterExt = useMemo(() => linterExtension(), []);

  // 折叠列（替代 basicSetup 默认 foldGutter：SVG chevron + 悬停显示，见 fold-gutter.ts）
  const foldGutterExt = useMemo(() => createFoldGutterExtension(), []);

  // 折叠策略（VSCode 风格：块注释、连续 import 组、#region、SV 关键字对、
  // 缩进回退——见 fold-strategies.ts；随文件语言变化重建）
  const languageId = useMemo(() => getLanguageId(fileName), [fileName]);
  const foldStrategiesExt = useMemo(() => createFoldStrategiesExtension(languageId), [languageId]);

  // 合并所有 extension（memoize 避免每次渲染触发 CodeMirror reconfigure）
  const editorExtensions = useMemo<Extension[]>(() => [
    ...languageExtension,
    syntaxHighlightExtension,
    cursorListenerExtension,
    indentGuidesExtension,
    foldGutterExt,
    foldStrategiesExt,
    linterExt,
    ...searchExtension,
    ...vimExtensions,
    ...inlineReviewExtensions,
  ], [languageExtension, syntaxHighlightExtension, cursorListenerExtension, indentGuidesExtension, foldGutterExt, foldStrategiesExt, linterExt, searchExtension, vimExtensions, inlineReviewExtensions]);

  const isDirty = content !== originalContent;

  const handleSave = useCallback(async (): Promise<boolean> => {
    if (!isDirty || saving) return false;
    if (wikiReadOnly) {
      setSaveError('受管 Wiki 页面只读：知识页由审阅/发布流程写入，schema/purpose 请在知识库「写作规则」编辑器中修改。');
      return false;
    }
    setSaving(true);
    setSaveError(null);
    try {
      await trpc.project.writeFile.mutate({ projectId, filePath, content });
      setOriginalContent(content);
      return true;
    } catch (err) {
      setSaveError(err instanceof Error ? err.message : String(err));
      return false;
    } finally {
      setSaving(false);
    }
  }, [projectId, filePath, content, isDirty, saving, wikiReadOnly]);

  const handleSelectionAccept = useCallback((replacement: string, selectedText: string) => {
    const view = editorViewRef.current;
    if (view?.dom.isConnected) {
      const { from, to } = view.state.selection.main;
      if (from !== to) {
        view.dispatch({ changes: { from, to, insert: replacement } });
        view.focus();
        return;
      }
    }

    const start = content.indexOf(selectedText);
    if (start < 0) return;
    setContent(`${content.slice(0, start)}${replacement}${content.slice(start + selectedText.length)}`);
  }, [content]);

  // 在外部浏览器中打开 HTML 文件
  const handleOpenInBrowser = useCallback(async () => {
    // 如果有未保存的修改，先保存
    if (isDirty) {
      const saved = await handleSave();
      if (!saved) return;
    }
    try {
      await trpc.project.openInExternalBrowser.mutate({ path: filePath });
    } catch (err) {
      useToastStore.getState().error(
        '无法在浏览器中打开',
        err instanceof Error ? err.message : String(err),
      );
    }
  }, [filePath, isDirty, handleSave]);

  // Ctrl+S 快捷键
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key === 's') {
        e.preventDefault();
        void handleSave();
      }
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [handleSave]);

  // ── 渲染 ──────────────────────────────────────────────────

  if (loading) {
    return (
      <div className="flex h-full items-center justify-center text-xs text-muted-foreground">
        <Loader2 className="mr-2 h-4 w-4 animate-spin" />
        加载中...
      </div>
    );
  }

  // ── 图片预览模式 ──────────────────────────────────────
  if (isImage) {
    // 鼠标滚轮缩放（以光标位置为中心）
    const handleImgWheel = (e: React.WheelEvent) => {
      e.preventDefault();
      const delta = e.deltaY > 0 ? -0.12 : 0.12;
      const container = imgScrollRef.current;
      if (!container) return;
      const oldZoom = imgZoom;
      const newZoom = Math.max(0.1, Math.min(oldZoom + delta, 10));
      if (newZoom === oldZoom) return;
      const rect = container.getBoundingClientRect();
      const cursorX = e.clientX - rect.left;
      const cursorY = e.clientY - rect.top;
      const contentX = (container.scrollLeft + cursorX) / oldZoom;
      const contentY = (container.scrollTop + cursorY) / oldZoom;
      const newScrollLeft = contentX * newZoom - cursorX;
      const newScrollTop = contentY * newZoom - cursorY;
      setImgZoom(newZoom);
      requestAnimationFrame(() => {
        if (imgScrollRef.current) {
          imgScrollRef.current.scrollLeft = newScrollLeft;
          imgScrollRef.current.scrollTop = newScrollTop;
        }
      });
    };
    // 鼠标拖拽平移
    const handleImgMouseDown = (e: React.MouseEvent) => {
      if (e.button !== 0) return;
      const container = imgScrollRef.current;
      if (!container) return;
      e.preventDefault();
      imgDragState.current = {
        startX: e.clientX,
        startY: e.clientY,
        scrollLeft: container.scrollLeft,
        scrollTop: container.scrollTop,
      };
      setImgDragging(true);
    };
    const handleImgMouseMove = (e: React.MouseEvent) => {
      if (!imgDragging) return;
      const container = imgScrollRef.current;
      if (!container) return;
      e.preventDefault();
      const dx = e.clientX - imgDragState.current.startX;
      const dy = e.clientY - imgDragState.current.startY;
      container.scrollLeft = imgDragState.current.scrollLeft - dx;
      container.scrollTop = imgDragState.current.scrollTop - dy;
    };
    const handleImgMouseUp = () => {
      setImgDragging(false);
    };
    // 重置缩放并滚动到中心
    const handleImgReset = () => {
      setImgZoom(1);
      if (imgScrollRef.current) {
        imgScrollRef.current.scrollTo({ left: 0, top: 0, behavior: 'smooth' });
      }
    };

    return (
      <div className="flex h-full flex-1 flex-col overflow-hidden">
        {/* 工具栏 */}
        <div className="flex items-center justify-between border-b bg-secondary/20 px-3 py-1">
          <span className="truncate text-xs text-muted-foreground" title={filePath}>
            {filePath}
          </span>
          <div className="flex items-center gap-2">
            <button
              onClick={() => setImgZoom((z) => Math.max(0.1, z - 0.25))}
              className="flex items-center gap-1 rounded px-2 py-0.5 text-[10px] text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
              title="缩小"
            >
              <ZoomOut className="h-3 w-3" />
            </button>
            <span className="text-[10px] text-muted-foreground tabular-nums">
              {Math.round(imgZoom * 100)}%
            </span>
            <button
              onClick={() => setImgZoom((z) => Math.min(10, z + 0.25))}
              className="flex items-center gap-1 rounded px-2 py-0.5 text-[10px] text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
              title="放大"
            >
              <ZoomIn className="h-3 w-3" />
            </button>
            <button
              onClick={handleImgReset}
              className="flex items-center gap-1 rounded px-2 py-0.5 text-[10px] text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
              title="重置缩放"
            >
              <Expand className="h-3 w-3" />
            </button>
          </div>
        </div>
        {/* 图片显示区域 — 可滚动 + 可拖拽 */}
        <div
          ref={imgScrollRef}
          className="min-h-0 flex-1 overflow-auto bg-secondary/10"
          onWheel={handleImgWheel}
          onMouseDown={handleImgMouseDown}
          onMouseMove={handleImgMouseMove}
          onMouseUp={handleImgMouseUp}
          onMouseLeave={handleImgMouseUp}
          style={{ cursor: imgDragging ? 'grabbing' : 'grab' }}
        >
          {/*
           * 内部容器：width 设为 zoom * 100% 撑开滚动区域。
           * 不用 CSS transform（transform 不改变布局尺寸，overflow-auto
           * 不会产生滚动条，导致放大后上方图片被遮挡且无法滚动到）。
           * zoom=1 时 width=100% 适应容器，zoom>1 时撑开产生滚动条。
           */}
          <div
            className="flex items-center justify-center p-4"
            style={{ width: `${imgZoom * 100}%`, minHeight: '100%', margin: 'auto' }}
          >
            <img
              src={imageUrl}
              alt={fileName}
              className="h-auto w-full max-w-full select-none object-contain"
              style={{
                transition: imgDragging ? 'none' : 'width 0.08s ease-out',
              }}
              loading="lazy"
              draggable={false}
            />
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="flex h-full flex-1 flex-col overflow-hidden">
      {/* 工具栏 */}
      <div className="flex items-center justify-between border-b bg-secondary/20 px-3 py-1">
        <Breadcrumb filePath={filePath} />
        <div className="flex items-center gap-2">
          {isDirty && (
            <span className="text-[10px] text-status-aborted-foreground">● 已修改</span>
          )}
          {saveError && (
            <span className="flex items-center gap-0.5 text-[10px] text-status-fail-foreground" title={saveError}>
              <AlertCircle className="h-2.5 w-2.5" />
              保存失败
            </span>
          )}
          {(isMd || isHtml) && !reviewEntry && (
            <button
              onClick={() => setPreviewMode(!previewMode)}
              className="flex items-center gap-1 rounded px-2 py-0.5 text-[10px] text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
              title={previewMode ? '切换到编辑模式' : '切换到预览模式'}
            >
              {previewMode ? <Pencil className="h-3 w-3" /> : <Eye className="h-3 w-3" />}
              {previewMode ? '编辑' : '预览'}
            </button>
          )}
          {isHtml && (
            <button
              onClick={() => void handleOpenInBrowser()}
              className="flex items-center gap-1 rounded px-2 py-0.5 text-[10px] text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
              title="在外部浏览器中打开"
            >
              <ExternalLink className="h-3 w-3" />
              浏览器
            </button>
          )}
          <button
            onClick={() => void handleSave()}
            disabled={!isDirty || saving}
            className={cn(
              'flex items-center gap-1 rounded px-2 py-0.5 text-[10px] transition-colors',
              isDirty && !saving
                ? 'bg-primary/10 text-primary hover:bg-primary/20'
                : 'cursor-not-allowed text-muted-foreground opacity-50',
            )}
            title="保存 (Ctrl+S)"
          >
            {saving ? <Loader2 className="h-3 w-3 animate-spin" /> : <Save className="h-3 w-3" />}
            保存
          </button>
        </div>
      </div>

      {/* 内联审阅工具条：文件在审阅队列中时显示（Cursor / VSCode 风格） */}
      {reviewEntry && (
        <InlineReviewToolbar
          entry={reviewEntry}
          diff={reviewDiff}
          loading={reviewLoading}
          error={reviewError}
        />
      )}

      {/* 编辑器 / 预览 */}
      <div className="min-h-0 flex-1 overflow-hidden">
        {isMd && previewMode && !reviewEntry ? (
          <div className="markdown-preview h-full overflow-auto">
            {/* 划选 AI 操作条宿主接管原内容容器（锚点随内容滚动平移）；
                引用标注带文件路径，会话落当前 AI 会话 */}
            <SelectionActionsHost
              source={{ kind: 'file', path: filePath }}
              onAcceptSelection={handleSelectionAccept}
              className="mx-auto max-w-4xl px-8 py-6"
            >
              <ReactMarkdown
                remarkPlugins={[remarkGfm]}
                rehypePlugins={[rehypeRaw]}
                components={{
                  // 将 HTML align 属性转为 inline style，确保 React 渲染到 DOM
                  // rehype-raw 解析的 align 属性不在 React 标准类型中，需类型断言
                  p: ({ children, ...props }) => {
                    const align = (props as Record<string, unknown>).align as string | undefined;
                    return (
                      <p style={align ? { textAlign: align as 'center' | 'left' | 'right' } : undefined}>
                        {children}
                      </p>
                    );
                  },
                  div: ({ children, ...props }) => {
                    const align = (props as Record<string, unknown>).align as string | undefined;
                    return (
                      <div style={align ? { textAlign: align as 'center' | 'left' | 'right' } : undefined}>
                        {children}
                      </div>
                    );
                  },
                  a: ({ href, children }) => {
                    if (href && !isExternalLink(href)) {
                      const resolvedPath = resolveRelativePath(filePath, href);
                      const name = basename(resolvedPath);
                      return (
                        <a
                          href={href}
                          onClick={(e) => {
                            e.preventDefault();
                            openFileTab(openDestination, resolvedPath, name);
                          }}
                          className="cursor-pointer"
                        >
                          {children}
                        </a>
                      );
                    }
                    return (
                      <a
                        href={href}
                        onClick={(e) => {
                          e.preventDefault();
                          void trpc.system.openExternal.mutate(href!);
                        }}
                      >
                        {children}
                      </a>
                    );
                  },
                  img: ({ src, alt }) => (
                    <img src={resolveImageSrc(filePath, src)} alt={alt} loading="lazy" className="max-w-full" />
                  ),
                  // Mermaid 代码块渲染为图表，其余代码块正常显示
                  code: ({ className, children }) => {
                    const text = extractText(children);
                    const lang = className?.replace('language-', '') ?? '';
                    if (lang === 'mermaid') {
                      return <MermaidDiagram code={text.trim()} />;
                    }
                    return (
                      <code className={className}>
                        {children}
                      </code>
                    );
                  },
                  // 透传 pre children，避免 mermaid 图表被 <pre> 包裹
                  pre: ({ children }) => <>{children}</>,
                }}
              >
                {content}
              </ReactMarkdown>
            </SelectionActionsHost>
          </div>
        ) : isHtml && previewMode && !reviewEntry ? (
          <iframe
            srcDoc={content}
            className="h-full w-full border-0 bg-white"
            title="HTML 预览"
            sandbox="allow-scripts allow-same-origin allow-forms allow-popups allow-modals"
          />
        ) : (
          /* CodeMirror 编辑区（代码/文本，含 AI 改动内联审阅的只读态）：
             host 包住内部滚动区，锚点靠 scroll 捕获重算跟随选区 */
          <SelectionActionsHost
            source={{ kind: 'file', path: filePath }}
            onAcceptSelection={handleSelectionAccept}
            className="h-full w-full"
          >
            <div className="flex h-full w-full overflow-hidden">
              <CodeMirror
                value={content}
                onChange={setContent}
                extensions={editorExtensions}
                readOnly={reviewActive || wikiReadOnly}
                theme={themeMode === 'dark' ? 'dark' : 'light'}
                height="100%"
                width="100%"
                className="h-full min-w-0 flex-1 overflow-hidden"
                onCreateEditor={(view) => {
                  editorViewRef.current = view;
                }}
                basicSetup={{
                  lineNumbers: true,
                  highlightActiveLine: true,
                  highlightActiveLineGutter: true,
                  // 折叠列使用自定义 fold-gutter 扩展（SVG chevron + 悬停显示）
                  foldGutter: false,
                  bracketMatching: true,
                  closeBrackets: true,
                  autocompletion: true,
                  indentOnInput: true,
                  tabSize: 2,
                }}
              />
              {minimapEnabled && (
                <Minimap getView={() => editorViewRef.current} />
              )}
            </div>
          </SelectionActionsHost>
        )}
      </div>
      {/* Vim 状态栏（仅 Vim 模式开启时显示） */}
      <VimStatusBar visible={vimEnabled && !isMd && !isHtml && !isImage} />
      {/* 底部状态栏 — 行列号、语言、编码等 */}
      <EditorStatusBar
        fileName={fileName}
        isDirty={isDirty}
        cursorPos={cursorPos}
        tabSize={2}
        lineEnding={lineEnding}
      />
    </div>
  );
}

// ── 内联审阅工具条 ───────────────────────────────────────────

function InlineReviewToolbar({
  entry,
  diff,
  loading,
  error,
}: {
  entry: ReviewEntry;
  diff: FileDiffResult | null;
  loading: boolean;
  error: string | null;
}) {
  const { current, total } = useDiffReviewStore.getState().getQueuePosition();
  const nextFileName = useDiffReviewStore.getState().getNextFileName();

  const stats = diff
    ? { add: diff.totalAdd, del: diff.totalDel, hunks: diff.hunks.length }
    : null;

  return (
    <div className="flex shrink-0 items-center gap-2.5 border-b border-primary/20 bg-primary/5 px-3 py-1.5">
      <GitCompare className="h-3.5 w-3.5 shrink-0 text-primary" />
      <span className="shrink-0 text-xs font-medium text-foreground">AI 改动待审阅</span>

      {loading && (
        <span className="flex items-center gap-1 text-[11px] text-muted-foreground">
          <Loader2 className="h-3 w-3 animate-spin" />
          加载 diff...
        </span>
      )}

      {!loading && error && (
        <span className="flex min-w-0 items-center gap-1 text-[11px] text-status-fail-foreground" title={error}>
          <AlertCircle className="h-3 w-3 shrink-0" />
          <span className="truncate">diff 加载失败：{error}</span>
        </span>
      )}

      {!loading && !error && stats && (
        <span className="flex shrink-0 items-center gap-1.5 font-mono text-[10px]">
          <span className="text-status-pass-foreground">+{stats.add}</span>
          <span className="text-destructive">−{stats.del}</span>
          <span className="text-muted-foreground">{stats.hunks} 处改动</span>
        </span>
      )}

      {total > 1 && (
        <span className="shrink-0 text-[10px] text-muted-foreground">
          {current}/{total} 文件
        </span>
      )}

      <div className="ml-auto flex shrink-0 items-center gap-1.5">
        <button
          onClick={() => { void useDiffReviewStore.getState().rejectAll(entry.filePath); }}
          className="flex items-center gap-1 rounded border border-border px-2 py-0.5 text-[10px] text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
          title="回滚此文件的全部 AI 改动"
        >
          <X className="h-2.5 w-2.5" />
          全部拒绝
        </button>
        <button
          onClick={() => useDiffReviewStore.getState().acceptAll(entry.filePath)}
          className="flex items-center gap-1 rounded border border-status-pass/30 bg-status-pass/10 px-2 py-0.5 text-[10px] text-status-pass-foreground transition-colors hover:bg-status-pass/20"
          title="保留此文件的全部 AI 改动"
        >
          <Check className="h-2.5 w-2.5" />
          全部接受
        </button>
        {nextFileName && (
          <button
            onClick={() => useDiffReviewStore.getState().nextFile()}
            className="flex items-center gap-1 rounded border border-primary/30 bg-primary/10 px-2 py-0.5 text-[10px] text-primary transition-colors hover:bg-primary/20"
            title={`审阅下一个文件: ${nextFileName}`}
          >
            <ArrowRight className="h-2.5 w-2.5" />
            <span className="max-w-[140px] truncate">{nextFileName}</span>
          </button>
        )}
      </div>
    </div>
  );
}
