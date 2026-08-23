import { useMemo } from 'react';
import hljs from 'highlight.js';
import { cn } from '@renderer/lib/utils';

/** Highlight code using highlight.js and return HTML string. */
function highlightCode(code: string, language: string): string {
  try {
    if (language && language !== 'plaintext' && hljs.getLanguage(language)) {
      return hljs.highlight(code, { language }).value;
    }
    return hljs.highlightAuto(code).value;
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
