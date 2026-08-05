/**
 * NewTabPage — 浏览器新标签首页。
 *
 * 显示地址输入框、常用书签占位和分组入口。
 * 用户输入 URL 后提交，触发 onNavigate 回调。
 * 非 http/https 输入被拒绝并显示明确提示。
 */
import { useState, useCallback, type FormEvent } from 'react';
import { Globe, ArrowRight, AlertCircle, Bookmark, Folder } from 'lucide-react';
import { normalizeUrl } from '@renderer/stores/browser';
import { cn } from '@renderer/lib/utils';

export type NewTabPageProps = {
  onNavigate: (url: string) => void;
};

/** 预设常用书签占位 */
const QUICK_LINKS = [
  { name: '回归平台', url: 'https://regression.example.com', icon: '📊' },
  { name: 'CQP', url: 'https://cqp.example.com', icon: '🔍' },
  { name: '文档中心', url: 'https://docs.example.com', icon: '📚' },
];

/** 分组占位 */
const GROUPS = [
  { name: '常用', count: 3 },
  { name: '回归', count: 5 },
  { name: '文档', count: 2 },
];

export function NewTabPage({ onNavigate }: NewTabPageProps) {
  const [input, setInput] = useState('');
  const [error, setError] = useState<string | null>(null);

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

      {/* 常用书签占位 */}
      <div className="mt-10 w-full max-w-2xl">
        <div className="mb-3 flex items-center gap-1.5 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
          <Bookmark className="h-3.5 w-3.5" />
          <span>常用书签</span>
        </div>
        <div className="grid grid-cols-3 gap-3">
          {QUICK_LINKS.map((link) => (
            <button
              key={link.name}
              onClick={() => onNavigate(link.url)}
              className="flex items-center gap-2.5 rounded-lg border border-border/50 bg-secondary/20 px-3 py-2.5 text-left transition-colors hover:border-primary hover:bg-accent"
            >
              <span className="text-lg">{link.icon}</span>
              <div className="min-w-0 flex-1">
                <div className="truncate text-xs font-medium text-foreground">{link.name}</div>
                <div className="truncate text-[10px] text-muted-foreground">{link.url}</div>
              </div>
            </button>
          ))}
        </div>
      </div>

      {/* 分组入口占位 */}
      <div className="mt-8 w-full max-w-2xl">
        <div className="mb-3 flex items-center gap-1.5 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
          <Folder className="h-3.5 w-3.5" />
          <span>书签分组</span>
        </div>
        <div className="flex flex-wrap gap-2">
          {GROUPS.map((group) => (
            <button
              key={group.name}
              className={cn(
                'flex items-center gap-1.5 rounded-md border border-border/50 bg-secondary/20 px-3 py-1.5 text-xs text-muted-foreground transition-colors hover:border-primary hover:bg-accent hover:text-foreground',
              )}
            >
              <Folder className="h-3 w-3 opacity-50" />
              <span>{group.name}</span>
              <span className="text-[10px] opacity-50">({group.count})</span>
            </button>
          ))}
        </div>
      </div>

      {/* 提示 */}
      <div className="mt-auto pt-8 text-[11px] text-muted-foreground/60">
        仅支持 http/https 网址 · 书签管理功能将在后续版本中完善
      </div>
    </div>
  );
}
