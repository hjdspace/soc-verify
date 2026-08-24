/**
 * ClosureDetailPage — 闭环详情页（Issue 06 / PRD US-22~28）。
 *
 * 覆盖率两视图（树表格/仪表盘）启动 AI 收敛后进入本页：
 * - 实时进度：消费 closure 事件流（closureLive），显示每个 target 的轮次/状态/当前动作
 *   （生成测试 / 仿真 / Recovery）
 * - 迭代历史：每轮生成测试文件列表 + 逐 metric Delta 前后对比；应用豁免后同时
 *   展示豁免前/豁免后双数字（ADR 0026 决策 4）
 * - 中止控制：整个闭环或单个 target（中止即转人工）
 * - 升级原因（escalationReason）与 AI triage 建议展示
 * - Exclusion 审批面板（工单 07）与 Test Promotion（终态后）
 */
import { useEffect, useState } from 'react';
import {
  ArrowLeft, Loader2, Square, ChevronDown, ChevronRight,
  Activity, FileCode, ShieldAlert, AlertTriangle,
} from 'lucide-react';
import { cn } from '@renderer/lib/utils';
import { useCoverageCoreStore, useCoverageClosureStore } from '@renderer/stores/coverage';
import type { ClosureTarget } from '@renderer/stores/coverage';
import { useProjectStore } from '@renderer/stores/project';
import { ExclusionApprovalPanel } from './ExclusionApprovalPanel';
import { TestPromotionPanel } from './TestPromotionPanel';

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

const TARGET_STATUS_LABEL: Record<string, string> = {
  pending: '待处理',
  in_progress: '进行中',
  closed: '已达标',
  escalated: '已升级',
  failed: '失败',
};

const TARGET_STATUS_DOT: Record<string, string> = {
  pending: 'bg-muted-foreground',
  in_progress: 'bg-primary',
  closed: 'bg-emerald-500',
  escalated: 'bg-destructive',
  failed: 'bg-destructive',
};

const CLOSURE_STATUS_LABEL: Record<string, string> = {
  pending: '待处理',
  running: '运行中',
  completed: '已完成',
  failed: '失败',
  aborted: '已中止',
};

const TERMINAL_TARGET_STATUSES = ['closed', 'escalated', 'failed'];

/** agentPhase → 当前动作文案（US-23：生成测试 / 仿真 / Recovery） */
function agentPhaseLabel(phase: string | undefined): string {
  switch (phase) {
    case 'prompting':
      return 'AI 生成测试中';
    case 'ended':
      return '仿真完成，扫描测试与计算 Delta';
    case 'recovering':
      return 'Coverage Recovery（合并 VDB → urg 报告 → 重解析）';
    default:
      return '等待迭代';
  }
}

// ─── 组件 ────────────────────────────────────────────────────────

