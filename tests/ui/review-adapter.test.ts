/**
 * Review Adapter 契约测试（issue 05 前半：Diff 展示与代码撤销动作解耦）。
 *
 * 目标：展示层（内联 diff / hunk 状态）与动作层（接受/拒绝）之间的接口，
 * 使代码审阅（code-applied：已写入、拒绝撤销）与知识审阅
 * （kb-staged：未写入、接受落地）可以共用同一份展示组件，
 * 而各自的动作语义不同。
 *
 * 约束：
 *  - 展示层不得自行调用 project 撤销 API；
 *  - 动作归 adapter 方；
 *  - 现有代码审阅行为保持原样（拒绝仍走 applyDiffRejections）。
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('@renderer/lib/trpc', () => ({
  trpc: {
    project: {
      getFileDiff: { query: vi.fn() },
      applyDiffRejections: { mutate: vi.fn() },
      fileExists: { query: vi.fn() },
      findFileByName: { query: vi.fn() },
    },
    kb: {
      decideStaged: { mutate: vi.fn() },
    },
  },
}));

import {
  createCodeAppliedAdapter,
  createKbStagedAdapter,
} from '@renderer/stores/review-adapter';
import { trpc } from '@renderer/lib/trpc';

beforeEach(() => {
  vi.clearAllMocks();
});

describe('review kind discriminator', () => {
  it('代码审阅与知识审阅用明确种类区分，且动作语义相反', () => {
    const code = createCodeAppliedAdapter({ projectId: 'p1', filePath: 'D:/p/a.ts' });
    const kb = createKbStagedAdapter({ changeSetId: 'cs-1', pageRelPath: 'wiki/concepts/x.md' });

    // 种类可区分：调用方据此选择展示/文案，不需要猜测
    expect(code.kind).toBe('code-applied');
    expect(kb.kind).toBe('kb-staged');
    // 拒绝语义相反：代码已写入故需撤销；知识提案未写入故不撤销
    expect(code.revertOnReject).toBe(true);
    expect(kb.revertOnReject).toBe(false);
  });
});

describe('createCodeAppliedAdapter（现有代码审阅，行为保持原样）', () => {
  it('拒绝 hunk 走 project.applyDiffRejections，不调用任何 kb 接口', async () => {
    vi.mocked(trpc.project.applyDiffRejections.mutate).mockResolvedValue({
      ok: true,
      appliedCount: 1,
      failures: [],
    });
    const adapter = createCodeAppliedAdapter({ projectId: 'p1', filePath: 'D:/p/a.ts' });
    const result = await adapter.reject([{
      hunkId: 1,
      toolCallId: 'tc-1',
      toolName: 'edit',
      startLine: 1,
      oldLines: ['before'],
      newLines: ['after'],
      beforeLine: null,
      afterLine: null,
      deleteFile: false,
    }]);

    expect(result.ok).toBe(true);
    expect(trpc.project.applyDiffRejections.mutate).toHaveBeenCalledTimes(1);
    expect(trpc.kb.decideStaged.mutate).not.toHaveBeenCalled();
  });

  it('接受 hunk 在 code-applied 下不做任何写操作（内容已在磁盘上）', async () => {
    const adapter = createCodeAppliedAdapter({ projectId: 'p1', filePath: 'D:/p/a.ts' });
    const result = await adapter.accept([1]);
    expect(result.ok).toBe(true);
    expect(trpc.project.applyDiffRejections.mutate).not.toHaveBeenCalled();
    expect(trpc.kb.decideStaged.mutate).not.toHaveBeenCalled();
  });

  it('kind 为 code-applied，拒绝撤销语义保持不变', () => {
    const adapter = createCodeAppliedAdapter({ projectId: 'p1', filePath: 'D:/p/a.ts' });
    expect(adapter.kind).toBe('code-applied');
    expect(adapter.revertOnReject).toBe(true);
  });
});

describe('createKbStagedAdapter（知识审阅：未写入，接受才落地）', () => {
  it('接受 hunk 走 kb.decideStaged（accepted），不调用 project 撤销 API', async () => {
    vi.mocked(trpc.kb.decideStaged.mutate).mockResolvedValue({ ok: true, review: { changeSetId: 'cs-1', pages: [], settled: false, updatedAt: 'x' } });
    const adapter = createKbStagedAdapter({ changeSetId: 'cs-1', pageRelPath: 'wiki/concepts/x.md' });
    const result = await adapter.accept([2, 3]);

    expect(result.ok).toBe(true);
    expect(trpc.kb.decideStaged.mutate).toHaveBeenCalledWith({
      changeSetId: 'cs-1',
      pageRelPath: 'wiki/concepts/x.md',
      hunkIds: [2, 3],
      decision: 'accepted',
    });
    expect(trpc.project.applyDiffRejections.mutate).not.toHaveBeenCalled();
  });

  it('拒绝 hunk 走 kb.decideStaged（rejected），不回滚磁盘', async () => {
    vi.mocked(trpc.kb.decideStaged.mutate).mockResolvedValue({ ok: true, review: { changeSetId: 'cs-1', pages: [], settled: false, updatedAt: 'x' } });
    const adapter = createKbStagedAdapter({ changeSetId: 'cs-1', pageRelPath: 'wiki/concepts/x.md' });
    const result = await adapter.reject([{
      hunkId: 5,
      toolCallId: 'kb',
      toolName: 'proposal',
      startLine: 1,
      oldLines: ['old'],
      newLines: ['new'],
      beforeLine: null,
      afterLine: null,
      deleteFile: false,
    }]);

    expect(result.ok).toBe(true);
    expect(trpc.kb.decideStaged.mutate).toHaveBeenCalledWith({
      changeSetId: 'cs-1',
      pageRelPath: 'wiki/concepts/x.md',
      hunkIds: [5],
      decision: 'rejected',
    });
    expect(trpc.project.applyDiffRejections.mutate).not.toHaveBeenCalled();
  });

  it('kind 为 kb-staged，拒绝不撤销已有内容', () => {
    const adapter = createKbStagedAdapter({ changeSetId: 'cs-1', pageRelPath: 'wiki/concepts/x.md' });
    expect(adapter.kind).toBe('kb-staged');
    expect(adapter.revertOnReject).toBe(false);
  });

  it('后端返回失败时 ok=false 不上报成功', async () => {
    vi.mocked(trpc.kb.decideStaged.mutate).mockResolvedValue({ ok: false, error: 'stale', code: 'changeSetNotFound' });
    const adapter = createKbStagedAdapter({ changeSetId: 'cs-1', pageRelPath: 'wiki/concepts/x.md' });
    const result = await adapter.accept([1]);
    expect(result.ok).toBe(false);
  });
});
