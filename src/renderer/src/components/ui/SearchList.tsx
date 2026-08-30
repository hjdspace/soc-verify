import { Search, X } from 'lucide-react';
import { cn } from '@renderer/lib/utils';

/**
 * 搜索框公共小件——SearchList primitive 的可复用切片，CommandPalette 与
 * 会话历史 HistoryView（RightPanel）共用：非空清除按钮、空状态卡片、
 * 匹配片段高亮。结果行与行间滑动高亮由宿主各自布局承担（面板侧用 GlideMenu）。
 *
 * 视觉/交互参考 beautiful-ui: D:\AI\beautiful-ui\components\primitives\SearchList.tsx
 */

type SearchClearButtonProps = {
  onClear: () => void;
  /** 追加定位类（如 HistoryView 搜索框内 absolute 右缘） */
  className?: string;
  testId?: string;
};

/** 输入非空时出现的清除按钮（.search-clear-in 150ms 淡入）；清空与回焦由宿主 onClear 处理 */
export function SearchClearButton({ onClear, className, testId }: SearchClearButtonProps) {
  return (
    <button
      type="button"
      aria-label="清除搜索"
      title="清除搜索"
      data-testid={testId}
      onClick={onClear}
      className={cn(
        'search-clear-in flex size-6 shrink-0 items-center justify-center rounded-full text-muted-foreground transition-colors duration-100 hover:bg-accent hover:text-foreground',
        className,
      )}
    >
      <X className="size-3" strokeWidth={2.2} />
    </button>
  );
}

type SearchEmptyStateProps = {
  /** 主文案（如"没有匹配的命令"） */
  title: string;
  /** 副文案（下一步动作提示） */
  hint: string;
  testId?: string;
};

/** 无匹配空状态卡：图标座 + 主/副文案（.search-empty-in 250ms 淡入） */
export function SearchEmptyState({ title, hint, testId }: SearchEmptyStateProps) {
  return (
    <div className="search-empty-in flex flex-col items-center justify-center gap-1 px-4 py-8" data-testid={testId}>
      <span className="search-empty-seat mb-1.5 flex size-8 items-center justify-center rounded-lg bg-muted text-muted-foreground">
        <Search className="size-4" strokeWidth={1.8} />
      </span>
      <span className="text-[13px] font-medium text-foreground">{title}</span>
      <span className="text-xs text-muted-foreground">{hint}</span>
    </div>
  );
}

/** 结果行 label 中首个命中 query（大小写不敏感）的片段高亮为 mark；无命中原样渲染 */
export function SearchMatch({ label, query }: { label: string; query: string }) {
  const kw = query.trim().toLowerCase();
  const index = kw ? label.toLowerCase().indexOf(kw) : -1;
  if (index < 0) return <>{label}</>;
  return (
    <>
      {label.slice(0, index)}
      <mark className="bg-transparent font-medium text-primary">{label.slice(index, index + kw.length)}</mark>
      {label.slice(index + kw.length)}
    </>
  );
}
