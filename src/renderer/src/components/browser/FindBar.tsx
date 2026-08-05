/**
 * FindBar — in-page find bar for Browser Surface.
 *
 * Issue #11: Ctrl+F toggles this bar. It provides:
 * - Text input for search query
 * - Previous / next match navigation
 * - Match count display (e.g. "2/5")
 * - Close button (also triggered by Escape)
 *
 * Search is delegated to the main process via surfaceBridge.findInPage.
 * Match results are received as find-result surface events and projected
 * into the browser store by BrowserView's event listener.
 */
import { useState, useCallback, useEffect, useRef, type FormEvent } from 'react';
import { ChevronUp, ChevronDown, X } from 'lucide-react';
import { useBrowserStore } from '@renderer/stores/browser';
import { cn } from '@renderer/lib/utils';

export type FindBarProps = {
  surfaceId: string;
};

export function FindBar({ surfaceId }: FindBarProps) {
  const [query, setQuery] = useState('');
  const inputRef = useRef<HTMLInputElement>(null);
  const findMatches = useBrowserStore((s) => s.tabs[surfaceId]?.findMatches ?? 0);
  const findActiveMatch = useBrowserStore((s) => s.tabs[surfaceId]?.findActiveMatch ?? 0);
  const closeFind = useBrowserStore((s) => s.closeFind);

  // Focus the input when the find bar appears
  useEffect(() => {
    inputRef.current?.focus();
    inputRef.current?.select();
  }, []);

  // Cleanup: stop find-in-page when the bar unmounts
  useEffect(() => {
    return () => {
      void window.surfaceBridge?.stopFindInPage(surfaceId, 'clearSelection');
    };
  }, [surfaceId]);

  const doSearch = useCallback((text: string, forward: boolean) => {
    if (!text.trim()) return;
    void window.surfaceBridge?.findInPage(surfaceId, text, { forward });
  }, [surfaceId]);

  const handleSubmit = useCallback((e: FormEvent) => {
    e.preventDefault();
    doSearch(query, true);
  }, [query, doSearch]);

  const handlePrev = useCallback(() => {
    doSearch(query, false);
  }, [query, doSearch]);

  const handleNext = useCallback(() => {
    doSearch(query, true);
  }, [query, doSearch]);

  const handleClose = useCallback(() => {
    void window.surfaceBridge?.stopFindInPage(surfaceId, 'clearSelection');
    closeFind(surfaceId);
  }, [surfaceId, closeFind]);

  const handleKeyDown = useCallback((e: React.KeyboardEvent) => {
    if (e.key === 'Escape') {
      e.preventDefault();
      handleClose();
    } else if (e.key === 'Enter' && e.shiftKey) {
      e.preventDefault();
      handlePrev();
    } else if (e.key === 'Enter') {
      e.preventDefault();
      handleNext();
    }
  }, [handleClose, handlePrev, handleNext]);

  const matchLabel = query.trim()
    ? findMatches > 0
      ? `${findActiveMatch}/${findMatches}`
      : '0/0'
    : '';

  return (
    <div className="flex h-8 shrink-0 items-center gap-1 border-b bg-secondary/40 px-2">
      <form onSubmit={handleSubmit} className="flex flex-1 items-center">
        <input
          ref={inputRef}
          type="text"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={handleKeyDown}
          placeholder="查找..."
          className="flex-1 rounded-md border border-border/50 bg-background px-2 py-0.5 text-xs text-foreground outline-none focus:border-primary"
          aria-label="查找"
          spellCheck={false}
        />
      </form>

      {/* Match count */}
      {matchLabel && (
        <span className="min-w-10 text-center text-[10px] text-muted-foreground">
          {matchLabel}
        </span>
      )}

      {/* Previous match */}
      <button
        onClick={handlePrev}
        disabled={!query.trim()}
        title="上一个匹配 (Shift+Enter)"
        className={cn(
          'flex items-center justify-center rounded p-1 transition-colors',
          query.trim()
            ? 'text-muted-foreground hover:bg-accent hover:text-foreground'
            : 'cursor-not-allowed text-muted-foreground/30',
        )}
      >
        <ChevronUp className="h-3.5 w-3.5" />
      </button>

      {/* Next match */}
      <button
        onClick={handleNext}
        disabled={!query.trim()}
        title="下一个匹配 (Enter)"
        className={cn(
          'flex items-center justify-center rounded p-1 transition-colors',
          query.trim()
            ? 'text-muted-foreground hover:bg-accent hover:text-foreground'
            : 'cursor-not-allowed text-muted-foreground/30',
        )}
      >
        <ChevronDown className="h-3.5 w-3.5" />
      </button>

      {/* Close */}
      <button
        onClick={handleClose}
        title="关闭 (Esc)"
        className="flex items-center justify-center rounded p-1 text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
      >
        <X className="h-3.5 w-3.5" />
      </button>
    </div>
  );
}
