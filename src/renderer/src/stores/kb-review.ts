/**
 * KB Review Store — 知识提案审阅入口的前端状态（issue 05 后半，07 扩展）。
 *
 * 数据链路：tRPC kb.stagedChangeSets / kb.stagedChangeSet / kb.decideStaged。
 *
 * 与代码审阅（diff-review）的差别，全部体现在动作语义上：
 *   - 提案尚未写入 wiki/，**接受才落地、拒绝只丢弃**；
 *   - 因此动作不接受「回滚」概念，`createKbStagedAdapter(revertOnReject: false)`。
 *
 * 展示侧只消费 `diff`（before/proposed 合成的 FileDiffResult）与
 * `hunkStates`（hunkId → pending/accepted/rejected），按钮回调经 adapter
 * 发往 kb.decideStaged —— 展示组件不掌握发布语义。
 *
 * issue 07：diff 合成统一走 shared `buildWikiPageDiff`（新页 = 整页 hunk 0，
 * 已有页 = frontmatter 合并块 + 正文逐 hunk，id 从 1 起），与发布侧
 * `rebuildWikiPage` 对同一 hunk id 有一致理解。
 *
 * 正式 Wiki/索引在发布（issue 06）前不改变：决策只写 `.kb/reviews/<changeSetId>.json`。
 *
 * @see docs/prd/knowledge-base-llm-wiki-spec.md §6
 */

import { create } from 'zustand';
import { trpc } from '@renderer/lib/trpc';
import { buildWikiPageDiff, WIKI_PAGE_HUNK_ID } from '@shared/wiki-hunks';
import { createKbStagedAdapter } from './review-adapter';
import { useToastStore } from './toast';
import type {
  WikiChangeSet,
  WikiChangeSetReview,
  WikiChangeSetSummary,
  WikiHunkDecision,
  WikiStagedPage,
} from '@shared/kb-types';
import type { WikiReviewDiff } from '@shared/wiki-hunks';

// ── diff 合成 ──────────────────────────────────────────────────

/** 整页/元数据伪 hunk id（新页整页处置、审阅面板整页动作）——shared 单一源 */
export const WHOLE_PAGE_HUNK_ID = WIKI_PAGE_HUNK_ID;

/**
 * 由 before/proposed 合成审阅展示用 diff（issue 07 起委托 shared 单一实现）。
 *
 * 新页 = 整页一个 hunk（id 0）；已有页 = frontmatter 合并块 + 正文逐 hunk
 * （id 从 1 起，与发布侧重建语义一致）。内容一致（含纯换行差异）返回 null。
 */
export function buildStagedDiff(page: WikiStagedPage): WikiReviewDiff | null {
  return buildWikiPageDiff(page);
}

// ── Store ──────────────────────────────────────────────────────

export type KbReviewHunkState = WikiHunkDecision;

type KbReviewStoreState = {
  /** 变更集摘要列表 */
  changeSets: WikiChangeSetSummary[];
  listLoading: boolean;
  listError: string | null;
  /** 当前打开的变更集 */
  activeChangeSet: WikiChangeSet | null;
  activeReview: WikiChangeSetReview | null;
  activeLoading: boolean;
  activeError: string | null;
  /** 当前选中的页（库内相对路径） */
  activePageRelPath: string | null;
  /** 正在提交的决策（防重复点击） */
  deciding: boolean;
  /** 正在发布（防重复点击） */
  publishing: boolean;

  loadChangeSets: () => Promise<void>;
  openChangeSet: (changeSetId: string) => Promise<void>;
  selectPage: (relPath: string) => void;
  /**
   * 处置若干 hunk：走 kb-staged adapter（不写 wiki/、不回滚磁盘）。
   * 成功后本地乐观更新，再以主进程返回的 review 覆盖。
   * 整页处置 = 传入全部真实 hunk id（新页 [0]；已有页 1..n，issue 07）。
   */
  decideHunk: (hunkIds: number[], decision: 'accepted' | 'rejected') => Promise<boolean>;
  /**
   * 发布当前变更集（issue 06）：经 `kb.publishStaged` 走一次原子提交
   * 写入正式页/聚合/日志/历史。成功返回已发布页的 pageId（供只读打开）；
   * stale 时主进程已失效旧批准，这里重新拉取审阅状态并提示原因。
   */
  publishActive: () => Promise<KbPublishOutcome>;
  reset: () => void;
};

export type KbPublishOutcome =
  | { ok: true; pageId: string }
  | { ok: false; error: string };

const INITIAL = {
  changeSets: [] as WikiChangeSetSummary[],
  listLoading: false,
  listError: null as string | null,
  activeChangeSet: null as WikiChangeSet | null,
  activeReview: null as WikiChangeSetReview | null,
  activeLoading: false,
  activeError: null as string | null,
  activePageRelPath: null as string | null,
  deciding: false,
  publishing: false,
};

