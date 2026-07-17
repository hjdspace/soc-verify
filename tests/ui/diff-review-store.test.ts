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
import { useDiffReviewStore } from '@renderer/stores/diff-review';
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

describe('Diff Review flow', () => {
  beforeEach(() => {
    useSessionStore.setState({ sessions: [] });
    useDiffReviewStore.setState({
      queue: [],
      currentFilePath: null,
      currentDiff: null,
      hunkStates: {},
      loading: false,
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
      }),
    ]);
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
});
