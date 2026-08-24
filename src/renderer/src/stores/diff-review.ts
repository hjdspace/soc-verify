/**
 * Diff Review Store — 全局 review queue + hunk 接受/拒绝状态管理（内联审阅模式）。
 *
 * 队列来源：从当前项目的会话 tool messages 中提取 WRITE/EDIT/apply_patch/ast_edit 工具调用，
 * 按文件路径聚合。文件在中栏普通编辑器（FileEditor）中打开，AI 改动以 CodeMirror
 * 内联 diff 装饰展示；拒绝的 hunk 立即回滚到文件系统，随后刷新 diff 与编辑器内容。
 *
 * reviewed 文件保留在队列中（标记 reviewed=true），后续新 edit 会重新进入队列。
 *
 * 所有按文件索引的状态（fileDiffs / hunkStates / contentVersions 等）以规范化路径
 * （normalizeReviewKey）为键，避免 Windows 路径大小写/分隔符差异导致查找失败。
 *
 * 持久化：reviewedFiles 按 projectId 存储在 localStorage，切换项目时恢复对应的
 * 审阅状态，避免重启后已审阅文件再次出现 "Review next file" 按钮。
 *
 * 纯函数逻辑（路径解析、omp diff 解析、队列聚合、拒绝构建等）提取到
 * diff-review-ops.ts，本文件只保留状态管理和异步操作。
 */

import { create } from 'zustand';
import { useMemo } from 'react';
import { trpc } from '@renderer/lib/trpc';
import { useSessionCoreStore } from './session-core';
import { useWorkbenchStore, openFileDestination } from './workbench';
import { useProjectStore } from './project';
import type { FileDiffResult } from '@shared/types';
import {
  type HunkState,
  type HunkStates,
  type ReviewEntry,
  normalizeReviewKey,
  isSameFilePath,
  resolveInsideProject,
  aggregateQueue,
  buildRejections,
  isReviewSettled,
  hasRejectedHunks,
  resolveFrontierId,
  loadReviewedFiles,
  persistReviewedFiles,
} from './diff-review-ops';

// ─── Re-exports ────────────────────────────────────────────
// 消费者从 diff-review.ts 导入这些符号，无需改 import 路径。

export type { HunkState, HunkStates, ReviewEntry } from './diff-review-ops';
export { normalizeReviewKey, isSameFilePath } from './diff-review-ops';

/**
 * Per-file review snapshot — 将 FileEditor 需要的六个 map 状态组合为一个
 * 投影对象，使 FileEditor 不再直接访问 store 的内部 map 结构。路径规范化、
 * 缺省值处理、entry 查找都在 store 侧完成，FileEditor 只消费快照。
 */
export interface ReviewSnapshot {
  /** 文件在审阅队列中的 entry（未审阅时非 null）；不在队列或已审阅时为 null */
  entry: ReviewEntry | null;
  /** diff 结果（未加载时为 null） */
  diff: FileDiffResult | null;
  /** hunk 状态（hunkId → state） */
  hunkStates: Record<number, HunkState>;
  /** diff 是否正在加载 */
  loading: boolean;
  /** diff 加载错误信息 */
  error: string | null;
  /** 是否处于活跃审阅状态（entry + diff 均就绪） */
  active: boolean;
  /** 内容版本号（递增时 FileEditor 重载磁盘内容） */
  contentVersion: number;
}

interface DiffReviewStoreState {
  /** 全局 review queue（按文件路径聚合，包含已审阅的文件） */
  queue: ReviewEntry[];
  /** 当前正在审阅的文件路径 */
  currentFilePath: string | null;
  /** 打开当前审阅文件时的最后一个 tool call（审阅前沿标记） */
  currentReviewToolCallId: string | null;
  /** 每个文件的 diff 结果缓存（key = 规范化路径；值为 null 表示加载失败） */
  fileDiffs: Record<string, FileDiffResult | null>;
  /** diff 已加载到的 tool call 前沿（key = 规范化路径），用于失效判断 */
  diffSignatures: Record<string, string>;
  /** 正在加载 diff 的文件 */
  loadingFiles: Record<string, boolean>;
  /** diff 加载失败的错误信息 */
  loadErrors: Record<string, string | null>;
  /** hunk 状态（key = 规范化路径） */
  hunkStates: HunkStates;
  /** 文件内容版本号：拒绝回滚后递增，FileEditor 据此重载内容 */
  contentVersions: Record<string, number>;
  /** 已审阅到的 tool call 标记集合 */
  reviewedFiles: Set<string>;

