import { AlertCircle } from 'lucide-react';

type ErrorMessageProps = {
  content: string;
};

function splitErrorContent(content: string): { summary: string; detail: string } {
  const normalized = content.trim().replace(/^\[错误\]\s*/, '');
  const [summary = '', ...detailParts] = normalized.split(/\n\s*\n/);
  const detail = detailParts.join('\n\n').replace(/^错误详情：\s*/, '').trim();
  return { summary: summary.trim(), detail };
}

/** Structured rendering for assistant error messages emitted by the session store. */
export function ErrorMessage({ content }: ErrorMessageProps) {
  const { summary, detail } = splitErrorContent(content);

  return (
    <section
      data-testid="assistant-error-message"
      role="alert"
      className="overflow-hidden rounded-lg border border-destructive/30 bg-destructive/5 text-xs"
    >
      <div className="flex items-center gap-1.5 border-b border-destructive/20 bg-destructive/10 px-2.5 py-1.5 text-destructive">
        <AlertCircle className="size-3.5 shrink-0" />
        <span className="font-semibold">请求失败</span>
        <span className="ml-auto font-mono text-[10px] text-destructive/70">API error</span>
      </div>
      <div className="px-2.5 py-2 leading-5 text-foreground">{summary || '请求未完成'}</div>
      {detail && (
        <pre className="border-t border-destructive/15 bg-background/40 px-2.5 py-2 font-mono text-[10px] leading-4 text-muted-foreground whitespace-pre-wrap break-words">
          {detail}
        </pre>
      )}
    </section>
  );
}
