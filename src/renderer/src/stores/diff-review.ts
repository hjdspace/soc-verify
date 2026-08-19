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
 */

import { create } from 'zustand';
import { trpc } from '@renderer/lib/trpc';
import { useSessionStore, type ChatMessage } from './session';
import { useWorkbenchStore, openFileDestination } from './workbench';
import { useProjectStore } from './project';
import type { DiffToolCall, DiffRejection, FileDiffResult } from '@shared/types';
import { extractResultText, hasResultWarning } from '@renderer/components/chat/tool-helpers';

// ─── Types ──────────────────────────────────────────────────

export type HunkState = 'pending' | 'accepted' | 'rejected';
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

/** 规范化路径作为按文件索引状态的键 */
export function normalizeReviewKey(filePath: string): string {
  return normalizeFilePath(filePath);
}

/** 路径等价比较（Windows 大小写不敏感 + 分隔符归一） */
export function isSameFilePath(left: string, right: string): boolean {
  return normalizeFilePath(left) === normalizeFilePath(right);
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

  // Only a write that was observed against a missing path is a new file.
  // Older persisted messages have no snapshot and are conservatively treated
  // as overwrites so rejecting them can never unlink an existing file.
  const fileExistedBefore = resultDetails?.fileExistedBefore;
  const isNewFile = name === 'write' && content != null && fileExistedBefore === false;
  const beforeContent = typeof resultDetails?.beforeContent === 'string'
    ? resultDetails.beforeContent
    : undefined;

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
  if (name !== 'write' && !isNewFile && edits.every((e) => e.oldText === e.newText)) {
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
    beforeContent,
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

      const newQueue = aggregateQueue(reviewedFiles);
      // 清理已不在队列中的文件的按文件状态
      const validKeys = new Set(newQueue.map((e) => normalizeFilePath(e.filePath)));
      const clean = <T>(map: Record<string, T>): Record<string, T> => {
        const out: Record<string, T> = {};
        for (const [k, v] of Object.entries(map)) {
          if (validKeys.has(k)) out[k] = v;
        }
        return out;
      };
      // 如果当前审阅的文件已不在队列中，清空
      const currentFilePath = s.currentFilePath && validKeys.has(normalizeFilePath(s.currentFilePath))
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

    // 始终在普通编辑器中打开；未审阅的文件同时加载 diff 供内联审阅展示
    openFileDestination(useWorkbenchStore.getState().open, targetPath, fileName);

    if (!entry || entry.reviewed) return;

    set({
      currentFilePath: entry.filePath,
      currentReviewToolCallId: entry.toolCalls[entry.toolCalls.length - 1]?.id ?? null,
    });
    void get().ensureDiffLoaded(entry.filePath);
  },

  ensureDiffLoaded: (filePath) => {
    const entry = get().queue.find((e) => isSameFilePath(e.filePath, filePath) && !e.reviewed);
    if (!entry) return Promise.resolve();

    const projectId = useProjectStore.getState().currentProjectId;
    if (!projectId) return Promise.resolve();

    const key = normalizeFilePath(entry.filePath);
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
    const key = normalizeFilePath(filePath);
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
    const key = normalizeFilePath(filePath);
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
    const key = normalizeFilePath(filePath);
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
}));

// ─── 拒绝应用 ────────────────────────────────────────────────

/**
 * 应用 hunk 拒绝：立即回滚到文件系统，失效 diff 缓存并刷新。
 * 成功后若 diff 不再包含可审阅 hunk，自动标记文件为已审阅。
 */
