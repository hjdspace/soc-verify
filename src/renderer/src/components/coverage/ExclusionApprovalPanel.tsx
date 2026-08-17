/**
 * ExclusionApprovalPanel — AI Exclusion 审批面板（ADR 0026 决策 2 / 工单 07）。
 *
 * 闭环详情页的 exclusion 审批面板：列出 AI（ai-triage）与人工提交的全部 pending
 * 建议（语义 selector、reason、AI 置信度），用户逐条 approve / reject。
 * 不做批量自动通过（ADR 0026 关键决策）。
 *
 * 自包含组件：内部 local state + tRPC（getClosure → listExclusions →
 * approveExclusion / rejectExclusion），不依赖也不修改全局 store；
 * 集成时由闭环详情页嵌入。
 *
 * 安全语义：审批通过后主进程自动重新生成 urg -elfile EL 文件，
 * 下次 Coverage Preprocessing / Recovery 的 urg 命令附加应用；
 * 被排除项移出计数，达标判定基于豁免后数字。
 */
import { useCallback, useEffect, useState, type ReactNode } from 'react';
import {
  Check, X, Loader2, ShieldAlert, ChevronDown, ChevronRight,
} from 'lucide-react';
import { cn } from '@renderer/lib/utils';
import { trpc } from '@renderer/lib/trpc';
import type { CoverageExclusion } from '@shared/types';

// ─── 常量 ────────────────────────────────────────────────────────

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

/** 审批人标识（单用户桌面应用）。 */
const APPROVER = 'user';

// ─── 组件 ────────────────────────────────────────────────────────

export type ExclusionApprovalPanelProps = {
  /** 当前项目 ID */
  projectId: string;
  /** 关联的 Closure Session ID（用于解析其 Coverage Merge Session） */
  closureId: string;
  /** 附加到根容器的 className */
  className?: string;
};

export function ExclusionApprovalPanel({
  projectId,
  closureId,
  className,
}: ExclusionApprovalPanelProps) {
  const [exclusions, setExclusions] = useState<CoverageExclusion[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  /** 正在处理的 exclusion id（approve / reject 请求进行中） */
  const [busyId, setBusyId] = useState<string | null>(null);
  /** 展开拒绝理由输入的 exclusion id */
  const [rejectingId, setRejectingId] = useState<string | null>(null);
  const [rejectReason, setRejectReason] = useState('');
  /** approved / rejected 分组折叠状态 */
  const [showApproved, setShowApproved] = useState(false);
  const [showRejected, setShowRejected] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      // closureId → 关联的 Coverage Merge Session（exclusion 的 sessionId 域）
      const closure = await trpc.coverage.getClosure.query({ projectId, closureId });
      if (!closure) {
        setError(`Closure ${closureId} 不存在`);
        setExclusions([]);
        return;
      }
      const list = await trpc.coverage.listExclusions.query({
        projectId,
        sessionId: closure.sessionId,
      });
      setExclusions(list);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  }, [projectId, closureId]);

  useEffect(() => {
    void load();
  }, [load]);

  const handleApprove = async (id: string) => {
    setBusyId(id);
    setError(null);
    try {
      await trpc.coverage.approveExclusion.mutate({ projectId, id, approver: APPROVER });
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusyId(null);
    }
  };

  const handleReject = async (id: string) => {
    const reason = rejectReason.trim();
    if (!reason) return; // 拒绝理由必填
    setBusyId(id);
    setError(null);
    try {
      await trpc.coverage.rejectExclusion.mutate({
        projectId,
        id,
        approver: APPROVER,
        reason,
      });
      setRejectingId(null);
      setRejectReason('');
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusyId(null);
    }
  };

  const pending = exclusions.filter((e) => e.status === 'pending');
  const approved = exclusions.filter((e) => e.status === 'approved');
  const rejected = exclusions.filter((e) => e.status === 'rejected');

  return (
    <div
      className={cn('rounded border border-border bg-card p-3', className)}
      data-testid="exclusion-approval-panel"
    >
      {/* ── 标题 ── */}
      <div className="mb-2 flex items-center gap-2">
        <ShieldAlert className="h-4 w-4 text-primary" />
        <span className="text-xs font-semibold">Exclusion 审批</span>
        <span className="text-[10px] text-muted-foreground">
          AI 只建议不排除——逐条审批通过后生成 EL 文件，下次报告应用
        </span>
      </div>

      {error && (
        <div
          className="mb-2 rounded border border-destructive/30 bg-destructive/10 px-2 py-1 text-[10px] text-destructive"
          data-testid="exclusion-panel-error"
        >
          {error}
        </div>
      )}

      {/* ── Pending 建议列表 ── */}
      <div className="mb-1 flex items-center justify-between">
        <span className="text-[10px] font-medium text-muted-foreground">
          待审批（{pending.length} 项）
        </span>
      </div>

      {loading ? (
        <div className="flex items-center justify-center gap-2 py-4 text-xs text-muted-foreground">
          <Loader2 className="h-3 w-3 animate-spin" />
          加载排除建议...
        </div>
      ) : pending.length === 0 ? (
        <div className="py-3 text-center text-xs text-muted-foreground">
          暂无待审批的豁免建议
        </div>
      ) : (
        <div className="flex max-h-[260px] flex-col gap-1.5 overflow-y-auto">
          {pending.map((e) => (
            <PendingRow
              key={e.id}
              exclusion={e}
              busy={busyId === e.id}
              rejecting={rejectingId === e.id}
              rejectReason={rejectReason}
              onRejectReasonChange={setRejectReason}
              onStartReject={() => {
                setRejectingId(rejectingId === e.id ? null : e.id);
                setRejectReason('');
              }}
              onApprove={() => void handleApprove(e.id)}
              onReject={() => void handleReject(e.id)}
            />
          ))}
        </div>
      )}

      {/* ── 已通过分组（可折叠） ── */}
      <GroupSection
        title={`已通过（${approved.length}）— 已写入 EL 文件`}
        count={approved.length}
        expanded={showApproved}
        onToggle={() => setShowApproved((v) => !v)}
        expandedIcon={<ChevronDown className="h-3 w-3" />}
        collapsedIcon={<ChevronRight className="h-3 w-3" />}
        titleClassName="text-emerald-500"
        data-testid="exclusion-group-approved"
      >
        {approved.map((e) => (
          <HistoryRow key={e.id} exclusion={e} tone="approved" />
        ))}
      </GroupSection>

      {/* ── 已驳回分组（可折叠） ── */}
      <GroupSection
        title={`已驳回（${rejected.length}）`}
        count={rejected.length}
        expanded={showRejected}
        onToggle={() => setShowRejected((v) => !v)}
        expandedIcon={<ChevronDown className="h-3 w-3" />}
        collapsedIcon={<ChevronRight className="h-3 w-3" />}
        titleClassName="text-destructive"
        data-testid="exclusion-group-rejected"
      >
        {rejected.map((e) => (
          <HistoryRow key={e.id} exclusion={e} tone="rejected" />
        ))}
      </GroupSection>
    </div>
  );
}

