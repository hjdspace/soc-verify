/**
 * Diff Review Store — 全局 review queue + hunk 接受/拒绝状态管理。
 *
 * 队列来源：从当前项目的会话 tool messages 中提取 WRITE/EDIT/apply_patch/ast_edit 工具调用，
 * 按文件路径聚合。hunk 状态在 store 中管理，「应用」时调用后端 API 批量撤销。
 *
 * reviewed 文件保留在队列中（标记 reviewed=true），这样 ToolCard 路径始终可点击。
 * 点击已 reviewed 的路径会打开文件编辑器；未 reviewed 的路径会打开 diff-review。
 *
 * 持久化：reviewedFiles 按 projectId 存储在 localStorage，切换项目时恢复对应的
 * 审阅状态，避免重启后已审阅文件再次出现 "Review next file" 按钮。
 */

import { create } from 'zustand';
import { trpc } from '@renderer/lib/trpc';
import { useSessionStore, type ChatMessage } from './session';
import { useWorkbenchStore, openFileDestination } from './workbench';
import { useProjectStore } from './project';
import type { DiffToolCall, DiffRejection, FileDiffResult } from '@shared/types';
import { extractResultText, hasResultWarning } from '@renderer/components/chat/tool-helpers';

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
  /** 打开当前 diff 时的最后一个 tool call */
  currentReviewToolCallId: string | null;
  /** 当前文件的 diff 结果 */
  currentDiff: FileDiffResult | null;
  /** hunk 状态：key = `${filePath}:${hunkId}` */
  hunkStates: HunkStates;
  /** 是否正在加载 diff */
  loading: boolean;
  /** diff 加载失败的错误信息（null 表示无错误） */
  loadError: string | null;
  /** 已审阅到的 tool call 标记集合 */
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

type OmpDiffEdit = { oldText: string; newText: string };

function extractOmpDiffEdits(result: unknown): OmpDiffEdit[] {
  if (!result || typeof result !== 'object') return [];
  const details = (result as Record<string, unknown>).details;
  if (!details || typeof details !== 'object') return [];
  const detailRecord = details as Record<string, unknown>;
  if (typeof detailRecord.diff !== 'string') {
    return typeof detailRecord.oldText === 'string' && typeof detailRecord.newText === 'string'
      ? [{ oldText: detailRecord.oldText, newText: detailRecord.newText }]
      : [];
  }

  const edits: OmpDiffEdit[] = [];
  let oldLines: string[] = [];
  let newLines: string[] = [];
  let changed = false;
  let previousOldLine: number | null = null;
  let previousNewLine: number | null = null;
  let previousPrefix: string | null = null;
  const flush = (): void => {
    if (changed) {
      edits.push({ oldText: oldLines.join('\n'), newText: newLines.join('\n') });
    }
    oldLines = [];
    newLines = [];
    changed = false;
    previousOldLine = null;
    previousNewLine = null;
    previousPrefix = null;
  };

  for (const line of detailRecord.diff.split('\n')) {
    const match = line.match(/^([ +-])\s*(\d+)\|(.*)$/);
    if (!match) {
      flush();
      continue;
    }
    const [, prefix, lineNumberText, content] = match;
    const lineNumber = Number(lineNumberText);
    const oldLine = prefix === '+' ? null : lineNumber;
    const newLine = prefix === '-' ? null : lineNumber;
    if (changed && !(previousPrefix === '-' && prefix === '+') && (
      (oldLine != null && previousOldLine != null && oldLine > previousOldLine + 1)
      || (newLine != null && previousNewLine != null && newLine > previousNewLine + 1)
    )) flush();
    if (prefix === ' ' && changed) {
      oldLines.push(content);
      newLines.push(content);
      flush();
      oldLines.push(content);
      newLines.push(content);
      previousOldLine = oldLine;
      previousNewLine = newLine;
      previousPrefix = prefix;
      continue;
    }
    if (prefix !== '+') oldLines.push(content);
    if (prefix !== '-') newLines.push(content);
    if (prefix !== ' ') changed = true;
    if (oldLine != null) previousOldLine = oldLine;
    if (newLine != null) previousNewLine = newLine;
    previousPrefix = prefix;
  }
  flush();
  return edits;
}

