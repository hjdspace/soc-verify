/**
 * NewTabPage — 浏览器新标签首页。
 *
 * 显示地址输入框、常用书签（从书签 store 投影）和分组入口。
 * 用户输入 URL 后提交，触发 onNavigate 回调。
 * 非 http/https 输入被拒绝并显示明确提示。
 *
 * Issue #8: 书签数据来自 useBookmarkStore，不再使用硬编码占位。
 */
import { useState, useCallback, useEffect, type FormEvent } from 'react';
import { Globe, ArrowRight, AlertCircle, Bookmark, Folder, Star } from 'lucide-react';
import { normalizeUrl } from '@renderer/stores/browser';
import { useBookmarkStore } from '@renderer/stores/bookmarks';
import { cn } from '@renderer/lib/utils';

export type NewTabPageProps = {
  onNavigate: (url: string) => void;
};

export function NewTabPage({ onNavigate }: NewTabPageProps) {
  const [input, setInput] = useState('');
  const [error, setError] = useState<string | null>(null);

  const bookmarks = useBookmarkStore((s) => s.bookmarks);
  const groups = useBookmarkStore((s) => s.groups);
  const loadBookmarks = useBookmarkStore((s) => s.load);
  const getFrequentBookmarks = useBookmarkStore((s) => s.getFrequentBookmarks);
  const getBookmarksByGroup = useBookmarkStore((s) => s.getBookmarksByGroup);

  // Load bookmarks on mount
  useEffect(() => {
    void loadBookmarks();
  }, [loadBookmarks]);

  const frequentBookmarks = getFrequentBookmarks();

  const handleSubmit = useCallback((e: FormEvent) => {
    e.preventDefault();
    const normalized = normalizeUrl(input);
    if (!normalized) {
      setError('请输入有效的网址（仅支持 http/https）');
      return;
    }
    setError(null);
    onNavigate(normalized);
  }, [input, onNavigate]);

  return (
    <div className="flex h-full w-full flex-col items-center overflow-auto bg-background px-4 py-12">
      {/* 地址输入 */}
      <div className="w-full max-w-2xl">
        <form onSubmit={handleSubmit} className="relative">
          <div className="flex items-center gap-2 rounded-lg border border-border bg-secondary/30 px-3 py-2.5 transition-colors focus-within:border-primary">
            <Globe className="h-4 w-4 shrink-0 text-muted-foreground" />
            <input
              type="text"
              value={input}
              onChange={(e) => {
                setInput(e.target.value);
                if (error) setError(null);
              }}
              placeholder="输入网址或搜索..."
              autoFocus
              className="flex-1 bg-transparent text-sm text-foreground outline-none placeholder:text-muted-foreground"
              aria-label="地址栏"
            />
            <button
              type="submit"
              className="flex shrink-0 items-center justify-center rounded p-1 text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
              aria-label="前往"
            >
              <ArrowRight className="h-4 w-4" />
            </button>
          </div>
        </form>
        {error && (
          <div className="mt-2 flex items-center gap-1.5 text-xs text-status-fail-foreground">
            <AlertCircle className="h-3.5 w-3.5 shrink-0" />
            <span>{error}</span>
          </div>
        )}
      </div>

      {/* 常用书签 */}
      <div className="mt-10 w-full max-w-2xl">
        <div className="mb-3 flex items-center gap-1.5 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
          <Star className="h-3.5 w-3.5" />
          <span>常用书签</span>
        </div>
        {frequentBookmarks.length > 0 ? (
          <div className="grid grid-cols-3 gap-3">
            {frequentBookmarks.map((bm) => (
              <button
                key={bm.id}
                onClick={() => onNavigate(bm.url)}
                className="flex items-center gap-2.5 rounded-lg border border-border/50 bg-secondary/20 px-3 py-2.5 text-left transition-colors hover:border-primary hover:bg-accent"
              >
                <Globe className="h-4 w-4 shrink-0 text-muted-foreground" />
                <div className="min-w-0 flex-1">
                  <div className="truncate text-xs font-medium text-foreground">{bm.title}</div>
                  <div className="truncate text-[10px] text-muted-foreground">{bm.url}</div>
                </div>
              </button>
            ))}
          </div>
        ) : (
          <div className="rounded-lg border border-dashed border-border/50 px-4 py-6 text-center text-xs text-muted-foreground">
            暂无常用书签。点击地址栏旁的星标按钮可收藏当前页面。
          </div>
        )}
      </div>

      {/* 书签分组 */}
      <div className="mt-8 w-full max-w-2xl">
        <div className="mb-3 flex items-center gap-1.5 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
          <Folder className="h-3.5 w-3.5" />
          <span>书签分组</span>
        </div>
        {groups.length > 0 ? (
          <div className="flex flex-wrap gap-2">
            {groups.map((group) => {
              const count = getBookmarksByGroup(group.id).length;
              return (
                <button
                  key={group.id}
                  onClick={() => {
                    // Navigate to the first bookmark in the group
                    const first = getBookmarksByGroup(group.id)[0];
                    if (first) onNavigate(first.url);
                  }}
                  className={cn(
                    'flex items-center gap-1.5 rounded-md border border-border/50 bg-secondary/20 px-3 py-1.5 text-xs text-muted-foreground transition-colors hover:border-primary hover:bg-accent hover:text-foreground',
                  )}
                >
                  <Folder className="h-3 w-3 opacity-50" />
                  <span>{group.name}</span>
                  <span className="text-[10px] opacity-50">({count})</span>
                </button>
              );
            })}
          </div>
        ) : (
          <div className="text-xs text-muted-foreground/60">暂无分组</div>
        )}
      </div>

      {/* 未分组书签 */}
      {bookmarks.filter((b) => b.groupId === null && !b.frequent).length > 0 && (
        <div className="mt-6 w-full max-w-2xl">
          <div className="mb-3 flex items-center gap-1.5 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
            <Bookmark className="h-3.5 w-3.5" />
            <span>其他书签</span>
          </div>
          <div className="grid grid-cols-3 gap-3">
            {bookmarks
              .filter((b) => b.groupId === null && !b.frequent)
              .map((bm) => (
                <button
                  key={bm.id}
                  onClick={() => onNavigate(bm.url)}
                  className="flex items-center gap-2.5 rounded-lg border border-border/50 bg-secondary/20 px-3 py-2.5 text-left transition-colors hover:border-primary hover:bg-accent"
                >
                  <Globe className="h-4 w-4 shrink-0 text-muted-foreground" />
                  <div className="min-w-0 flex-1">
                    <div className="truncate text-xs font-medium text-foreground">{bm.title}</div>
                    <div className="truncate text-[10px] text-muted-foreground">{bm.url}</div>
                  </div>
                </button>
              ))}
          </div>
        </div>
      )}

      {/* 提示 */}
      <div className="mt-auto pt-8 text-[11px] text-muted-foreground/60">
        仅支持 http/https 网址
      </div>
    </div>
  );
}
