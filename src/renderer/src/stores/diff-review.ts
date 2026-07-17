/**
 * Diff Review Store — 全局 review queue + hunk 接受/拒绝状态管理。
 *
 * 队列来源：从所有会话的 tool messages 中提取 WRITE/EDIT/apply_patch/ast_edit 工具调用，
 * 按文件路径聚合。hunk 状态在 store 中管理，「应用」时调用后端 API 批量撤销。
 */

import { create } from 'zustand';
import { trpc } from '@renderer/lib/trpc';
import { useSessionStore, type ChatMessage } from './session';
import { useWorkbenchStore } from './workbench';
import { useProjectStore } from './project';
import type { DiffToolCall, DiffRejection, FileDiffResult } from '@shared/types';

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
}

interface DiffReviewStoreState {
  /** 全局 review queue（按文件路径聚合） */
  queue: ReviewEntry[];
  /** 当前正在审阅的文件路径 */
  currentFilePath: string | null;
  /** 当前文件的 diff 结果 */
  currentDiff: FileDiffResult | null;
  /** hunk 状态：key = `${filePath}:${hunkId}` */
  hunkStates: HunkStates;
  /** 是否正在加载 diff */
  loading: boolean;

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
}

// ─── Constants ─────────────────────────────────────────────

const FILE_EDITING_TOOLS = new Set(['write', 'edit', 'apply_patch', 'ast_edit']);

// ─── Helpers ────────────────────────────────────────────────

function extractToolCallFromMessage(msg: ChatMessage): DiffToolCall | null {
  const name = msg.toolName ?? '';
  if (!FILE_EDITING_TOOLS.has(name)) return null;

  const args = msg.toolArgs as Record<string, unknown> | null;
  if (!args) return null;

  const filePath = typeof args.path === 'string'
    ? args.path
    : typeof args.file_path === 'string'
      ? args.file_path
      : null;
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
      : typeof args.find === 'string'
        ? args.find
        : undefined;

  const newText = typeof args.newText === 'string'
    ? args.newText
    : typeof args.new_string === 'string'
      ? args.new_string
      : typeof args.replace === 'string'
        ? args.replace
        : undefined;

  const content = typeof args.content === 'string' ? args.content : undefined;

  const isNewFile = name === 'write' && content != null;

  return {
    id: msg.id,
    toolName: name,
    filePath,
    timestamp: msg.timestamp,
    sessionId: msg.toolCallId,
    oldText,
    newText,
    content,
    isNewFile,
  };
}

function aggregateQueue(): ReviewEntry[] {
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
    entries.push({ filePath, fileName, toolCalls, isNewFile });
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

  refreshQueue: () => {
    const newQueue = aggregateQueue();
    set((s) => {
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
      return {
        queue: newQueue,
        hunkStates: cleanedHunkStates,
        currentFilePath,
        currentDiff: currentFilePath ? s.currentDiff : null,
      };
    });
  },

  openFile: (filePath) => {
    const entry = get().queue.find((e) => e.filePath === filePath);
    if (!entry) return;

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
      // 应用后刷新 diff
      get().openFile(filePath);
    } catch {
      // 错误处理留给 toast
    }
  },

  nextFile: () => {
    const { queue, currentFilePath } = get();
    if (!currentFilePath || queue.length === 0) return;

    const currentIdx = queue.findIndex((e) => e.filePath === currentFilePath);
    const nextIdx = currentIdx + 1;
    if (nextIdx < queue.length) {
      get().openFile(queue[nextIdx].filePath);
    }
  },

  getQueuePosition: () => {
    const { queue, currentFilePath } = get();
    if (!currentFilePath) return { current: 0, total: queue.length };
    const idx = queue.findIndex((e) => e.filePath === currentFilePath);
    return { current: idx + 1, total: queue.length };
  },

  getNextFileName: () => {
    const { queue, currentFilePath } = get();
    if (!currentFilePath || queue.length === 0) return null;
    const idx = queue.findIndex((e) => e.filePath === currentFilePath);
    const nextIdx = idx + 1;
    if (nextIdx < queue.length) {
      return queue[nextIdx].fileName;
    }
    return null;
  },
}));

let projectedSessions = useSessionStore.getState().sessions;
useSessionStore.subscribe((state) => {
  if (state.sessions === projectedSessions) return;
  projectedSessions = state.sessions;
  useDiffReviewStore.getState().refreshQueue();
});
