import { describe, expect, it, vi } from 'vitest';
import type { ChatMessage } from '@renderer/stores/session-types';
import type { FileDiffResult } from '@shared/types';
import {
  aggregateQueue,
  buildRejections,
  extractOmpDiffEdits,
  extractToolCallsFromMessage,
  getHunkPatch,
  isReviewSettled,
  hasRejectedHunks,
  isSameFilePath,
  loadReviewedFiles,
  normalizeReviewKey,
  resolveFrontierId,
  resolveInsideProject,
  type ReviewEntry,
} from '@renderer/stores/diff-review-ops';

// ─── Test fixtures ─────────────────────────────────────────

function completedEdit(filePath: string): ChatMessage {
  return {
    id: 'tool-1',
    role: 'tool',
    content: '',
    timestamp: 100,
    toolName: 'edit',
    toolCallId: 'call-1',
    toolArgs: { path: filePath, oldText: 'before', newText: 'after' },
    toolResult: { ok: true },
  };
}

function completedOmpEditWithDetails(filePath: string): ChatMessage {
  return {
    id: 'tool-omp-1',
    role: 'tool',
    content: '',
    timestamp: 100,
    toolName: 'edit',
    toolCallId: 'call-omp-1',
    toolArgs: { input: '[core.sv#DEBA]\nSWAP 1.=1:\n+assign ready = valid;' },
    toolResult: {
      content: [{ type: 'text', text: `[${filePath}#TAG]\n1:assign ready = valid;` }],
      details: {
        path: filePath,
        diff: '-1|assign ready = 1\'b0;\n+1|assign ready = valid;',
        op: 'update',
        firstChangedLine: 1,
      },
    },
  };
}

function completedOmpEditWithDistantChanges(filePath: string): ChatMessage {
  const message = completedOmpEditWithDetails(filePath);
  message.toolArgs = { path: 'rtl/core.sv', input: '[core.sv#DEBA]\nSWAP 1.=1:\n+first after' };
  message.toolResult = {
    content: [{ type: 'text', text: `[${filePath}#TAG]\n1:first after\n20:last after` }],
    details: {
      path: filePath,
      diff: '-1|first before\n+1|first after\n 2|middle\n-20|last before\n+20|last after',
      oldText: 'whole file before',
      newText: 'whole file after',
      op: 'update',
      firstChangedLine: 1,
    },
  };
  return message;
}

function completedOmpWrite(
  filePath: string,
  beforeContent: string | undefined,
  content: string,
  fileExistedBefore = true,
): ChatMessage {
  return {
    id: 'tool-write-overwrite',
    role: 'tool',
    content: '',
    timestamp: 100,
    toolName: 'write',
    toolCallId: 'call-write-overwrite',
    toolArgs: { path: filePath, content },
    toolResult: {
      ok: true,
      details: { resolvedPath: filePath, fileExistedBefore, beforeContent },
    },
  };
}

function diffWithOneHunk(filePath: string): FileDiffResult {
  return {
    filePath,
    isNewFile: false,
    lines: [
      { type: 'del', content: 'before', oldLine: 1, hunkId: 1 },
      { type: 'add', content: 'after', newLine: 1, hunkId: 1 },
    ],
    hunks: [{
      id: 1,
      toolCallId: 'tool-1',
      toolName: 'edit',
      overwritten: false,
      startLineIndex: 0,
      endLineIndex: 2,
      addCount: 1,
      delCount: 1,
    }],
    totalAdd: 1,
    totalDel: 1,
  };
}

function diffWithTwoHunks(filePath: string): FileDiffResult {
  return {
    filePath,
    isNewFile: false,
    lines: [
      { type: 'del', content: 'first before', oldLine: 1, hunkId: 1 },
      { type: 'add', content: 'first after', newLine: 1, hunkId: 1 },
      { type: 'ctx', content: 'middle', oldLine: 2, newLine: 2 },
      { type: 'del', content: 'last before', oldLine: 3, hunkId: 2 },
      { type: 'add', content: 'last after', newLine: 3, hunkId: 2 },
    ],
    hunks: [
      {
        id: 1, toolCallId: 'tool-1', toolName: 'edit', overwritten: false,
        startLineIndex: 0, endLineIndex: 2, addCount: 1, delCount: 1,
      },
      {
        id: 2, toolCallId: 'tool-2', toolName: 'edit', overwritten: false,
        startLineIndex: 3, endLineIndex: 5, addCount: 1, delCount: 1,
      },
    ],
    totalAdd: 2,
    totalDel: 2,
  };
}

