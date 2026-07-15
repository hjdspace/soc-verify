/**
 * DiffReviewView — 在中栏展示完整文件 diff，支持逐 hunk 接受/拒绝。
 *
 * 展示整个文件内容，修改部分用红绿高亮（无删除线），每块改动旁有接受/拒绝按钮，
 * 底部有「全部接受」「应用」「全部拒绝」「下个文件」导航。
 */

import { useState, useEffect, useRef, useCallback } from 'react';
import { Check, X, ChevronDown, ChevronUp, ArrowRight, Loader2, GitCompare } from 'lucide-react';
import { useDiffReviewStore, type ReviewEntry } from '@renderer/stores/diff-review';
import { useProjectStore } from '@renderer/stores/project';
import { trpc } from '@renderer/lib/trpc';
import hljs from 'highlight.js';
import { detectLanguage } from '@renderer/components/chat/tool-helpers';
import { cn } from '@renderer/lib/utils';
import type { DiffLine, DiffHunkInfo } from '@shared/types';

// ─── Syntax highlighting ────────────────────────────────────

function highlightCode(code: string, language: string): string {
  try {
    if (language && language !== 'plaintext' && hljs.getLanguage(language)) {
      return hljs.highlight(code, { language }).value;
    }
    return hljs.highlightAuto(code).value;
  } catch {
    return code.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  }
}

// ─── DiffReviewView ─────────────────────────────────────────

interface DiffReviewViewProps {
  entry: ReviewEntry;
}

