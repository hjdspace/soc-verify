/**
 * Diff Review 纯函数模块 — 路径解析、omp diff 解析、队列聚合、拒绝构建等。
 *
 * 所有函数不依赖 store 状态，可独立测试。
 * store 模块（diff-review.ts）调用这些函数完成具体逻辑。
 */

import type { ChatMessage } from './session-types';
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

type OmpDiffEdit = { oldText: string; newText: string };

type HunkPatch = {
  startLine: number;
  oldLines: string[];
  newLines: string[];
  beforeLine: string | null;
  afterLine: string | null;
};

// ─── Constants ─────────────────────────────────────────────

const FILE_EDITING_TOOLS = new Set(['write', 'write_file', 'edit', 'edit_file', 'apply_patch', 'ast_edit']);

// URI scheme 前缀（case://、local:// 等），不是文件系统路径，不指向项目内文件
const FILE_URI_SCHEME_RE = /^[a-zA-Z][a-zA-Z0-9+.-]*:\/\//;

const REVIEWED_STORAGE_PREFIX = 'socverify:reviewedFiles:';

// ─── Path helpers ──────────────────────────────────────────

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

/**
 * 将（可能为相对）的文件路径解析为项目目录内的绝对路径。
 * - 相对路径按项目根解析；绝对路径（盘符）原样使用。
 * - 解析后不在任一有效项目目录（rootPath + extraDirs）内、是 URI scheme 路径、
 *   或无法解析时返回 null。
 * - 返回统一使用正斜杠的绝对路径（含盘符）。
 *
 * 路径安全策略由 Project 模块定义（ADR 0027）：rootPath + 所有已添加的
 * Extra Directory 均为有效项目目录。Diff Review 只消费 Project 的路径列表，
 * 不重新定义成员判断。
 */
export function resolveInsideProject(
  rawPath: string,
  rootPath: string,
  extraDirPaths: string[] = [],
): string | null {
  const normalized = rawPath.replace(/\\/g, '/');
  if (FILE_URI_SCHEME_RE.test(normalized)) return null;

  // 第一步：解析路径（相对路径按 rootPath 解析，绝对路径原样使用）
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
  const lowerAbsolute = absolute.toLowerCase();

  // 第二步：检查解析后的路径是否在任一有效项目目录内
  const allDirs = [root, ...extraDirPaths.map((p) => p.replace(/\\/g, '/').replace(/\/+$/, ''))];
  for (const dir of allDirs) {
    const lowerDir = dir.toLowerCase();
    if (lowerAbsolute === lowerDir) return null;
    if (lowerAbsolute.startsWith(`${lowerDir}/`)) return absolute;
  }
  return null;
}

function reviewMarker(filePath: string, toolCallId: string): string {
  return `${normalizeFilePath(filePath)}\n${toolCallId}`;
}

// ─── omp diff parsing ─────────────────────────────────────

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

export function extractOmpDiffEdits(result: unknown): OmpDiffEdit[] {
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

// ─── Tool call extraction ─────────────────────────────────

export function extractToolCallsFromMessage(msg: ChatMessage): DiffToolCall[] {
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
  const fileExistedBefore = msg.toolFileExistedBefore ?? resultDetails?.fileExistedBefore;
  const isNewFile = name === 'write' && content != null && fileExistedBefore === false;
  const beforeContent = msg.toolBeforeContent
    ?? (typeof resultDetails?.beforeContent === 'string' ? resultDetails.beforeContent : undefined);

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

// ─── Queue aggregation ─────────────────────────────────────

/**
 * 聚合审阅队列：从会话消息中提取 tool calls，按文件路径聚合。
 *
 * 参数化纯函数——调用方传入 sessions/projectId/rootPath/extraDirPaths/reviewedFiles，
 * 不再直接读取 store。
 */
export function aggregateQueue(
  sessions: Array<{ projectId: string; messages: ChatMessage[] }>,
  currentProjectId: string | null,
  rootPath: string | null,
  extraDirPaths: string[],
  reviewedFiles: Set<string>,
): ReviewEntry[] {
  const relevantSessions = currentProjectId
    ? sessions.filter((s) => s.projectId === currentProjectId)
    : sessions;
  const byFile = new Map<string, { filePath: string; toolCalls: DiffToolCall[] }>();

  for (const session of relevantSessions) {
    for (const msg of session.messages) {
      if (msg.role !== 'tool') continue;
      for (const tc of extractToolCallsFromMessage(msg)) {
        // 相对路径按项目根解析并校验在任一有效项目目录内，避免队列里出现后端无法接受的路径。
        const absolutePath = rootPath ? resolveInsideProject(tc.filePath, rootPath, extraDirPaths) : tc.filePath;
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

// ─── Hunk patch extraction ────────────────────────────────

export function getHunkPatch(diff: FileDiffResult, hunkId: number): HunkPatch | null {
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

// ─── Rejection building ───────────────────────────────────

/**
 * 构建拒绝列表：从 diff 中提取指定 hunks 的 patch，计算 priorDelta，
 * 组装为 DiffRejection 数组。纯函数，不依赖 store。
 */
export function buildRejections(
  diff: FileDiffResult,
  entry: ReviewEntry,
  hunkIds: number[],
  hunkStates: Record<number, HunkState>,
): DiffRejection[] {
  const idSet = new Set(hunkIds);
  const rejections: DiffRejection[] = [];
  for (const hunk of diff.hunks) {
    if (!idSet.has(hunk.id)) continue;
    const patch = getHunkPatch(diff, hunk.id);
    if (!patch) continue;
    const priorDelta = diff.hunks.reduce((delta, candidate) => {
      if (hunkStates[candidate.id] !== 'rejected') return delta;
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
  return rejections;
}

// ─── Review settlement ────────────────────────────────────

/**
 * 判断文件审阅是否已全部结算：所有 hunk 已 accepted、rejected 或 overwritten。
 */
export function isReviewSettled(
  diff: FileDiffResult,
  hunkStates: Record<number, HunkState>,
): boolean {
  return diff.hunks.every((hunk) =>
    hunk.overwritten || hunkStates[hunk.id] === 'accepted' || hunkStates[hunk.id] === 'rejected',
  );
}

/**
 * 判断 diff 中是否有任何 hunk 被拒绝。
 */
export function hasRejectedHunks(
  diff: FileDiffResult,
  hunkStates: Record<number, HunkState>,
): boolean {
  return diff.hunks.some((hunk) => hunkStates[hunk.id] === 'rejected');
}

// ─── Frontier resolution ──────────────────────────────────

/**
 * 确定已审阅到哪个 tool call：优先用 currentReviewToolCallId（仅当它属于该文件
 * 的 tool calls，避免残留的其它文件前沿标记误伤），回退到 entry 中最后一个
 * pending tool call 的 id。
 */
export function resolveFrontierId(
  entry: ReviewEntry,
  currentReviewToolCallId: string | null,
): string | undefined {
  if (currentReviewToolCallId != null
    && entry.toolCalls.some((tc) => tc.id === currentReviewToolCallId)) {
    return currentReviewToolCallId;
  }
  return entry.toolCalls[entry.toolCalls.length - 1]?.id;
}

// ─── Persistence ──────────────────────────────────────────

export function loadReviewedFiles(projectId: string | null): Set<string> {
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

export function persistReviewedFiles(projectId: string | null, reviewedFiles: Set<string>): void {
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
