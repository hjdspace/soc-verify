import type { ChatMessage } from '@renderer/stores/session-types';
import {
  argStr,
  argVal,
  computeSimpleDiff,
} from '@renderer/components/chat/tool-helpers';

export type FileDiffStats = { added: number; deleted: number };

function contentLineCount(content: string): number {
  if (!content) return 0;
  return content.replace(/\r?\n$/, '').split(/\r?\n/).length;
}

function computeDiffStats(oldText: string, newText: string): FileDiffStats {
  if (!oldText) return { added: contentLineCount(newText), deleted: 0 };
  if (!newText) return { added: 0, deleted: contentLineCount(oldText) };
  const diff = computeSimpleDiff(oldText, newText);
  return {
    added: diff.filter((line) => line.type === 'add').length,
    deleted: diff.filter((line) => line.type === 'del').length,
  };
}

function resultDetails(result: unknown): Record<string, unknown> | null {
  if (typeof result !== 'object' || result === null) return null;
  const details = (result as Record<string, unknown>).details;
  return typeof details === 'object' && details !== null
    ? details as Record<string, unknown>
    : null;
}

function statsFromResultDiff(diff: string): FileDiffStats | null {
  let added = 0;
  let deleted = 0;
  for (const line of diff.split('\n')) {
    if (/^\+\s*\d+\|/.test(line)) added++;
    else if (/^-\s*\d+\|/.test(line)) deleted++;
  }
  return added > 0 || deleted > 0 ? { added, deleted } : null;
}

function statsFromPatch(patch: string): FileDiffStats | null {
  let added = 0;
  let deleted = 0;
  for (const line of patch.split('\n')) {
    if (line.startsWith('+') && !line.startsWith('+++')) added++;
    else if (line.startsWith('-') && !line.startsWith('---')) deleted++;
  }
  return added > 0 || deleted > 0 ? { added, deleted } : null;
}

function statsFromEditArgs(args: unknown): FileDiffStats | null {
  const oldText = argStr(args, 'oldText', 'old_string', 'old_text', 'find');
  const newText = argStr(args, 'newText', 'new_string', 'new_text', 'replace');
  if (oldText != null && newText != null) return computeDiffStats(oldText, newText);

  const edits = argVal(args, 'edits');
  if (Array.isArray(edits)) {
    let added = 0;
    let deleted = 0;
    let found = false;
    for (const edit of edits) {
      if (typeof edit !== 'object' || edit === null) continue;
      const record = edit as Record<string, unknown>;
      const oldValue = record.old_text ?? record.oldText ?? record.old_string;
      const newValue = record.new_text ?? record.newText ?? record.new_string;
      if (typeof oldValue !== 'string' || typeof newValue !== 'string') continue;
      const stats = computeDiffStats(oldValue, newValue);
      added += stats.added;
      deleted += stats.deleted;
      found = true;
    }
    if (found) return { added, deleted };
  }

  const patch = argStr(args, 'input', 'patch', 'diff');
  return patch ? statsFromPatch(patch) : null;
}

/** Compute file diff statistics (added/deleted line counts) from a tool message. */
export function getFileDiffStats(message: ChatMessage): FileDiffStats | null {
  const toolName = message.toolName ?? '';
  const details = resultDetails(message.toolResult);

  if (toolName === 'write' || toolName === 'write_file') {
    const content = argStr(message.toolArgs, 'content');
    if (content == null) return null;
    const beforeContent = message.toolBeforeContent
      ?? (typeof details?.beforeContent === 'string' ? details.beforeContent : undefined);
    return beforeContent == null
      ? { added: contentLineCount(content), deleted: 0 }
      : computeDiffStats(beforeContent, content);
  }

  if (toolName === 'edit' || toolName === 'edit_file' || toolName === 'apply_patch' || toolName === 'ast_edit') {
    if (typeof details?.diff === 'string') {
      const stats = statsFromResultDiff(details.diff);
      if (stats) return stats;
    }
    if (typeof details?.oldText === 'string' && typeof details.newText === 'string') {
      return computeDiffStats(details.oldText, details.newText);
    }
    return statsFromEditArgs(message.toolArgs);
  }

  return null;
}
