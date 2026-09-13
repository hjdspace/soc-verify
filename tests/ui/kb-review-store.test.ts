// @vitest-environment jsdom
/**
 * kb-review store 行为测试（issue 05 后半）。
 *
 * 覆盖验收中的三条：
 *  - 独立 before/after fixture 可渲染差异，无需伪造工具调用；
 *  - 展示侧不自行调用 project 撤销 API（kb-staged 只走 kb.decideStaged）；
 *  - 重开仍可审阅（列表/读回/决策读回）。
 *
 * diff 合成（buildStagedDiff）是纯函数导出，单测直接覆盖，不依赖 tRPC。
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

// ─── Mock data ──────────────────────────────────────────────

const { mockSummary, mockChangeSet, mockReview, mockEmptyReview } = vi.hoisted(() => {
  const before = [
    '---',
    'type: concept',
    'title: "AXI"',
    '---',
    '',
    '# AXI',
    '',
    '旧正文。',
  ].join('\n');
  const proposed = [
    '---',
    'type: concept',
    'title: "AXI"',
    '---',
    '',
    '# AXI',
    '',
    '新正文。',
    '',
    '补充说明。',
  ].join('\n');
  const newPage = [
    '---',
    'type: concept',
    'title: "APB"',
    '---',
    '',
    '# APB',
  ].join('\n');
  const sources = [{ sourceId: 'a'.repeat(64), sourceRevision: 'b'.repeat(64), parsedHash: 'c'.repeat(64) }];

  return {
    mockSummary: {
      changeSetId: 'cs-1',
      kbId: 'kb-1',
      taskId: 'task-1',
      origin: 'compile' as const,
      pageCount: 2,
      newPageCount: 1,
      findingCount: 0,
      settled: false,
      createdAt: '2026-09-13T00:00:00Z',
      updatedAt: '2026-09-13T00:00:00Z',
    },
    mockChangeSet: {
      changeSetId: 'cs-1',
      kbId: 'kb-1',
      taskId: 'task-1',
      origin: 'compile' as const,
      sources,
      schemaHash: 'h1',
      purposeHash: 'h2',
      readBaseline: [],
      pages: [
        {
          relPath: 'wiki/concepts/axi.md',
          pageId: 'concepts/axi',
          type: 'concept' as const,
          before,
          proposed,
          baselineHash: 'h3',
          sources,
        },
        {
          relPath: 'wiki/concepts/apb.md',
          pageId: 'concepts/apb',
          type: 'concept' as const,
          before: null,
          proposed: newPage,
          baselineHash: null,
          sources: [],
        },
      ],
      findings: [],
      warnings: ['来源页归属不符：模型提议「sources/other」，该块被丢弃。'],
      createdAt: '2026-09-13T00:00:00Z',
      updatedAt: '2026-09-13T00:00:00Z',
    },
    mockReview: {
      changeSetId: 'cs-1',
      pages: [
        { pageId: 'concepts/axi', relPath: 'wiki/concepts/axi.md', hunkStates: { 0: 'accepted' as const }, pageDecision: 'pending' as const },
        { pageId: 'concepts/apb', relPath: 'wiki/concepts/apb.md', hunkStates: {}, pageDecision: 'pending' as const },
      ],
      settled: false,
      updatedAt: '2026-09-13T00:00:00Z',
    },
    mockEmptyReview: {
      changeSetId: 'cs-1',
      pages: [
        { pageId: 'concepts/axi', relPath: 'wiki/concepts/axi.md', hunkStates: {}, pageDecision: 'pending' as const },
        { pageId: 'concepts/apb', relPath: 'wiki/concepts/apb.md', hunkStates: {}, pageDecision: 'pending' as const },
      ],
      settled: false,
      updatedAt: '2026-09-13T00:00:00Z',
    },
  };
});

// ─── Mock tRPC ──────────────────────────────────────────────

const {
  stagedChangeSetsMock, stagedChangeSetMock, decideStagedMock, publishStagedMock,
  projectApplyDiffRejectionsMock, getFileDiffMock,
} = vi.hoisted(() => ({
  stagedChangeSetsMock: vi.fn(),
  stagedChangeSetMock: vi.fn(),
  decideStagedMock: vi.fn(),
  publishStagedMock: vi.fn(),
  projectApplyDiffRejectionsMock: vi.fn(),
  getFileDiffMock: vi.fn(),
}));

vi.mock('@renderer/lib/trpc', () => ({
  trpc: {
    kb: {
      stagedChangeSets: { query: stagedChangeSetsMock },
      stagedChangeSet: { query: stagedChangeSetMock },
      decideStaged: { mutate: decideStagedMock },
      publishStaged: { mutate: publishStagedMock },
    },
    project: {
      applyDiffRejections: { mutate: projectApplyDiffRejectionsMock },
      getFileDiff: { query: getFileDiffMock },
    },
  },
}));

const { toastMocks } = vi.hoisted(() => ({
  toastMocks: { success: vi.fn(), error: vi.fn(), warning: vi.fn(), info: vi.fn() },
}));

vi.mock('@renderer/stores/toast', () => ({
  useToastStore: Object.assign(
    vi.fn((selector: (s: Record<string, unknown>) => unknown) => selector(toastMocks)),
    { getState: () => toastMocks },
  ),
}));

// ─── Import after mocks ─────────────────────────────────────

import { useKbReviewStore, buildStagedDiff, selectHunkStates } from '@renderer/stores/kb-review';
import type { WikiChangeSetReview } from '@shared/kb-types';

const reviewWithAccepted: WikiChangeSetReview = {
  changeSetId: 'cs-1',
  pages: [
    { pageId: 'concepts/axi', relPath: 'wiki/concepts/axi.md', hunkStates: { 0: 'accepted' }, pageDecision: 'pending' },
    { pageId: 'concepts/apb', relPath: 'wiki/concepts/apb.md', hunkStates: {}, pageDecision: 'pending' },
  ],
  settled: false,
  updatedAt: '2026-09-13T00:00:00Z',
};

beforeEach(() => {
  vi.clearAllMocks();
  stagedChangeSetsMock.mockResolvedValue({ ok: true, value: [mockSummary] });
  stagedChangeSetMock.mockResolvedValue({ changeSet: mockChangeSet, review: mockEmptyReview });
  useKbReviewStore.getState().reset();
});

describe('buildStagedDiff（由 before/proposed 合成展示用 diff）', () => {
  it('已有页：产出 add/del 行与正文 hunk（id 从 1 起），不需要工具调用', () => {
    const diff = buildStagedDiff(mockChangeSet.pages[0]);
    expect(diff).not.toBeNull();
    expect(diff!.lines.some((l) => l.type === 'del' && l.content === '旧正文。')).toBe(true);
    expect(diff!.lines.some((l) => l.type === 'add' && l.content === '新正文。')).toBe(true);
    expect(diff!.hunks).toHaveLength(1);
    // issue 07：已有页的真实改动块从 1 起编号（0 保留给整页伪 hunk）
    expect(diff!.hunks[0].id).toBe(1);
    expect(diff!.hunks[0].kind).toBe('body');
    expect(diff!.isNewFile).toBe(false);
    // 行号映射正确（add 行必须带 newLine，展示层靠它定位）
    expect(diff!.lines.filter((l) => l.type === 'add').every((l) => l.newLine !== undefined)).toBe(true);
  });

  it('新页（before === null）：全部为 add 行、isNewFile 为 true', () => {
    const diff = buildStagedDiff(mockChangeSet.pages[1]);
    expect(diff).not.toBeNull();
    expect(diff!.isNewFile).toBe(true);
    expect(diff!.lines.every((l) => l.type === 'add')).toBe(true);
    expect(diff!.totalDel).toBe(0);
  });

  it('内容一致时返回 null（无可审阅差异）', () => {
    const same = { ...mockChangeSet.pages[0], before: mockChangeSet.pages[0].proposed };
    expect(buildStagedDiff(same)).toBeNull();
  });

  it('CRLF 与 LF 的纯换行差异不产生内容 diff', () => {
    const page = mockChangeSet.pages[0];
    const crlf = { ...page, before: page.proposed.replace(/\n/g, '\r\n') };
    expect(buildStagedDiff(crlf)).toBeNull();
  });
});

describe('变更集列表与打开', () => {
  it('loadChangeSets 装载摘要列表', async () => {
    await useKbReviewStore.getState().loadChangeSets();
    expect(useKbReviewStore.getState().changeSets).toHaveLength(1);
    expect(useKbReviewStore.getState().listError).toBeNull();
  });

  it('loadChangeSets：未挂载时静默空列表（不弹错）', async () => {
    stagedChangeSetsMock.mockRejectedValueOnce(new Error('知识库未挂载'));
    await useKbReviewStore.getState().loadChangeSets();
    expect(useKbReviewStore.getState().changeSets).toHaveLength(0);
    expect(useKbReviewStore.getState().listError).toBeNull();
  });

  it('openChangeSet 装载变更集并默认选中第一页', async () => {
    await useKbReviewStore.getState().openChangeSet('cs-1');
    const s = useKbReviewStore.getState();
    expect(s.activeChangeSet?.changeSetId).toBe('cs-1');
    expect(s.activePageRelPath).toBe('wiki/concepts/axi.md');
    expect(s.activeLoading).toBe(false);
  });

  it('openChangeSet：失败时记录错误且不残留旧内容', async () => {
    await useKbReviewStore.getState().openChangeSet('cs-1');
    stagedChangeSetMock.mockRejectedValueOnce(new Error('变更集不存在'));
    await useKbReviewStore.getState().openChangeSet('cs-missing');
    const s = useKbReviewStore.getState();
    expect(s.activeChangeSet).toBeNull();
    expect(s.activeError).toContain('不存在');
  });

  it('selectPage 切换当前页', async () => {
    await useKbReviewStore.getState().openChangeSet('cs-1');
    useKbReviewStore.getState().selectPage('wiki/concepts/apb.md');
    expect(useKbReviewStore.getState().activePageRelPath).toBe('wiki/concepts/apb.md');
  });
});

describe('决策动作（kb-staged adapter，不触碰 project 撤销 API）', () => {
  it('accept 经 kb.decideStaged 记录 accepted，且不调用 project.applyDiffRejections', async () => {
    decideStagedMock.mockResolvedValue({ ok: true, review: mockReview });
    await useKbReviewStore.getState().openChangeSet('cs-1');
    const ok = await useKbReviewStore.getState().decideHunk([0], 'accepted');
    expect(ok).toBe(true);
    expect(decideStagedMock).toHaveBeenCalledWith({
      changeSetId: 'cs-1',
      pageRelPath: 'wiki/concepts/axi.md',
      hunkIds: [0],
      decision: 'accepted',
    });
    expect(projectApplyDiffRejectionsMock).not.toHaveBeenCalled();
  });

  it('reject 经 kb.decideStaged 记录 rejected（提案未落盘，无回滚语义）', async () => {
    decideStagedMock.mockResolvedValue({ ok: true, review: mockReview });
    await useKbReviewStore.getState().openChangeSet('cs-1');
    await useKbReviewStore.getState().decideHunk([0], 'rejected');
    expect(decideStagedMock).toHaveBeenCalledWith(expect.objectContaining({
      decision: 'rejected',
      hunkIds: [0],
    }));
    expect(projectApplyDiffRejectionsMock).not.toHaveBeenCalled();
  });

  it('决策失败（未知页）时返回 false，不假装成功', async () => {
    decideStagedMock.mockResolvedValue({ ok: false, error: 'unknownPage: 变更集中不存在页', code: 'unknownPage' });
    await useKbReviewStore.getState().openChangeSet('cs-1');
    const ok = await useKbReviewStore.getState().decideHunk([0], 'accepted');
    expect(ok).toBe(false);
    expect(useKbReviewStore.getState().deciding).toBe(false);
  });

  it('决策成功后用主进程返回的 review 覆盖（settled 由主进程判定）', async () => {
    decideStagedMock.mockResolvedValue({ ok: true, review: mockReview });
    stagedChangeSetMock.mockResolvedValue({ changeSet: mockChangeSet, review: mockReview });
    await useKbReviewStore.getState().openChangeSet('cs-1');
    await useKbReviewStore.getState().decideHunk([0], 'accepted');
    expect(useKbReviewStore.getState().activeReview?.pages[0].hunkStates[0]).toBe('accepted');
  });

  it('未打开变更集或未选页时不发请求', async () => {
    expect(await useKbReviewStore.getState().decideHunk([0], 'accepted')).toBe(false);
    expect(decideStagedMock).not.toHaveBeenCalled();
  });
});

describe('selectHunkStates 选择器', () => {
  it('返回当前页 hunk 状态；未选页/无 review 时为空对象', async () => {
    await useKbReviewStore.getState().openChangeSet('cs-1');
    useKbReviewStore.setState({ activeReview: reviewWithAccepted, activePageRelPath: 'wiki/concepts/axi.md' });
    expect(selectHunkStates(useKbReviewStore.getState())).toEqual({ 0: 'accepted' });
    useKbReviewStore.setState({ activePageRelPath: 'wiki/concepts/apb.md' });
    expect(selectHunkStates(useKbReviewStore.getState())).toEqual({});
    useKbReviewStore.setState({ activeReview: null });
    expect(selectHunkStates(useKbReviewStore.getState())).toEqual({});
  });
});

describe('publishActive（issue 06：整页提案 → 发布 → 只读打开）', () => {
  it('发布成功：经 kb.publishStaged 提交，返回已发布页 pageId 并关闭变更集视图', async () => {
    publishStagedMock.mockResolvedValue({
      ok: true,
      commitId: 'commit-abcdef12',
      revision: 1,
      pages: [{ pageId: 'concepts/axi', relPath: 'wiki/concepts/axi.md', operation: 'create', beforeHash: null, afterHash: 'h' }],
      warnings: [],
    });
    await useKbReviewStore.getState().openChangeSet('cs-1');

    const res = await useKbReviewStore.getState().publishActive();
    expect(res).toEqual({ ok: true, pageId: 'concepts/axi' });
    expect(publishStagedMock).toHaveBeenCalledWith({ changeSetId: 'cs-1' });
    expect(toastMocks.success).toHaveBeenCalledWith('已发布', expect.stringContaining('concepts/axi'));
    // 已发布 → 关闭视图，避免重复发布
    expect(useKbReviewStore.getState().activeChangeSet).toBeNull();
    expect(useKbReviewStore.getState().publishing).toBe(false);
  });

  it('stale：不假装成功，原因可见并刷新为失效后的审阅状态', async () => {
    publishStagedMock.mockResolvedValue({
      ok: false,
      error: {
        code: 'stale',
        message: '发布前基线校验未通过：读/写集或来源/规则基线已变动，旧批准已失效。',
        detail: ['写集基线变动：wiki/concepts/axi.md 内容与提案基线不一致（可能被外部编辑）。'],
      },
    });
    stagedChangeSetMock.mockResolvedValue({
      changeSet: mockChangeSet,
      review: {
        ...mockEmptyReview,
        stale: { detectedAt: '2026-09-13T10:00:00Z', reasons: ['写集基线变动：内容不一致'] },
      },
    });
    await useKbReviewStore.getState().openChangeSet('cs-1');

    const res = await useKbReviewStore.getState().publishActive();
    expect(res.ok).toBe(false);
    expect(toastMocks.error).toHaveBeenCalledWith(
      '发布失败',
      expect.stringContaining('写集基线变动'),
    );
    // 主进程已失效旧批准 → store 拉取到 stale 状态（组件据此显示横幅）
    expect(useKbReviewStore.getState().activeReview?.stale).toBeTruthy();
    expect(useKbReviewStore.getState().publishing).toBe(false);
  });

  it('nothingAccepted：不写正式资产，错误透传', async () => {
    publishStagedMock.mockResolvedValue({
      ok: false,
      error: { code: 'nothingAccepted', message: '变更集没有已接受的候选页' },
    });
    await useKbReviewStore.getState().openChangeSet('cs-1');
    const res = await useKbReviewStore.getState().publishActive();
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error).toContain('已接受');
  });

  it('未打开变更集时不发请求', async () => {
    const res = await useKbReviewStore.getState().publishActive();
    expect(res.ok).toBe(false);
    expect(publishStagedMock).not.toHaveBeenCalled();
  });

  it('请求抛错时回到非发布中状态并提示', async () => {
    publishStagedMock.mockRejectedValueOnce(new Error('知识库未挂载'));
    await useKbReviewStore.getState().openChangeSet('cs-1');
    const res = await useKbReviewStore.getState().publishActive();
    expect(res.ok).toBe(false);
    expect(useKbReviewStore.getState().publishing).toBe(false);
    expect(toastMocks.error).toHaveBeenCalled();
  });
});
