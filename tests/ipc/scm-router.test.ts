/**
 * scm-router 端到端测试（fileDiff）。
 *
 * 测试缝：tRPC server-side caller（router.createCaller）。
 * mock requireProject / sourceControlService。
 *
 * 先例：tests/ipc/case-cfg-router.test.ts
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';

// ─── Hoisted mock state ─────────────────────────────────────

const { mockRequireProject, mockService } = vi.hoisted(() => ({
  mockRequireProject: vi.fn(),
  mockService: {
    getStatus: vi.fn(),
    stageFiles: vi.fn(),
    unstageFiles: vi.fn(),
    discardChanges: vi.fn(),
    commit: vi.fn(),
    commitAll: vi.fn(),
    generateCommitMessage: vi.fn(),
    getFileDiff: vi.fn(),
  },
}));

// ─── Mocks ──────────────────────────────────────────────────

vi.mock('../../src/main/services/project-service', () => ({
  requireProject: mockRequireProject,
}));

vi.mock('../../src/main/scm/source-control', () => ({
  sourceControlService: mockService,
}));

// ─── Imports (after mocks) ──────────────────────────────────

import { scmRouter } from '../../src/main/ipc/routers/scm-router';

const caller = scmRouter.createCaller({});

const testDiff = {
  path: 'src/a.ts',
  staged: false,
  isNewFile: false,
  isDeleted: false,
  isBinary: false,
  hunks: [
    {
      header: '@@ -1,1 +1,1 @@',
      lines: [
        { type: 'del' as const, content: 'old', oldLine: 1 },
        { type: 'add' as const, content: 'new', newLine: 1 },
      ],
    },
  ],
  totalAdd: 1,
  totalDel: 1,
};

describe('scm-router fileDiff', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockRequireProject.mockReturnValue({ id: 'p1', rootPath: 'D:\\repo', name: 'Repo' });
  });

  it('returns the file diff with staged flag passed through', async () => {
    mockService.getFileDiff.mockResolvedValue(testDiff);

    const result = await caller.fileDiff({ projectId: 'p1', filePath: 'src/a.ts', staged: false });

    expect(mockService.getFileDiff).toHaveBeenCalledWith('D:\\repo', 'src/a.ts', { staged: false });
    expect(result.diff).toEqual(testDiff);
  });

  it('propagates staged=true for staged diffs', async () => {
    mockService.getFileDiff.mockResolvedValue({ ...testDiff, staged: true });

    await caller.fileDiff({ projectId: 'p1', filePath: 'src/a.ts', staged: true });

    expect(mockService.getFileDiff).toHaveBeenCalledWith('D:\\repo', 'src/a.ts', { staged: true });
  });

  it('rejects a missing filePath with BAD_REQUEST', async () => {
    await expect(caller.fileDiff({ projectId: 'p1', filePath: '', staged: false })).rejects.toMatchObject({
      code: 'BAD_REQUEST',
    });
    await expect(
      caller.fileDiff({ projectId: 'p1', filePath: 'a.ts', staged: 'yes' as unknown as boolean }),
    ).rejects.toMatchObject({ code: 'BAD_REQUEST' });
    expect(mockService.getFileDiff).not.toHaveBeenCalled();
  });

  it('wraps service errors as BAD_REQUEST', async () => {
    mockService.getFileDiff.mockRejectedValue(new Error('git failed'));

    await expect(caller.fileDiff({ projectId: 'p1', filePath: 'src/a.ts', staged: false })).rejects.toMatchObject({
      code: 'BAD_REQUEST',
      message: 'git failed',
    });
  });
});
