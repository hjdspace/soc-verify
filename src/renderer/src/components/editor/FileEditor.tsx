import { useState, useEffect, useCallback, useMemo } from 'react';
import CodeMirror from '@uiw/react-codemirror';
import { StreamLanguage } from '@codemirror/language';
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
import { Save, Eye, Pencil, Loader2, AlertCircle } from 'lucide-react';
import { trpc } from '@renderer/lib/trpc';
import { useThemeStore } from '@renderer/stores/theme';
import { cn } from '@renderer/lib/utils';

// ── 语言扩展映射 ──────────────────────────────────────────────

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

// ── FileEditor 组件 ───────────────────────────────────────────

interface FileEditorProps {
  projectId: string;
  filePath: string;
  fileName: string;
}

export function FileEditor({ projectId, filePath, fileName }: FileEditorProps) {
  const [content, setContent] = useState('');
  const [originalContent, setOriginalContent] = useState('');
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [previewMode, setPreviewMode] = useState(false);

  const currentTheme = useThemeStore((s) => s.currentTheme);
  const themes = useThemeStore((s) => s.themes);
  const themeMode = themes.find((t) => t.id === currentTheme)?.mode ?? 'dark';

  const isMd = isMarkdownFile(fileName);
  const languageExtension = useMemo(() => {
    const ext = getLanguageExtension(fileName);
    return ext ? [ext] : [];
  }, [fileName]);

  // 加载文件内容
  useEffect(() => {
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
  }, [projectId, filePath]);

  const isDirty = content !== originalContent;

  const handleSave = useCallback(async () => {
    if (!isDirty || saving) return;
    setSaving(true);
    setSaveError(null);
    try {
      await trpc.project.writeFile.mutate({ projectId, filePath, content });
      setOriginalContent(content);
    } catch (err) {
      setSaveError(err instanceof Error ? err.message : String(err));
    } finally {
      setSaving(false);
    }
  }, [projectId, filePath, content, isDirty, saving]);

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

  return (
    <div className="flex h-full flex-1 flex-col overflow-hidden">
      {/* 工具栏 */}
      <div className="flex items-center justify-between border-b bg-secondary/20 px-3 py-1">
        <span className="truncate text-xs text-muted-foreground" title={filePath}>
          {filePath}
        </span>
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
          {isMd && (
            <button
              onClick={() => setPreviewMode(!previewMode)}
              className="flex items-center gap-1 rounded px-2 py-0.5 text-[10px] text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
              title={previewMode ? '切换到编辑模式' : '切换到预览模式'}
            >
              {previewMode ? <Pencil className="h-3 w-3" /> : <Eye className="h-3 w-3" />}
              {previewMode ? '编辑' : '预览'}
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

      {/* 编辑器 / 预览 */}
      <div className="min-h-0 flex-1 overflow-hidden">
        {isMd && previewMode ? (
          <div className="markdown-preview h-full overflow-auto">
            <div className="mx-auto max-w-4xl px-8 py-6">
              <ReactMarkdown remarkPlugins={[remarkGfm]}>{content}</ReactMarkdown>
            </div>
          </div>
        ) : (
          <CodeMirror
            value={content}
            onChange={setContent}
            extensions={languageExtension}
            theme={themeMode === 'dark' ? 'dark' : 'light'}
            height="100%"
            width="100%"
            className="h-full w-full overflow-hidden text-xs"
            basicSetup={{
              lineNumbers: true,
              highlightActiveLine: true,
              highlightActiveLineGutter: true,
              foldGutter: true,
              bracketMatching: true,
              closeBrackets: true,
              autocompletion: true,
              indentOnInput: true,
              tabSize: 2,
            }}
          />
        )}
      </div>
    </div>
  );
}
