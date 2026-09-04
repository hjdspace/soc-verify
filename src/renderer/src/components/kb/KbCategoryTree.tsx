/**
 * KbCategoryTree — 分类树面板（分类列表 + 计数，点击筛选文档列表）。
 *
 * 功能：
 *   - 分类列表点击 → 筛选文档列表
 *   - 右键分类 → 上下文菜单（重命名分类）
 *   - 内联重命名输入框 → Enter 确认 / Esc 取消
 */

import { useState, useCallback, useRef, useEffect } from 'react';
import { FolderOpen, Folder, Pencil } from 'lucide-react';
import { useKbStore } from '@renderer/stores/kb';
import { cn } from '@renderer/lib/utils';

export function KbCategoryTree() {
  const categories = useKbStore((s) => s.categories);
  const documents = useKbStore((s) => s.documents);
  const selectedCategory = useKbStore((s) => s.selectedCategory);
  const setSelectedCategory = useKbStore((s) => s.setSelectedCategory);
  const renameCategory = useKbStore((s) => s.renameCategory);

  const totalCount = documents.length;

  // ── 右键菜单状态 ──────────────────────────────────────────
  const [contextMenu, setContextMenu] = useState<{
    x: number;
    y: number;
    categoryName: string;
  } | null>(null);

  // ── 内联重命名状态 ────────────────────────────────────────
  const [renamingCategory, setRenamingCategory] = useState<string | null>(null);
  const [renameValue, setRenameValue] = useState('');
  const renameInputRef = useRef<HTMLInputElement>(null);

  // 右键菜单关闭：点击任意位置
  useEffect(() => {
    if (!contextMenu) return;
    const handleClick = () => setContextMenu(null);
    window.addEventListener('click', handleClick);
    return () => window.removeEventListener('click', handleClick);
  }, [contextMenu]);

  // 重命名输入框聚焦
  useEffect(() => {
    if (renamingCategory && renameInputRef.current) {
      renameInputRef.current.focus();
      renameInputRef.current.select();
    }
  }, [renamingCategory]);

  // ── 右键菜单 ─────────────────────────────────────────────
  const handleContextMenu = useCallback((e: React.MouseEvent, categoryName: string) => {
    e.preventDefault();
    e.stopPropagation();
    setContextMenu({ x: e.clientX, y: e.clientY, categoryName });
  }, []);

  // ── 开始重命名 ────────────────────────────────────────────
  const startRename = useCallback((categoryName: string) => {
    setRenamingCategory(categoryName);
    setRenameValue(categoryName);
    setContextMenu(null);
  }, []);

  // ── 确认重命名 ────────────────────────────────────────────
  const confirmRename = useCallback(async () => {
    if (!renamingCategory) return;
    const newName = renameValue.trim();
    if (newName && newName !== renamingCategory) {
      await renameCategory(renamingCategory, newName);
    }
    setRenamingCategory(null);
    setRenameValue('');
  }, [renamingCategory, renameValue, renameCategory]);

  // ── 取消重命名 ────────────────────────────────────────────
  const cancelRename = useCallback(() => {
    setRenamingCategory(null);
    setRenameValue('');
  }, []);

  return (
    <aside className="flex w-52 shrink-0 flex-col overflow-y-auto border-r border-border bg-card p-2">
      <div className="mb-1 px-2 py-1 text-[10px] font-semibold uppercase tracking-[0.06em] text-muted-foreground">
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
        <div
          key={cat.name}
          onContextMenu={(e) => handleContextMenu(e, cat.name)}
          className="relative"
        >
          {renamingCategory === cat.name ? (
            // 内联重命名输入框
            <div className="flex items-center gap-1 px-1 py-0.5">
              <input
                ref={renameInputRef}
                type="text"
                value={renameValue}
                onChange={(e) => setRenameValue(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') {
                    e.preventDefault();
                    void confirmRename();
                  }
                  if (e.key === 'Escape') {
                    e.preventDefault();
                    cancelRename();
                  }
                }}
                onBlur={() => void confirmRename()}
                className="h-6 flex-1 rounded border border-primary bg-background px-2 text-xs outline-none"
              />
            </div>
          ) : (
            <button
              onClick={() => setSelectedCategory(cat.name)}
              className={cn(
                'flex w-full items-center justify-between rounded px-2.5 py-1.5 text-xs transition-colors',
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
          )}
        </div>
      ))}

      {categories.length === 0 && (
        <div className="px-2 py-1 text-[11px] text-muted-foreground">
          暂无分类
        </div>
      )}

      {/* 右键上下文菜单 */}
      {contextMenu && (
        <div
          className="fixed z-50 min-w-[120px] rounded-lg border border-border bg-popover p-1 shadow-lg"
          style={{ left: contextMenu.x, top: contextMenu.y }}
          onClick={(e) => e.stopPropagation()}
        >
          <button
            onClick={() => startRename(contextMenu.categoryName)}
            className="flex w-full items-center gap-2 rounded px-2 py-1.5 text-xs text-card-foreground transition-colors hover:bg-accent"
          >
            <Pencil className="h-3 w-3" />
            重命名分类
          </button>
        </div>
      )}
    </aside>
  );
}