export function ClosureDetailPage() {
  const currentProjectId = useProjectStore((s) => s.currentProjectId);
const closures = useCoverageClosureStore((s) => s.closures);
const currentClosureId = useCoverageClosureStore((s) => s.currentClosureId);
const currentClosure = useCoverageClosureStore((s) => s.currentClosure);
const closureLive = useCoverageClosureStore((s) => s.closureLive);
const setView = useCoverageCoreStore((s) => s.setView);
const loadClosures = useCoverageClosureStore((s) => s.loadClosures);
const loadClosure = useCoverageClosureStore((s) => s.loadClosure);
const abortClosure = useCoverageClosureStore((s) => s.abortClosure);
const abortClosureTarget = useCoverageClosureStore((s) => s.abortClosureTarget);

  /** 展开迭代历史的 targetId 集合 */
  const [expandedTargets, setExpandedTargets] = useState<Set<string>>(new Set());

  // 加载 closure 列表（切换历史 closure 用）
  useEffect(() => {
    if (currentProjectId) void loadClosures(currentProjectId);
  }, [currentProjectId, loadClosures]);

  // currentClosureId 存在但数据未加载（如重启后直接进入详情页）时拉取
  useEffect(() => {
    if (currentProjectId && currentClosureId && !currentClosure) {
      void loadClosure(currentProjectId, currentClosureId);
    }
  }, [currentProjectId, currentClosureId, currentClosure, loadClosure]);

  const handleSwitchClosure = (closureId: string): void => {
    if (!currentProjectId || !closureId) return;
    void loadClosure(currentProjectId, closureId);
  };

  const handleAbortClosure = (): void => {
    if (!currentProjectId || !currentClosure) return;
    void abortClosure(currentProjectId, currentClosure.id);
  };

  const handleAbortTarget = (targetId: string): void => {
    if (!currentProjectId || !currentClosure) return;
    void abortClosureTarget(currentProjectId, currentClosure.id, targetId);
  };

  const toggleExpanded = (targetId: string): void => {
    setExpandedTargets((prev) => {
      const next = new Set(prev);
      if (next.has(targetId)) next.delete(targetId);
      else next.add(targetId);
      return next;
    });
  };

  // ─── 无 Closure：返回入口 ───────────────────────────────────
  if (!currentClosureId && closures.length === 0) {
    return (
      <div className="flex flex-col items-center justify-center gap-2 py-12">
        <Activity className="h-8 w-8 text-muted-foreground/50" />
        <p className="text-xs text-muted-foreground">暂无 AI 收敛闭环记录</p>
        <button
          onClick={() => setView('tree-table')}
          className="rounded border border-border bg-card px-3 py-1 text-xs hover:bg-secondary"
          data-testid="closure-detail-back"
        >
          返回覆盖率分析
        </button>
      </div>
    );
  }

  return (
    <div data-testid="closure-detail-page" className="space-y-3">
      {/* ── 头部：返回 + Closure 选择 + 状态 + 整体中止 ── */}
      <div className="flex flex-wrap items-center gap-2">
        <button
          onClick={() => setView('tree-table')}
          className="flex items-center gap-1 rounded border border-border bg-card px-2 py-1 text-xs hover:bg-secondary"
          data-testid="closure-detail-back"
        >
          <ArrowLeft className="h-3 w-3" />
          返回
        </button>
        <span className="text-xs font-semibold">AI 收敛闭环详情</span>
        {closures.length > 0 && (
          <select
            value={currentClosureId ?? ''}
            onChange={(e) => handleSwitchClosure(e.target.value)}
            className="rounded border border-border bg-card px-2 py-1 font-mono text-[10px]"
            data-testid="closure-detail-selector"
          >
            {closures.map((c) => (
              <option key={c.id} value={c.id}>
                {c.id}（{CLOSURE_STATUS_LABEL[c.status] ?? c.status}）
              </option>
            ))}
          </select>
        )}
        {currentClosure && (
          <span
            className={cn(
              'rounded px-1.5 py-0.5 text-[10px]',
              closureLive.running ? 'bg-primary/15 text-primary' : 'bg-secondary text-muted-foreground',
            )}
            data-testid="closure-detail-status"
          >
            {CLOSURE_STATUS_LABEL[currentClosure.status] ?? currentClosure.status}
          </span>
        )}
        {closureLive.running && currentClosure && (
          <button
            onClick={handleAbortClosure}
            className="ml-auto flex items-center gap-1 rounded border border-destructive/50 bg-destructive/10 px-3 py-1 text-xs text-destructive hover:bg-destructive/20"
            data-testid="closure-detail-abort"
          >
            <Square className="h-3 w-3" />
            中止整个闭环
          </button>
        )}
      </div>

      {!currentClosure ? (
        <div className="flex items-center justify-center gap-2 py-8">
          <Loader2 className="h-4 w-4 animate-spin text-primary" />
          <span className="text-xs text-muted-foreground">加载闭环数据...</span>
        </div>
      ) : (
        <>
          {/* ── 实时进度（事件流驱动，US-23） ── */}
          {closureLive.running && (
            <div className="rounded border border-primary/30 bg-primary/5 p-2" data-testid="closure-live-progress">
              <div className="flex items-center gap-2 text-xs">
                <Loader2 className="h-3.5 w-3.5 animate-spin text-primary" />
                <span>
                  {closureLive.activeTargetId
                    ? `Target 迭代中 · Round ${closureLive.activeRound ?? '?'} · ${agentPhaseLabel(closureLive.agentPhase)}`
                    : '调度 Target 中...'}
                </span>
              </div>
              {typeof closureLive.lastDeltaOverall === 'number' && (
                <div className="mt-1 font-mono text-[10px] text-muted-foreground">
                  最近 Delta: <span className="text-primary">+{closureLive.lastDeltaOverall.toFixed(2)}%</span>
                </div>
              )}
              {closureLive.lastEscalation && (
                <div className="mt-1 text-[10px] text-destructive" data-testid="closure-live-escalation">
                  最近升级：{closureLive.lastEscalation.reason}
                </div>
              )}
              {closureLive.lastError && (
                <div className="mt-1 text-[10px] text-destructive" data-testid="closure-live-error">
                  {closureLive.lastError}
                </div>
              )}
            </div>
          )}

          {/* ── Target 列表（轮次/状态/中止/升级原因/迭代历史） ── */}
          <div className="space-y-2">
            {currentClosure.targets.map((target) => (
              <TargetCard
                key={target.id}
                target={target}
                isLiveTarget={closureLive.running && closureLive.activeTargetId === target.id}
                livePhase={closureLive.activeTargetId === target.id ? closureLive.agentPhase : undefined}
                expanded={expandedTargets.has(target.id)}
                onToggle={() => toggleExpanded(target.id)}
                onAbort={() => handleAbortTarget(target.id)}
              />
            ))}
          </div>

          {/* ── Exclusion 审批面板（工单 07 / US-30~33） ── */}
          {currentProjectId && (
            <ExclusionApprovalPanel projectId={currentProjectId} closureId={currentClosure.id} />
          )}

          {/* ── Test Promotion（终态后，US-27） ── */}
          {['completed', 'aborted', 'failed'].includes(currentClosure.status) && (
            <TestPromotionPanel closureId={currentClosure.id} />
          )}
        </>
      )}
    </div>
  );
}

