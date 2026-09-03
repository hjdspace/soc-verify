import { useMemo } from 'react';
import hljs from 'highlight.js';
import { cn } from '@renderer/lib/utils';

/** Highlight code using highlight.js and return HTML string. */
function highlightCode(code: string, language: string): string {
  try {
    if (language && language !== 'plaintext' && hljs.getLanguage(language)) {
      return hljs.highlight(code, { language }).value;
    }
    // highlightAuto 是全语言探测，实测单行 13ms+；工具行内容（diff/日志/
    // 目录树）逐行调用会把整列表卡成数秒（见 perf 基准）。语言未知时只对
    // 多行内容做一次探测，单行直接转义纯文本——与 MarkdownRenderer 的
    // CodeBlock 守卫一致。
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

/**
 * Renders code with syntax highlighting via highlight.js.
 * Uses dangerouslySetInnerHTML for performance.
 */
export function CodeHighlight({ code, language, className }: { code: string; language: string; className?: string }) {
  const html = useMemo(() => highlightCode(code, language), [code, language]);
  return (
    <code
      className={cn('hljs font-mono whitespace-pre-wrap break-words', className)}
      dangerouslySetInnerHTML={{ __html: html }}
    />
  );
}
