/**
 * TestPromotionPanel — Test Promotion 审阅与提升面板（Slice 8 / Issue #10）。
 *
 * Coverage Closure 结束后展示闭环结果摘要，并让用户审阅 Closure Workspace 中的
 * 测试改动，决定哪些测试提升到正式 testbench/ 目录。
 *
 * 数据结构对齐 Diff Review 域的 Hunk/Review Queue 概念：每个 PromotionQueueItem
 * 是一个审阅单元，用户可逐项接受/拒绝，最后批量执行 Test Promotion。
 */
import { useEffect, useMemo, useState } from 'react';
import {
  Check, X, Trash2, Loader2, FileCode, ArrowUpCircle, AlertTriangle,
} from 'lucide-react';
import { cn } from '@renderer/lib/utils';
import { useCoverageStore } from '@renderer/stores/coverage';
import { useProjectStore } from '@renderer/stores/project';
import type { PromotionQueueItem, ClosureSummary } from '@shared/types';

// ─── 常量 ────────────────────────────────────────────────────────

/** Gap 状态徽章样式 */
const GAP_STATUS_BADGE: Record<string, string> = {
  closed: 'bg-emerald-500/15 text-emerald-500',
  escalated: 'bg-destructive/15 text-destructive',
  failed: 'bg-destructive/15 text-destructive',
  in_progress: 'bg-primary/15 text-primary',
  pending: 'bg-muted text-muted-foreground',
};

const GAP_STATUS_LABEL: Record<string, string> = {
  closed: '已关闭',
  escalated: '已升级',
  failed: '失败',
  in_progress: '进行中',
  pending: '待处理',
};

const METRIC_LABELS: Record<string, string> = {
  line: 'Line',
  branch: 'Branch',
  toggle: 'Toggle',
  condition: 'Cond',
  fsm_state: 'FSM St',
  fsm_transition: 'FSM Tr',
  functional: 'Func',
  assertion: 'Assert',
};

// ─── 组件 ────────────────────────────────────────────────────────

export type TestPromotionPanelProps = {
  /** 当前 Closure Session ID */
  closureId: string;
};

