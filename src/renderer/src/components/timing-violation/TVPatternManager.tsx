/**
 * TVPatternManager — Pattern 管理面板
 *
 * 展示所有历史确认 Pattern 列表，支持清除所有 Pattern。
 * 每条 Pattern 显示：Hierarchy / Check / 确认人 / 结果 / 理由 / 使用次数 / 最后使用时间。
 */

import { useEffect, useState } from 'react';
import { X, Trash2, Loader2, Search } from 'lucide-react';
import { useTimingViolationStore, type ViolationPattern } from '@renderer/stores/timing-violation';
import { useProjectStore } from '@renderer/stores/project';
import { cn } from '@renderer/lib/utils';

type PatternManagerProps = {
  open: boolean;
  onClose: () => void;
};

export function TVPatternManager({ open, onClose }: PatternManagerProps) {
  const projectId = useProjectStore((s) => s.currentProjectId);
  const patterns = useTimingViolationStore((s) => s.patterns);
  const loading = useTimingViolationStore((s) => s.loadingPatterns);
  const loadPatterns = useTimingViolationStore((s) => s.loadPatterns);
  const clearAllPatterns = useTimingViolationStore((s) => s.clearAllPatterns);

  const [searchText, setSearchText] = useState('');
  const [clearing, setClearing] = useState(false);

  useEffect(() => {
    if (open && projectId) {
      void loadPatterns(projectId);
    }
  }, [open, projectId, loadPatterns]);

  if (!open) return null;

  const filteredPatterns = searchText
    ? patterns.filter(
        (p) =>
          p.hierPattern.includes(searchText) ||
          p.checkPattern.includes(searchText) ||
          (p.defaultConfirmer ?? '').includes(searchText),
      )
    : patterns;

  const handleClearAll = async () => {
    if (!projectId) return;
    if (!window.confirm(`确定要清除所有 ${patterns.length} 条 Pattern 吗？此操作不可撤销。`)) return;
    setClearing(true);
    await clearAllPatterns(projectId);
    setClearing(false);
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50" onClick={onClose}>
      <div
        className="flex max-h-[80vh] w-[800px] flex-col rounded-lg border border-border bg-background shadow-xl"
        onClick={(e) => e.stopPropagation()}
      >
        {/* 头部 */}
        <div className="flex items-center justify-between border-b px-4 py-3">
          <h2 className="text-sm font-semibold">
            Pattern 管理
            {patterns.length > 0 && (
              <span className="ml-2 text-xs text-muted-foreground">共 {patterns.length} 条</span>
            )}
          </h2>
          <div className="flex items-center gap-2">
            <button
              onClick={handleClearAll}
              disabled={clearing || patterns.length === 0}
              className={cn(
                'flex items-center gap-1 rounded-md border border-destructive/30 px-2 py-1 text-xs text-destructive transition-colors',
                'hover:bg-destructive/10',
                (clearing || patterns.length === 0) && 'opacity-40 cursor-not-allowed',
              )}
            >
              {clearing ? <Loader2 className="h-3 w-3 animate-spin" /> : <Trash2 className="h-3 w-3" />}
              清除全部
            </button>
            <button onClick={onClose} className="rounded-md p-1 text-muted-foreground hover:bg-accent hover:text-foreground">
              <X className="h-4 w-4" />
            </button>
          </div>
        </div>

        {/* 搜索栏 */}
        <div className="border-b px-4 py-2">
          <div className="flex items-center gap-2 rounded-md border border-border bg-secondary/20 px-2 py-1">
            <Search className="h-3.5 w-3.5 text-muted-foreground" />
            <input
              type="text"
              value={searchText}
              onChange={(e) => setSearchText(e.target.value)}
              placeholder="搜索 Hierarchy / Check / 确认人..."
              className="flex-1 bg-transparent text-xs outline-none placeholder:text-muted-foreground"
            />
          </div>
        </div>

        {/* 列表 */}
        <div className="flex-1 overflow-auto">
          {loading ? (
            <div className="flex h-full items-center justify-center text-sm text-muted-foreground">
              <Loader2 className="mr-2 h-4 w-4 animate-spin" />
              加载中...
            </div>
          ) : filteredPatterns.length === 0 ? (
            <div className="flex h-full flex-col items-center justify-center gap-2 text-sm text-muted-foreground">
              <p>暂无 Pattern 数据</p>
              <p className="text-[11px]">手动确认违例后，Pattern 会自动保存到这里</p>
            </div>
          ) : (
            <div className="divide-y divide-border/30">
              {filteredPatterns.map((p) => (
                <PatternRow key={p.id} pattern={p} />
              ))}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

function PatternRow({ pattern }: { pattern: ViolationPattern }) {
  const [expanded, setExpanded] = useState(false);

  const resultColor = pattern.defaultResult === 'pass' ? 'text-green-600 dark:text-green-400' : 'text-red-600 dark:text-red-400';

  return (
    <div className="px-4 py-2 hover:bg-accent/20 transition-colors cursor-pointer" onClick={() => setExpanded(!expanded)}>
      <div className="flex items-center gap-3 text-xs">
        <div className="flex-1 min-w-0">
          <span className="font-mono text-foreground truncate block">{pattern.hierPattern}</span>
        </div>
        <div className="w-16 shrink-0 text-center">
          <span className={cn('font-medium', resultColor)}>{pattern.defaultResult ?? '—'}</span>
        </div>
        <div className="w-20 shrink-0 text-muted-foreground">{pattern.defaultConfirmer ?? '—'}</div>
        <div className="w-16 shrink-0 text-right tabular-nums text-muted-foreground">
          ×{pattern.matchCount}
        </div>
        <div className="w-32 shrink-0 text-right text-[10px] text-muted-foreground">
          {pattern.lastUsed}
        </div>
      </div>
      {expanded && (
        <div className="mt-2 space-y-1 text-[11px] text-muted-foreground">
          <div>
            <span className="font-semibold">Check: </span>
            <span className="font-mono text-foreground break-all">{pattern.checkPattern}</span>
          </div>
          {pattern.defaultReason && (
            <div>
              <span className="font-semibold">理由: </span>
              <span className="text-foreground">{pattern.defaultReason}</span>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
