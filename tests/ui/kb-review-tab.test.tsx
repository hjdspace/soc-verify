// @vitest-environment jsdom
/**
 * KbReviewTab 行为测试（issue 05 后半）。
 *
 * 验收对照：
 *  - 独立 before/after fixture 可渲染差异（不需要伪造工具调用）；
 *  - 展示组件不自行调用 project 撤销 API（拒绝按钮只走 kb.decideStaged）；
 *  - 重复目标/未闭合/坏类型的失败在列表中可见（warnings 横幅）；
 *  - 新页与已有页的展示差异（新建徽章 / 覆盖提示）。
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor, fireEvent } from '@testing-library/react';

// ─── Mock data ──────────────────────────────────────────────

const { mockSummary, mockChangeSet, mockEmptyReview } = vi.hoisted(() => {
  const before = ['---', 'type: concept', '---', '', '# AXI', '', '旧正文。'].join('\n');
  const proposed = ['---', 'type: concept', '---', '', '# AXI', '', '新正文。', '', '补充说明。'].join('\n');
  const sources = [{ sourceId: 'a'.repeat(64), sourceRevision: 'b'.repeat(64), parsedHash: 'c'.repeat(64) }];
  return {
    mockSummary: {
      changeSetId: 'cs-1', kbId: 'kb-1', taskId: 'task-1', origin: 'compile' as const,
      pageCount: 2, newPageCount: 1, findingCount: 0, settled: false,
      createdAt: '2026-09-13T00:00:00Z', updatedAt: '2026-09-13T00:00:00Z',
    },
    mockChangeSet: {
      changeSetId: 'cs-1', kbId: 'kb-1', taskId: 'task-1', origin: 'compile' as const,
      sources, schemaHash: 'h1', purposeHash: 'h2', readBaseline: [],
      pages: [
        {
          relPath: 'wiki/concepts/axi.md', pageId: 'concepts/axi', type: 'concept' as const,
          before, proposed, baselineHash: 'h3', sources,
        },
        {
          relPath: 'wiki/concepts/apb.md', pageId: 'concepts/apb', type: 'concept' as const,
          before: null, proposed: '# APB', baselineHash: null, sources: [],
        },
      ],
      findings: [],
      warnings: ['提案目标不可写：重复目标 wiki/concepts/axi.md'],
      createdAt: '2026-09-13T00:00:00Z', updatedAt: '2026-09-13T00:00:00Z',
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

const { stagedChangeSetsMock, stagedChangeSetMock, decideStagedMock, publishStagedMock, projectApplyDiffRejectionsMock } = vi.hoisted(() => ({
  stagedChangeSetsMock: vi.fn(),
  stagedChangeSetMock: vi.fn(),
  decideStagedMock: vi.fn(),
  publishStagedMock: vi.fn(),
  projectApplyDiffRejectionsMock: vi.fn(),
}));

vi.mock('@renderer/lib/trpc', () => ({
  trpc: {
    kb: {
      stagedChangeSets: { query: stagedChangeSetsMock },
      stagedChangeSet: { query: stagedChangeSetMock },
      decideStaged: { mutate: decideStagedMock },
      publishStaged: { mutate: publishStagedMock },
    },
    project: { applyDiffRejections: { mutate: projectApplyDiffRejectionsMock } },
  },
}));

// 发布成功后切 tab 并只读打开已发布页：store 仅用 getState()，测试观察调用即可
const { setActiveTabMock, openPageMock } = vi.hoisted(() => ({
  setActiveTabMock: vi.fn(),
  openPageMock: vi.fn(),
}));

vi.mock('@renderer/stores/kb', () => ({
  useKbStore: { getState: () => ({ setActiveTab: setActiveTabMock }) },
}));

vi.mock('@renderer/stores/kb-wiki', () => ({
  useKbWikiStore: { getState: () => ({ openPage: openPageMock }) },
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

import { KbReviewTab } from '@renderer/components/kb/KbReviewTab';
import { useKbReviewStore } from '@renderer/stores/kb-review';

beforeEach(() => {
  vi.clearAllMocks();
  stagedChangeSetsMock.mockResolvedValue({ ok: true, value: [mockSummary] });
  stagedChangeSetMock.mockResolvedValue({ changeSet: mockChangeSet, review: mockEmptyReview });
  decideStagedMock.mockResolvedValue({ ok: true, review: mockEmptyReview });
  publishStagedMock.mockResolvedValue({ ok: false, error: { code: 'nothingAccepted', message: '没有已接受的候选页' } });
  openPageMock.mockResolvedValue(undefined);
  useKbReviewStore.getState().reset();
});

describe('KbReviewTab 列表与导航', () => {
  it('渲染待审阅变更集摘要（来源种类 + 页数）', async () => {
    render(<KbReviewTab />);
    expect(await screen.findByTestId('kb-changeset-cs-1')).toBeInTheDocument();
    expect(screen.getByText(/编译产出/)).toBeInTheDocument();
    expect(screen.getByText(/2 页（新页 1）/)).toBeInTheDocument();
  });

  it('无待审阅提案时给出空态', async () => {
    stagedChangeSetsMock.mockResolvedValue({ ok: true, value: [] });
    render(<KbReviewTab />);
    expect(await screen.findByText('没有待审阅的知识提案')).toBeInTheDocument();
  });

  it('展开变更集后列出页面，且失败/丢弃说明可见', async () => {
    render(<KbReviewTab />);
    fireEvent.click(await screen.findByTestId('kb-changeset-open-cs-1'));
    await waitFor(() => {
      expect(screen.getByTestId('kb-page-wiki/concepts/axi.md')).toBeInTheDocument();
      expect(screen.getByTestId('kb-page-wiki/concepts/apb.md')).toBeInTheDocument();
    });
    expect(screen.getByTestId('kb-changeset-warnings')).toBeInTheDocument();
    expect(screen.getByText(/重复目标/)).toBeInTheDocument();
  });

  it('切换页面时 diff 随之更新', async () => {
    render(<KbReviewTab />);
    fireEvent.click(await screen.findByTestId('kb-changeset-open-cs-1'));
    await waitFor(() => expect(screen.getByTestId('kb-review-diff')).toBeInTheDocument());

    // 默认第一页：已有页 → 有 del 行与「覆盖」提示
    expect(await screen.findByTestId('kb-diff-del')).toBeInTheDocument();
    expect(screen.getByText('接受后覆盖已发布页')).toBeInTheDocument();

    fireEvent.click(screen.getByTestId('kb-page-wiki/concepts/apb.md'));
    // 新页 → 无 del 行、显示「新建」徽章与「作为新页发布」
    await waitFor(() => {
      expect(screen.queryByTestId('kb-diff-del')).not.toBeInTheDocument();
      expect(screen.getByText('新建')).toBeInTheDocument();
      expect(screen.getByText('接受后作为新页发布')).toBeInTheDocument();
    });
  });
});

describe('KbReviewTab 发布（issue 06：整页提案 → 发布 → 只读打开）', () => {
  it('点「发布」经 kb.publishStaged 提交，成功后切到知识页并只读打开', async () => {
    publishStagedMock.mockResolvedValue({
      ok: true,
      commitId: 'commit-abcdef12',
      revision: 1,
      pages: [{ pageId: 'concepts/axi', relPath: 'wiki/concepts/axi.md', operation: 'create', beforeHash: null, afterHash: 'h' }],
      warnings: [],
    });
    render(<KbReviewTab />);
    fireEvent.click(await screen.findByTestId('kb-changeset-open-cs-1'));
    fireEvent.click(await screen.findByTestId('kb-page-publish'));

    await waitFor(() => expect(publishStagedMock).toHaveBeenCalledWith({ changeSetId: 'cs-1' }));
    await waitFor(() => expect(openPageMock).toHaveBeenCalledWith('concepts/axi'));
    expect(setActiveTabMock).toHaveBeenCalledWith('wiki');
  });

  it('发布失败（stale）时显示旧批准已失效横幅与原因', async () => {
    publishStagedMock.mockResolvedValue({
      ok: false,
      error: { code: 'stale', message: '发布前基线校验未通过', detail: ['写集基线变动：内容不一致'] },
    });
    stagedChangeSetMock.mockResolvedValue({
      changeSet: mockChangeSet,
      review: {
        ...mockEmptyReview,
        stale: { detectedAt: '2026-09-13T10:00:00Z', reasons: ['写集基线变动：wiki/concepts/axi.md 内容与提案基线不一致'] },
      },
    });
    render(<KbReviewTab />);
    fireEvent.click(await screen.findByTestId('kb-changeset-open-cs-1'));

    // 打开时审阅状态已含 stale → 横幅可见
    expect(await screen.findByTestId('kb-review-stale')).toBeInTheDocument();
    expect(screen.getByText(/旧批准已失效/)).toBeInTheDocument();

    fireEvent.click(screen.getByTestId('kb-page-publish'));
    await waitFor(() => expect(toastMocks.error).toHaveBeenCalledWith(
      '发布失败',
      expect.stringContaining('写集基线变动'),
    ));
    expect(openPageMock).not.toHaveBeenCalled();
  });
});

describe('KbReviewTab diff 渲染（独立 before/after fixture）', () => {
  it('渲染增删行，不依赖任何工具调用数据', async () => {
    render(<KbReviewTab />);
    fireEvent.click(await screen.findByTestId('kb-changeset-open-cs-1'));
    const rows = await screen.findAllByTestId('kb-diff-add');
    expect(rows.some((r) => r.textContent?.includes('新正文。'))).toBe(true);
    expect(rows.some((r) => r.textContent?.includes('补充说明。'))).toBe(true);
  });

  it('内容一致的提案不显示差异（提示无差异）', async () => {
    stagedChangeSetMock.mockResolvedValue({
      changeSet: {
        ...mockChangeSet,
        pages: [{ ...mockChangeSet.pages[0], before: mockChangeSet.pages[0].proposed }],
        warnings: [],
      },
      review: mockEmptyReview,
    });
    render(<KbReviewTab />);
    fireEvent.click(await screen.findByTestId('kb-changeset-open-cs-1'));
    expect(await screen.findByText('提案内容与已发布页一致，无差异')).toBeInTheDocument();
  });
});

describe('KbReviewTab 动作（展示层不掌握发布语义）', () => {
  it('「接受」走 kb.decideStaged 且不调用 project 撤销 API', async () => {
    render(<KbReviewTab />);
    fireEvent.click(await screen.findByTestId('kb-changeset-open-cs-1'));
    fireEvent.click(await screen.findByTestId('kb-page-accept'));
    await waitFor(() => {
      expect(decideStagedMock).toHaveBeenCalledWith(expect.objectContaining({
        changeSetId: 'cs-1',
        pageRelPath: 'wiki/concepts/axi.md',
        decision: 'accepted',
      }));
    });
    expect(projectApplyDiffRejectionsMock).not.toHaveBeenCalled();
  });

  it('「拒绝」同样只记录选择，不回滚磁盘', async () => {
    render(<KbReviewTab />);
    fireEvent.click(await screen.findByTestId('kb-changeset-open-cs-1'));
    fireEvent.click(await screen.findByTestId('kb-page-reject'));
    await waitFor(() => {
      expect(decideStagedMock).toHaveBeenCalledWith(expect.objectContaining({ decision: 'rejected' }));
    });
    expect(projectApplyDiffRejectionsMock).not.toHaveBeenCalled();
  });

  it('决策失败时错误可见', async () => {
    decideStagedMock.mockResolvedValue({ ok: false, error: 'unknownPage: 变更集中不存在页', code: 'unknownPage' });
    render(<KbReviewTab />);
    fireEvent.click(await screen.findByTestId('kb-changeset-open-cs-1'));
    fireEvent.click(await screen.findByTestId('kb-page-accept'));
    await waitFor(() => {
      expect(toastMocks.error).toHaveBeenCalledWith('记录审阅选择失败', expect.stringContaining('unknownPage'));
    });
  });

  it('决策后按主进程返回的 review 显示已接受徽章', async () => {
    decideStagedMock.mockResolvedValue({
      ok: true,
      review: {
        ...mockEmptyReview,
        pages: [
          { pageId: 'concepts/axi', relPath: 'wiki/concepts/axi.md', hunkStates: { 1: 'accepted' as const }, pageDecision: 'pending' as const },
          mockEmptyReview.pages[1],
        ],
      },
    });
    stagedChangeSetMock.mockResolvedValue({
      changeSet: mockChangeSet,
      review: {
        ...mockEmptyReview,
        pages: [
          { pageId: 'concepts/axi', relPath: 'wiki/concepts/axi.md', hunkStates: { 1: 'accepted' as const }, pageDecision: 'pending' as const },
          mockEmptyReview.pages[1],
        ],
      },
    });
    render(<KbReviewTab />);
    fireEvent.click(await screen.findByTestId('kb-changeset-open-cs-1'));
    fireEvent.click(await screen.findByTestId('kb-page-accept'));
    expect(await screen.findByText('已接受')).toBeInTheDocument();
    // accepted 后 add 行折叠为普通代码（不再有 add 高亮行）
    await waitFor(() => expect(screen.queryAllByTestId('kb-diff-add')).toHaveLength(0));
  });
});