export function DiffReviewView({ entry }: DiffReviewViewProps) {
  const projectId = useProjectStore((s) => s.currentProjectId);
  const currentDiff = useDiffReviewStore((s) => s.currentDiff);
  const loading = useDiffReviewStore((s) => s.loading);
  const hunkStates = useDiffReviewStore((s) => s.hunkStates);
  const openFile = useDiffReviewStore((s) => s.openFile);
  const setHunkState = useDiffReviewStore((s) => s.setHunkState);
  const acceptAll = useDiffReviewStore((s) => s.acceptAll);
  const rejectAll = useDiffReviewStore((s) => s.rejectAll);
  const applyRejections = useDiffReviewStore((s) => s.applyRejections);
  const nextFile = useDiffReviewStore((s) => s.nextFile);
  const getQueuePosition = useDiffReviewStore((s) => s.getQueuePosition);
  const getNextFileName = useDiffReviewStore((s) => s.getNextFileName);

  const [diffData, setDiffData] = useState(currentDiff);
  const containerRef = useRef<HTMLDivElement>(null);
  const hunkRefs = useRef<Map<number, HTMLDivElement>>(new Map());

  // Load diff data from backend
  useEffect(() => {
    if (!projectId) return;
    let cancelled = false;
    setDiffData(null);

    trpc.project.getFileDiff.query({
      projectId,
      filePath: entry.filePath,
      toolCalls: entry.toolCalls,
    })
      .then((data) => {
        if (!cancelled) setDiffData(data);
      })
      .catch(() => {
        if (!cancelled) setDiffData(null);
      });

    return () => { cancelled = true; };
  }, [projectId, entry.filePath, entry.toolCalls]);

  // Sync with store's currentDiff
  useEffect(() => {
    setDiffData(currentDiff);
  }, [currentDiff]);

  const language = detectLanguage(entry.filePath);
  const { current, total } = getQueuePosition();
  const nextFileName = getNextFileName();
  const hasRejections = diffData
    ? diffData.hunks.some((h) => hunkStates[`${entry.filePath}:${h.id}`] === 'rejected')
    : false;

  // Hunk navigation
  const navigateHunk = useCallback((direction: number) => {
    if (!diffData) return;
    const hunks = diffData.hunks;
    if (hunks.length === 0) return;

    // Find current hunk position based on scroll
    let currentIdx = 0;
    for (let i = 0; i < hunks.length; i++) {
      const el = hunkRefs.current.get(hunks[i].id);
      if (el && el.getBoundingClientRect().bottom > 100) {
        currentIdx = i;
        break;
      }
    }

    const nextIdx = Math.max(0, Math.min(hunks.length - 1, currentIdx + direction));
    const targetEl = hunkRefs.current.get(hunks[nextIdx].id);
    if (targetEl) {
      targetEl.scrollIntoView({ behavior: 'smooth', block: 'center' });
    }
  }, [diffData]);

  // Keyboard navigation
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.shiftKey && e.key === 'ArrowDown') {
        e.preventDefault();
        navigateHunk(1);
      } else if (e.shiftKey && e.key === 'ArrowUp') {
        e.preventDefault();
        navigateHunk(-1);
      }
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [navigateHunk]);

  const handleApply = async () => {
    await applyRejections(entry.filePath);
    // Refresh after apply
    openFile(entry.filePath);
  };

  // ── Loading state ──
  if (loading || !diffData) {
    return (
      <div className="flex h-full flex-1 items-center justify-center text-xs text-muted-foreground">
        <Loader2 className="mr-2 h-4 w-4 animate-spin" />
        加载 diff...
      </div>
    );
  }

  const totalAdd = diffData.totalAdd;
  const totalDel = diffData.totalDel;

  // Group diff lines by hunk for rendering
  const hunks = diffData.hunks;
  const lines = diffData.lines;

  return (
    <div className="flex h-full flex-1 flex-col overflow-hidden">
      {/* ── Header ── */}
      <div className="flex items-center gap-3 border-b bg-secondary/20 px-3 py-1.5">
        <GitCompare className="h-3.5 w-3.5 shrink-0 text-primary" />
        <span className="truncate text-xs font-medium text-foreground" title={entry.filePath}>
          {entry.filePath}
        </span>
        <div className="flex gap-2 text-[11px]">
          <span className="text-green-500">+{totalAdd}</span>
          <span className="text-red-500">-{totalDel}</span>
          <span className="text-muted-foreground">{hunks.length} hunks</span>
        </div>
        {/* Hunk navigation */}
        <div className="ml-auto flex gap-1">
          <button
            onClick={() => navigateHunk(-1)}
            title="上一个改动 (Shift+↑)"
            className="rounded border border-border p-1 text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
          >
            <ChevronUp className="h-3 w-3" />
          </button>
          <button
            onClick={() => navigateHunk(1)}
            title="下一个改动 (Shift+↓)"
            className="rounded border border-border p-1 text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
          >
            <ChevronDown className="h-3 w-3" />
          </button>
        </div>
      </div>

      {/* ── Code area ── */}
      <div ref={containerRef} className="flex min-h-0 flex-1 overflow-auto font-mono text-[12px] leading-[1.55]">
        {/* Line number gutter */}
        <div className="sticky left-0 z-10 shrink-0 select-none border-r border-border/40 bg-secondary/20 text-right">
          {lines.map((line, i) => (
            <div
              key={i}
              className={cn(
                'px-2 py-0 text-[11px] tabular-nums',
                line.type === 'add' && 'bg-green-500/5 text-green-600/60 dark:text-green-500/40',
                line.type === 'del' && 'bg-red-500/5 text-red-600/60 dark:text-red-500/40',
                line.type === 'ctx' && 'text-muted-foreground/30',
              )}
              style={{ minHeight: '1.55em', minWidth: '44px' }}
            >
              {line.type === 'add' ? (line.newLine ?? '') : line.type === 'del' ? (line.oldLine ?? '') : (line.oldLine ?? '')}
            </div>
          ))}
        </div>

        {/* File content with diff */}
        <div className="flex-1 overflow-x-auto py-0">
          {renderLines(lines, hunks, entry, hunkStates, setHunkState, language, hunkRefs)}
        </div>
      </div>

      {/* ── Bottom toolbar ── */}
      <div className="flex items-center gap-3 border-t bg-secondary/20 px-3 py-2">
        {/* Queue position */}
        <div className="flex items-center gap-1 text-[11px] text-muted-foreground">
          <span className="font-semibold text-foreground">{current}</span>
          <span>/</span>
          <span>{total} 文件</span>
        </div>

        <div className="h-5 w-px bg-border" />

        {/* Accept all */}
        <button
          onClick={() => acceptAll(entry.filePath)}
          className="flex items-center gap-1 rounded border border-green-500/30 bg-green-500/10 px-2.5 py-1 text-[11px] text-green-500 transition-colors hover:bg-green-500/20"
        >
          <Check className="h-3 w-3" />
          全部接受
        </button>

        {/* Apply */}
        <button
          onClick={handleApply}
          disabled={!hasRejections}
          className={cn(
            'flex items-center gap-1 rounded px-2.5 py-1 text-[11px] transition-colors',
            hasRejections
              ? 'border border-primary/40 bg-primary/15 text-primary hover:bg-primary/25'
              : 'cursor-not-allowed border border-border bg-secondary/30 text-muted-foreground/50',
          )}
        >
          <Check className="h-3 w-3" />
          应用
        </button>

        <div className="h-5 w-px bg-border" />

        {/* Reject all */}
        <button
          onClick={() => rejectAll(entry.filePath)}
          className="flex items-center gap-1 rounded border border-border px-2.5 py-1 text-[11px] text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
        >
          <X className="h-3 w-3" />
          全部拒绝
        </button>

        {/* Next file */}
        {nextFileName && (
          <button
            onClick={() => nextFile()}
            className="ml-auto flex items-center gap-1.5 rounded border border-primary/30 bg-primary/10 px-2.5 py-1 text-[11px] text-primary transition-colors hover:bg-primary/20"
          >
            <ArrowRight className="h-3 w-3" />
            下个文件:
            <span className="max-w-[180px] truncate">{nextFileName}</span>
          </button>
        )}
      </div>
    </div>
  );
}