export function TestPromotionPanel({ closureId }: TestPromotionPanelProps) {
  const currentProjectId = useProjectStore((s) => s.currentProjectId);
  const promotionQueue = useCoverageStore((s) => s.promotionQueue);
  const closureSummary = useCoverageStore((s) => s.closureSummary);
  const promoting = useCoverageStore((s) => s.promoting);
  const loadPromotionQueue = useCoverageStore((s) => s.loadPromotionQueue);
  const promoteTests = useCoverageStore((s) => s.promoteTests);
  const loadClosureSummary = useCoverageStore((s) => s.loadClosureSummary);
  const cleanupClosure = useCoverageStore((s) => s.cleanupClosure);

  // 客户端审阅决策：itemId → 'accepted' | 'rejected' | 'pending'
  // 初始化自后端队列项的 status（已提升的显示为 accepted）
  const [decisions, setDecisions] = useState<Record<string, 'accepted' | 'rejected' | 'pending'>>({});
  const [confirmCleanup, setConfirmCleanup] = useState(false);

  // 首次挂载加载队列与摘要
  useEffect(() => {
    if (!currentProjectId) return;
    void loadPromotionQueue(currentProjectId, closureId);
    void loadClosureSummary(currentProjectId, closureId);
  }, [currentProjectId, closureId, loadPromotionQueue, loadClosureSummary]);

  // 队列加载后同步本地决策状态
  useEffect(() => {
    setDecisions((prev) => {
      const next: Record<string, 'accepted' | 'rejected' | 'pending'> = {};
      for (const item of promotionQueue) {
        next[item.id] = prev[item.id] ?? item.status;
      }
      return next;
    });
  }, [promotionQueue]);

  const acceptedIds = useMemo(
    () => promotionQueue.filter((i) => decisions[i.id] === 'accepted').map((i) => i.id),
    [promotionQueue, decisions],
  );
  const rejectedIds = useMemo(
    () => promotionQueue.filter((i) => decisions[i.id] === 'rejected').map((i) => i.id),
    [promotionQueue, decisions],
  );
  const pendingCount = promotionQueue.length - acceptedIds.length - rejectedIds.length;

  const setItemDecision = (itemId: string, state: 'accepted' | 'rejected' | 'pending') => {
    setDecisions((prev) => ({ ...prev, [itemId]: state }));
  };

  const acceptAll = () => {
    setDecisions((prev) => {
      const next = { ...prev };
      for (const item of promotionQueue) {
        next[item.id] = 'accepted';
      }
      return next;
    });
  };

  const rejectAll = () => {
    setDecisions((prev) => {
      const next = { ...prev };
      for (const item of promotionQueue) {
        next[item.id] = 'rejected';
      }
      return next;
    });
  };

  const handlePromote = () => {
    if (!currentProjectId) return;
    if (acceptedIds.length === 0 && rejectedIds.length === 0) return;
    void promoteTests(currentProjectId, closureId, acceptedIds, rejectedIds);
  };

  const handleCleanup = () => {
    if (!currentProjectId) return;
    void cleanupClosure(currentProjectId, closureId);
    setConfirmCleanup(false);
  };

  const hasItems = promotionQueue.length > 0;
  const hasDecisions = acceptedIds.length > 0 || rejectedIds.length > 0;

  return (
    <div className="rounded border border-border bg-card p-3" data-testid="test-promotion-panel">
      {/* ── 标题 ── */}
      <div className="mb-2 flex items-center gap-2">
        <ArrowUpCircle className="h-4 w-4 text-primary" />
        <span className="text-xs font-semibold">Test Promotion</span>
        <span className="text-[10px] text-muted-foreground">
          审阅 Closure Workspace 中的测试改动，决定哪些提升到正式目录
        </span>
      </div>

      {/* ── 结果摘要区 ── */}
      {closureSummary && <SummarySection summary={closureSummary} />}

      {/* ── 审阅队列区 ── */}
      <div className="mt-2">
        <div className="mb-1 flex items-center justify-between">
          <span className="text-[10px] font-medium text-muted-foreground">
            审阅队列（{promotionQueue.length} 项）
          </span>
          {hasItems && (
            <div className="flex gap-1">
              <button
                onClick={acceptAll}
                className="rounded border border-border bg-background px-2 py-0.5 text-[10px] hover:bg-secondary"
              >
                全部接受
              </button>
              <button
                onClick={rejectAll}
                className="rounded border border-border bg-background px-2 py-0.5 text-[10px] hover:bg-secondary"
              >
                全部拒绝
              </button>
            </div>
          )}
        </div>

        {!hasItems ? (
          <div className="py-4 text-center text-xs text-muted-foreground">
            Closure Workspace 中暂无测试改动
          </div>
        ) : (
          <div className="flex max-h-[220px] flex-col gap-1 overflow-y-auto">
            {promotionQueue.map((item) => (
              <QueueItemRow
                key={item.id}
                item={item}
                decision={decisions[item.id] ?? item.status}
                onDecision={setItemDecision}
              />
            ))}
          </div>
        )}
      </div>

      {/* ── 操作区 ── */}
      <div className="mt-3 flex items-center gap-2 border-t border-border pt-2">
        <button
          onClick={handlePromote}
          disabled={!hasDecisions || promoting}
          className={cn(
            'flex items-center gap-1 rounded px-3 py-1 text-xs transition-colors',
            hasDecisions && !promoting
              ? 'bg-primary text-primary-foreground hover:bg-primary/90'
              : 'cursor-not-allowed bg-secondary text-muted-foreground',
          )}
          data-testid="promotion-execute-btn"
        >
          {promoting ? <Loader2 className="h-3 w-3 animate-spin" /> : <ArrowUpCircle className="h-3 w-3" />}
          提升已接受的测试
          {acceptedIds.length > 0 && `（${acceptedIds.length}）`}
        </button>

        <div className="ml-auto flex items-center gap-2 text-[10px] text-muted-foreground">
          <span>待审 {pendingCount}</span>
          <span className="text-emerald-500">接受 {acceptedIds.length}</span>
          <span className="text-destructive">拒绝 {rejectedIds.length}</span>
        </div>

        {/* 清理按钮 */}
        {confirmCleanup ? (
          <div className="flex items-center gap-1">
            <span className="text-[10px] text-destructive">确认删除？</span>
            <button
              onClick={handleCleanup}
              className="rounded bg-destructive px-2 py-0.5 text-[10px] text-destructive-foreground hover:bg-destructive/90"
              data-testid="promotion-cleanup-confirm"
            >
              确认
            </button>
            <button
              onClick={() => setConfirmCleanup(false)}
              className="rounded border border-border bg-background px-2 py-0.5 text-[10px] hover:bg-secondary"
            >
              取消
            </button>
          </div>
        ) : (
          <button
            onClick={() => setConfirmCleanup(true)}
            className="flex items-center gap-1 rounded border border-border px-2 py-0.5 text-[10px] text-muted-foreground hover:bg-secondary hover:text-foreground"
            data-testid="promotion-cleanup-btn"
          >
            <Trash2 className="h-3 w-3" />
            清理 Workspace
          </button>
        )}
      </div>
    </div>
  );
}

