/**
 * KbCategoryTree — 分类树面板（分类列表 + 计数，点击筛选文档列表）。
 */

import { FolderOpen, Folder } from 'lucide-react';
import { useKbStore } from '@renderer/stores/kb';
import { cn } from '@renderer/lib/utils';

export function KbCategoryTree() {
  const categories = useKbStore((s) => s.categories);
  const documents = useKbStore((s) => s.documents);
  const selectedCategory = useKbStore((s) => s.selectedCategory);
  const setSelectedCategory = useKbStore((s) => s.setSelectedCategory);

  const totalCount = documents.length;

  return (
    <aside className="flex w-52 shrink-0 flex-col overflow-y-auto border-r border-border bg-card p-2">
      <div className="mb-1 px-2 py-1 text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">
        分类（AI 自动归类）
      </div>

      {/* 全部文档 */}
      <button
        onClick={() => setSelectedCategory(null)}
        className={cn(
          'flex items-center justify-between rounded px-2.5 py-1.5 text-xs transition-colors',
          selectedCategory === null
            ? 'bg-primary text-primary-foreground'
            : 'text-card-foreground hover:bg-accent',
        )}
      >
        <span className="flex items-center gap-2">
          <FolderOpen className="h-3.5 w-3.5" />
          全部文档
        </span>
        <span
          className={cn(
            'rounded-full px-2 py-0.5 text-[10px]',
            selectedCategory === null
              ? 'bg-primary-foreground/20'
              : 'bg-secondary text-muted-foreground',
          )}
        >
          {totalCount}
        </span>
      </button>

      {/* 分类列表 */}
      {categories.map((cat) => (
        <button
          key={cat.name}
          onClick={() => setSelectedCategory(cat.name)}
          className={cn(
            'flex items-center justify-between rounded px-2.5 py-1.5 text-xs transition-colors',
            selectedCategory === cat.name
              ? 'bg-primary text-primary-foreground'
              : 'text-card-foreground hover:bg-accent',
          )}
        >
          <span className="flex items-center gap-2 overflow-hidden">
            <Folder className="h-3.5 w-3.5 shrink-0" />
            <span className="truncate">{cat.name}</span>
          </span>
          <span
            className={cn(
              'rounded-full px-2 py-0.5 text-[10px]',
              selectedCategory === cat.name
                ? 'bg-primary-foreground/20'
                : 'bg-secondary text-muted-foreground',
            )}
          >
            {cat.count}
          </span>
        </button>
      ))}

      {categories.length === 0 && (
        <div className="px-2 py-1 text-[11px] text-muted-foreground">
          暂无分类
        </div>
      )}
    </aside>
  );
}