// ─── Target 卡片子组件 ───────────────────────────────────────────

type TargetCardProps = {
  target: ClosureTarget;
  isLiveTarget: boolean;
  livePhase: string | undefined;
  expanded: boolean;
  onToggle: () => void;
  onAbort: () => void;
};

function TargetCard({ target, isLiveTarget, livePhase, expanded, onToggle, onAbort }: TargetCardProps) {
  const isTerminal = TERMINAL_TARGET_STATUSES.includes(target.status);
  const canAbort = !isTerminal;
  const metricLabels = target.gaps.map((g) => METRIC_LABELS[g.metric] ?? g.metric).join(', ');
  const lastIter = target.iterations[target.iterations.length - 1];
  const iterDelta = lastIter?.deltaBefore && lastIter?.deltaAfter
    ? lastIter.deltaAfter.overall - lastIter.deltaBefore.overall
    : undefined;

  return (
    <div
      className={cn(
        'rounded border bg-card p-2',
        isLiveTarget ? 'border-primary/50' : 'border-border',
      )}
      data-testid={`closure-target-${target.id}`}
    >
      {/* 头部行 */}
      <div className="flex flex-wrap items-center gap-2 text-xs">
        <button
          onClick={onToggle}
          className="flex items-center gap-1"
          data-testid={`closure-target-expand-${target.id}`}
        >
          {expanded
            ? <ChevronDown className="h-3 w-3 text-muted-foreground" />
            : <ChevronRight className="h-3 w-3 text-muted-foreground" />}
          <span className={cn('h-2 w-2 flex-shrink-0 rounded-full', TARGET_STATUS_DOT[target.status] ?? 'bg-muted-foreground')} />
          <span className="font-mono font-medium">{target.module.name}</span>
        </button>
        <span className="text-[10px] text-muted-foreground" title={target.module.path}>
          {metricLabels}
        </span>
        {target.iterations.length > 0 && (
          <span className="font-mono text-[10px] text-muted-foreground">
            Round {target.iterations.length}
            {typeof iterDelta === 'number' && (
              <span className={iterDelta >= 1 ? 'text-primary' : 'text-yellow-500'}>
                {' '}({iterDelta >= 0 ? '+' : ''}{iterDelta.toFixed(1)}%)
              </span>
            )}
          </span>
        )}
        {isLiveTarget && (
          <span className="flex items-center gap-1 text-[10px] text-primary">
            <Loader2 className="h-3 w-3 animate-spin" />
            {agentPhaseLabel(livePhase)}
          </span>
        )}
        <span className={cn(
          'ml-auto rounded px-1.5 py-0.5 text-[10px]',
          target.status === 'closed' && 'bg-emerald-500/15 text-emerald-500',
          target.status === 'in_progress' && 'bg-primary/15 text-primary',
          (target.status === 'escalated' || target.status === 'failed') && 'bg-destructive/15 text-destructive',
          target.status === 'pending' && 'bg-muted text-muted-foreground',
        )}>
          {TARGET_STATUS_LABEL[target.status] ?? target.status}
        </span>
        {/* 单 target 中止（中止即转人工，Issue 06） */}
        {canAbort && (
          <button
            onClick={onAbort}
            className="flex items-center gap-1 rounded border border-destructive/40 px-1.5 py-0.5 text-[10px] text-destructive hover:bg-destructive/10"
            title="中止该 target（转人工处理，不影响其他 target）"
            data-testid={`closure-target-abort-${target.id}`}
          >
            <Square className="h-2.5 w-2.5" />
            中止
          </button>
        )}
      </div>

      {/* 升级原因（US-28） */}
      {target.escalationReason && (
        <div
          className="mt-1.5 flex items-start gap-1.5 rounded bg-destructive/5 px-2 py-1 text-[10px] text-destructive"
          data-testid={`closure-target-escalation-${target.id}`}
        >
          <AlertTriangle className="mt-0.5 h-3 w-3 flex-shrink-0" />
          升级原因：{target.escalationReason}
        </div>
      )}

      {/* 迭代历史（展开） */}
      {expanded && (
        <div className="mt-2 space-y-2">
          {target.iterations.length === 0 ? (
            <div className="py-2 text-center text-[10px] text-muted-foreground">暂无迭代记录</div>
          ) : (
            target.iterations
              .slice()
              .reverse()
              .map((iter) => (
                <IterationCard key={iter.round} target={target} iter={iter} />
              ))
          )}
        </div>
      )}
    </div>
  );
}

