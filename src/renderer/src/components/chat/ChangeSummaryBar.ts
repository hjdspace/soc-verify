/**
 * ChangeSummaryBar — 聊天输入框上方的代码改动摘要条。
 *
 * 展示当前未审阅的文件改动数量，提供"全部接受"和"全部拒绝"按钮。
 * 点击展开后显示文件列表，每行显示文件名和增删行数，点击文件可打开 diff-review。
 * 所有文件处理完毕后该组件自动隐藏。
 */

import { useState, useMemo, useCallback } from 'react';
import { ChevronDown, ChevronUp, Check, X, GitCompare, FileText, FilePlus } from 'lucide-react';
import { useDiffReviewStore } from '@renderer/stores/diff-review';
import { cn } from '@renderer/lib/utils';
import type { DiffToolCall } from '@shared/types';

// ─── 行数计算 ──────────────────────────────────────────────

function countLines(text: string | undefined): number {
  if (!text) return 0;
  const trimmed = text.replace(/\n$/, '');
  if (trimmed === '') return 0;
  return trimmed.split('\n').length;
}

interface FileStats {
  filePath: string;
  fileName: string;
  addCount: number;
  delCount: number;
  isNewFile: boolean;
  reviewed: boolean;
}

function computeFileStats(
  filePath: string,
  fileName: string,
  toolCalls: DiffToolCall[],
  isNewFile: boolean,
  reviewed: boolean,
): FileStats {
  let addCount = 0;
  let delCount = 0;

  if (isNewFile) {
    // WRITE: all lines are additions
    for (const tc of toolCalls) {
      addCount += countLines(tc.content);
    }
  } else {
    // EDIT: count added/deleted lines from oldText vs newText
    for (const tc of toolCalls) {
      const oldLines = countLines(tc.oldText);
      const newLines = countLines(tc.newText);
      // Simple approximation: net difference
      if (newLines > oldLines) {
        addCount += newLines - oldLines;
      } else if (oldLines > newLines) {
        delCount += oldLines - newLines;
      }
      // For same-line-count replacements, count as equal add+del
      if (oldLines > 0 && newLines > 0 && oldLines === newLines) {
        addCount += newLines;
        delCount += oldLines;
      }
    }
  }

  return { filePath, fileName, addCount, delCount, isNewFile, reviewed };
}

// ─── Component ─────────────────────────────────────────────

