import type { ChatMessage } from '@renderer/stores/session-types';
import type { DiffLineData } from '@renderer/components/chat/tool-helpers';
import {
  argStr,
  argVal,
  computeSimpleDiff,
  extractEditFilePath,
  extractResultText,
} from '@renderer/components/chat/tool-helpers';

export type FileDiffStats = { added: number; deleted: number };

export type FileDiffPreview = {
  path: string;
  added: number;
  deleted: number;
  lines: DiffLineData[];
};

function resultDetails(result: unknown): Record<string, unknown> | null {
  if (typeof result !== 'object' || result === null) return null;
  const details = (result as Record<string, unknown>).details;
  return typeof details === 'object' && details !== null
    ? details as Record<string, unknown>
    : null;
}

/**
 * 解析 omp edit 返回的 details.diff。兼容两种格式：
 * - 编号 diff（generateDiffString）：`+N|line` / `-N|line` / ` N|line`，gap 行为空行或 `…`
 * - unified diff（generateUnifiedDiffString，patch 模式）：`@@` hunk + `+`/`-`/` ` 行
 */
export function parseResultDiffLines(diff: string): DiffLineData[] {
  const lines: DiffLineData[] = [];
  for (const line of diff.split('\n')) {
    // unified diff 文件头行不计入变更
    if (line.startsWith('+++') || line.startsWith('---')) continue;
    const numbered = /^([+\- ])(\d+)\|(.*)$/.exec(line);
    if (numbered) {
      const [, prefix, num, content] = numbered;
      if (prefix === '+') lines.push({ type: 'add', content, newLine: Number(num) });
      else if (prefix === '-') lines.push({ type: 'del', content, oldLine: Number(num) });
      else lines.push({ type: 'ctx', content, oldLine: Number(num) });
      continue;
    }
    // gap 行（空行 / 省略号）：分隔不连续区域
    if (line === '' || line === '…' || line === '...') {
      if (lines.length > 0) lines.push({ type: 'ctx', content: '…' });
      continue;
    }
    if (line.startsWith('+')) {
      lines.push({ type: 'add', content: line.slice(1) });
      continue;
    }
    if (line.startsWith('-')) {
      lines.push({ type: 'del', content: line.slice(1) });
      continue;
    }
    lines.push({ type: 'ctx', content: line });
  }
  return lines;
}

/** 解析 unified patch 文本（args.input/patch/diff），无有效 +/- 行时返回 null */
function parsePatchLines(patch: string): DiffLineData[] | null {
  const lines: DiffLineData[] = [];
  for (const line of patch.split('\n')) {
    if (line.startsWith('+++') || line.startsWith('---')) continue;
    if (line.startsWith('+')) lines.push({ type: 'add', content: line.slice(1) });
    else if (line.startsWith('-')) lines.push({ type: 'del', content: line.slice(1) });
    else lines.push({ type: 'ctx', content: line });
  }
  return lines.some((l) => l.type !== 'ctx') ? lines : null;
}

function countLines(lines: DiffLineData[]): FileDiffStats {
  return {
    added: lines.filter((l) => l.type === 'add').length,
    deleted: lines.filter((l) => l.type === 'del').length,
  };
}

/**
 * 从 omp edit 工具结果的 details 中提取行级 diff（EditBody 展开体复用）。
 * 数据源优先级：details.diff（编号/unified 均可）→ details.oldText + details.newText。
 * omp 全部 edit 模式（hashline / replace / patch / sloppy）成功时都会填充这两个字段，
 * 因此这是展开体渲染 diff 的最可靠数据源。
 */
export function getEditDetailDiff(toolResult: unknown): DiffLineData[] | null {
  const details = resultDetails(toolResult);
  if (!details) return null;
  if (typeof details.diff === 'string') {
    const lines = parseResultDiffLines(details.diff);
    if (lines.some((l) => l.type !== 'ctx')) return lines;
  }
  if (typeof details.oldText === 'string' && typeof details.newText === 'string'
    && details.oldText !== details.newText) {
    return computeSimpleDiff(details.oldText, details.newText);
  }
  return null;
}

/** 编辑类工具的行级 diff 数据（不含路径），统计数字由此派生 */
function editDiffLines(message: ChatMessage): DiffLineData[] | null {
  const toolName = message.toolName ?? '';
  const args = message.toolArgs;
  const details = resultDetails(message.toolResult);

  if (toolName === 'write' || toolName === 'write_file') {
    const content = argStr(args, 'content');
    if (content == null) return null;
    const beforeContent = message.toolBeforeContent
      ?? (typeof details?.beforeContent === 'string' ? details.beforeContent : undefined);
    if (beforeContent == null) {
      if (!content) return [];
      return content
        .replace(/\r?\n$/, '')
        .split(/\r?\n/)
        .map((c) => ({ type: 'add' as const, content: c }));
    }
    return computeSimpleDiff(beforeContent, content);
  }

  if (toolName === 'edit' || toolName === 'edit_file' || toolName === 'apply_patch' || toolName === 'ast_edit') {
    if (typeof details?.diff === 'string') {
      const lines = parseResultDiffLines(details.diff);
      if (lines.some((l) => l.type !== 'ctx')) return lines;
    }
    if (typeof details?.oldText === 'string' && typeof details.newText === 'string') {
      return computeSimpleDiff(details.oldText, details.newText);
    }
    const oldText = argStr(args, 'oldText', 'old_string', 'old_text', 'find');
    const newText = argStr(args, 'newText', 'new_string', 'new_text', 'replace');
    if (oldText != null && newText != null) return computeSimpleDiff(oldText, newText);

    const edits = argVal(args, 'edits');
    if (Array.isArray(edits)) {
      const lines: DiffLineData[] = [];
      for (const edit of edits) {
        if (typeof edit !== 'object' || edit === null) continue;
        const record = edit as Record<string, unknown>;
        const oldValue = record.old_text ?? record.oldText ?? record.old_string;
        const newValue = record.new_text ?? record.newText ?? record.new_string;
        if (typeof oldValue !== 'string' || typeof newValue !== 'string') continue;
        lines.push(...computeSimpleDiff(oldValue, newValue));
      }
      if (lines.length > 0) return lines;
    }

    const patch = argStr(args, 'input', 'patch', 'diff');
    return patch ? parsePatchLines(patch) : null;
  }

  return null;
}

/**
 * 行级文件 diff 预览（编辑类工具）：数据源优先级与 getFileDiffStats 一致，
 * 供 ToolRunGroup 的 diff chip hover 预览使用。预览 chip 需要可打开的
 * 文件路径，路径不可得时返回 null。
 */
export function getFileDiffPreview(message: ChatMessage): FileDiffPreview | null {
  const lines = editDiffLines(message);
  if (!lines) return null;
  const path = extractEditFilePath(message.toolArgs, extractResultText(message.toolResult))
    ?? argStr(message.toolArgs, 'path', 'file_path');
  if (!path) return null;
  return { path, ...countLines(lines), lines };
}

/** Compute file diff statistics (added/deleted line counts) from a tool message. */
export function getFileDiffStats(message: ChatMessage): FileDiffStats | null {
  const lines = editDiffLines(message);
  return lines ? countLines(lines) : null;
}