function normalizeFilePath(filePath: string): string {
  const normalized = filePath.replace(/\\/g, '/');
  return /^[A-Za-z]:\//.test(normalized) ? normalized.toLowerCase() : normalized;
}

// URI scheme 前缀（case://、local:// 等），不是文件系统路径，不指向项目内文件
const FILE_URI_SCHEME_RE = /^[a-zA-Z][a-zA-Z0-9+.-]*:\/\//;

/**
 * 将（可能为相对）的文件路径解析为项目根内的绝对路径。
 * - 相对路径按项目根解析；绝对路径（盘符）原样使用。
 * - 解析后不在项目根内、是 URI scheme 路径、或无法解析时返回 null。
 * - 返回统一使用正斜杠的绝对路径（含盘符）。
 */
function resolveInsideProject(rawPath: string, rootPath: string): string | null {
  const normalized = rawPath.replace(/\\/g, '/');
  if (FILE_URI_SCHEME_RE.test(normalized)) return null;

  const root = rootPath.replace(/\\/g, '/').replace(/\/+$/, '');
  const isAbsolute = /^[A-Za-z]:\//.test(normalized);
  const segments = [...(isAbsolute ? [] : root.split('/')), ...normalized.split('/')];

  const resolved: string[] = [];
  for (const segment of segments) {
    if (segment === '' || segment === '.') continue;
    if (segment === '..') {
      resolved.pop();
      continue;
    }
    resolved.push(segment);
  }
  if (resolved.length === 0) return null;

  const absolute = resolved.join('/');
  // Windows 下路径大小写不敏感
  const lowerAbsolute = absolute.toLowerCase();
  const lowerRoot = root.toLowerCase();
  if (lowerAbsolute === lowerRoot) return null;
  if (!lowerAbsolute.startsWith(`${lowerRoot}/`)) return null;
  return absolute;
}

function sameFilePath(left: string, right: string): boolean {
  return normalizeFilePath(left) === normalizeFilePath(right);
}

function reviewMarker(filePath: string, toolCallId: string): string {
  return `${normalizeFilePath(filePath)}\n${toolCallId}`;
}

