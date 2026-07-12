import { memo, useState, type ReactNode } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { cn } from '@renderer/lib/utils';

interface MarkdownRendererProps {
  content: string;
  onUriClick?: (uri: string) => void;
}

/**
 * Renders markdown content with GitHub-flavored markdown support.
 * Handles case:///, log:///, cov:/// URIs as clickable links.
 */
export const MarkdownRenderer = memo(function MarkdownRenderer({ content, onUriClick }: MarkdownRendererProps) {
  return (
    <div className="markdown-body text-xs leading-relaxed">
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        components={{
          a: ({ href, children }) => {
            if (!href) return <span>{children}</span>;
            const isHostUri = href.startsWith('case:///') || href.startsWith('log:///') || href.startsWith('cov:///');
            if (isHostUri) {
              return (
                <button
                  onClick={() => onUriClick?.(href)}
                  className="inline-flex items-center gap-0.5 rounded bg-primary/10 px-1 py-0.5 text-[10px] text-primary hover:bg-primary/20"
                >
                  {children}
                </button>
              );
            }
            return (
              <a href={href} target="_blank" rel="noopener noreferrer" className="text-primary underline">
                {children}
              </a>
            );
          },
          code: ({ className, children }) => {
            const isInline = !className;
            if (isInline) {
              return (
                <code className="rounded bg-secondary px-1 py-0.5 text-[10px] font-mono">
                  {children}
                </code>
              );
            }
            const lang = className?.replace('language-', '') ?? '';
            return <CodeBlock language={lang}>{String(children)}</CodeBlock>;
          },
          pre: ({ children }) => <>{children}</>,
          table: ({ children }) => (
            <div className="my-2 overflow-x-auto">
              <table className="w-full border-collapse text-[11px]">{children}</table>
            </div>
          ),
          th: ({ children }) => (
            <th className="border border-border/50 bg-secondary/50 px-2 py-1 text-left font-semibold">
              {children}
            </th>
          ),
          td: ({ children }) => (
            <td className="border border-border/50 px-2 py-1">{children}</td>
          ),
          ul: ({ children }) => <ul className="ml-4 list-disc space-y-0.5">{children}</ul>,
          ol: ({ children }) => <ol className="ml-4 list-decimal space-y-0.5">{children}</ol>,
          li: ({ children }) => <li>{children}</li>,
          p: ({ children }) => <p className="mb-1 last:mb-0">{children}</p>,
          h1: ({ children }) => <h1 className="mb-1 text-sm font-bold">{children}</h1>,
          h2: ({ children }) => <h2 className="mb-1 text-sm font-bold">{children}</h2>,
          h3: ({ children }) => <h3 className="mb-1 text-xs font-bold">{children}</h3>,
          blockquote: ({ children }) => (
            <blockquote className="border-l-2 border-border/50 pl-2 italic text-muted-foreground">
              {children}
            </blockquote>
          ),
          hr: () => <hr className="my-2 border-border/50" />,
        }}
      >
        {content}
      </ReactMarkdown>
    </div>
  );
});

// ── Code block with copy button ──────────────────────────

function CodeBlock({ language, children }: { language: string; children: ReactNode }) {
  const [copied, setCopied] = useState(false);

  const handleCopy = () => {
    void navigator.clipboard.writeText(String(children)).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    });
  };

  return (
    <div className="group relative my-1.5 overflow-hidden rounded-md border border-border/40 bg-secondary/30">
      <div className="flex items-center justify-between border-b border-border/30 bg-secondary/20 px-2 py-0.5">
        <span className="text-[9px] font-medium uppercase text-muted-foreground">
          {language || 'code'}
        </span>
        <button
          onClick={handleCopy}
          className="text-[9px] text-muted-foreground opacity-0 transition-opacity hover:text-foreground group-hover:opacity-100"
        >
          {copied ? '已复制' : '复制'}
        </button>
      </div>
      <pre className="overflow-x-auto p-2">
        <code className="text-[10px] font-mono">{children}</code>
      </pre>
    </div>
  );
}
