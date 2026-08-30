/**
 * TVAISuggestionCard — 时序违例 AI 建议卡（RecommendationCard 第一场景）
 *
 * 在右侧 AI 面板中把 TV AI 返回的 JSON 建议映射为通用建议卡
 * （components/ui/RecommendationCard）：违例上下文 preface + 置信度信号条
 * （3 根竖条 Meter）+ 确认并应用 CTA（success 态）+ 重新分析/拒绝动作。
 * 数据源 violation-router 不变；确认仍写 tv-confirmations store
 * （applyAISuggestion），拒绝/重新分析语义保持不变。
 */

import { useState, useMemo, useEffect, type ReactNode } from 'react';
import { Sparkles, XCircle, Loader2, RefreshCw } from 'lucide-react';
import { cn } from '@renderer/lib/utils';
import { useTvDataStore, useTvConfirmationsStore, type AISuggestion } from '@renderer/stores/timing-violation';
import { useProjectStore } from '@renderer/stores/project';
import { formatTimeDisplay } from '@renderer/lib/tv-utils';
import { RecommendationCard, type RecommendationOption } from '@renderer/components/ui/RecommendationCard';

type TVAISuggestionCardProps = {
  /** AI 返回的原始响应文本（JSON 或包含 JSON 的 markdown） */
  content: string;
  /** 当前分析的违例 ID */
  violationId: number;
};

/**
 * 尝试从 AI 响应文本中解析出 JSON 建议对象。
 * 支持：纯 JSON、markdown 代码块包裹的 JSON、文本中嵌入的 { ... } 块。
 */
function parseSuggestionJson(text: string): AISuggestion | null {
  // 1. 直接解析
  try {
    const parsed = JSON.parse(text);
    return normalizeSuggestion(parsed);
  } catch {
    // 继续尝试
  }

  // 2. 从 markdown 代码块提取
  const codeBlockMatch = text.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (codeBlockMatch) {
    try {
      const parsed = JSON.parse(codeBlockMatch[1].trim());
      return normalizeSuggestion(parsed);
    } catch {
      // 继续
    }
  }

  // 3. 从文本中提取 { ... } 块
  const jsonMatch = text.match(/\{[\s\S]*\}/);
  if (jsonMatch) {
    try {
      const parsed = JSON.parse(jsonMatch[0]);
      return normalizeSuggestion(parsed);
    } catch {
      // 解析失败
    }
  }

  return null;
}

function normalizeSuggestion(parsed: unknown): AISuggestion | null {
  if (typeof parsed !== 'object' || parsed === null) return null;
  const obj = parsed as Record<string, unknown>;

  // 必须至少包含 confirmer 或 result 字段才算有效的 TV 建议
  if (!('confirmer' in obj) && !('result' in obj)) return null;

  return {
    confirmer: typeof obj.confirmer === 'string' ? obj.confirmer : undefined,
    result: typeof obj.result === 'string' ? obj.result : undefined,
    reason: typeof obj.reason === 'string' ? obj.reason : undefined,
    confidence: typeof obj.confidence === 'number' ? Math.max(0, Math.min(1, obj.confidence)) : 0,
    analysis: typeof obj.analysis === 'string' ? obj.analysis : undefined,
  };
}

/** confidence(0–1) → 信号条格数 1–3（>0 才显示信号条） */
function confidenceToSignal(confidence: number): number {
  if (confidence >= 0.7) return 3;
  if (confidence >= 0.4) return 2;
  return 1;
}

/** 信号条语义色：1 格 fail / 2 格 aborted / 3 格 pass（索引 0 不触达） */
const SIGNAL_TONES = [
  'var(--status-fail)',
  'var(--status-fail)',
  'var(--status-aborted)',
  'var(--status-pass)',
];

function confidenceLabel(confidence: number): string {
  const pct = Math.round(confidence * 100);
  if (confidence >= 0.7) return `高置信度 ${pct}%`;
  if (confidence >= 0.4) return `需复核 ${pct}%`;
  return `低置信度 ${pct}%`;
}

/** 建议字段行（确认人/确认结果/分析理由/详细分析共用） */
function SuggestionRow({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="flex items-start gap-2 text-[11px]">
      <span className="shrink-0 text-muted-foreground">{label}:</span>
      <span className="min-w-0 text-foreground">{children}</span>
    </div>
  );
}