function extractResultDetails(result: unknown): Record<string, unknown> | null {
  if (!result || typeof result !== 'object') return null;
  const details = (result as Record<string, unknown>).details;
  return details && typeof details === 'object' ? details as Record<string, unknown> : null;
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

function extractToolCallsFromMessage(msg: ChatMessage): DiffToolCall[] {
  const name = msg.toolName ?? '';
  if (!FILE_EDITING_TOOLS.has(name)) return [];

  const args = msg.toolArgs as Record<string, unknown> | null;
  if (!args) return [];
  const resultDetails = extractResultDetails(msg.toolResult);

  // The successful result path is authoritative and normally absolute.
  // omp write 成功时返回 details.resolvedPath（解析后的绝对路径），omp edit 返回 details.path。
  let filePath = typeof resultDetails?.path === 'string'
    ? resultDetails.path
    : typeof resultDetails?.resolvedPath === 'string'
      ? resultDetails.resolvedPath
      : typeof args.path === 'string'
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
  if (!filePath) return [];

  // 检查是否有 toolResult（工具必须已完成执行）
  if (!msg.toolResult) return [];

  // 检查是否为错误结果
  const result = msg.toolResult as Record<string, unknown> | null;
  if (result && typeof result === 'object' && 'isError' in result && result.isError) {
    return [];
  }

  // 检查是否为 warning 结果（omp edit 工具在路径匹配失败时会返回 warning 而非 error）
  // warning 结果意味着编辑未实际生效，不应进入 diff-review 队列
  const resultText = extractResultText(msg.toolResult);
  if (hasResultWarning(resultText)) {
    return [];
  }

  // omp write 工具成功时总是返回 details.resolvedPath（写入目标解析后的绝对路径）。
  // 缺少该字段说明写入失败（如 EISDIR / 校验错误），没有产生实际文件改动，不应进入审阅队列。
  if (name === 'write' && typeof resultDetails?.resolvedPath !== 'string') {
    return [];
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

  const ompEdits = extractOmpDiffEdits(msg.toolResult);
  if ((name === 'edit' || name === 'edit_file')
    && ompEdits.length === 0
    && (finalOldText == null || finalNewText == null)) {
    return [];
  }
  const edits = ompEdits.length > 0
    ? ompEdits
    : [{ oldText: finalOldText, newText: finalNewText }];

  // 跳过无实际变更的编辑（oldText === newText 表示没有改动，会产生 +0 -0 的空 diff）
  if (!isNewFile && edits.every((e) => e.oldText === e.newText)) {
    return [];
  }

  return edits.map((edit, index) => ({
    id: edits.length === 1 ? msg.id : `${msg.id}:${index}`,
    toolName: name,
    filePath,
    timestamp: msg.timestamp + index / 1000,
    sessionId: msg.toolCallId,
    oldText: edit.oldText,
    newText: edit.newText,
    content,
    isNewFile,
  }));
}

function aggregateQueue(reviewedFiles: Set<string>): ReviewEntry[] {
  // 只聚合当前项目的会话，避免切换项目后旧项目的 diff-review 队列残留
  const currentProjectId = useProjectStore.getState().currentProjectId;
  const currentProject = currentProjectId
    ? useProjectStore.getState().projects.find((p) => p.id === currentProjectId)
    : undefined;
  const rootPath = currentProject?.rootPath ?? null;
  const sessions = useSessionStore.getState().sessions;
  const relevantSessions = currentProjectId
    ? sessions.filter((s) => s.projectId === currentProjectId)
    : sessions;
  const byFile = new Map<string, { filePath: string; toolCalls: DiffToolCall[] }>();

  for (const session of relevantSessions) {
    for (const msg of session.messages) {
      if (msg.role !== 'tool') continue;
      for (const tc of extractToolCallsFromMessage(msg)) {
        // 相对路径按项目根解析并校验在项目根内，避免队列里出现后端无法接受的路径。
        const absolutePath = rootPath ? resolveInsideProject(tc.filePath, rootPath) : tc.filePath;
        if (!absolutePath) continue;
        const key = normalizeFilePath(absolutePath);
        const existing = byFile.get(key) ?? { filePath: absolutePath, toolCalls: [] };
        existing.toolCalls.push({ ...tc, filePath: absolutePath });
        byFile.set(key, existing);
      }
    }
  }

  const entries: ReviewEntry[] = [];
  for (const { filePath, toolCalls: allToolCalls } of byFile.values()) {
    // 按时间排序
    allToolCalls.sort((a, b) => a.timestamp - b.timestamp);
    let reviewedIndex = -1;
    for (let i = 0; i < allToolCalls.length; i++) {
      if (reviewedFiles.has(reviewMarker(filePath, allToolCalls[i].id))) reviewedIndex = i;
    }
    const pendingToolCalls = allToolCalls.slice(reviewedIndex + 1);
    const reviewed = reviewedIndex >= 0 && pendingToolCalls.length === 0;
    const toolCalls = reviewed ? allToolCalls : pendingToolCalls;
    const fileName = filePath.replace(/\\/g, '/').split('/').pop() ?? filePath;
    const isNewFile = toolCalls.some((tc) => tc.isNewFile);
    entries.push({ filePath, fileName, toolCalls, isNewFile, reviewed });
  }

  return entries;
}

// ─── 持久化：按 projectId 存储 reviewedFiles ────────────────────

const REVIEWED_STORAGE_PREFIX = 'socverify:reviewedFiles:';

function loadReviewedFiles(projectId: string | null): Set<string> {
  if (!projectId) return new Set();
  try {
    const raw = localStorage.getItem(REVIEWED_STORAGE_PREFIX + projectId);
    if (!raw) return new Set();
    const arr = JSON.parse(raw) as string[];
    return Array.isArray(arr) ? new Set(arr) : new Set();
  } catch {
    return new Set();
  }
}

function persistReviewedFiles(projectId: string | null, reviewedFiles: Set<string>): void {
  if (!projectId) return;
  try {
    localStorage.setItem(
      REVIEWED_STORAGE_PREFIX + projectId,
      JSON.stringify([...reviewedFiles]),
    );
  } catch {
    // localStorage may be unavailable — ignore
  }
}

// ─── Store ──────────────────────────────────────────────────

export const useDiffReviewStore = create<DiffReviewStoreState>((set, get) => ({
  queue: [],
  currentFilePath: null,
  currentReviewToolCallId: null,
  currentDiff: null,
  hunkStates: {},
  loading: false,
  loadError: null,
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

      const newQueue = aggregateQueue(reviewedFiles);
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
      // 不清理 reviewedFiles——保留所有标记，避免竞态条件导致标记丢失。
      // reviewedFiles 只增不减：markFileReviewed 添加标记，project 切换时整体替换。
      return {
        queue: newQueue,
        hunkStates: cleanedHunkStates,
        currentFilePath,
        currentReviewToolCallId: currentFilePath ? s.currentReviewToolCallId : null,
        currentDiff: currentFilePath ? s.currentDiff : null,
        reviewedFiles,
      };
    });
  },

  openFile: (filePath) => {
    const entry = get().queue.find((e) => sameFilePath(e.filePath, filePath));
    if (!entry) return;

    // If already reviewed, open the file in the editor instead of diff-review
    if (entry.reviewed) {
      openFileDestination(useWorkbenchStore.getState().open, entry.filePath, entry.fileName);
      return;
    }

    const projectId = useProjectStore.getState().currentProjectId;
    if (!projectId) return;

    const reviewPath = entry.filePath;
    set({
      currentFilePath: reviewPath,
      currentReviewToolCallId: entry.toolCalls[entry.toolCalls.length - 1]?.id ?? null,
      loading: true,
      loadError: null,
    });

    useWorkbenchStore.getState().open({
      type: 'diff-review',
      filePath: entry.filePath,
      fileName: entry.fileName,
    });

    trpc.project.getFileDiff.query({
      projectId,
      filePath: reviewPath,
      toolCalls: entry.toolCalls,
    })
      .then((diff) => {
        set({ currentDiff: diff, loading: false, loadError: null });
        // 初始化 hunkStates：overwritten hunks 默认 accepted，其余 pending
        const states: HunkStates = { ...get().hunkStates };
        const fileStates = { ...states[reviewPath] };
        for (const hunk of diff.hunks) {
          if (!(hunk.id in fileStates)) {
            fileStates[hunk.id] = hunk.overwritten ? 'accepted' : 'pending';
          }
        }
        states[reviewPath] = fileStates;
        set({ hunkStates: states });
      })
      .catch((err) => {
        const message = err instanceof Error ? err.message : String(err);
        set({ loading: false, currentDiff: null, loadError: message });
      });
  },

  setHunkState: (filePath, hunkId, state) => {
    set((s) => ({
      hunkStates: {
        ...s.hunkStates,
        [filePath]: { ...s.hunkStates[filePath], [hunkId]: state },
      },
    }));
    // 全部接受时可以直接完成；拒绝项必须等「应用」真正回滚后才能完成。
    const { currentDiff, hunkStates } = get();
    if (!currentDiff) return;
    const allAccepted = currentDiff.hunks.every((h) => {
      const st = hunkStates[filePath]?.[h.id];
      return h.overwritten || st === 'accepted';
    });
    if (allAccepted) {
      markFileReviewed(filePath);
    }
  },

  acceptAll: (filePath) => {
    const diff = get().currentDiff;
    // 即使 diff 未加载或加载失败，也要标记为已审阅——
    // 用户明确选择了「接受」，不应因 diff 不可用而阻止审阅完成。
    if (diff) {
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
    }
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
    // diff 不可用（文件不存在、加载失败等）时，直接标记为已审阅。
    // 用户已明确选择「拒绝」，即使无法回滚也应完成审阅流程。
    if (!currentDiff) {
      markFileReviewed(filePath);
      return;
    }

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
      const result = await trpc.project.applyDiffRejections.mutate({
        projectId,
        filePath,
        rejections,
      });
      if (!result.ok) return;
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
    set({ currentFilePath: null, currentReviewToolCallId: null, currentDiff: null, loading: false, loadError: null });
  },
}));