// ─── 迭代历史子组件 ──────────────────────────────────────────────

type IterationCardProps = {
  target: TargetCardProps['target'];
  iter: TargetCardProps['target']['iterations'][number];
};

function IterationCard({ target, iter }: IterationCardProps) {
  // 逐 metric delta（US-24）：仅展示该 target 关心的 metric + 有数据的
  const gapMetrics = new Set(target.gaps.map((g) => g.metric));
  const deltaRows = (iter.deltas ?? []).filter((d) => gapMetrics.has(d.metric));

  return (
    <div
      className="rounded border border-border bg-secondary/30 p-2"
      data-testid={`closure-iteration-${target.id}-${iter.round}`}
    >
      <div className="flex items-center gap-2 text-[11px]">
        <span className="font-mono font-medium">Round {iter.round}</span>
        <span
          className={cn(
            'rounded px-1 py-0.5 text-[9px]',
            iter.status === 'completed' && 'bg-emerald-500/15 text-emerald-500',
            iter.status === 'failed' && 'bg-destructive/15 text-destructive',
            iter.status === 'running' && 'bg-primary/15 text-primary',
            iter.status === 'pending' && 'bg-muted text-muted-foreground',
          )}
        >
          {iter.status === 'completed' ? '已完成' : iter.status === 'failed' ? '失败' : iter.status === 'running' ? '进行中' : '待处理'}
        </span>
        {iter.error && <span className="truncate text-[10px] text-destructive" title={iter.error}>{iter.error}</span>}
      </div>

      {/* 生成测试文件列表（US-25） */}
      <div className="mt-1.5" data-testid={`closure-iteration-tests-${target.id}-${iter.round}`}>
        <span className="text-[10px] font-medium text-muted-foreground">
          生成测试（{iter.generatedTests.length}）
        </span>
        {iter.generatedTests.length === 0 ? (
          <span className="ml-1 text-[10px] text-muted-foreground/70">无</span>
        ) : (
          <ul className="mt-0.5 flex flex-wrap gap-1">
            {iter.generatedTests.map((f) => (
              <li
                key={f}
                className="flex items-center gap-1 rounded bg-muted px-1.5 py-0.5 font-mono text-[10px]"
                title={`${f}（位于 Closure Workspace）`}
              >
                <FileCode className="h-2.5 w-2.5 text-muted-foreground" />
                {f}
              </li>
            ))}
          </ul>
        )}
      </div>

      {/* 逐 metric Delta 前后对比（US-24）+ 豁免前后双数字（US-32） */}
      {deltaRows.length > 0 && (
        <div className="mt-1.5 overflow-x-auto" data-testid={`closure-iteration-delta-${target.id}-${iter.round}`}>
          <table className="w-full text-[10px]">
            <thead className="text-muted-foreground">
              <tr>
                <th className="py-0.5 pr-2 text-left">Metric</th>
                <th className="py-0.5 pr-2 text-right">Before</th>
                <th className="py-0.5 pr-2 text-right">After</th>
                <th className="py-0.5 pr-2 text-right">Delta</th>
                <th className="py-0.5 text-right">豁免影响</th>
              </tr>
            </thead>
            <tbody>
              {deltaRows.map((d) => {
                const beforeExc = iter.beforeExclusionMetrics?.[d.metric];
                const afterExc = iter.afterExclusionMetrics?.[d.metric];
                const exclusionChanged =
                  beforeExc !== undefined &&
                  afterExc !== undefined &&
                  beforeExc.percentage !== afterExc.percentage;
                return (
                  <tr key={d.metric} className="border-t border-border/50">
                    <td className="py-0.5 pr-2">{METRIC_LABELS[d.metric] ?? d.metric}</td>
                    <td className="py-0.5 pr-2 text-right font-mono">{d.before.toFixed(1)}%</td>
                    <td className="py-0.5 pr-2 text-right font-mono">{d.after.toFixed(1)}%</td>
                    <td
                      className={cn(
                        'py-0.5 pr-2 text-right font-mono',
                        d.delta > 0 && 'text-primary',
                        d.delta < 0 && 'text-destructive',
                      )}
                    >
                      {d.delta > 0 ? '+' : ''}{d.delta.toFixed(1)}
                    </td>
                    <td className="py-0.5 text-right font-mono">
                      {exclusionChanged ? (
                        <span className="flex items-center justify-end gap-1 text-muted-foreground">
                          <ShieldAlert className="h-2.5 w-2.5" />
                          {beforeExc.percentage?.toFixed(1)}% → {afterExc.percentage?.toFixed(1)}%
                        </span>
                      ) : (
                        '—'
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
