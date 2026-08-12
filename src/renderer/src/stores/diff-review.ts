/**
 * Diff Review Store — 全局 review queue + hunk 接受/拒绝状态管理。
 *
 * 队列来源：从所有会话的 tool messages 中提取 WRITE/EDIT/apply_patch/ast_edit 工具调用，
 * 按文件路径聚合。hunk 状态在 store 中管理，「应用」时调用后端 API 批量撤销。
 *
 * reviewed 文件保留在队列中（标记 reviewed=true），这样 ToolCard 路径始终可点击。
 * 点击已 reviewed 的路径会打开文件编辑器；未 reviewed 的路径会打开 diff-review。
 */

import { create } from 'zustand';
import { trpc } from '@renderer/lib/trpc';
import { useSessionStore, type ChatMessage } from './session';
import { useWorkbenchStore, openFileDestination } from './workbench';
import { useProjectStore } from './project';
import type { DiffToolCall, DiffRejection, FileDiffResult } from '@shared/types';
import { extractResultText } from '@renderer/components/chat/tool-helpers';

// ─── Types ──────────────────────────────────────────────────

type HunkState = 'pending' | 'accepted' | 'rejected';
export type HunkStates = Record<string, Record<number, HunkState>>;

export interface ReviewEntry {
  /** 唯一标识（文件路径） */
  filePath: string;
  /** 短文件名（用于 tab 标题） */
  fileName: string;
  /** 该文件的所有 tool calls */
  toolCalls: DiffToolCall[];
  /** 是否为新文件（WRITE） */
  isNewFile: boolean;
  /** 是否已完成审阅（全部 hunk 已接受或已处理） */
  reviewed: boolean;
}

interface DiffReviewStoreState {
  /** 全局 review queue（按文件路径聚合，包含已审阅的文件） */
  queue: ReviewEntry[];
  /** 当前正在审阅的文件路径 */
  currentFilePath: string | null;
  /** 当前文件的 diff 结果 */
  currentDiff: FileDiffResult | null;
  /** hunk 状态：key = `${filePath}:${hunkId}` */
  hunkStates: HunkStates;
  /** 是否正在加载 diff */
  loading: boolean;
  /** 已审阅完成的文件路径集合（全部 hunk 已接受或已处理） */
  reviewedFiles: Set<string>;

  // Actions
  refreshQueue: () => void;
  openFile: (filePath: string) => void;
  setHunkState: (filePath: string, hunkId: number, state: HunkState) => void;
  acceptAll: (filePath: string) => void;
  rejectAll: (filePath: string) => void;
  applyRejections: (filePath: string) => Promise<void>;
  nextFile: () => void;
  getQueuePosition: () => { current: number; total: number };
  getNextFileName: () => string | null;
  /** 关闭当前 diff review 视图，返回正常文件展示 */
  closeReview: () => void;
}

// ─── Constants ─────────────────────────────────────────────

const FILE_EDITING_TOOLS = new Set(['write', 'write_file', 'edit', 'edit_file', 'apply_patch', 'ast_edit']);

// ─── Helpers ────────────────────────────────────────────────

/** Extract old/new text from omp edit tool's `edits` array format.
 * The omp edit tool sends args like { path, edits: [{ old_text, new_text }] }
 */
function extractFromEdits(args: Record<string, unknown>, ...keys: string[]): string | undefined {
  const edits = args.edits;
  if (!Array.isArray(edits) || edits.length === 0) return undefined;
  const firstEdit = edits[0];
  if (!firstEdit || typeof firstEdit !== 'object') return undefined;
  const editObj = firstEdit as Record<string, unknown>;
  for (const k of keys) {
    if (typeof editObj[k] === 'string') return editObj[k] as string;
  }
  return undefined;
}

/**
 * Extract file path from omp edit tool's `input` field.
 * omp edit format: `[filename#tag]\nDEL 42-49\n`
 */
