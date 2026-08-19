import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@renderer/lib/trpc', () => ({
  trpc: {
    project: {
      getFileDiff: { query: vi.fn() },
      applyDiffRejections: { mutate: vi.fn() },
    },
  },
}));

import { useSessionStore, type ChatMessage } from '@renderer/stores/session';
import { openReviewAwareFile, useDiffReviewStore, normalizeReviewKey } from '@renderer/stores/diff-review';
import { useProjectStore } from '@renderer/stores/project';
import { useWorkbenchStore } from '@renderer/stores/workbench';
import { trpc } from '@renderer/lib/trpc';
import type { FileDiffResult } from '@shared/types';

const defaultWorkbenchOpen = useWorkbenchStore.getState().open;

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

/** Build a ChatMessage for omp edit format (input-based, no path field). */
function completedOmpEdit(resultText: string): ChatMessage {
  return {
    id: 'tool-omp-1',
    role: 'tool',
    content: '',
    timestamp: 100,
    toolName: 'edit',
    toolCallId: 'call-omp-1',
    toolArgs: { input: '[test.ts#DEBA]\nDEL 42-49\n' },
    toolResult: { content: [{ type: 'text', text: resultText }] },
  };
}

function completedOmpEditWithDetails(filePath: string): ChatMessage {
  return {
    id: 'tool-omp-details-1',
    role: 'tool',
    content: '',
    timestamp: 100,
    toolName: 'edit',
    toolCallId: 'call-omp-details-1',
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

function emptyDiff(filePath: string): FileDiffResult {
  return { filePath, isNewFile: false, lines: [], hunks: [], totalAdd: 0, totalDel: 0 };
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

describe('Diff Review flow', () => {
  beforeEach(() => {
    useSessionStore.setState({ sessions: [] });
    useDiffReviewStore.setState({
      queue: [],
      currentFilePath: null,
      currentReviewToolCallId: null,
      fileDiffs: {},
      diffSignatures: {},
      loadingFiles: {},
      loadErrors: {},
      hunkStates: {},
      contentVersions: {},
      reviewedFiles: new Set(),
    });
    useProjectStore.setState({ currentProjectId: 'project-1', projects: [] });
    useWorkbenchStore.setState({ tabs: [], activeTabId: null, open: defaultWorkbenchOpen });
    vi.mocked(trpc.project.getFileDiff.query).mockReset();
    vi.mocked(trpc.project.applyDiffRejections.mutate).mockReset();
  });

  it('automatically projects completed editing tool events into the global Review Queue', () => {
    useSessionStore.setState({
      sessions: [{
        id: 'session-1',
        projectId: 'project-1',
        name: 'Agent conversation',
        status: 'idle',
        messages: [completedEdit('D:\\project\\rtl\\core.sv')],
        composer: { inputMessage: '', selectedSkills: [], contextFiles: [] },
        createdAt: 1,
      }],
    });

    expect(useDiffReviewStore.getState().queue).toEqual([
      expect.objectContaining({
        filePath: 'D:\\project\\rtl\\core.sv',
        fileName: 'core.sv',
        reviewed: false,
      }),
    ]);
  });

  it('projects omp edit format tool calls (path extracted from result text)', () => {
    const filePath = 'D:\\project\\test.ts';
    useSessionStore.setState({
      sessions: [{
        id: 'session-1',
        projectId: 'project-1',
        name: 'Agent conversation',
        status: 'idle',
        messages: [completedOmpEditWithDetails(filePath)],
        composer: { inputMessage: '', selectedSkills: [], contextFiles: [] },
        createdAt: 1,
      }],
    });

    const queue = useDiffReviewStore.getState().queue;
    expect(queue).toHaveLength(1);
    expect(queue[0].filePath).toBe(filePath);
    expect(queue[0].fileName).toBe('test.ts');
  });

  it('extracts reversible changes from a completed omp edit result', () => {
    const filePath = 'D:\\project\\rtl\\core.sv';
    useSessionStore.setState({
      sessions: [{
        id: 'session-1',
        projectId: 'project-1',
        name: 'Agent conversation',
        status: 'idle',
        messages: [completedOmpEditWithDetails(filePath)],
        composer: { inputMessage: '', selectedSkills: [], contextFiles: [] },
        createdAt: 1,
      }],
    });

    expect(useDiffReviewStore.getState().queue[0]?.toolCalls[0]).toEqual(
      expect.objectContaining({
        filePath,
        oldText: "assign ready = 1'b0;",
        newText: 'assign ready = valid;',
      }),
    );
  });

  it('uses the absolute result path and splits distant omp diff blocks', () => {
    const filePath = 'D:\\project\\rtl\\core.sv';
    useSessionStore.setState({
      sessions: [{
        id: 'session-1',
        projectId: 'project-1',
        name: 'Agent conversation',
        status: 'idle',
        messages: [completedOmpEditWithDistantChanges(filePath)],
        composer: { inputMessage: '', selectedSkills: [], contextFiles: [] },
        createdAt: 1,
      }],
    });

    const entry = useDiffReviewStore.getState().queue[0];
    expect(entry.filePath).toBe(filePath);
    expect(entry.toolCalls).toEqual([
      expect.objectContaining({ oldText: 'first before\nmiddle', newText: 'first after\nmiddle' }),
      expect.objectContaining({ oldText: 'middle\nlast before', newText: 'middle\nlast after' }),
    ]);
  });

  it('splits nearby omp changes separated by context into reversible blocks', () => {
    const filePath = 'D:\\project\\rtl\\core.sv';
    const message = completedOmpEditWithDistantChanges(filePath);
    const details = (message.toolResult as { details: { diff: string } }).details;
    details.diff = '-1|first before\n+1|first after\n 2|middle\n-3|last before\n+3|last after';
    useSessionStore.setState({
      sessions: [{
        id: 'session-1', projectId: 'project-1', name: 'Agent conversation', status: 'idle',
        messages: [message], composer: { inputMessage: '', selectedSkills: [], contextFiles: [] }, createdAt: 1,
      }],
    });

    expect(useDiffReviewStore.getState().queue[0].toolCalls).toEqual([
      expect.objectContaining({ oldText: 'first before\nmiddle', newText: 'first after\nmiddle' }),
      expect.objectContaining({ oldText: 'middle\nlast before', newText: 'middle\nlast after' }),
    ]);
  });

  it('does not queue an omp edit attempt that produced no file change', () => {
    useSessionStore.setState({
      sessions: [{
        id: 'session-1',
        projectId: 'project-1',
        name: 'Agent conversation',
        status: 'idle',
        messages: [completedOmpEdit('[D:\\project\\test.ts#TAG]\nEdit anchor did not match')],
        composer: { inputMessage: '', selectedSkills: [], contextFiles: [] },
        createdAt: 1,
      }],
    });

    expect(useDiffReviewStore.getState().queue).toEqual([]);
  });

  it('does not queue a failed omp write (EISDIR, no resolvedPath)', () => {
    useSessionStore.setState({
      sessions: [{
        id: 'session-1',
        projectId: 'project-1',
        name: 'Agent conversation',
        status: 'idle',
        messages: [{
          id: 'tool-write-eisdir',
          role: 'tool',
          content: '',
          timestamp: 100,
          toolName: 'write',
          toolCallId: 'call-write-eisdir',
          toolArgs: { path: 'README.md', content: '# TopDash' },
          toolResult: {
            content: [{ type: 'text', text: 'EISDIR: illegal operation on a directory, read' }],
            details: {},
          },
        }],
        composer: { inputMessage: '', selectedSkills: [], contextFiles: [] },
        createdAt: 1,
      }],
    });

    expect(useDiffReviewStore.getState().queue).toEqual([]);
  });

  it('resolves a cwd-relative result path into the project root for the review queue', () => {
    useProjectStore.setState({
      currentProjectId: 'project-1',
      projects: [{ id: 'project-1', name: 'Project', rootPath: 'D:\\project', createdAt: 1, lastOpenedAt: 1 }],
    });
    useSessionStore.setState({
      sessions: [{
        id: 'session-1',
        projectId: 'project-1',
        name: 'Agent conversation',
        status: 'idle',
        messages: [completedOmpEditWithDetails('rtl/core.sv')],
        composer: { inputMessage: '', selectedSkills: [], contextFiles: [] },
        createdAt: 1,
      }],
    });

    const queue = useDiffReviewStore.getState().queue;
    expect(queue).toHaveLength(1);
    expect(queue[0].filePath).toBe('D:/project/rtl/core.sv');
  });

  it('skips an edit whose resolved path lies outside the project root', () => {
    useProjectStore.setState({
      currentProjectId: 'project-1',
      projects: [{ id: 'project-1', name: 'Project', rootPath: 'D:\\project', createdAt: 1, lastOpenedAt: 1 }],
    });
    useSessionStore.setState({
      sessions: [{
        id: 'session-1',
        projectId: 'project-1',
        name: 'Agent conversation',
        status: 'idle',
        messages: [completedOmpEditWithDetails('../outside.sv')],
        composer: { inputMessage: '', selectedSkills: [], contextFiles: [] },
        createdAt: 1,
      }],
    });

    expect(useDiffReviewStore.getState().queue).toEqual([]);
  });

  it('retains hunk decisions for Windows file paths when the Review Queue refreshes', () => {
    const filePath = 'D:\\project\\rtl\\core.sv';
    const message = completedEdit(filePath);
    useSessionStore.setState({
      sessions: [{
        id: 'session-1',
        projectId: 'project-1',
        name: 'Agent conversation',
        status: 'idle',
        messages: [message],
        composer: { inputMessage: '', selectedSkills: [], contextFiles: [] },
        createdAt: 1,
      }],
    });
    const key = normalizeReviewKey(filePath);
    useDiffReviewStore.setState({ hunkStates: { [key]: { 1: 'rejected' } } });

    useSessionStore.setState((state) => ({
      sessions: state.sessions.map((session) => ({ ...session, name: 'Renamed conversation' })),
    }));

    expect(useDiffReviewStore.getState().hunkStates).toEqual({
      [key]: { 1: 'rejected' },
    });
  });

  it('loads a file once and opens a regular file tab with cached diff', async () => {
    const filePath = 'D:\\project\\rtl\\core.sv';
    vi.mocked(trpc.project.getFileDiff.query).mockResolvedValue(diffWithOneHunk(filePath));
    useSessionStore.setState({
      sessions: [{
        id: 'session-1',
        projectId: 'project-1',
        name: 'Agent conversation',
        status: 'idle',
        messages: [completedEdit(filePath)],
        composer: { inputMessage: '', selectedSkills: [], contextFiles: [] },
        createdAt: 1,
      }],
    });

    useDiffReviewStore.getState().openFile(filePath);
    const key = normalizeReviewKey(filePath);
    await vi.waitFor(() => expect(useDiffReviewStore.getState().loadingFiles[key]).toBeFalsy());

    expect(trpc.project.getFileDiff.query).toHaveBeenCalledTimes(1);
    expect(useDiffReviewStore.getState().hunkStates[key]).toEqual({ 1: 'pending' });
    expect(useDiffReviewStore.getState().fileDiffs[key]).toEqual(expect.objectContaining({ filePath }));
    // diff 加载后通知编辑器重载内容（内联装饰行号与磁盘对齐）
    expect(useDiffReviewStore.getState().contentVersions[key]).toBe(1);
    expect(useWorkbenchStore.getState().tabs[0]?.destination).toEqual({
      type: 'file',
      path: filePath,
      name: 'core.sv',
    });

    // 再次 openFile 不重复加载（diff 签名未变）
    useDiffReviewStore.getState().openFile(filePath);
    expect(trpc.project.getFileDiff.query).toHaveBeenCalledTimes(1);
  });

  it('sets the next review entry before switching the workbench file', () => {
    const firstPath = 'D:\\project\\rtl\\first.sv';
    const secondPath = 'D:\\project\\rtl\\second.sv';
    const first = completedEdit(firstPath);
    const second = { ...completedEdit(secondPath), id: 'tool-2', toolCallId: 'call-2' };
    useSessionStore.setState({
      sessions: [{
        id: 'session-1', projectId: 'project-1', name: 'Agent conversation', status: 'idle',
        messages: [first, second],
        composer: { inputMessage: '', selectedSkills: [], contextFiles: [] }, createdAt: 1,
      }],
    });
    vi.mocked(trpc.project.getFileDiff.query).mockResolvedValue(emptyDiff(secondPath));

    const openCalls: Array<{ currentFilePath: string | null; path: string }> = [];
    const originalOpen = defaultWorkbenchOpen;
    useWorkbenchStore.setState({
      open: (destination) => {
        if (destination.type === 'file') {
          openCalls.push({ currentFilePath: useDiffReviewStore.getState().currentFilePath, path: destination.path });
        }
        originalOpen(destination);
      },
    });

    useDiffReviewStore.getState().openFile(secondPath);

    expect(openCalls).toEqual([{ currentFilePath: secondPath, path: secondPath }]);
    useWorkbenchStore.setState({ open: originalOpen });
  });

  it('opens an unreviewed file from another Windows path spelling in the editor', async () => {
    const queuedPath = 'D:\\Project\\rtl\\core.sv';
    vi.mocked(trpc.project.getFileDiff.query).mockResolvedValue(emptyDiff(queuedPath));
    useSessionStore.setState({
      sessions: [{
        id: 'session-1',
        projectId: 'project-1',
        name: 'Agent conversation',
        status: 'idle',
        messages: [completedEdit(queuedPath)],
        composer: { inputMessage: '', selectedSkills: [], contextFiles: [] },
        createdAt: 1,
      }],
    });

    useDiffReviewStore.getState().openFile('d:/project/rtl/core.sv');
    await vi.waitFor(() => expect(useDiffReviewStore.getState().loadingFiles[normalizeReviewKey(queuedPath)]).toBeFalsy());

    expect(useWorkbenchStore.getState().tabs[0]?.destination).toEqual({
      type: 'file',
      path: queuedPath,
      name: 'core.sv',
    });
  });

  it('routes the review-aware file helper to a regular file tab', async () => {
    const filePath = 'D:\\project\\rtl\\core.sv';
    vi.mocked(trpc.project.getFileDiff.query).mockResolvedValue(emptyDiff(filePath));
    useSessionStore.setState({
      sessions: [{
        id: 'session-1', projectId: 'project-1', name: 'Agent conversation', status: 'idle',
        messages: [completedEdit(filePath)], composer: { inputMessage: '', selectedSkills: [], contextFiles: [] }, createdAt: 1,
      }],
    });

    openReviewAwareFile(filePath, 'core.sv');
    await vi.waitFor(() => expect(useDiffReviewStore.getState().loadingFiles[normalizeReviewKey(filePath)]).toBeFalsy());

    expect(useWorkbenchStore.getState().tabs[0]?.destination.type).toBe('file');
  });

  it('resolves a relative path against the project root before opening a file tab', () => {
    useProjectStore.setState({
      currentProjectId: 'project-1',
      projects: [{ id: 'project-1', name: 'Project', rootPath: 'D:\\project', createdAt: 1, lastOpenedAt: 1 }],
    });

    openReviewAwareFile('README.md', 'README.md');

    expect(useWorkbenchStore.getState().tabs[0]?.destination).toEqual({
      type: 'file',
      path: 'D:/project/README.md',
      name: 'README.md',
    });
  });

  it('matches a relative clicked path against an absolute queue entry', async () => {
    vi.mocked(trpc.project.getFileDiff.query).mockResolvedValue({
      filePath: 'D:/project/rtl/core.sv', isNewFile: false, lines: [], hunks: [], totalAdd: 0, totalDel: 0,
    });
    useProjectStore.setState({
      currentProjectId: 'project-1',
      projects: [{ id: 'project-1', name: 'Project', rootPath: 'D:\\project', createdAt: 1, lastOpenedAt: 1 }],
    });
    useSessionStore.setState({
      sessions: [{
        id: 'session-1', projectId: 'project-1', name: 'Agent conversation', status: 'idle',
        messages: [completedEdit('rtl/core.sv')], composer: { inputMessage: '', selectedSkills: [], contextFiles: [] }, createdAt: 1,
      }],
    });

    openReviewAwareFile('rtl/core.sv', 'core.sv');
    await vi.waitFor(() => expect(useDiffReviewStore.getState().loadingFiles['d:/project/rtl/core.sv']).toBeFalsy());

    expect(useWorkbenchStore.getState().tabs[0]?.destination.type).toBe('file');
  });

  it('setHunkState marks the hunk without completing the review', () => {
    const filePath = 'D:\\project\\rtl\\core.sv';
    const key = normalizeReviewKey(filePath);
    useDiffReviewStore.setState({
      queue: [{
        filePath,
        fileName: 'core.sv',
        toolCalls: [],
        isNewFile: false,
        reviewed: false,
      }],
      currentFilePath: filePath,
      fileDiffs: { [key]: diffWithOneHunk(filePath) },
    });

    useDiffReviewStore.getState().setHunkState(filePath, 1, 'rejected');

    expect(useDiffReviewStore.getState().hunkStates[key]).toEqual({ 1: 'rejected' });
    expect(useDiffReviewStore.getState().queue[0]?.reviewed).toBe(false);
    expect(useDiffReviewStore.getState().currentFilePath).toBe(filePath);
  });

  it('restores pending state when applying a rejection fails', async () => {
    const filePath = 'D:\\project\\rtl\\core.sv';
    const key = normalizeReviewKey(filePath);
    vi.mocked(trpc.project.applyDiffRejections.mutate).mockResolvedValue({
      ok: false,
      appliedCount: 0,
      failures: [{ hunkId: 1, reason: 'newText not found' }],
    });
    useDiffReviewStore.setState({
      queue: [{
        filePath,
        fileName: 'core.sv',
        toolCalls: [{
          id: 'tool-1',
          toolName: 'edit',
          filePath,
          timestamp: 100,
          oldText: 'before',
          newText: 'after',
          isNewFile: false,
        }],
        isNewFile: false,
        reviewed: false,
      }],
      currentFilePath: filePath,
      fileDiffs: { [key]: diffWithOneHunk(filePath) },
    });

    const applied = await useDiffReviewStore.getState().rejectHunk(filePath, 1);

    expect(applied).toBe(false);
    expect(useDiffReviewStore.getState().hunkStates[key]).toEqual({ 1: 'pending' });
    expect(useDiffReviewStore.getState().queue[0]?.reviewed).toBe(false);
    expect(useDiffReviewStore.getState().currentFilePath).toBe(filePath);
  });

  it('applies a hunk rejection immediately and completes review without rebuilding the diff', async () => {
    const filePath = 'D:\\project\\rtl\\core.sv';
    const key = normalizeReviewKey(filePath);
    vi.mocked(trpc.project.applyDiffRejections.mutate).mockResolvedValue({
      ok: true,
      appliedCount: 1,
      failures: [],
    });
    vi.mocked(trpc.project.getFileDiff.query)
      .mockResolvedValueOnce(diffWithOneHunk(filePath))
      .mockResolvedValueOnce(emptyDiff(filePath));
    useSessionStore.setState({
      sessions: [{
        id: 'session-1', projectId: 'project-1', name: 'Agent conversation', status: 'idle',
        messages: [completedEdit(filePath)], composer: { inputMessage: '', selectedSkills: [], contextFiles: [] }, createdAt: 1,
      }],
    });

    useDiffReviewStore.getState().openFile(filePath);
    await vi.waitFor(() => expect(useDiffReviewStore.getState().fileDiffs[key]).toBeTruthy());

    const applied = await useDiffReviewStore.getState().rejectHunk(filePath, 1);

    expect(applied).toBe(true);
    expect(trpc.project.applyDiffRejections.mutate).toHaveBeenCalledWith(
      expect.objectContaining({
        projectId: 'project-1',
        filePath,
        rejections: [expect.objectContaining({ hunkId: 1, toolCallId: 'tool-1' })],
      }),
    );
    // 拒绝后在当前 diff 快照中完成审阅，不再用同一 tool call 重建 before。
    expect(trpc.project.getFileDiff.query).toHaveBeenCalledTimes(1);
    expect(useDiffReviewStore.getState().queue[0]?.reviewed).toBe(true);
    expect(useDiffReviewStore.getState().fileDiffs[key]).toBeUndefined();
    expect(useDiffReviewStore.getState().contentVersions[key]).toBeGreaterThanOrEqual(2);
  });

  it('does not mark a write overwrite as a new file or request deletion on reject all', async () => {
    const filePath = 'D:\\project\\README.md';
    const message = completedOmpWrite(filePath, 'body\n', '# SoC Verify\n\nbody\n');
    useSessionStore.setState({
      sessions: [{
        id: 'session-1', projectId: 'project-1', name: 'Agent conversation', status: 'idle',
        messages: [message], composer: { inputMessage: '', selectedSkills: [], contextFiles: [] }, createdAt: 1,
      }],
    });
    const entry = useDiffReviewStore.getState().queue[0];
    expect(entry.isNewFile).toBe(false);
    vi.mocked(trpc.project.getFileDiff.query).mockResolvedValue({
      filePath, isNewFile: false,
      lines: [
        { type: 'del', content: 'body', oldLine: 1, hunkId: 1 },
        { type: 'add', content: '# SoC Verify', newLine: 1, hunkId: 1 },
      ],
      hunks: [{ id: 1, toolCallId: message.id, toolName: 'write', overwritten: false,
        startLineIndex: 0, endLineIndex: 2, addCount: 1, delCount: 1 }],
      totalAdd: 1, totalDel: 1,
    });
    vi.mocked(trpc.project.applyDiffRejections.mutate).mockResolvedValue({ ok: true, appliedCount: 1, failures: [] });
    expect(await useDiffReviewStore.getState().rejectAll(filePath)).toBe(true);
    expect(trpc.project.applyDiffRejections.mutate).toHaveBeenCalledWith(expect.objectContaining({
      rejections: [expect.objectContaining({ deleteFile: false })],
    }));
  });

  it('marks a write observed against a missing path as a new file', () => {
    const filePath = 'D:\\project\\generated.md';
    useSessionStore.setState({
      sessions: [{
        id: 'session-1', projectId: 'project-1', name: 'Agent conversation', status: 'idle',
        messages: [completedOmpWrite(filePath, undefined, 'generated\n', false)],
        composer: { inputMessage: '', selectedSkills: [], contextFiles: [] }, createdAt: 1,
      }],
    });

    expect(useDiffReviewStore.getState().queue[0]).toEqual(expect.objectContaining({
      filePath,
      isNewFile: true,
    }));
  });

  it('uses the tool-start snapshot to recognize a newly generated file', () => {
    const filePath = 'D:\\project\\generated.md';
    const message = completedOmpWrite(filePath, undefined, 'generated\n');
    message.toolFileExistedBefore = false;
    message.toolBeforeContent = undefined;
    message.toolResult = {
      ok: true,
      details: { resolvedPath: filePath },
    };
    useSessionStore.setState({
      sessions: [{
        id: 'session-1', projectId: 'project-1', name: 'Agent conversation', status: 'idle',
        messages: [message],
        composer: { inputMessage: '', selectedSkills: [], contextFiles: [] }, createdAt: 1,
      }],
    });

    expect(useDiffReviewStore.getState().queue[0]).toEqual(expect.objectContaining({
      filePath,
      isNewFile: true,
      reviewed: false,
    }));
  });

  it('settles two hunks independently before completing the file review', async () => {
    const filePath = 'D:\\project\\README.md';
    const key = normalizeReviewKey(filePath);
    vi.mocked(trpc.project.applyDiffRejections.mutate).mockResolvedValue({
      ok: true,
      appliedCount: 1,
      failures: [],
    });
    useDiffReviewStore.setState({
      queue: [{
        filePath,
        fileName: 'README.md',
        toolCalls: [
          { id: 'tool-1', toolName: 'edit', filePath, timestamp: 1, isNewFile: false },
          { id: 'tool-2', toolName: 'edit', filePath, timestamp: 2, isNewFile: false },
        ],
        isNewFile: false,
        reviewed: false,
      }],
      currentFilePath: filePath,
      currentReviewToolCallId: 'tool-2',
      fileDiffs: { [key]: diffWithTwoHunks(filePath) },
      hunkStates: { [key]: { 1: 'pending', 2: 'pending' } },
    });

    const rejected = await useDiffReviewStore.getState().rejectHunk(filePath, 1);

    expect(rejected).toBe(true);
    expect(useDiffReviewStore.getState().queue[0]?.reviewed).toBe(false);
    expect(useDiffReviewStore.getState().hunkStates[key]).toEqual({
      1: 'rejected',
      2: 'pending',
    });
    expect(trpc.project.applyDiffRejections.mutate).toHaveBeenCalledWith(
      expect.objectContaining({
        rejections: [expect.objectContaining({
          hunkId: 1,
          startLine: 1,
          oldLines: ['first before'],
          newLines: ['first after'],
        })],
      }),
    );

    useDiffReviewStore.getState().setHunkState(filePath, 2, 'accepted');

    expect(useDiffReviewStore.getState().queue.some((entry) => !entry.reviewed)).toBe(false);
    expect(useDiffReviewStore.getState().fileDiffs[key]).toBeUndefined();
  });

  it('rejects all hunks once and clears the review immediately', async () => {
    const filePath = 'D:\\project\\README.md';
    const key = normalizeReviewKey(filePath);
    vi.mocked(trpc.project.applyDiffRejections.mutate).mockResolvedValue({
      ok: true,
      appliedCount: 2,
      failures: [],
    });
    useDiffReviewStore.setState({
      queue: [{
        filePath,
        fileName: 'README.md',
        toolCalls: [
          { id: 'tool-1', toolName: 'edit', filePath, timestamp: 1, isNewFile: false },
          { id: 'tool-2', toolName: 'edit', filePath, timestamp: 2, isNewFile: false },
        ],
        isNewFile: false,
        reviewed: false,
      }],
      currentFilePath: filePath,
      currentReviewToolCallId: 'tool-2',
      fileDiffs: { [key]: diffWithTwoHunks(filePath) },
      hunkStates: { [key]: { 1: 'pending', 2: 'pending' } },
    });

    expect(await useDiffReviewStore.getState().rejectAll(filePath)).toBe(true);
    expect(useDiffReviewStore.getState().queue.some((entry) => !entry.reviewed)).toBe(false);
    expect(useDiffReviewStore.getState().fileDiffs[key]).toBeUndefined();
    expect(trpc.project.applyDiffRejections.mutate).toHaveBeenCalledTimes(1);
    expect(vi.mocked(trpc.project.applyDiffRejections.mutate).mock.calls[0][0].rejections).toHaveLength(2);

    expect(await useDiffReviewStore.getState().rejectAll(filePath)).toBe(true);
    expect(trpc.project.applyDiffRejections.mutate).toHaveBeenCalledTimes(1);
  });

  it('keeps reviewed entries in queue with reviewed=true (not removed)', () => {
    const filePath = 'D:\\project\\rtl\\core.sv';
    useSessionStore.setState({
      sessions: [{
        id: 'session-1',
        projectId: 'project-1',
        name: 'Agent conversation',
        status: 'idle',
        messages: [completedEdit(filePath)],
        composer: { inputMessage: '', selectedSkills: [], contextFiles: [] },
        createdAt: 1,
      }],
    });

    // Simulate marking the current tool call frontier as reviewed
    useDiffReviewStore.setState({
      reviewedFiles: new Set([`${filePath.toLowerCase().replace(/\\/g, '/')}\ntool-1`]),
    });
    useDiffReviewStore.getState().refreshQueue();

    const queue = useDiffReviewStore.getState().queue;
    expect(queue).toHaveLength(1);
    expect(queue[0].filePath).toBe(filePath);
    expect(queue[0].reviewed).toBe(true);
  });

  it('queues only later edits after a file was reviewed', () => {
    const filePath = 'D:\\project\\rtl\\core.sv';
    const first = completedEdit(filePath);
    const second = { ...completedEdit(filePath), id: 'tool-2', timestamp: 200 };
    useSessionStore.setState({
      sessions: [{
        id: 'session-1',
        projectId: 'project-1',
        name: 'Agent conversation',
        status: 'idle',
        messages: [first],
        composer: { inputMessage: '', selectedSkills: [], contextFiles: [] },
        createdAt: 1,
      }],
    });
    useDiffReviewStore.setState({
      reviewedFiles: new Set([`${filePath.toLowerCase().replace(/\\/g, '/')}\ntool-1`]),
    });

    useSessionStore.setState((state) => ({
      sessions: state.sessions.map((session) => ({ ...session, messages: [first, second] })),
    }));

    const entry = useDiffReviewStore.getState().queue[0];
    expect(entry.reviewed).toBe(false);
    expect(entry.toolCalls.map((toolCall) => toolCall.id)).toEqual(['tool-2']);
    expect(useDiffReviewStore.getState().hunkStates[filePath]).toBeUndefined();
  });

  it('does not mark an edit that arrives during review as reviewed', () => {
    const filePath = 'D:\\project\\rtl\\core.sv';
    const first = completedEdit(filePath);
    const second = { ...completedEdit(filePath), id: 'tool-2', timestamp: 200 };
    useSessionStore.setState({
      sessions: [{
        id: 'session-1', projectId: 'project-1', name: 'Agent conversation', status: 'idle',
        messages: [first], composer: { inputMessage: '', selectedSkills: [], contextFiles: [] }, createdAt: 1,
      }],
    });
    useDiffReviewStore.setState({ currentFilePath: filePath, currentReviewToolCallId: 'tool-1' });
    useDiffReviewStore.setState({
      fileDiffs: { [normalizeReviewKey(filePath)]: diffWithOneHunk(filePath) },
    });
    useSessionStore.setState((state) => ({
      sessions: state.sessions.map((session) => ({ ...session, messages: [first, second] })),
    }));
    vi.mocked(trpc.project.getFileDiff.query).mockResolvedValue({
      filePath, isNewFile: false, lines: [], hunks: [], totalAdd: 0, totalDel: 0,
    });

    useDiffReviewStore.getState().acceptAll(filePath);

    const entry = useDiffReviewStore.getState().queue[0];
    expect(entry.reviewed).toBe(false);
    expect(entry.toolCalls.map((toolCall) => toolCall.id)).toEqual(['tool-2']);
  });

  it('preserves reviewedFiles when sessions are restored with empty messages (race condition)', () => {
    const filePath = 'D:\\project\\rtl\\core.sv';
    const marker = `${filePath.toLowerCase().replace(/\\/g, '/')}\ntool-1`;

    // Simulate the app-startup race: sessions are created with empty messages,
    // then messages are loaded asynchronously. reviewedFiles from localStorage
    // must survive the intermediate refreshQueue() calls.

    // Step 1: reviewedFiles loaded from localStorage, sessions empty
    useDiffReviewStore.setState({ reviewedFiles: new Set([marker]) });
    useSessionStore.setState({ sessions: [] });
    useDiffReviewStore.getState().refreshQueue();

    // reviewedFiles must not be cleared
    expect(useDiffReviewStore.getState().reviewedFiles.has(marker)).toBe(true);

    // Step 2: session created with empty messages (before async message load)
    useSessionStore.setState({
      sessions: [{
        id: 'session-1', projectId: 'project-1', name: 'Agent conversation', status: 'idle',
        messages: [], composer: { inputMessage: '', selectedSkills: [], contextFiles: [] }, createdAt: 1,
      }],
    });

    // reviewedFiles must still survive
    expect(useDiffReviewStore.getState().reviewedFiles.has(marker)).toBe(true);

    // Step 3: messages loaded asynchronously — now the file appears in the queue
    useSessionStore.setState((state) => ({
      sessions: state.sessions.map((session) => ({
        ...session,
        messages: [completedEdit(filePath)],
      })),
    }));

    // Now the file should be marked as reviewed in the queue
    const queue = useDiffReviewStore.getState().queue;
    expect(queue).toHaveLength(1);
    expect(queue[0].reviewed).toBe(true);
    expect(useDiffReviewStore.getState().reviewedFiles.has(marker)).toBe(true);
  });

  it('auto-restores reviewedFiles from localStorage when store has empty set', () => {
    const filePath = 'D:\\project\\rtl\\core.sv';
    const marker = `${filePath.toLowerCase().replace(/\\/g, '/')}\ntool-1`;

    // Mock localStorage for this test
    const store: Record<string, string> = {};
    const localStorageMock = {
      getItem: (key: string) => store[key] ?? null,
      setItem: (key: string, value: string) => { store[key] = value; },
    };
    vi.stubGlobal('localStorage', localStorageMock);

    // Simulate: store initialized with empty reviewedFiles (currentProjectId was null),
    // but localStorage has data. refreshQueue should auto-restore.
    store['socverify:reviewedFiles:project-1'] = JSON.stringify([marker]);
    useDiffReviewStore.setState({ reviewedFiles: new Set() });
    useProjectStore.setState({ currentProjectId: 'project-1' });

    useDiffReviewStore.getState().refreshQueue();

    // reviewedFiles should be auto-restored from localStorage
    expect(useDiffReviewStore.getState().reviewedFiles.has(marker)).toBe(true);

    vi.unstubAllGlobals();
  });
});