// ─── Helpers ────────────────────────────────────────────────

export function openReviewAwareFile(filePath: string, fileName: string): void {
  // 工具卡片中的路径可能是相对路径（如 README.md、src-tauri/tauri.conf.json），
  // 先解析为项目根内的绝对路径，避免以相对路径打开文件导致后端校验失败。
  const currentProjectId = useProjectStore.getState().currentProjectId;
  const currentProject = currentProjectId
    ? useProjectStore.getState().projects.find((p) => p.id === currentProjectId)
    : undefined;
  const rootPath = currentProject?.rootPath ?? null;
  const resolvedPath = rootPath ? resolveInsideProject(filePath, rootPath) ?? filePath : filePath;

  const reviewStore = useDiffReviewStore.getState();
  const pendingEntry = reviewStore.queue.find((entry) =>
    !entry.reviewed && sameFilePath(entry.filePath, resolvedPath),
  );
  if (pendingEntry) {
    reviewStore.openFile(pendingEntry.filePath);
    return;
  }
  openFileDestination(useWorkbenchStore.getState().open, resolvedPath, fileName);
}

/**
 * 标记文件为已审阅：在队列中标记 reviewed=true，关闭 diff-review tab，
 * 并刷新 store 状态。不自动打开文件编辑器——用户可以通过工具卡片路径
 * 或文件树手动打开已审阅的文件。
 * 不自动打开下一个文件——用户可以通过浮动按钮或工具卡片路径手动打开。
 */
