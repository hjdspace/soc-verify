import { MessageSquareQuote, X } from 'lucide-react';
import { cn } from '@renderer/lib/utils';
import type { SessionQuote } from '@renderer/stores/session-types';

/**
 * 对话引用 chip 行（划选「添加到当前任务」产生，输入框上方展示）。
 *
 * 每条引用一个 chip；鼠标悬停 chip 时在上方浮出引用内容预览
 * （来源标注 + 原文），× 删除单条。onRemove 缺省时为只读模式
 * （用户消息气泡内回显，不可删除）。
 */
export function ComposerQuoteChips({
  quotes,
  onRemove,
  className,
}: {
  quotes: SessionQuote[];
  /** 删除回调（缺省 = 只读模式，用于消息气泡回显） */
  onRemove?: (id: string) => void;
  className?: string;
}) {
  if (quotes.length === 0) return null;
  return (
    <div className={cn('flex flex-wrap items-center gap-1', className)} data-testid="composer-quotes">
      {quotes.map((quote, index) => (
        <div key={quote.id} className="group/quote relative">
          {/* hover 预览浮层：来源标注 + 引用原文 */}
          <div
            data-testid={`composer-quote-preview-${index}`}
            className="pointer-events-none invisible absolute bottom-full left-0 z-50 mb-1.5 w-72 rounded-lg border border-border bg-[var(--dsw-bubble)] p-2 opacity-0 shadow-[var(--dsw-shadow-lv2)] transition-opacity duration-150 group-hover/quote:visible group-hover/quote:opacity-100"
          >
            <div className="mb-1 flex items-center gap-1 text-[10px] text-muted-foreground">
              <MessageSquareQuote className="h-3 w-3 shrink-0" />
              <span className="truncate">
                {quote.source} · #{index + 1}
              </span>
            </div>
            <div className="max-h-32 overflow-y-auto whitespace-pre-wrap break-words text-[11px] leading-4 text-foreground">
              {quote.text}
            </div>
          </div>
          <span
            data-testid={`composer-quote-chip-${index}`}
            title={quote.source}
            className="inline-flex h-5 max-w-[200px] items-center gap-1 rounded-full bg-[var(--dsw-selector)] px-2 text-[10px] leading-none text-foreground/80"
          >
            <MessageSquareQuote className="h-3 w-3 shrink-0 text-primary" aria-hidden />
            <span className="truncate">{quotes.length > 1 ? `对话引用 #${index + 1}` : '1 条对话引用'}</span>
            {onRemove && (
              <button
                type="button"
                aria-label={`删除对话引用 #${index + 1}`}
                title="删除此引用"
                data-testid={`composer-quote-remove-${index}`}
                onClick={() => onRemove(quote.id)}
                className="-mr-0.5 shrink-0 rounded-full p-0.5 text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
              >
                <X className="h-2.5 w-2.5" aria-hidden />
              </button>
            )}
          </span>
        </div>
      ))}
    </div>
  );
}
