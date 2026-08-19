import { cn } from '@renderer/lib/utils';

// ── 语言标识映射 ────────────────────────────────────────────────

const EXTENSION_LANGUAGE_MAP: Record<string, string> = {
  // SystemVerilog / Verilog
  sv: 'SystemVerilog',
  svh: 'SystemVerilog',
  v: 'Verilog',
  vh: 'Verilog',
  // Web
  js: 'JavaScript',
  jsx: 'JavaScript',
  mjs: 'JavaScript',
  cjs: 'JavaScript',
  ts: 'TypeScript',
  tsx: 'TypeScript',
  html: 'HTML',
  htm: 'HTML',
  vue: 'Vue',
  css: 'CSS',
  scss: 'SCSS',
  less: 'Less',
  // Data
  json: 'JSON',
  yaml: 'YAML',
  yml: 'YAML',
  // Scripting
  py: 'Python',
  pyw: 'Python',
  sh: 'Shell',
  bash: 'Shell',
  zsh: 'Shell',
  tcl: 'Tcl',
  // C/C++
  c: 'C',
  h: 'C',
  cpp: 'C++',
  cc: 'C++',
  cxx: 'C++',
  hpp: 'C++',
  hxx: 'C++',
  // Docs
  md: 'Markdown',
  markdown: 'Markdown',
};

/**
 * 从文件扩展名映射到语言标识。
 * 未知扩展名返回 `Plain Text`。
 */
export function getLanguageLabel(filename: string): string {
  const ext = filename.split('.').pop()?.toLowerCase() ?? '';
  return EXTENSION_LANGUAGE_MAP[ext] ?? 'Plain Text';
}

// ── EditorStatusBar 组件 ────────────────────────────────────────

export type CursorPosition = {
  line: number;
  col: number;
};

interface EditorStatusBarProps {
  /** 当前文件名，用于推断语言标识 */
  fileName: string;
  /** 文件是否有未保存修改 */
  isDirty: boolean;
  /** 当前光标位置 */
  cursorPos: CursorPosition;
  /** 缩进大小（来自 basicSetup.tabSize） */
  tabSize: number;
  /** 换行符类型，默认 `LF` */
  lineEnding?: 'LF' | 'CRLF';
}

export function EditorStatusBar({
  fileName,
  isDirty,
  cursorPos,
  tabSize,
  lineEnding = 'LF',
}: EditorStatusBarProps) {
  const language = getLanguageLabel(fileName);

  return (
    <div
      className="flex items-center gap-3 border-t bg-secondary/30 px-3 py-0.5 text-[10px] text-muted-foreground"
      data-testid="editor-status-bar"
    >
      {/* 保存状态 */}
      <span
        className={cn('flex items-center gap-1', isDirty && 'text-status-aborted-foreground')}
        data-testid="status-save-status"
      >
        <span
          className={cn(
            'inline-block h-1.5 w-1.5 rounded-full',
            isDirty ? 'bg-status-aborted-foreground' : 'bg-status-pass-foreground',
          )}
        />
        {isDirty ? '已修改' : '已保存'}
      </span>

      {/* 光标位置 */}
      <span
        className="tabular-nums"
        data-testid="status-cursor"
      >
        {`Ln ${cursorPos.line}, Col ${cursorPos.col}`}
      </span>

      {/* 缩进 */}
      <span data-testid="status-indent">{`Tab: ${tabSize}`}</span>

      {/* 语言标识 */}
      <span data-testid="status-language">{language}</span>

      {/* 右侧：编码 · 换行符 */}
      <span className="ml-auto flex items-center gap-3">
        <span data-testid="status-encoding">UTF-8</span>
        <span data-testid="status-line-ending">{lineEnding}</span>
      </span>
    </div>
  );
}