export function ChangeSummaryBar() {
  const queue = useDiffReviewStore((s) => s.queue);
  const acceptAll = useDiffReviewStore((s) => s.acceptAll);
  const rejectAll = useDiffReviewStore((s) => s.rejectAll);
  const applyRejections = useDiffReviewStore((s) => s.applyRejections);
  const openFile = useDiffReviewStore((s) => s.openFile);
  const currentFilePath = useDiffReviewStore((s) => s.currentFilePath);

  const [expanded, setExpanded] = useState(false);
  const [applying, setApplying] = useState(false);

  // Only show unreviewed files
  const pendingEntries = useMemo(
    () => queue.filter((e) => !e.reviewed),
    [queue],
  );

  const fileStats = useMemo(
    () => pendingEntries.map((e) =>
      computeFileStats(e.filePath, e.fileName, e.toolCalls, e.isNewFile, e.reviewed),
    ),
    [pendingEntries],
  );

  const totalAdd = useMemo(
    () => fileStats.reduce((sum, f) => sum + f.addCount, 0),
    [fileStats],
  );
  const totalDel = useMemo(
    () => fileStats.reduce((sum, f) => sum + f.delCount, 0),
    [fileStats],
  );

  // 全部接受：直接调用 acceptAll，不需要先 openFile。
  // acceptAll 现在即使 currentDiff 为 null（加载失败/未加载）也能标记为已审阅。
  const handleAcceptAll = useCallback(async () => {
    setApplying(true);
    try {
      const entries = pendingEntries;
      for (const entry of entries) {
        acceptAll(entry.filePath);
      }
    } finally {
      setApplying(false);
    }
  }, [pendingEntries, acceptAll]);

  // 全部拒绝：先设置 hunk 状态为 rejected，然后尝试应用回滚。
  // 如果 diff 不可用（文件不存在等），跳过回滚直接标记为已审阅。
  const handleRejectAll = useCallback(async () => {
    setApplying(true);
    try {
      const entries = pendingEntries;
      for (const entry of entries) {
        // 先尝试打开文件加载 diff（用于 rejectAll 设置 hunk 状态）
        // 如果加载失败，rejectAll 会跳过 hunk 状态设置，直接标记为已审阅
        if (currentFilePath !== entry.filePath) {
          openFile(entry.filePath);
          // 等待 diff 加载，最多等 200ms
          await new Promise((r) => setTimeout(r, 200));
        }
        rejectAll(entry.filePath);
        await applyRejections(entry.filePath);
        // applyRejections 在 diff 不可用时会直接 return，
        // 但 markFileReviewed 仍需要被调用来标记已审阅。
        // 检查文件是否仍为未审阅状态（说明 applyRejections 未触发 markFileReviewed）
        const stillPending = useDiffReviewStore.getState().queue.find(
          (e) => !e.reviewed && e.filePath === entry.filePath,
        );
        if (stillPending) {
          // diff 不可用，直接标记为已审阅
          acceptAll(entry.filePath);
        }
      }
    } finally {
      setApplying(false);
    }
  }, [pendingEntries, currentFilePath, openFile, rejectAll, applyRejections, acceptAll]);

  // Hide if no pending files
  if (pendingEntries.length === 0) return null;

  return (
    <div className="border-b border-border/50 bg-primary/5">
      {/* ── Summary bar ─────────────────────────────── */}
      <div className="flex items-center gap-2 px-2 py-1.5">
        {/* Expand toggle */}
        <button
          onClick={() => setExpanded((v) => !v)}
          className="flex items-center gap-1 rounded text-muted-foreground transition-colors hover:text-foreground"
          title={expanded ? '收起文件列表' : '展开文件列表'}
        >
          {expanded ? (
            <ChevronUp className="h-3 w-3" />
          ) : (
            <ChevronDown className="h-3 w-3" />
          )}
          <GitCompare className="h-3 w-3 text-primary" />
          <span className="text-[11px] font-medium text-foreground">
            {pendingEntries.length} 个文件改动
          </span>
          <span className="text-[10px] text-status-pass-foreground font-mono">+{totalAdd}</span>
          <span className="text-[10px] text-destructive font-mono">−{totalDel}</span>
        </button>

        {/* Spacer */}
        <div className="flex-1" />

        {/* Action buttons */}
        <button
          onClick={handleRejectAll}
          disabled={applying}
          className="flex items-center gap-1 rounded border border-border px-2 py-0.5 text-[10px] text-muted-foreground transition-colors hover:bg-accent hover:text-foreground disabled:opacity-50"
          title="拒绝所有文件改动"
        >
          <X className="h-2.5 w-2.5" />
          全部拒绝
        </button>
        <button
          onClick={handleAcceptAll}
          disabled={applying}
          className="flex items-center gap-1 rounded border border-status-pass/30 bg-status-pass/10 px-2 py-0.5 text-[10px] text-status-pass-foreground transition-colors hover:bg-status-pass/20 disabled:opacity-50"
          title="接受所有文件改动"
        >
          <Check className="h-2.5 w-2.5" />
          全部接受
        </button>
      </div>

      {/* ── Expanded file list ─────────────────────── */}
      {expanded && (
        <div className="max-h-40 overflow-y-auto border-t border-border/50 px-1 py-1">
          {fileStats.map((f) => (
            <button
              key={f.filePath}
              onClick={() => openFile(f.filePath)}
              className={cn(
                'flex w-full items-center gap-1.5 rounded px-1.5 py-1 text-left text-[11px] transition-colors hover:bg-accent',
                currentFilePath === f.filePath && 'bg-accent/50',
              )}
              title={f.filePath}
            >
              {f.isNewFile ? (
                <FilePlus className="h-3 w-3 shrink-0 text-status-pass-foreground" />
              ) : (
                <FileText className="h-3 w-3 shrink-0 text-muted-foreground" />
              )}
              <span className="truncate font-medium text-foreground">{f.fileName}</span>
              <span className="ml-auto flex shrink-0 items-center gap-1 font-mono text-[10px]">
                <span className="text-status-pass-foreground">+{f.addCount}</span>
                <span className="text-destructive">−{f.delCount}</span>
              </span>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