// ─── Pending 行子组件 ────────────────────────────────────────────

function PendingRow({
  exclusion,
  busy,
  rejecting,
  rejectReason,
  onRejectReasonChange,
  onStartReject,
  onApprove,
  onReject,
}: {
  exclusion: CoverageExclusion;
  busy: boolean;
  rejecting: boolean;
  rejectReason: string;
  onRejectReasonChange: (v: string) => void;
  onStartReject: () => void;
  onApprove: () => void;
  onReject: () => void;
}) {
  const e = exclusion;
  return (
    <div
      className="rounded border border-border bg-secondary/30 px-2 py-1.5"
      data-testid={`exclusion-pending-${e.id}`}
    >
      <div className="flex items-center gap-2 text-[11px]">
        <span className="min-w-[110px] truncate font-mono font-medium text-foreground" title={e.nodePath}>
          {e.nodePath}
        </span>
        <span className="rounded bg-muted px-1 py-0.5 text-[9px] text-muted-foreground">
          {METRIC_LABELS[e.metric] ?? e.metric}
        </span>
        {/* 语义 selector：file:line 或 bin */}
        <span className="truncate font-mono text-[10px] text-muted-foreground" title={selectorText(e)}>
          {selectorText(e)}
        </span>
        {/* AI 置信度（百分比展示，仅 ai-triage 建议有） */}
        {e.requestedBy === 'ai-triage' && e.confidence !== undefined && (
          <span
            className="rounded bg-primary/15 px-1 py-0.5 text-[9px] font-mono text-primary"
            title="AI 置信度"
          >
            {Math.round(e.confidence * 100)}%
          </span>
        )}
      </div>
      <div className="mt-1 flex items-start gap-2">
        <span className="flex-1 text-[10px] leading-relaxed text-muted-foreground" title={e.reason}>
          {e.reason}
        </span>
        <span className="flex flex-shrink-0 gap-1">
          <button
            onClick={onApprove}
            disabled={busy}
            className={cn(
              'flex items-center gap-0.5 rounded border px-1.5 py-0.5 text-[9px] transition-colors',
              busy
                ? 'cursor-not-allowed opacity-50'
                : 'border-emerald-500/50 bg-background text-emerald-500 hover:bg-emerald-500/15',
            )}
            data-testid={`exclusion-approve-${e.id}`}
          >
            <Check className="h-2.5 w-2.5" />
            通过
          </button>
          <button
            onClick={onStartReject}
            disabled={busy}
            className={cn(
              'flex items-center gap-0.5 rounded border px-1.5 py-0.5 text-[9px] transition-colors',
              busy
                ? 'cursor-not-allowed opacity-50'
                : 'border-border bg-background text-muted-foreground hover:text-destructive',
            )}
            data-testid={`exclusion-reject-${e.id}`}
          >
            <X className="h-2.5 w-2.5" />
            驳回
          </button>
        </span>
      </div>
      {/* 驳回理由输入（必填） */}
      {rejecting && (
        <div className="mt-1.5 flex items-center gap-1">
          <input
            value={rejectReason}
            onChange={(ev) => onRejectReasonChange(ev.target.value)}
            placeholder="驳回理由（必填）"
            className="flex-1 rounded border border-border bg-background px-1.5 py-1 text-[10px] text-foreground placeholder:text-muted-foreground focus:outline-none focus:ring-1 focus:ring-primary"
            data-testid={`exclusion-reject-reason-${e.id}`}
          />
          <button
            onClick={onReject}
            disabled={busy || rejectReason.trim() === ''}
            className={cn(
              'rounded px-2 py-1 text-[9px] transition-colors',
              busy || rejectReason.trim() === ''
                ? 'cursor-not-allowed bg-secondary text-muted-foreground'
                : 'bg-destructive text-destructive-foreground hover:bg-destructive/90',
            )}
            data-testid={`exclusion-reject-confirm-${e.id}`}
          >
            {busy ? <Loader2 className="h-2.5 w-2.5 animate-spin" /> : '确认驳回'}
          </button>
        </div>
      )}
    </div>
  );
}