function markFileReviewed(filePath: string): void {
  const store = useDiffReviewStore.getState();
  const entry = store.queue.find((candidate) => sameFilePath(candidate.filePath, filePath));
  if (!entry) return;
  // 确定已审阅到哪个 tool call：优先用 currentReviewToolCallId，
  // 回退到 entry 中最后一个 pending tool call 的 id。
  // 如果 entry.toolCalls 为空（不应发生但防御性处理），也直接标记。
  const reviewedToolCallId = store.currentReviewToolCallId
    ?? entry.toolCalls[entry.toolCalls.length - 1]?.id;
  // 记录已审阅到哪个 tool call；后续新 edit 会重新进入 review queue。
  const newReviewed = new Set(store.reviewedFiles);
  if (reviewedToolCallId) {
    newReviewed.add(reviewMarker(entry.filePath, reviewedToolCallId));
  } else {
    // 没有可用 tool call id 时，标记该文件所有 pending tool calls 为已审阅
    for (const tc of entry.toolCalls) {
      newReviewed.add(reviewMarker(entry.filePath, tc.id));
    }
  }
  // 持久化到 localStorage
  persistReviewedFiles(useProjectStore.getState().currentProjectId, newReviewed);
  // 在队列中标记为已审阅（不从队列中移除，保持 ToolCard 路径可点击）
  const newQueue = aggregateQueue(newReviewed);
  const newHunkStates = { ...store.hunkStates };
  delete newHunkStates[filePath];
  // 关闭 diff-review tab
  const tabId = `diff-review:${filePath}`;
  useWorkbenchStore.getState().close(tabId);
  // 更新 store 状态
  useDiffReviewStore.setState({
    reviewedFiles: newReviewed,
    queue: newQueue,
    hunkStates: newHunkStates,
    currentFilePath: null,
    currentReviewToolCallId: null,
    currentDiff: null,
    loading: false,
    loadError: null,
  });
}

let projectedSessions = useSessionStore.getState().sessions;
useSessionStore.subscribe((state) => {
  if (state.sessions === projectedSessions) return;
  projectedSessions = state.sessions;
  useDiffReviewStore.getState().refreshQueue();
});

// ── 监听项目切换：加载该项目的 reviewedFiles 并刷新队列 ──
let projectedProjectId = useProjectStore.getState().currentProjectId;
useProjectStore.subscribe((state) => {
  const newProjectId = state.currentProjectId;
  if (newProjectId === projectedProjectId) return;
  projectedProjectId = newProjectId;
  // 加载新项目的持久化审阅状态
  const restoredReviewed = loadReviewedFiles(newProjectId);
  // 重置 diff-review 状态，用新项目的 reviewedFiles 重建队列
  useDiffReviewStore.setState({
    reviewedFiles: restoredReviewed,
    currentFilePath: null,
    currentReviewToolCallId: null,
    currentDiff: null,
    loading: false,
    loadError: null,
    hunkStates: {},
  });
  useDiffReviewStore.getState().refreshQueue();
});