  // Actions
  refreshQueue: () => void;
  /** 在普通编辑器中打开文件；未审阅时同时加载 diff */
  openFile: (filePath: string) => void;
  /** 加载/刷新文件 diff（tool call 前沿变化时自动失效重载） */
  ensureDiffLoaded: (filePath: string) => Promise<void>;
  setHunkState: (filePath: string, hunkId: number, state: HunkState) => void;
  /** 拒绝单个 hunk：立即回滚并刷新 diff；返回是否成功 */
  rejectHunk: (filePath: string, hunkId: number) => Promise<boolean>;
  acceptAll: (filePath: string) => void;
  /** 拒绝全部 hunk：立即回滚并刷新 diff；返回是否成功 */
  rejectAll: (filePath: string) => Promise<boolean>;
  nextFile: () => void;
  getQueuePosition: () => { current: number; total: number };
  getNextFileName: () => string | null;
  /** 获取文件的审阅快照：将六个 per-file map 组合为一个投影对象 */
  getReviewSnapshot: (filePath: string) => ReviewSnapshot;
}

// ─── Constants ─────────────────────────────────────────────

/** 稳定的空 hunk 状态引用，避免每次调用 getReviewSnapshot 创建新对象 */
const EMPTY_HUNK_STATES: Record<number, HunkState> = {};

// ─── Store ──────────────────────────────────────────────────

