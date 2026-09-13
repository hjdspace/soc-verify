/**
 * KB Review Store — 知识提案审阅入口的前端状态（issue 05 后半）。
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
 * 正式 Wiki/索引在本票内不改变：决策只写 `.kb/reviews/<changeSetId>.json`。
 *
 * @see docs/prd/knowledge-base-llm-wiki-spec.md §6
 */

import { create } from 'zustand';
import { trpc } from '@renderer/lib/trpc';
import { lcsDiff } from '@shared/diff-lcs';
import { createKbStagedAdapter } from './review-adapter';
import { useToastStore } from './toast';
import type {
  WikiChangeSet,
  WikiChangeSetReview,
  WikiChangeSetSummary,
  WikiHunkDecision,
  WikiStagedPage,
} from '@shared/kb-types';
import type { DiffHunkInfo, DiffLine, FileDiffResult } from '@shared/types';

// ── diff 合成 ──────────────────────────────────────────────────

/** 提案合成 diff 的固定 hunk id：新页只有整页一个块 */
export const WHOLE_PAGE_HUNK_ID = 0;

/**
 * 由 before/proposed 合成审阅展示用的 FileDiffResult。
 *
 * 用行级 LCS 求最小编辑脚本，产出与代码审阅同构的 `lines` / `hunks`，
 * 因此展示层（内联装饰、hunk 操作条）可以原样复用，无需伪造 tool call。
 *
 * 行数与新文件完全相同时返回 null（无差异可审阅）。
 */
export function buildStagedDiff(page: WikiStagedPage): FileDiffResult | null {
  const beforeLines = page.before === null ? [] : splitLines(page.before);
  const afterLines = splitLines(page.proposed);
  if (beforeLines.length === afterLines.length && beforeLines.every((l, i) => l === afterLines[i])) {
    return null;
  }

  const ops = lcsDiff(beforeLines, afterLines, MAX_DP_LINES);
  const lines: DiffLine[] = [];
  let addCount = 0;
  let delCount = 0;
  let startLineIndex = 0;
  let sawChange = false;

  for (const op of ops) {
    if (op.type === 'ctx') {
      lines.push({ type: 'ctx', content: op.content, oldLine: op.oldLine, newLine: op.newLine });
      sawChange = false;
      continue;
    }
    if (!sawChange) {
      startLineIndex = lines.length;
      sawChange = true;
    }
    if (op.type === 'del') {
      lines.push({ type: 'del', content: op.content, oldLine: op.oldLine, hunkId: WHOLE_PAGE_HUNK_ID });
      delCount += 1;
    } else {
      lines.push({ type: 'add', content: op.content, newLine: op.newLine, hunkId: WHOLE_PAGE_HUNK_ID });
      addCount += 1;
    }
  }

  const hunks: DiffHunkInfo[] = addCount + delCount === 0
    ? []
    : [{
        id: WHOLE_PAGE_HUNK_ID,
        toolCallId: `kb-staged:${page.relPath}`,
        toolName: 'wiki-proposal',
        overwritten: false,
        startLineIndex,
        endLineIndex: lines.length,
        addCount,
        delCount,
      }];

  return {
    filePath: page.relPath,
    isNewFile: page.before === null,
    lines,
    hunks,
    totalAdd: addCount,
    totalDel: delCount,
  };
}

/** 单页提案通常几百行；超过则退化为整体替换，避免 DP 卡住 UI */
const MAX_DP_LINES = 2000;

function splitLines(text: string): string[] {
  // 统一按 LF 切分；CRLF 的 \r 保留在行尾（与磁盘内容逐字对应，不改写提案）
  return text.length === 0 ? [] : text.replace(/\r\n/g, '\n').split('\n');
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

  loadChangeSets: () => Promise<void>;
  openChangeSet: (changeSetId: string) => Promise<void>;
  selectPage: (relPath: string) => void;
  /**
   * 处置某个 hunk：走 kb-staged adapter（不写 wiki/、不回滚磁盘）。
   * 成功后本地乐观更新，再以主进程返回的 review 覆盖。
   */
  decideHunk: (hunkId: number, decision: 'accepted' | 'rejected') => Promise<boolean>;
  reset: () => void;
};

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

  decideHunk: async (hunkId, decision) => {
    const { activeChangeSet, activePageRelPath, deciding } = get();
    if (!activeChangeSet || !activePageRelPath || deciding) return false;

    set({ deciding: true });
    const adapter = createKbStagedAdapter({
      changeSetId: activeChangeSet.changeSetId,
      pageRelPath: activePageRelPath,
    });
    // adapter 的 reject 接收 DiffRejection 补丁数组；kb-staged 只取 hunkId，
    // 提案从未落盘，补丁的上游定位信息（toolCallId 等）不参与语义。
    const result = decision === 'accepted'
      ? await adapter.accept([hunkId])
      : await adapter.reject([{ hunkId, toolCallId: '', toolName: 'wiki-proposal', deleteFile: false }]);

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
