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
import { openReviewAwareFile, useDiffReviewStore } from '@renderer/stores/diff-review';
import { useProjectStore } from '@renderer/stores/project';
import { useWorkbenchStore } from '@renderer/stores/workbench';
import { trpc } from '@renderer/lib/trpc';

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

describe('Diff Review flow', () => {
  beforeEach(() => {
    useSessionStore.setState({ sessions: [] });
    useDiffReviewStore.setState({
      queue: [],
      currentFilePath: null,
      currentReviewToolCallId: null,
      currentDiff: null,
      hunkStates: {},
      loading: false,
      reviewedFiles: new Set(),
    });
    useProjectStore.setState({ currentProjectId: 'project-1' });
    useWorkbenchStore.setState({ tabs: [], activeTabId: null });
    vi.mocked(trpc.project.getFileDiff.query).mockReset();
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
    useDiffReviewStore.setState({ hunkStates: { [filePath]: { 1: 'rejected' } } });

    useSessionStore.setState((state) => ({
      sessions: state.sessions.map((session) => ({ ...session, name: 'Renamed conversation' })),
    }));

    expect(useDiffReviewStore.getState().hunkStates).toEqual({
      [filePath]: { 1: 'rejected' },
    });
  });

  it('loads a file once and opens its typed Workbench destination', async () => {
    const filePath = 'D:\\project\\rtl\\core.sv';
    vi.mocked(trpc.project.getFileDiff.query).mockResolvedValue({
      filePath,
      isNewFile: false,
      lines: [{ type: 'add', content: 'after', newLine: 1, hunkId: 1 }],
      hunks: [{
        id: 1,
        toolCallId: 'tool-1',
        toolName: 'edit',
        overwritten: false,
        startLineIndex: 0,
        endLineIndex: 1,
        addCount: 1,
        delCount: 0,
      }],
      totalAdd: 1,
      totalDel: 0,
    });
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
    await vi.waitFor(() => expect(useDiffReviewStore.getState().loading).toBe(false));

    expect(trpc.project.getFileDiff.query).toHaveBeenCalledTimes(1);
    expect(useDiffReviewStore.getState().hunkStates[filePath]).toEqual({ 1: 'pending' });
    expect(useWorkbenchStore.getState().tabs[0]?.destination).toEqual({
      type: 'diff-review',
      filePath,
      fileName: 'core.sv',
    });
  });

  it('opens an unreviewed file from another Windows path spelling in Diff Review', async () => {
    const queuedPath = 'D:\\Project\\rtl\\core.sv';
    vi.mocked(trpc.project.getFileDiff.query).mockResolvedValue({
      filePath: queuedPath,
      isNewFile: false,
      lines: [],
      hunks: [],
      totalAdd: 0,
      totalDel: 0,
    });
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
    await vi.waitFor(() => expect(useDiffReviewStore.getState().loading).toBe(false));

    expect(useWorkbenchStore.getState().tabs[0]?.destination).toEqual({
      type: 'diff-review',
      filePath: queuedPath,
      fileName: 'core.sv',
    });
  });

  it('routes the review-aware file helper to a Diff Review destination', async () => {
    const filePath = 'D:\\project\\rtl\\core.sv';
    vi.mocked(trpc.project.getFileDiff.query).mockResolvedValue({
      filePath, isNewFile: false, lines: [], hunks: [], totalAdd: 0, totalDel: 0,
    });
    useSessionStore.setState({
      sessions: [{
        id: 'session-1', projectId: 'project-1', name: 'Agent conversation', status: 'idle',
        messages: [completedEdit(filePath)], composer: { inputMessage: '', selectedSkills: [], contextFiles: [] }, createdAt: 1,
      }],
    });

    openReviewAwareFile(filePath, 'core.sv');
    await vi.waitFor(() => expect(useDiffReviewStore.getState().loading).toBe(false));

    expect(useWorkbenchStore.getState().tabs[0]?.destination.type).toBe('diff-review');
  });

  it('keeps rejected hunks pending until their reversions are applied', () => {
    const filePath = 'D:\\project\\rtl\\core.sv';
    useDiffReviewStore.setState({
      queue: [{
        filePath,
        fileName: 'core.sv',
        toolCalls: [],
        isNewFile: false,
        reviewed: false,
      }],
      currentFilePath: filePath,
      currentDiff: {
        filePath,
        isNewFile: false,
        lines: [],
        hunks: [{
          id: 1,
          toolCallId: 'tool-1',
          toolName: 'edit',
          overwritten: false,
          startLineIndex: 0,
          endLineIndex: 1,
          addCount: 1,
          delCount: 1,
        }],
        totalAdd: 1,
        totalDel: 1,
      },
    });

    useDiffReviewStore.getState().setHunkState(filePath, 1, 'rejected');

    expect(useDiffReviewStore.getState().queue[0]?.reviewed).toBe(false);
    expect(useDiffReviewStore.getState().currentFilePath).toBe(filePath);
  });

  it('keeps review open when applying rejected hunks fails', async () => {
    const filePath = 'D:\\project\\rtl\\core.sv';
    vi.mocked(trpc.project.applyDiffRejections.mutate).mockResolvedValue({
      ok: false,
      appliedCount: 0,
      failures: [{ hunkId: 1, reason: 'newText not found' }],
    });
    useDiffReviewStore.setState({
      queue: [{
        filePath,
        fileName: 'core.sv',
        toolCalls: [completedEdit(filePath)].map((message) => ({
          id: message.id,
          toolName: 'edit',
          filePath,
          timestamp: message.timestamp,
          oldText: 'before',
          newText: 'after',
          isNewFile: false,
        })),
        isNewFile: false,
        reviewed: false,
      }],
      currentFilePath: filePath,
      currentDiff: {
        filePath,
        isNewFile: false,
        lines: [],
        hunks: [{
          id: 1,
          toolCallId: 'tool-1',
          toolName: 'edit',
          overwritten: false,
          startLineIndex: 0,
          endLineIndex: 1,
          addCount: 1,
          delCount: 1,
        }],
        totalAdd: 1,
        totalDel: 1,
      },
      hunkStates: { [filePath]: { 1: 'rejected' } },
    });

    await useDiffReviewStore.getState().applyRejections(filePath);

    expect(useDiffReviewStore.getState().queue[0]?.reviewed).toBe(false);
    expect(useDiffReviewStore.getState().currentFilePath).toBe(filePath);
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
      currentDiff: {
        filePath,
        isNewFile: false,
        lines: [],
        hunks: [{
          id: 1, toolCallId: 'tool-1', toolName: 'edit', overwritten: false,
          startLineIndex: 0, endLineIndex: 1, addCount: 1, delCount: 1,
        }],
        totalAdd: 1,
        totalDel: 1,
      },
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
});
