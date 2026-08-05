/**
 * NavigationBar — 浏览器导航控制条。
 *
 * 始终显示在 Browser Surface 上方，提供：
 * - 后退、前进、刷新按钮
 * - 地址栏（显示当前 URL，可编辑提交新 URL）
 * - 加载状态指示
 * - 收藏当前页（使用主进程事件提供的当前 URL/title）
 * - 在系统浏览器中打开
 *
 * 按钮 disabled 状态由主进程 navigation 事件驱动的 canGoBack/canGoForward 控制。
 */
import { useState, useCallback, type FormEvent, useEffect } from 'react';
import { ArrowLeft, ArrowRight, RotateCw, ExternalLink, Loader2, Globe, AlertCircle, Star } from 'lucide-react';
import { trpc } from '@renderer/lib/trpc';
import { normalizeUrl } from '@renderer/stores/browser';
import { useBookmarkStore } from '@renderer/stores/bookmarks';
import { cn } from '@renderer/lib/utils';

export type NavigationBarProps = {
  surfaceId: string;
  url: string;
  /** Current page title (from surface event, used when bookmarking). */
  title?: string;
  loading: boolean;
  canGoBack: boolean;
  canGoForward: boolean;
  error: string | null;
  onNavigate: (url: string) => void;
};

export function NavigationBar({
  surfaceId,
  url,
  title,
  loading,
  canGoBack,
  canGoForward,
  error,
  onNavigate,
}: NavigationBarProps) {
  const [addressValue, setAddressValue] = useState(url);
  const bookmarks = useBookmarkStore((s) => s.bookmarks);
  const addBookmark = useBookmarkStore((s) => s.addBookmark);
  const toggleFrequent = useBookmarkStore((s) => s.toggleFrequent);

  // Check if current URL is already bookmarked
  const existingBookmark = bookmarks.find((b) => b.url === url);

  // Sync address bar when the URL changes from navigation (back/forward/link click)
  useEffect(() => {
    setAddressValue(url);
  }, [url]);

  const handleBack = useCallback(() => {
    void window.surfaceBridge?.goBack(surfaceId);
  }, [surfaceId]);

  const handleForward = useCallback(() => {
    void window.surfaceBridge?.goForward(surfaceId);
  }, [surfaceId]);

  const handleReload = useCallback(() => {
    void window.surfaceBridge?.reload(surfaceId);
  }, [surfaceId]);

  const handleOpenExternal = useCallback(async () => {
    if (!url) return;
    try {
      await trpc.system.openExternal.mutate(url);
    } catch {
      // best-effort
    }
  }, [url]);

  // Bookmark the current page (or toggle frequent if already bookmarked)
  const handleBookmark = useCallback(async () => {
    if (!url) return;
    if (existingBookmark) {
      // Toggle frequent flag on existing bookmark
      await toggleFrequent(existingBookmark.id);
    } else {
      // Create new bookmark with current URL and title
      await addBookmark({ url, title: title || url, frequent: true });
    }
  }, [url, title, existingBookmark, addBookmark, toggleFrequent]);

  const handleSubmit = useCallback((e: FormEvent) => {
    e.preventDefault();
    const normalized = normalizeUrl(addressValue);
    if (normalized && normalized !== url) {
      onNavigate(normalized);
    } else {
      // Restore to current URL if invalid or unchanged
      setAddressValue(url);
    }
  }, [addressValue, url, onNavigate]);

  return (
    <div className="flex h-9 shrink-0 items-center gap-1 border-b bg-secondary/30 px-2">
      {/* 后退 */}
      <button
        onClick={handleBack}
        disabled={!canGoBack}
        title="后退"
        className={cn(
          'flex items-center justify-center rounded p-1.5 transition-colors',
          canGoBack
            ? 'text-muted-foreground hover:bg-accent hover:text-foreground'
            : 'cursor-not-allowed text-muted-foreground/30',
        )}
      >
        <ArrowLeft className="h-4 w-4" />
      </button>

      {/* 前进 */}
      <button
        onClick={handleForward}
        disabled={!canGoForward}
        title="前进"
        className={cn(
          'flex items-center justify-center rounded p-1.5 transition-colors',
          canGoForward
            ? 'text-muted-foreground hover:bg-accent hover:text-foreground'
            : 'cursor-not-allowed text-muted-foreground/30',
        )}
      >
        <ArrowRight className="h-4 w-4" />
      </button>

      {/* 刷新 / 加载中 */}
      <button
        onClick={handleReload}
        disabled={loading}
        title={loading ? '加载中...' : '刷新'}
        className="flex items-center justify-center rounded p-1.5 text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
      >
        {loading ? (
          <Loader2 className="h-4 w-4 animate-spin" />
        ) : (
          <RotateCw className="h-4 w-4" />
        )}
      </button>

      {/* 地址栏 */}
      <form onSubmit={handleSubmit} className="flex flex-1 items-center">
        <div className="flex w-full items-center gap-1.5 rounded-md border border-border/50 bg-background px-2 py-1 transition-colors focus-within:border-primary">
          {error ? (
            <AlertCircle className="h-3.5 w-3.5 shrink-0 text-status-fail-foreground" />
          ) : (
            <Globe className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
          )}
          <input
            type="text"
            value={addressValue}
            onChange={(e) => setAddressValue(e.target.value)}
            onFocus={(e) => e.target.select()}
            placeholder="输入网址..."
            className="flex-1 bg-transparent text-xs text-foreground outline-none placeholder:text-muted-foreground"
            aria-label="地址栏"
            spellCheck={false}
          />
          {loading && (
            <Loader2 className="h-3 w-3 shrink-0 animate-spin text-muted-foreground" />
          )}
        </div>
      </form>

      {/* 收藏当前页 */}
      <button
        onClick={handleBookmark}
        disabled={!url}
        title={existingBookmark ? '取消常用' : '收藏为常用书签'}
        className={cn(
          'flex items-center justify-center rounded p-1.5 transition-colors',
          url
            ? existingBookmark?.frequent
              ? 'text-primary hover:bg-accent'
              : 'text-muted-foreground hover:bg-accent hover:text-foreground'
            : 'cursor-not-allowed text-muted-foreground/30',
        )}
      >
        <Star className={cn('h-4 w-4', existingBookmark?.frequent && 'fill-current')} />
      </button>

      {/* 在系统浏览器中打开 */}
      <button
        onClick={handleOpenExternal}
        disabled={!url}
        title="在系统浏览器中打开"
        className={cn(
          'flex items-center justify-center rounded p-1.5 transition-colors',
          url
            ? 'text-muted-foreground hover:bg-accent hover:text-foreground'
            : 'cursor-not-allowed text-muted-foreground/30',
        )}
      >
        <ExternalLink className="h-4 w-4" />
      </button>
    </div>
  );
}