export const useKbReviewStore = create<KbReviewStoreState>((set, get) => ({
  ...INITIAL,

  loadChangeSets: async () => {
    set({ listLoading: true, listError: null });
    try {
      const res = await trpc.kb.stagedChangeSets.query({});
      if (res.ok) {
        set({ changeSets: res.value, listLoading: false });
      } else {
        set({ changeSets: [], listLoading: false, listError: res.error.message });
      }
    } catch (err) {
      // 未挂载 / 非 wiki 布局：静默空列表（与 kb store 的既有降级一致）
      const message = err instanceof Error ? err.message : String(err);
      set({ changeSets: [], listLoading: false, listError: null });
      if (!message.includes('未挂载') && !message.includes('wiki')) {
        useToastStore.getState().error('加载待审阅提案失败', message);
      }
    }
  },

  openChangeSet: async (changeSetId) => {
    set({ activeLoading: true, activeError: null, activePageRelPath: null });
    try {
      const res = await trpc.kb.stagedChangeSet.query({ changeSetId });
      const firstPage = res.changeSet.pages[0]?.relPath ?? null;
      set({
        activeChangeSet: res.changeSet,
        activeReview: res.review,
        activePageRelPath: firstPage,
        activeLoading: false,
      });
    } catch (err) {
      set({
        activeChangeSet: null,
        activeReview: null,
        activeLoading: false,
        activeError: err instanceof Error ? err.message : String(err),
      });
    }
  },

  selectPage: (relPath) => set({ activePageRelPath: relPath }),

  decideHunk: async (hunkIds, decision) => {
    const { activeChangeSet, activePageRelPath, deciding } = get();
    if (!activeChangeSet || !activePageRelPath || deciding || hunkIds.length === 0) return false;

    set({ deciding: true });
    const adapter = createKbStagedAdapter({
      changeSetId: activeChangeSet.changeSetId,
      pageRelPath: activePageRelPath,
    });
    // adapter 的 reject 接收 DiffRejection 补丁数组；kb-staged 只取 hunkId，
    // 提案从未落盘，补丁的上游定位信息（toolCallId 等）不参与语义。
    const result = decision === 'accepted'
      ? await adapter.accept(hunkIds)
      : await adapter.reject(hunkIds.map((hunkId) => ({ hunkId, toolCallId: '', toolName: 'wiki-proposal', deleteFile: false })));

    if (!result.ok) {
      set({ deciding: false });
      useToastStore.getState().error('记录审阅选择失败', result.error);
      return false;
    }

    // 用主进程返回的 review 覆盖本地（主进程是 settled 判定的唯一权威）
    try {
      const refreshed = await trpc.kb.stagedChangeSet.query({ changeSetId: activeChangeSet.changeSetId });
      set({ activeReview: refreshed.review, deciding: false });
    } catch {
      set({ deciding: false });
    }
    await get().loadChangeSets();
    return true;
  },

  publishActive: async () => {
    const { activeChangeSet, publishing } = get();
    if (!activeChangeSet) return { ok: false, error: '没有打开的变更集' };
    if (publishing) return { ok: false, error: '正在发布，请稍候' };

    set({ publishing: true });
    try {
      const res = await trpc.kb.publishStaged.mutate({ changeSetId: activeChangeSet.changeSetId });
      if (!res.ok) {
        const detail = res.error.detail !== undefined && res.error.detail.length > 0
          ? `\n${res.error.detail.map((d) => `• ${d}`).join('\n')}`
          : '';
        useToastStore.getState().error('发布失败', `${res.error.message}${detail}`);
        // stale：主进程已把旧批准重置为 pending，重新拉取以刷新视图
        if (res.error.code === 'stale') {
          try {
            const refreshed = await trpc.kb.stagedChangeSet.query({ changeSetId: activeChangeSet.changeSetId });
            set({ activeReview: refreshed.review });
          } catch {
            // 保持当前视图；下一次打开会重新拉取
          }
        }
        set({ publishing: false });
        await get().loadChangeSets();
        return { ok: false, error: res.error.message };
      }

      const pageId = res.pages[0]?.pageId ?? null;
      const pageLabel = res.pages.length > 1 ? `${pageId} 等 ${res.pages.length} 页` : pageId;
      const partialLabel = res.partial ? '（部分接受）' : '';
      useToastStore.getState().success(
        '已发布',
        pageId !== null
          ? `${pageLabel}${partialLabel} · 提交 ${res.commitId.slice(0, 8)}`
          : `提交 ${res.commitId.slice(0, 8)}`,
      );
      await get().loadChangeSets();
      // 已发布：关闭变更集视图（同一变更集不会重复发布）
      set({ activeChangeSet: null, activeReview: null, activePageRelPath: null, publishing: false });
      return pageId !== null ? { ok: true, pageId } : { ok: false, error: '发布成功但未返回页面身份' };
    } catch (err) {
      set({ publishing: false });
      const message = err instanceof Error ? err.message : String(err);
      useToastStore.getState().error('发布失败', message);
      return { ok: false, error: message };
    }
  },

  reset: () => set({ ...INITIAL }),
}));

// ── 选择器 ─────────────────────────────────────────────────────

/**
 * 当前页的审阅 hunk 状态（缺省 pending）。
 *
 * 注意：返回值是**新对象**，不要直接把本函数传给 `useKbReviewStore(...)`
 * 作为 selector —— useSyncExternalStore 要求 getSnapshot 结果稳定缓存，
 * 否则会触发「getSnapshot should be cached」告警与无限重渲染。
 * 组件侧应订阅 `activeReview` / `activePageRelPath` 原始切片后用 useMemo 组合。
 */
export function selectHunkStates(state: {
  activeReview: WikiChangeSetReview | null;
  activePageRelPath: string | null;
}): Record<number, KbReviewHunkState> {
  const { activeReview, activePageRelPath } = state;
  if (!activeReview || !activePageRelPath) return {};
  const page = activeReview.pages.find((p) => p.relPath === activePageRelPath);
  return page?.hunkStates ?? {};
}
