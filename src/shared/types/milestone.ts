/**
 * 里程碑类型与状态推导（renderer / main 共享）。
 *
 * status 语义：每个节点根据自身的真实完成条件独立判定 done；
 * 「current」标记最左侧未完成节点（下一步待推进的阶段），其后为 pending。
 * 覆盖率收敛节点由渲染端用 coverage store 的实时 overview 覆盖 done 后再统一推导。
 */

export type MilestoneStatus = 'done' | 'current' | 'pending';

export type MilestoneId =
  | 'requirement-import'
  | 'env-gen'
  | 'case-dev'
  | 'smoke'
  | 'functional'
  | 'coverage'
  | 'post-sim'
  | 'signoff';

/** 里程碑节点的内在数据（done 为「是否满足该节点真实完成条件」，未做线性推导） */
export type MilestoneNode = {
  id: MilestoneId;
  label: string;
  /** 描述性副文案（真实统计值或目标说明） */
  hint?: string;
  /** 内在完成标志 */
  done: boolean;
};

export type MilestoneStep = MilestoneNode & { status: MilestoneStatus };

/**
 * 由内在 done 标志推导各节点 status：
 * - done 节点恒为 done（独立判定，不受前置节点影响）
 * - 最左侧未完成节点为 current
 * - 其余未完成节点为 pending
 *
 * @param nodes 按流程顺序排列的节点
 */
export function computeMilestoneStatuses(nodes: MilestoneNode[]): MilestoneStep[] {
  let currentAssigned = false;
  return nodes.map((node) => {
    if (node.done) {
      return { ...node, status: 'done' as const };
    }
    if (!currentAssigned) {
      currentAssigned = true;
      return { ...node, status: 'current' as const };
    }
    return { ...node, status: 'pending' as const };
  });
}
