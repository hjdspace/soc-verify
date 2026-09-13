/**
 * Review Adapter — 审阅「展示」与「动作」的解耦契约（issue 05）。
 *
 * 背景：diff 展示（内联装饰、hunk 状态、快照）与审阅动作此前耦合在
 * `diff-review.ts` 里 —— 展示组件的拒绝按钮直接调用 project 撤销 API。
 * 知识库提案（spec §6）需要在同一处审阅，但它的动作语义完全不同：
 * 提案**尚未写入** wiki/，接受才落地，拒绝只是丢弃。
 *
 * 本模块定义唯一的动作接口 ReviewAdapter：
 *   - `code-applied`（现有代码审阅）：内容已写入磁盘；接受 = 保留；
 *     拒绝 = 回滚（project.applyDiffRejections）。
 *   - `kb-staged`（知识审阅）：内容在 staging 未发布；接受/拒绝 = 记录
 *     用户选择（kb.decideStaged），不触碰磁盘。
 *
 * 展示层（FileEditor / inline-review / KbReviewPanel）只消费 diff 与
 * hunk 状态，动作经 adapter 注入 —— 展示组件不再自行调用撤销 API。
 *
 * @see docs/prd/knowledge-base-llm-wiki-spec.md §6（审阅、发布与页面历史）
 */

import { trpc } from '@renderer/lib/trpc';
import type { DiffRejection } from '@shared/types';

/** 审阅种类（spec §6：共用入口，数据用明确种类区分） */
export type ReviewKind = 'code-applied' | 'kb-staged';

export type ReviewActionResult =
  | { ok: true }
  | { ok: false; error: string };

/**
 * 审阅动作接口 —— 展示层唯一的动作入口。
 *
 * `accept` 收到 hunk id 列表（整页接受 = 全部 id）；`reject` 在
 * code-applied 下额外接收拒绝补丁（用于回滚），kb-staged 下补丁被忽略
 * （提案从未落盘，无需回滚）。
 */
export type ReviewAdapter = {
  readonly kind: ReviewKind;
  /**
   * 拒绝是否回滚磁盘内容。
   * code-applied：true（已写入，拒绝撤销）；kb-staged：false（未写入）。
   */
  readonly revertOnReject: boolean;
  /** 接受指定 hunk（或全部）。 */
  accept(hunkIds: number[]): Promise<ReviewActionResult>;
  /**
   * 拒绝指定 hunk。
   *
   * 调用方（store）统一传入 `buildRejections` 产出的补丁数组（每项含
   * `hunkId`）：code-applied 用它回滚磁盘；kb-staged 只取 hunkId 记录
   * 用户选择，补丁的上游定位信息被忽略（提案从未落盘）。
   */
  reject(rejections: DiffRejection[]): Promise<ReviewActionResult>;
};

// ── code-applied（现有代码审阅）──────────────────────────────────

export type CodeAppliedAdapterContext = {
  projectId: string;
  filePath: string;
};

/**
 * 现有代码审阅适配器。
 *
 * 行为与解耦前完全一致：接受是纯本地标记（内容已在磁盘）；拒绝调用
 * `project.applyDiffRejections` 回滚。拒绝补丁由调用方（store）用
 * `buildRejections` 构建后传入，保持原有的 priorDelta 计算。
 */
export function createCodeAppliedAdapter(ctx: CodeAppliedAdapterContext): ReviewAdapter {
  return {
    kind: 'code-applied',
    revertOnReject: true,

    accept: async () => ({ ok: true }),

    reject: async (rejections: DiffRejection[]) => {
      if (rejections.length === 0) return { ok: false, error: '没有可回滚的改动' };
      try {
        const result = await trpc.project.applyDiffRejections.mutate({
          projectId: ctx.projectId,
          filePath: ctx.filePath,
          rejections,
        });
        if (!result.ok || result.appliedCount === 0) {
          return { ok: false, error: '回滚未生效（目标内容可能已变化）' };
        }
        return { ok: true };
      } catch (err) {
        return { ok: false, error: err instanceof Error ? err.message : String(err) };
      }
    },
  };
}

// ── kb-staged（知识审阅）─────────────────────────────────────────

export type KbStagedAdapterContext = {
  changeSetId: string;
  /** 库内相对路径（`wiki/concepts/x.md`），作为页 identity 参与选择持久化 */
  pageRelPath: string;
};

/**
 * 知识审阅适配器（kb-staged）。
 *
 * 接受/拒绝都只是把用户选择记回 staging（`kb.decideStaged`），
 * 不写 wiki/、不回滚磁盘 —— 因此展示组件可以在不掌握发布语义的前提下
 * 复用它。staging 记录被拒绝时 `ok: false` 原样上报，不假装成功。
 */
export function createKbStagedAdapter(ctx: KbStagedAdapterContext): ReviewAdapter {
  const decide = async (hunkIds: number[], decision: 'accepted' | 'rejected'): Promise<ReviewActionResult> => {
    try {
      const result = await trpc.kb.decideStaged.mutate({
        changeSetId: ctx.changeSetId,
        pageRelPath: ctx.pageRelPath,
        hunkIds,
        decision,
      });
      if (!result.ok) {
        return { ok: false, error: result.error ?? '选择未保存' };
      }
      return { ok: true };
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) };
    }
  };

  return {
    kind: 'kb-staged',
    revertOnReject: false,
    accept: (hunkIds) => decide(hunkIds, 'accepted'),
    reject: (rejections) => decide(rejections.map((r) => r.hunkId), 'rejected'),
  };
}