function makeSession(projectId: string, messages: ChatMessage[]): {
  projectId: string;
  messages: ChatMessage[];
} {
  return { projectId, messages };
}

// ─── Tests ─────────────────────────────────────────────────

describe('diff-review-ops', () => {
  // ── normalizeReviewKey & isSameFilePath ──────────────

  describe('normalizeReviewKey', () => {
    it('normalizes Windows backslash paths to forward slashes', () => {
      expect(normalizeReviewKey('D:\\project\\rtl\\core.sv')).toBe('d:/project/rtl/core.sv');
    });

    it('lowercases drive letters for Windows absolute paths', () => {
      expect(normalizeReviewKey('D:/Project/RTL/core.sv')).toBe('d:/project/rtl/core.sv');
    });

    it('does not lowercase non-drive-letter relative paths', () => {
      expect(normalizeReviewKey('src/Components/Button.tsx')).toBe('src/Components/Button.tsx');
    });
  });

  describe('isSameFilePath', () => {
    it('matches identical paths', () => {
      expect(isSameFilePath('D:\\project\\core.sv', 'D:/project/core.sv')).toBe(true);
    });

    it('matches with different case on Windows drive letters', () => {
      expect(isSameFilePath('D:\\Project\\core.sv', 'd:/project/core.sv')).toBe(true);
    });

    it('rejects different paths', () => {
      expect(isSameFilePath('D:/project/a.sv', 'D:/project/b.sv')).toBe(false);
    });
  });

  // ── resolveInsideProject ──────────────────────────────

  describe('resolveInsideProject', () => {
    const rootPath = 'D:\\project';
    const extraDirs: string[] = [];

    it('resolves a relative path against the project root', () => {
      expect(resolveInsideProject('rtl/core.sv', rootPath, extraDirs)).toBe('D:/project/rtl/core.sv');
    });

    it('accepts an absolute path inside the project root', () => {
      expect(resolveInsideProject('D:\\project\\rtl\\core.sv', rootPath, extraDirs)).toBe('D:/project/rtl/core.sv');
    });

    it('rejects a path outside the project root', () => {
      expect(resolveInsideProject('../outside.sv', rootPath, extraDirs)).toBeNull();
    });

    it('rejects URI scheme paths', () => {
      expect(resolveInsideProject('case://session-1', rootPath, extraDirs)).toBeNull();
    });

    it('accepts paths inside extra directories', () => {
      // Path inside an extra directory is accepted
      expect(resolveInsideProject('D:/extra/core.sv', rootPath, ['D:\\extra'])).toBe('D:/extra/core.sv');
      // Path inside root still accepted when extra dirs are configured
      expect(resolveInsideProject('core.sv', rootPath, ['D:\\extra'])).toBe('D:/project/core.sv');
      // Path outside both root and extra dirs is rejected
      expect(resolveInsideProject('D:/other/core.sv', rootPath, ['D:\\extra'])).toBeNull();
    });

    it('rejects the root directory itself', () => {
      expect(resolveInsideProject('.', rootPath, extraDirs)).toBeNull();
      expect(resolveInsideProject('D:\\project', rootPath, extraDirs)).toBeNull();
    });

    it('rejects tilde home-shorthand paths instead of joining them into the root', () => {
      // ~/.claude/skills/... 曾被拼成 D:/project/~/.claude/...，点击后加载报 ENOENT
      expect(resolveInsideProject('~/.claude/skills/tdd/tests.md', rootPath, extraDirs)).toBeNull();
      expect(resolveInsideProject('~', rootPath, extraDirs)).toBeNull();
      expect(resolveInsideProject('~\\.claude\\skills\\tdd\\tests.md', rootPath, extraDirs)).toBeNull();
    });
  });

  // ── extractOmpDiffEdits ──────────────────────────────

  describe('extractOmpDiffEdits', () => {
    it('returns empty array for null result', () => {
      expect(extractOmpDiffEdits(null)).toEqual([]);
    });

    it('returns oldText/newText directly when no diff string', () => {
      const result = { details: { oldText: 'a', newText: 'b' } };
      expect(extractOmpDiffEdits(result)).toEqual([{ oldText: 'a', newText: 'b' }]);
    });

    it('parses a single-line omp diff', () => {
      const result = {
        details: {
          diff: '-1|assign ready = 1\'b0;\n+1|assign ready = valid;',
          path: 'test.sv',
        },
      };
      const edits = extractOmpDiffEdits(result);
      expect(edits).toHaveLength(1);
      expect(edits[0]).toEqual({
        oldText: "assign ready = 1'b0;",
        newText: 'assign ready = valid;',
      });
    });

    it('splits distant changes into separate edits', () => {
      const result = {
        details: {
          diff: '-1|first before\n+1|first after\n 2|middle\n-20|last before\n+20|last after',
        },
      };
      const edits = extractOmpDiffEdits(result);
      expect(edits).toHaveLength(2);
      expect(edits[0]).toEqual({ oldText: 'first before\nmiddle', newText: 'first after\nmiddle' });
      expect(edits[1]).toEqual({ oldText: 'middle\nlast before', newText: 'middle\nlast after' });
    });

    it('splits nearby changes separated by context line', () => {
      const result = {
        details: {
          diff: '-1|first before\n+1|first after\n 2|middle\n-3|last before\n+3|last after',
        },
      };
      const edits = extractOmpDiffEdits(result);
      expect(edits).toHaveLength(2);
    });
  });

  // ── extractToolCallsFromMessage ───────────────────────

  describe('extractToolCallsFromMessage', () => {
    it('extracts a standard edit tool call', () => {
      const msg = completedEdit('D:\\project\\core.sv');
      const calls = extractToolCallsFromMessage(msg);
      expect(calls).toHaveLength(1);
      expect(calls[0]).toEqual(expect.objectContaining({
        filePath: 'D:\\project\\core.sv',
        oldText: 'before',
        newText: 'after',
        isNewFile: false,
      }));
    });

    it('extracts an omp edit with details.diff', () => {
      const msg = completedOmpEditWithDetails('D:\\project\\rtl\\core.sv');
      const calls = extractToolCallsFromMessage(msg);
      expect(calls).toHaveLength(1);
      expect(calls[0]).toEqual(expect.objectContaining({
        filePath: 'D:\\project\\rtl\\core.sv',
        oldText: "assign ready = 1'b0;",
        newText: 'assign ready = valid;',
      }));
    });

    it('splits distant omp changes into multiple tool calls', () => {
      const msg = completedOmpEditWithDistantChanges('D:\\project\\rtl\\core.sv');
      const calls = extractToolCallsFromMessage(msg);
      expect(calls).toHaveLength(2);
      expect(calls[0]).toEqual(expect.objectContaining({
        oldText: 'first before\nmiddle',
        newText: 'first after\nmiddle',
      }));
      expect(calls[1]).toEqual(expect.objectContaining({
        oldText: 'middle\nlast before',
        newText: 'middle\nlast after',
      }));
    });

    it('returns empty for non-editing tools', () => {
      const msg: ChatMessage = {
        id: 'r1', role: 'tool', content: '', timestamp: 1,
        toolName: 'read_file', toolCallId: 'c1',
        toolArgs: { path: 'test.sv' },
        toolResult: { ok: true },
      };
      expect(extractToolCallsFromMessage(msg)).toEqual([]);
    });

    it('returns empty for a tool call without toolResult', () => {
      const msg: ChatMessage = {
        id: 'r1', role: 'tool', content: '', timestamp: 1,
        toolName: 'edit', toolCallId: 'c1',
        toolArgs: { path: 'test.sv', oldText: 'a', newText: 'b' },
        toolResult: null,
      };
      expect(extractToolCallsFromMessage(msg)).toEqual([]);
    });

    it('returns empty for an error result', () => {
      const msg: ChatMessage = {
        id: 'r1', role: 'tool', content: '', timestamp: 1,
        toolName: 'edit', toolCallId: 'c1',
        toolArgs: { path: 'test.sv', oldText: 'a', newText: 'b' },
        toolResult: { isError: true },
      };
      expect(extractToolCallsFromMessage(msg)).toEqual([]);
    });

    it('returns empty for a failed omp write (no resolvedPath)', () => {
      const msg: ChatMessage = {
        id: 'r1', role: 'tool', content: '', timestamp: 1,
        toolName: 'write', toolCallId: 'c1',
        toolArgs: { path: 'README.md', content: '# Test' },
        toolResult: { content: [{ type: 'text', text: 'EISDIR' }], details: {} },
      };
      expect(extractToolCallsFromMessage(msg)).toEqual([]);
    });

    it('returns empty for no-change edits (oldText === newText)', () => {
      const msg: ChatMessage = {
        id: 'r1', role: 'tool', content: '', timestamp: 1,
        toolName: 'edit', toolCallId: 'c1',
        toolArgs: { path: 'test.sv', oldText: 'same', newText: 'same' },
        toolResult: { ok: true },
      };
      expect(extractToolCallsFromMessage(msg)).toEqual([]);
    });

    it('marks a write as new file when fileExistedBefore is false', () => {
      const msg = completedOmpWrite('D:\\project\\gen.md', undefined, 'generated\n', false);
      const calls = extractToolCallsFromMessage(msg);
      expect(calls).toHaveLength(1);
      expect(calls[0].isNewFile).toBe(true);
    });

    it('marks a write as overwrite when fileExistedBefore is true', () => {
      const msg = completedOmpWrite('D:\\project\\README.md', 'body\n', '# New\n', true);
      const calls = extractToolCallsFromMessage(msg);
      expect(calls).toHaveLength(1);
      expect(calls[0].isNewFile).toBe(false);
    });
  });

  // ── aggregateQueue ───────────────────────────────────

  describe('aggregateQueue', () => {
    it('aggregates tool calls by file path', () => {
      const sessions = [makeSession('project-1', [completedEdit('D:\\project\\rtl\\core.sv')])];
      const queue = aggregateQueue(sessions, 'project-1', null, [], new Set());
      expect(queue).toHaveLength(1);
      expect(queue[0]).toEqual(expect.objectContaining({
        filePath: 'D:\\project\\rtl\\core.sv',
        fileName: 'core.sv',
        reviewed: false,
      }));
    });

    it('filters sessions by projectId', () => {
      const sessions = [
        makeSession('project-1', [completedEdit('D:\\project\\a.sv')]),
        makeSession('project-2', [completedEdit('D:\\project\\b.sv')]),
      ];
      const queue = aggregateQueue(sessions, 'project-1', null, [], new Set());
      expect(queue).toHaveLength(1);
      expect(queue[0].filePath).toBe('D:\\project\\a.sv');
    });

    it('resolves relative paths against rootPath', () => {
      const sessions = [makeSession('project-1', [completedOmpEditWithDetails('rtl/core.sv')])];
      const queue = aggregateQueue(sessions, 'project-1', 'D:\\project', [], new Set());
      expect(queue).toHaveLength(1);
      expect(queue[0].filePath).toBe('D:/project/rtl/core.sv');
    });

    it('skips paths outside the project root', () => {
      const sessions = [makeSession('project-1', [completedOmpEditWithDetails('../outside.sv')])];
      const queue = aggregateQueue(sessions, 'project-1', 'D:\\project', [], new Set());
      expect(queue).toEqual([]);
    });

    it('marks entries as reviewed when frontier tool call is in reviewedFiles', () => {
      const filePath = 'D:\\project\\core.sv';
      const msg = completedEdit(filePath);
      const sessions = [makeSession('project-1', [msg])];
      const reviewedFiles = new Set([`${normalizeReviewKey(filePath)}\ntool-1`]);
      const queue = aggregateQueue(sessions, 'project-1', null, [], reviewedFiles);
      expect(queue).toHaveLength(1);
      expect(queue[0].reviewed).toBe(true);
    });

    it('only queues later edits after a reviewed tool call', () => {
      const filePath = 'D:\\project\\core.sv';
      const first = completedEdit(filePath);
      const second = { ...completedEdit(filePath), id: 'tool-2', timestamp: 200 };
      const sessions = [makeSession('project-1', [first, second])];
      const reviewedFiles = new Set([`${normalizeReviewKey(filePath)}\ntool-1`]);
      const queue = aggregateQueue(sessions, 'project-1', null, [], reviewedFiles);
      expect(queue).toHaveLength(1);
      expect(queue[0].reviewed).toBe(false);
      expect(queue[0].toolCalls.map((tc) => tc.id)).toEqual(['tool-2']);
    });

    it('uses all sessions when currentProjectId is null', () => {
      const sessions = [
        makeSession('project-1', [completedEdit('D:\\project\\a.sv')]),
        makeSession('project-2', [completedEdit('D:\\project\\b.sv')]),
      ];
      const queue = aggregateQueue(sessions, null, null, [], new Set());
      expect(queue).toHaveLength(2);
    });

    it('sorts tool calls by timestamp within a file', () => {
      const filePath = 'D:\\project\\core.sv';
      const first = completedEdit(filePath);
      const second = { ...completedEdit(filePath), id: 'tool-2', timestamp: 50 };
      const sessions = [makeSession('project-1', [first, second])];
      const queue = aggregateQueue(sessions, 'project-1', null, [], new Set());
      expect(queue[0].toolCalls.map((tc) => tc.id)).toEqual(['tool-2', 'tool-1']);
    });
  });

  // ── getHunkPatch ──────────────────────────────────────

  describe('getHunkPatch', () => {
    it('extracts patch for a single hunk', () => {
      const diff = diffWithOneHunk('test.sv');
      const patch = getHunkPatch(diff, 1);
      expect(patch).toEqual({
        startLine: 1,
        oldLines: ['before'],
        newLines: ['after'],
        beforeLine: null,
        afterLine: null,
      });
    });

    it('returns null for a non-existent hunk id', () => {
      const diff = diffWithOneHunk('test.sv');
      expect(getHunkPatch(diff, 999)).toBeNull();
    });

    it('extracts patch with context for two hunks', () => {
      const diff = diffWithTwoHunks('test.sv');
      const patch1 = getHunkPatch(diff, 1);
      expect(patch1?.oldLines).toEqual(['first before']);
      expect(patch1?.newLines).toEqual(['first after']);
      expect(patch1?.startLine).toBe(1);

      const patch2 = getHunkPatch(diff, 2);
      expect(patch2?.oldLines).toEqual(['last before']);
      expect(patch2?.newLines).toEqual(['last after']);
      expect(patch2?.startLine).toBe(3);
    });
  });

  // ── buildRejections ──────────────────────────────────

  describe('buildRejections', () => {
    it('builds rejection for a single hunk', () => {
      const filePath = 'D:\\project\\core.sv';
      const diff = diffWithOneHunk(filePath);
      const entry: ReviewEntry = {
        filePath, fileName: 'core.sv', toolCalls: [], isNewFile: false, reviewed: false,
      };
      const rejections = buildRejections(diff, entry, [1], {});
      expect(rejections).toHaveLength(1);
      expect(rejections[0]).toEqual(expect.objectContaining({
        hunkId: 1,
        toolCallId: 'tool-1',
        toolName: 'edit',
        startLine: 1,
        oldLines: ['before'],
        newLines: ['after'],
        deleteFile: false,
      }));
    });

    it('sets deleteFile=true for new files', () => {
      const filePath = 'D:\\project\\gen.md';
      const diff = diffWithOneHunk(filePath);
      const entry: ReviewEntry = {
        filePath, fileName: 'gen.md', toolCalls: [], isNewFile: true, reviewed: false,
      };
      const rejections = buildRejections(diff, entry, [1], {});
      expect(rejections[0].deleteFile).toBe(true);
    });

    it('skips hunks not in hunkIds', () => {
      const filePath = 'D:\\project\\core.sv';
      const diff = diffWithTwoHunks(filePath);
      const entry: ReviewEntry = {
        filePath, fileName: 'core.sv', toolCalls: [], isNewFile: false, reviewed: false,
      };
      const rejections = buildRejections(diff, entry, [1], {});
      expect(rejections).toHaveLength(1);
      expect(rejections[0].hunkId).toBe(1);
    });

    it('computes priorDelta for previously rejected hunks', () => {
      const filePath = 'D:\\project\\core.sv';
      const diff = diffWithTwoHunks(filePath);
      const entry: ReviewEntry = {
        filePath, fileName: 'core.sv', toolCalls: [], isNewFile: false, reviewed: false,
      };
      // Reject hunk 2 when hunk 1 is already rejected.
      // hunk 1 patch: oldLines=['first before'] (1 line), newLines=['first after'] (1 line)
      // priorDelta = 1 - 1 = 0
      const rejections = buildRejections(diff, entry, [2], { 1: 'rejected' });
      expect(rejections).toHaveLength(1);
      expect(rejections[0].hunkId).toBe(2);
      // priorDelta is 0 because oldLines.length === newLines.length for hunk 1
      expect(rejections[0].startLine).toBe(3);
    });
  });

  // ── isReviewSettled & hasRejectedHunks ────────────────

  describe('isReviewSettled', () => {
    it('returns false when there are pending hunks', () => {
      const diff = diffWithOneHunk('test.sv');
      expect(isReviewSettled(diff, { 1: 'pending' })).toBe(false);
    });

    it('returns true when all hunks are accepted', () => {
      const diff = diffWithOneHunk('test.sv');
      expect(isReviewSettled(diff, { 1: 'accepted' })).toBe(true);
    });

    it('returns true when all hunks are rejected', () => {
      const diff = diffWithOneHunk('test.sv');
      expect(isReviewSettled(diff, { 1: 'rejected' })).toBe(true);
    });

    it('returns true when hunks are mixed accepted/rejected', () => {
      const diff = diffWithTwoHunks('test.sv');
      expect(isReviewSettled(diff, { 1: 'accepted', 2: 'rejected' })).toBe(true);
    });

    it('returns true when hunks are overwritten', () => {
      const diff: FileDiffResult = {
        filePath: 'test.sv', isNewFile: false,
        lines: [], hunks: [{ id: 1, toolCallId: 't1', toolName: 'edit', overwritten: true,
          startLineIndex: 0, endLineIndex: 0, addCount: 0, delCount: 0 }],
        totalAdd: 0, totalDel: 0,
      };
      expect(isReviewSettled(diff, {})).toBe(true);
    });

    it('returns false with mixed settled and pending', () => {
      const diff = diffWithTwoHunks('test.sv');
      expect(isReviewSettled(diff, { 1: 'accepted', 2: 'pending' })).toBe(false);
    });
  });

  describe('hasRejectedHunks', () => {
    it('returns true when at least one hunk is rejected', () => {
      const diff = diffWithTwoHunks('test.sv');
      expect(hasRejectedHunks(diff, { 1: 'rejected', 2: 'pending' })).toBe(true);
    });

    it('returns false when no hunks are rejected', () => {
      const diff = diffWithTwoHunks('test.sv');
      expect(hasRejectedHunks(diff, { 1: 'accepted', 2: 'pending' })).toBe(false);
    });
  });

  // ── resolveFrontierId ────────────────────────────────

  describe('resolveFrontierId', () => {
    const entry: ReviewEntry = {
      filePath: 'D:/project/core.sv',
      fileName: 'core.sv',
      toolCalls: [
        { id: 'tool-1', toolName: 'edit', filePath: 'D:/project/core.sv', timestamp: 1, isNewFile: false },
        { id: 'tool-2', toolName: 'edit', filePath: 'D:/project/core.sv', timestamp: 2, isNewFile: false },
      ],
      isNewFile: false,
      reviewed: false,
    };

    it('uses currentReviewToolCallId when it belongs to the entry', () => {
      expect(resolveFrontierId(entry, 'tool-2')).toBe('tool-2');
    });

    it('falls back to last tool call when currentReviewToolCallId does not match', () => {
      expect(resolveFrontierId(entry, 'tool-other')).toBe('tool-2');
    });

    it('falls back to last tool call when currentReviewToolCallId is null', () => {
      expect(resolveFrontierId(entry, null)).toBe('tool-2');
    });

    it('returns undefined when entry has no tool calls', () => {
      const emptyEntry: ReviewEntry = {
        filePath: 'D:/project/core.sv', fileName: 'core.sv',
        toolCalls: [], isNewFile: false, reviewed: false,
      };
      expect(resolveFrontierId(emptyEntry, null)).toBeUndefined();
    });
  });

  // ── loadReviewedFiles ─────────────────────────────────

  describe('loadReviewedFiles', () => {
    it('returns empty set for null projectId', () => {
      expect(loadReviewedFiles(null).size).toBe(0);
    });

    it('returns empty set when localStorage has no data', () => {
      vi.stubGlobal('localStorage', { getItem: () => null });
      expect(loadReviewedFiles('project-1').size).toBe(0);
      vi.unstubAllGlobals();
    });

    it('loads reviewed files from localStorage', () => {
      const store: Record<string, string> = {};
      store['socverify:reviewedFiles:project-1'] = JSON.stringify(['marker1', 'marker2']);
      vi.stubGlobal('localStorage', { getItem: (k: string) => store[k] ?? null });
      const result = loadReviewedFiles('project-1');
      expect(result.size).toBe(2);
      expect(result.has('marker1')).toBe(true);
      expect(result.has('marker2')).toBe(true);
      vi.unstubAllGlobals();
    });

    it('returns empty set on JSON parse error', () => {
      vi.stubGlobal('localStorage', { getItem: () => 'not valid json{' });
      expect(loadReviewedFiles('project-1').size).toBe(0);
      vi.unstubAllGlobals();
    });
  });
});