export function TVAISuggestionCard({ content, violationId }: TVAISuggestionCardProps) {
  const projectId = useProjectStore((s) => s.currentProjectId);
  const violations = useTvDataStore((s) => s.violations);
  const applyAISuggestion = useTvConfirmationsStore((s) => s.applyAISuggestion);
  const clearAISuggestion = useTvConfirmationsStore((s) => s.clearAISuggestion);
  const startAISuggestion = useTvConfirmationsStore((s) => s.startAISuggestion);

  const [actionLoading, setActionLoading] = useState(false);
  const [applied, setApplied] = useState(false);
  const [rejected, setRejected] = useState(false);

  // 解析 AI 响应 JSON
  const suggestion = useMemo(() => parseSuggestionJson(content), [content]);

  // 查找当前违例信息
  const violation = useMemo(
    () => violations.find((v) => v.id === violationId),
    [violations, violationId],
  );

  // 当 content 变化（新的 AI 响应）时重置 applied/rejected 状态
  useEffect(() => {
    setApplied(false);
    setRejected(false);
  }, [content]);

  // 如果违例已被确认（状态为 confirmed），标记为已应用
  const isConfirmed = violation?.status === 'confirmed';
  const isApplied = applied || isConfirmed;

  // 如果无法解析为 TV 建议 JSON，返回 null（让调用方回退到普通渲染）
  if (!suggestion) return null;

  const hasConfidence = suggestion.confidence > 0;
  const signal = hasConfidence ? confidenceToSignal(suggestion.confidence) : 0;

  // AISuggestion → 通用建议卡 Option 契约（单选项，无备选抽屉）
  const option: RecommendationOption = {
    key: `${suggestion.confirmer ?? ''}|${suggestion.result ?? ''}|${suggestion.reason ?? ''}|${suggestion.confidence}`,
    body: (
      <div className="space-y-1.5">
        {suggestion.confirmer && <SuggestionRow label="确认人">{suggestion.confirmer}</SuggestionRow>}
        {suggestion.result && (
          <SuggestionRow label="确认结果">
            <span
              className={cn(
                'inline-flex items-center rounded px-1.5 py-0.5 text-[10px] font-medium',
                suggestion.result === 'pass'
                  ? 'bg-green-500/15 text-green-600 dark:text-green-400'
                  : 'bg-red-500/15 text-red-600 dark:text-red-400',
              )}
            >
              {suggestion.result === 'pass' ? '✓ Pass' : '✗ Issue'}
            </span>
          </SuggestionRow>
        )}
        {suggestion.reason && <SuggestionRow label="分析理由">{suggestion.reason}</SuggestionRow>}
        {suggestion.analysis && <SuggestionRow label="详细分析">{suggestion.analysis}</SuggestionRow>}
      </div>
    ),
    short:
      suggestion.reason?.trim()
      || suggestion.analysis?.trim()
      || [suggestion.confirmer, suggestion.result].filter(Boolean).join(' · ')
      || 'TV AI 建议',
    ...(hasConfidence
      ? { signal, tone: SIGNAL_TONES[signal], label: confidenceLabel(suggestion.confidence) }
      : {}),
    cta: rejected ? '已拒绝' : '确认并应用',
    ctaVariant: 'accent',
  };

  const handleConfirm = async () => {
    if (!projectId || !suggestion.confirmer || !suggestion.result) return;
    setActionLoading(true);
    try {
      await applyAISuggestion(projectId, violationId, suggestion);
      setApplied(true);
    } finally {
      setActionLoading(false);
    }
  };

  const handleReanalyze = async () => {
    if (!projectId) return;
    clearAISuggestion();
    setActionLoading(true);
    try {
      await startAISuggestion(projectId, violationId);
    } finally {
      setActionLoading(false);
    }
  };

  const handleReject = () => {
    setRejected(true);
    clearAISuggestion();
  };

  return (
    <RecommendationCard
      options={[option]}
      title={
        <>
          <Sparkles className="size-3 text-primary" />
          AI 分析建议
        </>
      }
      preface={
        violation && (
          <div className="mb-2.5 rounded-md bg-background/60 px-2.5 py-1.5">
            <div className="text-[10px] font-semibold uppercase text-muted-foreground">
              当前分析的违例
            </div>
            <div className="mt-0.5 flex items-center gap-2 text-[11px]">
              <span className="font-mono font-semibold text-primary">Vio#{violation.num}</span>
              <span className="truncate font-mono text-foreground">{violation.hier}</span>
            </div>
            <div className="mt-0.5 flex flex-wrap items-center gap-x-3 gap-y-0.5 text-[10px] text-muted-foreground">
              <span>时间: {formatTimeDisplay(violation.timeFs)}</span>
              <span>用例: {violation.caseName}</span>
              <span>Corner: {violation.corner ?? '默认 (未匹配)'}</span>
            </div>
          </div>
        )
      }
      accepted={isApplied}
      acceptedLabel="已应用"
      disabled={actionLoading || rejected}
      onAccept={handleConfirm}
      footerLeft={
        <>
          <button
            onClick={handleReanalyze}
            disabled={actionLoading || isApplied || rejected}
            className="flex items-center gap-0.5 rounded border border-primary/40 bg-primary/5 px-2.5 py-1 text-[10px] font-medium text-primary hover:bg-primary/10 transition-colors disabled:opacity-50"
          >
            {actionLoading ? (
              <Loader2 className="size-2.5 animate-spin" />
            ) : (
              <RefreshCw className="size-2.5" />
            )}
            重新分析
          </button>
          <button
            onClick={handleReject}
            disabled={actionLoading || isApplied || rejected}
            className={cn(
              'flex items-center gap-0.5 rounded border px-2.5 py-1 text-[10px] font-medium transition-colors disabled:opacity-50',
              rejected
                ? 'border-border bg-muted text-muted-foreground cursor-not-allowed'
                : 'border-border text-muted-foreground hover:bg-accent',
            )}
          >
            <XCircle className="size-2.5" />
            {rejected ? '已拒绝' : '拒绝'}
          </button>
        </>
      }
    />
  );
}