// ─── 历史（approved/rejected）行子组件 ───────────────────────────

function HistoryRow({ exclusion, tone }: { exclusion: CoverageExclusion; tone: 'approved' | 'rejected' }) {
  const e = exclusion;
  return (
    <div
      className={cn(
        'flex items-center gap-2 rounded px-2 py-1 text-[10px]',
        tone === 'approved' ? 'bg-emerald-500/5' : 'bg-destructive/5',
      )}
      data-testid={`exclusion-history-${e.id}`}
    >
      <span className="min-w-[110px] truncate font-mono text-foreground" title={e.nodePath}>
        {e.nodePath}
      </span>
      <span className="rounded bg-muted px-1 py-0.5 text-[9px] text-muted-foreground">
        {METRIC_LABELS[e.metric] ?? e.metric}
      </span>
      <span className="truncate font-mono text-[9px] text-muted-foreground" title={selectorText(e)}>
        {selectorText(e)}
      </span>
      <span className="ml-auto flex-shrink-0 text-[9px] text-muted-foreground" title={e.reason}>
        {tone === 'approved'
          ? `by ${e.approvedBy ?? 'unknown'}`
          : e.rejectionReason
            ? `驳回：${e.rejectionReason}`
            : '已驳回'}
      </span>
    </div>
  );
}

// ─── 可折叠分组子组件 ────────────────────────────────────────────

function GroupSection({
  title,
  count,
  expanded,
  onToggle,
  expandedIcon,
  collapsedIcon,
  titleClassName,
  children,
  'data-testid': testId,
}: {
  title: string;
  count: number;
  expanded: boolean;
  onToggle: () => void;
  expandedIcon: ReactNode;
  collapsedIcon: ReactNode;
  titleClassName?: string;
  children: ReactNode;
  'data-testid'?: string;
}) {
  return (
    <div className="mt-2 border-t border-border pt-1.5" data-testid={testId}>
      <button
        onClick={onToggle}
        disabled={count === 0}
        className={cn(
          'flex w-full items-center gap-1 text-[10px] font-medium',
          count === 0 ? 'cursor-default text-muted-foreground/50' : titleClassName,
        )}
      >
        {expanded ? expandedIcon : collapsedIcon}
        {title}
      </button>
      {expanded && count > 0 && <div className="mt-1 flex flex-col gap-1">{children}</div>}
    </div>
  );
}

// ─── 辅助 ────────────────────────────────────────────────────────

/** 语义 selector 展示文本：file:line 或 bin；两者皆无时显示 nodePath 级排除。 */
function selectorText(e: CoverageExclusion): string {
  if (e.file !== undefined && e.line !== undefined) return `${e.file}:${e.line}`;
  if (e.bin !== undefined) return `bin:${e.bin}`;
  return '(模块级排除)';
}