export const useDiffReviewStore = create<DiffReviewStoreState>((set, get) => ({
  queue: [],
  currentFilePath: null,
  currentReviewToolCallId: null,
  fileDiffs: {},
  diffSignatures: {},
  loadingFiles: {},
  loadErrors: {},
  hunkStates: {},
  contentVersions: {},
  reviewedFiles: loadReviewedFiles(useProjectStore.getState().currentProjectId),

  refreshQueue: () => {
    set((s) => {
      // 如果当前 reviewedFiles 为空但 localStorage 有数据（如重启后 store 初始化时
      // currentProjectId 为 null 导致 reviewedFiles 为空，后来 project 加载完成
      // 但 subscribe 可能已经错过），在此处自动恢复。
      let reviewedFiles = s.reviewedFiles;
      const currentProjectId = useProjectStore.getState().currentProjectId;
      if (reviewedFiles.size === 0 && currentProjectId) {
        const stored = loadReviewedFiles(currentProjectId);
        if (stored.size > 0) {
          reviewedFiles = stored;
        }
      }

      const projectState = useProjectStore.getState();
      const currentProject = projectState.currentProjectId
        ? projectState.projects.find((p) => p.id === projectState.currentProjectId)
        : undefined;
      const rootPath = currentProject?.rootPath ?? null;
      const extraDirPaths = projectState.extraDirs.map((d) => d.path);
      const sessions = useSessionCoreStore.getState().sessions;

      const newQueue = aggregateQueue(sessions, projectState.currentProjectId, rootPath, extraDirPaths, reviewedFiles);
      // 清理已不在队列中的文件的按文件状态
      const validKeys = new Set(newQueue.map((e) => normalizeReviewKey(e.filePath)));
      const clean = <T>(map: Record<string, T>): Record<string, T> => {
        const out: Record<string, T> = {};
        for (const [k, v] of Object.entries(map)) {
          if (validKeys.has(k)) out[k] = v;
        }
        return out;
      };
      // 如果当前审阅的文件已不在队列中，清空
      const currentFilePath = s.currentFilePath && validKeys.has(normalizeReviewKey(s.currentFilePath))
        ? s.currentFilePath
        : null;
      // 不清理 reviewedFiles——保留所有标记，避免竞态条件导致标记丢失。
      // reviewedFiles 只增不减：markFileReviewed 添加标记，project 切换时整体替换。
      return {
        queue: newQueue,
        fileDiffs: clean(s.fileDiffs),
        diffSignatures: clean(s.diffSignatures),
        loadingFiles: clean(s.loadingFiles),
        loadErrors: clean(s.loadErrors),
        hunkStates: clean(s.hunkStates),
        contentVersions: clean(s.contentVersions),
        currentFilePath,
        currentReviewToolCallId: currentFilePath ? s.currentReviewToolCallId : null,
        reviewedFiles,
      };
    });
  },

  openFile: (filePath) => {
    const entry = get().queue.find((e) => isSameFilePath(e.filePath, filePath));
    const targetPath = entry?.filePath ?? filePath;
    const fileName = entry?.fileName ?? targetPath.replace(/\\/g, '/').split('/').pop() ?? targetPath;

    if (!entry || entry.reviewed) {
      openFileDestination(useWorkbenchStore.getState().open, targetPath, fileName);
      return;
    }

    // 先设置当前 review entry，再切换编辑器。
    // Workbench.open 会同步挂载 FileEditor；如果顺序相反，新的编辑器会在
    // review 状态尚未就绪时初始化，导致 Review next file 页面缺少审阅控件。
    set({
      currentFilePath: entry.filePath,
      currentReviewToolCallId: entry.toolCalls[entry.toolCalls.length - 1]?.id ?? null,
    });

    // 始终在普通编辑器中打开；未审阅的文件同时加载 diff 供内联审阅展示
    openFileDestination(useWorkbenchStore.getState().open, targetPath, fileName);
    void get().ensureDiffLoaded(entry.filePath);
  },

  ensureDiffLoaded: (filePath) => {
    const entry = get().queue.find((e) => isSameFilePath(e.filePath, filePath) && !e.reviewed);
    if (!entry) return Promise.resolve();

    const projectId = useProjectStore.getState().currentProjectId;
    if (!projectId) return Promise.resolve();

    const key = normalizeReviewKey(entry.filePath);
    const signature = entry.toolCalls[entry.toolCalls.length - 1]?.id ?? '';
    if (get().diffSignatures[key] === signature) return Promise.resolve();
    if (get().loadingFiles[key]) return Promise.resolve();

    set((s) => ({
      loadingFiles: { ...s.loadingFiles, [key]: true },
      loadErrors: { ...s.loadErrors, [key]: null },
    }));

    return trpc.project.getFileDiff.query({
      projectId,
      filePath: entry.filePath,
      toolCalls: entry.toolCalls,
    })
      .then((diff) => {
        set((s) => {
          // 重建 hunk 状态：diff 重算后 hunkId 会重新分配，旧状态不再可靠
          const fileStates: Record<number, HunkState> = {};
          for (const hunk of diff.hunks) {
            fileStates[hunk.id] = hunk.overwritten ? 'accepted' : 'pending';
          }
          return {
            fileDiffs: { ...s.fileDiffs, [key]: diff },
            diffSignatures: { ...s.diffSignatures, [key]: signature },
            loadingFiles: { ...s.loadingFiles, [key]: false },
            loadErrors: { ...s.loadErrors, [key]: null },
            hunkStates: { ...s.hunkStates, [key]: fileStates },
            // diff 加载/刷新都意味着文件内容可能与编辑器展示的不一致（新 tool call
            // 或拒绝回滚），始终通知编辑器重载内容，保证内联装饰行号与磁盘对齐
            contentVersions: { ...s.contentVersions, [key]: (s.contentVersions[key] ?? 0) + 1 },
          };
        });
        // diff 为空（全部回滚完成）或全部 overwritten 时，自动完成审阅
        const allAccepted = diff.hunks.every((h) => h.overwritten);
        if (allAccepted) {
          markFileReviewed(entry.filePath);
        }
      })
      .catch((err) => {
        const message = err instanceof Error ? err.message : String(err);
        set((s) => ({
          loadingFiles: { ...s.loadingFiles, [key]: false },
          fileDiffs: { ...s.fileDiffs, [key]: null },
          loadErrors: { ...s.loadErrors, [key]: message },
        }));
      });
  },

  setHunkState: (filePath, hunkId, state) => {
    const key = normalizeReviewKey(filePath);
    set((s) => ({
      hunkStates: {
        ...s.hunkStates,
        [key]: { ...s.hunkStates[key], [hunkId]: state },
      },
    }));
    if (state === 'accepted') finishReviewIfSettled(filePath);
  },

  rejectHunk: (filePath, hunkId) => applyHunkRejections(filePath, [hunkId]),

  acceptAll: (filePath) => {
    const key = normalizeReviewKey(filePath);
    const diff = get().fileDiffs[key];
    // 即使 diff 未加载或加载失败，也要标记为已审阅——
    // 用户明确选择了「接受」，不应因 diff 不可用而阻止审阅完成。
    if (diff) {
      set((s) => {
        const fileStates = { ...(s.hunkStates[key] ?? {}) };
        for (const hunk of diff.hunks) {
          if (!hunk.overwritten) {
            fileStates[hunk.id] = 'accepted';
          }
        }
        return { hunkStates: { ...s.hunkStates, [key]: fileStates } };
      });
    }
    // 接受全部后，标记为已审阅
    markFileReviewed(filePath);
  },

  rejectAll: async (filePath) => {
    const key = normalizeReviewKey(filePath);
    // diff 未加载时先加载（ChangeSummaryBar 的「全部拒绝」可能在文件未打开时触发）
    if (get().fileDiffs[key] == null && !get().loadingFiles[key]) {
      await get().ensureDiffLoaded(filePath);
    }
    const diff = get().fileDiffs[key];
    // diff 不可用（文件不存在、加载失败等）时，直接标记为已审阅。
    // 用户已明确选择「拒绝」，即使无法回滚也应完成审阅流程。
    if (!diff) {
      markFileReviewed(filePath);
      return true;
    }
    const states = get().hunkStates[key] ?? {};
    const ids = diff.hunks
      .filter((h) => !h.overwritten && states[h.id] !== 'rejected')
      .map((h) => h.id);
    if (ids.length === 0) {
      markFileReviewed(filePath);
      return true;
    }
    return applyHunkRejections(filePath, ids);
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

  getReviewSnapshot: (filePath) => {
    const { queue, fileDiffs, hunkStates, loadingFiles, loadErrors, contentVersions } = get();
    const entry = queue.find((e) => isSameFilePath(e.filePath, filePath) && !e.reviewed) ?? null;
    const key = normalizeReviewKey(filePath);
    const diff = entry ? (fileDiffs[key] ?? null) : null;
    const states = hunkStates[key] ?? EMPTY_HUNK_STATES;
    const loading = entry ? (loadingFiles[key] ?? false) : false;
    const error = entry ? (loadErrors[key] ?? null) : null;
    const contentVersion = contentVersions[key] ?? 0;
    return {
      entry,
      diff,
      hunkStates: states,
      loading,
      error,
      active: entry != null && diff != null,
      contentVersion,
    };
  },
}));

// ─── 拒绝应用 ────────────────────────────────────────────────

/**
 * 应用 hunk 拒绝：立即回滚到文件系统，失效 diff 缓存并刷新。
 * 成功后若 diff 不再包含可审阅 hunk，自动标记文件为已审阅。
 */
async function applyHunkRejections(filePath: string, hunkIds: number[]): Promise<boolean> {
  const key = normalizeReviewKey(filePath);
  const { fileDiffs, hunkStates, queue } = useDiffReviewStore.getState();
  const diff = fileDiffs[key];
  const entry = queue.find((e) => isSameFilePath(e.filePath, filePath));

  // diff 不可用（文件不存在、加载失败等）时，直接标记为已审阅。
  if (!diff || !entry) {
    markFileReviewed(filePath);
    return true;
  }

  const rejections = buildRejections(diff, entry, hunkIds, hunkStates[key] ?? {});

  const projectId = useProjectStore.getState().currentProjectId;
  if (!projectId || rejections.length === 0) return false;

  try {
    const result = await trpc.project.applyDiffRejections.mutate({
      projectId,
      filePath: entry.filePath,
      rejections,
    });
    if (!result.ok || result.appliedCount === 0) {
      setRejectedStates(key, hunkIds, 'pending');
      return false;
    }
  } catch {
    setRejectedStates(key, hunkIds, 'pending');
    return false;
  }

  // 保持当前 diff 快照，避免已拒绝的 tool call 在 before reconstruction 中再次执行。
  // 文件内容在全部 hunk 结算后统一重载，期间其余 hunk 的行号仍与当前编辑器一致。
  setRejectedStates(key, hunkIds);
  finishReviewIfSettled(entry.filePath);
  return true;
}

function finishReviewIfSettled(filePath: string): boolean {
  const store = useDiffReviewStore.getState();
  const key = normalizeReviewKey(filePath);
  const diff = store.fileDiffs[key];
  if (!diff) return false;
  const states = store.hunkStates[key] ?? {};
  if (!isReviewSettled(diff, states)) return false;
  if (hasRejectedHunks(diff, states)) {
    useDiffReviewStore.setState((state) => ({
      contentVersions: {
        ...state.contentVersions,
        [key]: (state.contentVersions[key] ?? 0) + 1,
      },
    }));
  }
  markFileReviewed(filePath);
  return true;
}

function setRejectedStates(key: string, hunkIds: number[], state: HunkState = 'rejected'): void {
  useDiffReviewStore.setState((s) => {
    const fileStates = { ...(s.hunkStates[key] ?? {}) };
    for (const id of hunkIds) {
      fileStates[id] = state;
    }
    return { hunkStates: { ...s.hunkStates, [key]: fileStates } };
  });
}

// ─── Helpers ────────────────────────────────────────────────

export function openReviewAwareFile(filePath: string, _fileName: string): void {
  // 工具卡片中的路径可能是相对路径（如 README.md、src-tauri/tauri.conf.json），
  // 先解析为项目根内的绝对路径，避免以相对路径打开文件导致后端校验失败。
  const currentProjectId = useProjectStore.getState().currentProjectId;
  const currentProject = currentProjectId
    ? useProjectStore.getState().projects.find((p) => p.id === currentProjectId)
    : undefined;
  const rootPath = currentProject?.rootPath ?? null;
  const extraDirPaths = useProjectStore.getState().extraDirs.map((d) => d.path);
  const resolvedPath = rootPath ? resolveInsideProject(filePath, rootPath, extraDirPaths) ?? filePath : filePath;

  // 未审阅的文件由 openFile 打开编辑器并加载 diff；其余情况也统一走 openFile
  // （openFile 内部对已审阅/不在队列的路径回退为普通文件打开）。
  useDiffReviewStore.getState().openFile(resolvedPath);
}

/**
 * 标记文件为已审阅：在队列中标记 reviewed=true，清除该文件的 diff 缓存与
 * hunk 状态（内联审阅装饰随之消失，编辑器恢复可编辑），并刷新 store 状态。
 * 不自动打开下一个文件——用户可以通过浮动按钮或工具卡片路径手动打开。
 */
function markFileReviewed(filePath: string): void {
  const store = useDiffReviewStore.getState();
  const entry = store.queue.find((candidate) => isSameFilePath(candidate.filePath, filePath));
  if (!entry) return;
  // 确定已审阅到哪个 tool call
  const frontierId = resolveFrontierId(entry, store.currentReviewToolCallId);
  // 记录已审阅到哪个 tool call；后续新 edit 会重新进入 review queue。
  const newReviewed = new Set(store.reviewedFiles);
  if (frontierId) {
    newReviewed.add(`${normalizeReviewKey(entry.filePath)}\n${frontierId}`);
  } else {
    // 没有可用 tool call id 时，标记该文件所有 pending tool calls 为已审阅
    for (const tc of entry.toolCalls) {
      newReviewed.add(`${normalizeReviewKey(entry.filePath)}\n${tc.id}`);
    }
  }
  // 持久化到 localStorage
  persistReviewedFiles(useProjectStore.getState().currentProjectId, newReviewed);
  // 在队列中标记为已审阅（不从队列中移除，保持 ToolCard 路径可点击）
  const projectState = useProjectStore.getState();
  const currentProject = projectState.currentProjectId
    ? projectState.projects.find((p) => p.id === projectState.currentProjectId)
    : undefined;
  const rootPath = currentProject?.rootPath ?? null;
  const extraDirPaths = projectState.extraDirs.map((d) => d.path);
  const sessions = useSessionCoreStore.getState().sessions;
  const newQueue = aggregateQueue(sessions, projectState.currentProjectId, rootPath, extraDirPaths, newReviewed);
  // 清除该文件的审阅状态（装饰消失、编辑器恢复可编辑）
  const key = normalizeReviewKey(entry.filePath);
  const pickRest = <T>(map: Record<string, T>): Record<string, T> => {
    const out: Record<string, T> = {};
    for (const [k, v] of Object.entries(map)) {
      if (k !== key) out[k] = v;
    }
    return out;
  };
  useDiffReviewStore.setState({
    reviewedFiles: newReviewed,
    queue: newQueue,
    hunkStates: pickRest(store.hunkStates),
    fileDiffs: pickRest(store.fileDiffs),
    diffSignatures: pickRest(store.diffSignatures),
    loadingFiles: pickRest(store.loadingFiles),
    loadErrors: pickRest(store.loadErrors),
  });
}

let projectedSessions = useSessionCoreStore.getState().sessions;
useSessionCoreStore.subscribe((state) => {
  if (state.sessions === projectedSessions) return;
  projectedSessions = state.sessions;
  useDiffReviewStore.getState().refreshQueue();
});

// ── 监听项目切换：加载该项目的 reviewedFiles 并刷新队列 ──
let projectedProjectId = useProjectStore.getState().currentProjectId;
let projectedExtraDirs = useProjectStore.getState().extraDirs;
useProjectStore.subscribe((state) => {
  const newProjectId = state.currentProjectId;
  const newExtraDirs = state.extraDirs;
  const projectIdChanged = newProjectId !== projectedProjectId;
  const extraDirsChanged = newExtraDirs !== projectedExtraDirs;
  if (!projectIdChanged && !extraDirsChanged) return;
  projectedProjectId = newProjectId;
  projectedExtraDirs = newExtraDirs;
  // 加载新项目的持久化审阅状态
  const restoredReviewed = loadReviewedFiles(newProjectId);
  // 重置 diff-review 状态，用新项目的 reviewedFiles 重建队列
  useDiffReviewStore.setState({
    reviewedFiles: restoredReviewed,
    currentFilePath: null,
    currentReviewToolCallId: null,
    fileDiffs: {},
    diffSignatures: {},
    loadingFiles: {},
    loadErrors: {},
    hunkStates: {},
    contentVersions: {},
  });
  useDiffReviewStore.getState().refreshQueue();
});

// ─── Per-file review snapshot hook ────────────────────────────
//
// 将六个 per-file map 的组合逻辑收到 store 侧：FileEditor 只需调用
// `useReviewSnapshot(filePath)` 即可获取当前文件的审阅快照，
// 不再直接访问 queue / fileDiffs / hunkStates / loadingFiles / loadErrors / contentVersions。
//
// 实现上仍然用细粒度 selector 订阅各自的状态切片（避免不必要的重渲染），
// 但组合、路径规范化、缺省值处理都在 getReviewSnapshot 中完成。

export function useReviewSnapshot(filePath: string): ReviewSnapshot {
  // 订阅各 map 的相关切片——只有对应文件的状态变化才触发重渲染
  const queue = useDiffReviewStore((s) => s.queue);
  const diff = useDiffReviewStore((s) => s.fileDiffs[normalizeReviewKey(filePath)] ?? null);
  const hunkStates = useDiffReviewStore((s) => s.hunkStates[normalizeReviewKey(filePath)] ?? EMPTY_HUNK_STATES);
  const loading = useDiffReviewStore((s) => s.loadingFiles[normalizeReviewKey(filePath)] ?? false);
  const error = useDiffReviewStore((s) => s.loadErrors[normalizeReviewKey(filePath)] ?? null);
  const contentVersion = useDiffReviewStore((s) => s.contentVersions[normalizeReviewKey(filePath)] ?? 0);

  // 组合为快照——使用 useMemo 避免在状态未变时创建新对象
  return useMemo(() => {
    const entry = queue.find((e) => isSameFilePath(e.filePath, filePath) && !e.reviewed) ?? null;
    return {
      entry,
      diff: entry ? diff : null,
      hunkStates,
      loading: entry ? loading : false,
      error: entry ? error : null,
      active: entry != null && diff != null,
      contentVersion,
    };
  }, [queue, filePath, diff, hunkStates, loading, error, contentVersion]);
}