// ─── 结果摘要子组件 ──────────────────────────────────────────────

function SummarySection({ summary }: { summary: ClosureSummary }) {
  return (
    <div className="rounded border border-border bg-secondary/30 p-2">
      <div className="mb-1 flex items-center justify-between">
        <span className="text-[10px] font-medium text-muted-foreground">Closure 结果摘要</span>
        <div className="flex items-center gap-3 text-[10px]">
          {summary.totalDelta !== null && (
            <span className="font-mono text-primary">
              总 Delta: +{summary.totalDelta.toFixed(1)}%
            </span>
          )}
          <span className="text-emerald-500">已提升 {summary.promotedCount}</span>
          <span className="text-muted-foreground">待审 {summary.pendingCount}</span>
          <span className="text-destructive">拒绝 {summary.rejectedCount}</span>
        </div>
      </div>
      {/* Gap 状态列表 */}
      <div className="flex flex-col gap-1">
        {summary.gaps.map((gap) => (
          <div key={gap.gapId} className="flex items-center gap-2 text-[11px]">
            <span
              className={cn(
                'rounded px-1.5 py-0.5 text-[9px] font-bold',
                GAP_STATUS_BADGE[gap.status] ?? 'bg-muted text-muted-foreground',
              )}
            >
              {GAP_STATUS_LABEL[gap.status] ?? gap.status}
            </span>
            <span className="min-w-[100px] font-mono font-medium text-foreground">
              {gap.moduleName}
            </span>
            <span className="text-muted-foreground">
              {METRIC_LABELS[gap.metric] ?? gap.metric}
            </span>
            <span className="font-mono text-[10px] text-muted-foreground">
              {gap.rounds} 轮
            </span>
            {gap.finalDelta !== null && (
              <span
                className={cn(
                  'font-mono text-[10px]',
                  gap.finalDelta >= 1 ? 'text-primary' : 'text-yellow-500',
                )}
              >
                ({gap.finalDelta >= 0 ? '+' : ''}{gap.finalDelta.toFixed(1)}%)
              </span>
            )}
            {gap.escalationReason && (
              <span className="ml-auto flex items-center gap-0.5 text-[9px] text-destructive">
                <AlertTriangle className="h-2.5 w-2.5" />
                {gap.escalationReason}
              </span>
            )}
          </div>
        ))}
      </div>
    </div>
  );
}

// ─── 队列项行子组件 ──────────────────────────────────────────────

function QueueItemRow({
  item,
  decision,
  onDecision,
}: {
  item: PromotionQueueItem;
  decision: 'accepted' | 'rejected' | 'pending';
  onDecision: (itemId: string, state: 'accepted' | 'rejected' | 'pending') => void;
}) {
  return (
    <div
      className={cn(
        'flex items-center gap-2 rounded px-2 py-1.5 text-[11px]',
        decision === 'accepted' && 'bg-emerald-500/5',
        decision === 'rejected' && 'bg-destructive/5',
        decision === 'pending' && 'bg-secondary/50',
      )}
    >
      <FileCode className="h-3 w-3 flex-shrink-0 text-muted-foreground" />
      <span className="min-w-[120px] truncate font-mono font-medium text-foreground" title={item.fileName}>
        {item.fileName}
      </span>
      <span className="font-mono text-[10px] text-muted-foreground">
        R{item.round}
      </span>
      <span className="ml-auto flex gap-1">
        <button
          onClick={() => onDecision(item.id, 'accepted')}
          className={cn(
            'flex items-center gap-0.5 rounded border px-1.5 py-0.5 text-[9px] transition-colors',
            decision === 'accepted'
              ? 'border-emerald-500/50 bg-emerald-500/20 text-emerald-500'
              : 'border-border bg-background text-muted-foreground hover:text-foreground',
          )}
          data-testid={`promotion-accept-${item.id}`}
        >
          <Check className="h-2.5 w-2.5" />
          接受
        </button>
        <button
          onClick={() => onDecision(item.id, 'rejected')}
          className={cn(
            'flex items-center gap-0.5 rounded border px-1.5 py-0.5 text-[9px] transition-colors',
            decision === 'rejected'
              ? 'border-destructive/50 bg-destructive/20 text-destructive'
              : 'border-border bg-background text-muted-foreground hover:text-foreground',
          )}
          data-testid={`promotion-reject-${item.id}`}
        >
          <X className="h-2.5 w-2.5" />
          拒绝
        </button>
      </span>
    </div>
  );
}