function extractOmpPathFromInput(args: Record<string, unknown>): string | null {
  const input = typeof args.input === 'string' ? args.input : null;
  if (!input) return null;
  const match = input.match(/^\[([^\]]+)#[A-Za-z0-9_]+\]/);
  return match ? match[1] : null;
}

/**
 * Extract file path from omp edit tool's result text.
 * Result format starts with `[absolute_path#tag]` on the first line.
 */
function extractOmpPathFromResult(resultText: string): string | null {
  if (!resultText) return null;
  const match = resultText.match(/^\[([^\]]+)#[A-Za-z0-9_]+\]/m);
  return match ? match[1] : null;
}

function extractToolCallFromMessage(msg: ChatMessage): DiffToolCall | null {
  const name = msg.toolName ?? '';
  if (!FILE_EDITING_TOOLS.has(name)) return null;

  const args = msg.toolArgs as Record<string, unknown> | null;
  if (!args) return null;

  // Try direct path/file_path args first
  let filePath = typeof args.path === 'string'
    ? args.path
    : typeof args.file_path === 'string'
      ? args.file_path
      : null;

  // If not found, try omp edit format: extract from result text first (has absolute path),
  // then input field (may only have filename)
  if (!filePath && msg.toolResult) {
    const resultText = extractResultText(msg.toolResult);
    filePath = extractOmpPathFromResult(resultText);
  }
  if (!filePath) {
    filePath = extractOmpPathFromInput(args);
  }
  if (!filePath) return null;

  // 检查是否有 toolResult（工具必须已完成执行）
  if (!msg.toolResult) return null;

  // 检查是否为错误结果
  const result = msg.toolResult as Record<string, unknown> | null;
  if (result && typeof result === 'object' && 'isError' in result && result.isError) {
    return null;
  }

  const oldText = typeof args.oldText === 'string'
    ? args.oldText
    : typeof args.old_string === 'string'
      ? args.old_string
      : typeof args.old_text === 'string'
        ? args.old_text
        : typeof args.find === 'string'
          ? args.find
          : undefined;

  const newText = typeof args.newText === 'string'
    ? args.newText
    : typeof args.new_string === 'string'
      ? args.new_string
      : typeof args.new_text === 'string'
        ? args.new_text
        : typeof args.replace === 'string'
          ? args.replace
          : undefined;

  // omp edit tool uses { path, edits: [{ old_text, new_text }] }
  // If flat oldText/newText not found, try extracting from edits array
  const finalOldText = oldText ?? extractFromEdits(args, 'old_text', 'oldText', 'old_string');
  const finalNewText = newText ?? extractFromEdits(args, 'new_text', 'newText', 'new_string');

  const content = typeof args.content === 'string' ? args.content : undefined;

  const isNewFile = name === 'write' && content != null;

  return {
    id: msg.id,
    toolName: name,
    filePath,
    timestamp: msg.timestamp,
    sessionId: msg.toolCallId,
    oldText: finalOldText,
    newText: finalNewText,
    content,
    isNewFile,
  };
}

function aggregateQueue(reviewedFiles: Set<string>): ReviewEntry[] {
  const sessions = useSessionStore.getState().sessions;
  const byFile = new Map<string, DiffToolCall[]>();

  for (const session of sessions) {
    for (const msg of session.messages) {
      if (msg.role !== 'tool') continue;
      const tc = extractToolCallFromMessage(msg);
      if (!tc) continue;
      const existing = byFile.get(tc.filePath) ?? [];
      existing.push(tc);
      byFile.set(tc.filePath, existing);
    }
  }

  const entries: ReviewEntry[] = [];
  for (const [filePath, toolCalls] of byFile) {
    // 按时间排序
    toolCalls.sort((a, b) => a.timestamp - b.timestamp);
    const fileName = filePath.replace(/\\/g, '/').split('/').pop() ?? filePath;
    const isNewFile = toolCalls.some((tc) => tc.isNewFile);
    const reviewed = reviewedFiles.has(filePath);
    entries.push({ filePath, fileName, toolCalls, isNewFile, reviewed });
  }

  return entries;
}

// ─── Store ──────────────────────────────────────────────────

export const useDiffReviewStore = create<DiffReviewStoreState>((set, get) => ({
  queue: [],
  currentFilePath: null,
  currentDiff: null,
  hunkStates: {},
  loading: false,
  reviewedFiles: new Set<string>(),

  refreshQueue: () => {
    set((s) => {
      const newQueue = aggregateQueue(s.reviewedFiles);
      // 保留已有 hunkStates 中仍在队列里的条目
      const validPaths = new Set(newQueue.map((e) => e.filePath));
      const cleanedHunkStates: HunkStates = {};
      for (const [filePath, states] of Object.entries(s.hunkStates)) {
        if (validPaths.has(filePath)) cleanedHunkStates[filePath] = states;
      }
      // 如果当前审阅的文件已不在队列中，清空
      const currentFilePath = s.currentFilePath && validPaths.has(s.currentFilePath)
        ? s.currentFilePath
        : null;
      // 清理 reviewedFiles 中不再有对应 tool call 的条目
      const cleanedReviewed = new Set<string>();
      for (const fp of s.reviewedFiles) {
        if (validPaths.has(fp)) cleanedReviewed.add(fp);
      }
      return {
        queue: newQueue,
        hunkStates: cleanedHunkStates,
        currentFilePath,
        currentDiff: currentFilePath ? s.currentDiff : null,
        reviewedFiles: cleanedReviewed,
      };
    });
  },

  openFile: (filePath) => {
    const entry = get().queue.find((e) => e.filePath === filePath);
    if (!entry) return;

    // If already reviewed, open the file in the editor instead of diff-review
    if (entry.reviewed) {
      openFileDestination(useWorkbenchStore.getState().open, entry.filePath, entry.fileName);
      return;
    }

    const projectId = useProjectStore.getState().currentProjectId;
    if (!projectId) return;

    set({ currentFilePath: filePath, loading: true });

    useWorkbenchStore.getState().open({
      type: 'diff-review',
      filePath: entry.filePath,
      fileName: entry.fileName,
    });

    trpc.project.getFileDiff.query({
      projectId,
      filePath,
      toolCalls: entry.toolCalls,
    })
      .then((diff) => {
        set({ currentDiff: diff, loading: false });
        // 初始化 hunkStates：overwritten hunks 默认 accepted，其余 pending
        const states: HunkStates = { ...get().hunkStates };
        const fileStates = { ...states[filePath] };
        for (const hunk of diff.hunks) {
          if (!(hunk.id in fileStates)) {
            fileStates[hunk.id] = hunk.overwritten ? 'accepted' : 'pending';
          }
        }
        states[filePath] = fileStates;
        set({ hunkStates: states });
      })
      .catch(() => {
        set({ loading: false, currentDiff: null });
      });
  },

  setHunkState: (filePath, hunkId, state) => {
    set((s) => ({
      hunkStates: {
        ...s.hunkStates,
        [filePath]: { ...s.hunkStates[filePath], [hunkId]: state },
      },
    }));
    // 检查是否所有 hunk 都已处理（accepted 或 rejected）
    // 如果全部处理完毕，自动标记为已审阅
    const { currentDiff, hunkStates } = get();
    if (!currentDiff) return;
    const allResolved = currentDiff.hunks.every((h) => {
      const st = hunkStates[filePath]?.[h.id];
      return h.overwritten || st === 'accepted' || st === 'rejected';
    });
    if (allResolved) {
      markFileReviewed(filePath);
    }
  },

  acceptAll: (filePath) => {
    const diff = get().currentDiff;
    if (!diff) return;
    set((s) => {
      const states = { ...s.hunkStates };
      const fileStates = { ...states[filePath] };
      for (const hunk of diff.hunks) {
        if (!hunk.overwritten) {
          fileStates[hunk.id] = 'accepted';
        }
      }
      states[filePath] = fileStates;
      return { hunkStates: states };
    });
    // 接受全部后，标记为已审阅
    markFileReviewed(filePath);
  },

  rejectAll: (filePath) => {
    const diff = get().currentDiff;
    if (!diff) return;
    set((s) => {
      const states = { ...s.hunkStates };
      const fileStates = { ...states[filePath] };
      for (const hunk of diff.hunks) {
        if (!hunk.overwritten) {
          fileStates[hunk.id] = 'rejected';
        }
      }
      states[filePath] = fileStates;
      return { hunkStates: states };
    });
  },

  applyRejections: async (filePath) => {
    const { currentDiff, hunkStates } = get();
    if (!currentDiff) return;

    const projectId = useProjectStore.getState().currentProjectId;
    if (!projectId) return;

    // 收集所有 rejected hunks
    const rejections: DiffRejection[] = [];
    for (const hunk of currentDiff.hunks) {
      const state = hunkStates[filePath]?.[hunk.id];
      if (state === 'rejected') {
        // 找到对应的 tool call
        const entry = get().queue.find((e) => e.filePath === filePath);
        const tc = entry?.toolCalls.find((t) => t.id === hunk.toolCallId);
        rejections.push({
          hunkId: hunk.id,
          toolCallId: hunk.toolCallId,
          toolName: hunk.toolName,
          oldText: tc?.oldText,
          newText: tc?.newText,
          deleteFile: entry?.isNewFile ?? false,
        });
      }
    }

    if (rejections.length === 0) return;

    try {
      await trpc.project.applyDiffRejections.mutate({
        projectId,
        filePath,
        rejections,
      });
      // 应用拒绝后，标记为已审阅
      markFileReviewed(filePath);
    } catch {
      // 错误处理留给 toast
    }
  },

  nextFile: () => {
    const { queue, currentFilePath } = get();
    if (!currentFilePath || queue.length === 0) return;

    // Find next unreviewed file
    const currentIdx = queue.findIndex((e) => e.filePath === currentFilePath);
    for (let i = currentIdx + 1; i < queue.length; i++) {
      if (!queue[i].reviewed) {
        get().openFile(queue[i].filePath);
        return;
      }
    }
  },

  getQueuePosition: () => {
    const { queue, currentFilePath } = get();
    // Only count unreviewed files for the position
    const pending = queue.filter((e) => !e.reviewed);
    if (!currentFilePath) return { current: 0, total: pending.length };
    const idx = pending.findIndex((e) => e.filePath === currentFilePath);
    return { current: idx + 1, total: pending.length };
  },

  getNextFileName: () => {
    const { queue, currentFilePath } = get();
    if (!currentFilePath || queue.length === 0) return null;
    const currentIdx = queue.findIndex((e) => e.filePath === currentFilePath);
    for (let i = currentIdx + 1; i < queue.length; i++) {
      if (!queue[i].reviewed) {
        return queue[i].fileName;
      }
    }
    return null;
  },

  closeReview: () => {
    const { currentFilePath } = get();
    if (currentFilePath) {
      const tabId = `diff-review:${currentFilePath}`;
      useWorkbenchStore.getState().close(tabId);
    }
    set({ currentFilePath: null, currentDiff: null, loading: false });
  },
}));

// ─── Helpers ────────────────────────────────────────────────

/**
 * 标记文件为已审阅：在队列中标记 reviewed=true，关闭 diff-review tab，
 * 并在中栏打开文件编辑器显示审阅后的文件内容。
 * 不自动打开下一个文件——用户可以通过浮动按钮或工具卡片路径手动打开。
 */
function markFileReviewed(filePath: string): void {
  const store = useDiffReviewStore.getState();
  // 添加到已审阅集合
  const newReviewed = new Set(store.reviewedFiles);
  newReviewed.add(filePath);
  // 在队列中标记为已审阅（不从队列中移除，保持 ToolCard 路径可点击）
  const newQueue = store.queue.map((e) =>
    e.filePath === filePath ? { ...e, reviewed: true } : e,
  );
  // 关闭 diff-review tab
  const tabId = `diff-review:${filePath}`;
  useWorkbenchStore.getState().close(tabId);
  // 更新 store 状态
  useDiffReviewStore.setState({
    reviewedFiles: newReviewed,
    queue: newQueue,
    currentFilePath: null,
    currentDiff: null,
    loading: false,
  });
  // 打开文件编辑器，显示审阅后的文件内容
  const fileName = filePath.replace(/\\/g, '/').split('/').pop() ?? filePath;
  openFileDestination(useWorkbenchStore.getState().open, filePath, fileName);
}

let projectedSessions = useSessionStore.getState().sessions;
useSessionStore.subscribe((state) => {
  if (state.sessions === projectedSessions) return;
  projectedSessions = state.sessions;
  useDiffReviewStore.getState().refreshQueue();
});