// ─── Line rendering ─────────────────────────────────────────

function renderLines(
  lines: DiffLine[],
  hunks: DiffHunkInfo[],
  entry: ReviewEntry,
  hunkStates: Record<string, string>,
  setHunkState: (filePath: string, hunkId: number, state: 'pending' | 'accepted' | 'rejected') => void,
  language: string,
  hunkRefs: React.MutableRefObject<Map<number, HTMLDivElement>>,
): React.ReactNode {
  const result: React.ReactNode[] = [];
  let currentHunkId: number | undefined;
  let hunkLines: React.ReactNode[] = [];

  function flushHunk() {
    if (currentHunkId == null || hunkLines.length === 0) {
      result.push(...hunkLines);
      hunkLines = [];
      return;
    }

    const hunk = hunks.find((h) => h.id === currentHunkId);
    if (!hunk) {
      result.push(...hunkLines);
      hunkLines = [];
      return;
    }

    const key = `${entry.filePath}:${hunk.id}`;
    const state = hunkStates[key] ?? 'pending';
    const isOverwritten = hunk.overwritten;

    result.push(
      <div
        key={`hunk-${hunk.id}`}
        ref={(el) => {
          if (el) hunkRefs.current.set(hunk.id, el);
          else hunkRefs.current.delete(hunk.id);
        }}
        className={cn(
          'relative border-l-2 transition-colors',
          state === 'pending' && 'border-border-bright',
          state === 'accepted' && 'border-green-500 bg-green-500/5',
          state === 'rejected' && 'border-red-500 bg-red-500/5',
          isOverwritten && 'border-yellow-500/50 bg-yellow-500/5',
        )}
      >
        {/* Hunk action buttons */}
        {!isOverwritten && (
          <div
            className={cn(
              'absolute right-2 top-0.5 z-10 flex gap-1 transition-opacity',
              state === 'pending' ? 'opacity-0 hover:opacity-100' : 'opacity-100',
            )}
          >
            <button
              onClick={() => setHunkState(entry.filePath, hunk.id, 'accepted')}
              className={cn(
                'flex items-center gap-1 rounded border px-1.5 py-0.5 text-[9px] font-medium transition-colors',
                state === 'accepted'
                  ? 'border-green-500/50 bg-green-500/20 text-green-500'
                  : 'border-border bg-secondary/80 text-muted-foreground hover:text-foreground',
              )}
            >
              <Check className="h-2.5 w-2.5" />
              接受
            </button>
            <button
              onClick={() => setHunkState(entry.filePath, hunk.id, 'rejected')}
              className={cn(
                'flex items-center gap-1 rounded border px-1.5 py-0.5 text-[9px] font-medium transition-colors',
                state === 'rejected'
                  ? 'border-red-500/50 bg-red-500/20 text-red-500'
                  : 'border-border bg-secondary/80 text-muted-foreground hover:text-foreground',
              )}
            >
              <X className="h-2.5 w-2.5" />
              拒绝
            </button>
          </div>
        )}
        {isOverwritten && (
          <div className="absolute right-2 top-0.5 z-10">
            <span className="flex items-center gap-1 rounded border border-yellow-500/30 bg-yellow-500/10 px-1.5 py-0.5 text-[9px] font-medium text-yellow-500">
              已被覆盖
            </span>
          </div>
        )}
        {hunkLines}
      </div>
    );

    hunkLines = [];
  }

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];

    // Detect hunk boundary change
    if (line.hunkId !== currentHunkId) {
      flushHunk();
      currentHunkId = line.hunkId;
    }

    const sign = line.type === 'add' ? '+' : line.type === 'del' ? '-' : ' ';
    const html = highlightCode(line.content || '\u00A0', language);

    const lineEl = (
      <div
        key={i}
        className={cn(
          'flex',
          line.type === 'add' && 'bg-green-500/10',
          line.type === 'del' && 'bg-red-500/10',
        )}
      >
        <span
          className={cn(
            'w-5 shrink-0 select-none text-center',
            line.type === 'add' && 'text-green-500',
            line.type === 'del' && 'text-red-500',
            line.type === 'ctx' && 'text-transparent',
          )}
        >
          {sign}
        </span>
        <span
          className={cn(
            'flex-1 overflow-x-auto px-2 py-0',
            line.type === 'add' && 'text-green-700 dark:text-green-300/90',
            line.type === 'del' && 'text-red-700/80 dark:text-red-300/70',
            line.type === 'ctx' && 'text-muted-foreground',
          )}
          dangerouslySetInnerHTML={{ __html: html }}
        />
      </div>
    );

    if (currentHunkId != null) {
      hunkLines.push(lineEl);
    } else {
      result.push(lineEl);
    }
  }

  flushHunk();

  return result;
}