async function applyHunkRejections(filePath: string, hunkIds: number[]): Promise<boolean> {
  const key = normalizeFilePath(filePath);
  const { fileDiffs, hunkStates, queue } = useDiffReviewStore.getState();
  const diff = fileDiffs[key];
  const entry = queue.find((e) => isSameFilePath(e.filePath, filePath));

  // diff 不可用（文件不存在、加载失败等）时，直接标记为已审阅。
  if (!diff || !entry) {
    markFileReviewed(filePath);
    return true;
  }

  const idSet = new Set(hunkIds);
  const rejections: DiffRejection[] = [];
  for (const hunk of diff.hunks) {
    if (!idSet.has(hunk.id)) continue;
    const patch = getHunkPatch(diff, hunk.id);
    if (!patch) continue;
    const priorDelta = diff.hunks.reduce((delta, candidate) => {
      if (hunkStates[key]?.[candidate.id] !== 'rejected') return delta;
      const priorPatch = getHunkPatch(diff, candidate.id);
      if (!priorPatch || priorPatch.startLine >= patch.startLine) return delta;
      return delta + priorPatch.oldLines.length - priorPatch.newLines.length;
    }, 0);
    rejections.push({
      hunkId: hunk.id,
      toolCallId: hunk.toolCallId,
      toolName: hunk.toolName,
      startLine: patch.startLine + priorDelta,
      oldLines: patch.oldLines,
      newLines: patch.newLines,
      beforeLine: patch.beforeLine,
      afterLine: patch.afterLine,
      deleteFile: entry.isNewFile,
    });
  }

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

type HunkPatch = {
  startLine: number;
  oldLines: string[];
  newLines: string[];
  beforeLine: string | null;
  afterLine: string | null;
};

function getHunkPatch(diff: FileDiffResult, hunkId: number): HunkPatch | null {
  const hunk = diff.hunks.find((candidate) => candidate.id === hunkId);
  if (!hunk) return null;
  const hunkLines = diff.lines.slice(hunk.startLineIndex, hunk.endLineIndex);
  const oldLines = hunkLines.filter((line) => line.type === 'del').map((line) => line.content);
  const newLineEntries = hunkLines.filter((line) => line.type === 'add' && line.newLine != null);
  const newLines = newLineEntries.map((line) => line.content);
  const before = [...diff.lines.slice(0, hunk.startLineIndex)]
    .reverse()
    .find((line) => line.newLine != null);
  const after = diff.lines.slice(hunk.endLineIndex).find((line) => line.newLine != null);
  const startLine = newLineEntries[0]?.newLine ?? after?.newLine ?? ((before?.newLine ?? 0) + 1);
  return {
    startLine,
    oldLines,
    newLines,
    beforeLine: before?.content ?? null,
    afterLine: after?.content ?? null,
  };
}

function finishReviewIfSettled(filePath: string): boolean {
  const store = useDiffReviewStore.getState();
  const key = normalizeFilePath(filePath);
  const diff = store.fileDiffs[key];
  if (!diff) return false;
  const states = store.hunkStates[key] ?? {};
  const settled = diff.hunks.every((hunk) =>
    hunk.overwritten || states[hunk.id] === 'accepted' || states[hunk.id] === 'rejected',
  );
  if (!settled) return false;
  if (diff.hunks.some((hunk) => states[hunk.id] === 'rejected')) {
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
  const resolvedPath = rootPath ? resolveInsideProject(filePath, rootPath) ?? filePath : filePath;

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
  // 确定已审阅到哪个 tool call：优先用 currentReviewToolCallId（仅当它属于该文件
  // 的 tool calls，避免残留的其它文件前沿标记误伤），回退到 entry 中最后一个
  // pending tool call 的 id。
  const frontierId = store.currentReviewToolCallId != null
    && entry.toolCalls.some((tc) => tc.id === store.currentReviewToolCallId)
    ? store.currentReviewToolCallId
    : entry.toolCalls[entry.toolCalls.length - 1]?.id;
  // 记录已审阅到哪个 tool call；后续新 edit 会重新进入 review queue。
  const newReviewed = new Set(store.reviewedFiles);
  if (frontierId) {
    newReviewed.add(reviewMarker(entry.filePath, frontierId));
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
  // 清除该文件的审阅状态（装饰消失、编辑器恢复可编辑）
  const key = normalizeFilePath(entry.filePath);
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
    fileDiffs: {},
    diffSignatures: {},
    loadingFiles: {},
    loadErrors: {},
    hunkStates: {},
    contentVersions: {},
  });
  useDiffReviewStore.getState().refreshQueue();
});
