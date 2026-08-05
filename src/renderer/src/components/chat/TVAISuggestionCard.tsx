/**
 * TVAISuggestionCard — 时序违例 AI 建议可视化卡片
 *
 * 在右侧 AI 面板中渲染 TV AI 返回的 JSON 建议为结构化卡片，
 * 包含确认人、确认结果、分析理由、置信度进度条，
 * 以及确认/重新分析/拒绝三个操作按钮。
 *
 * 替代直接显示原始 JSON 文本。
 */

import { useState, useMemo, useEffect } from 'react';
import { Sparkles, Check, XCircle, Loader2, RefreshCw, CheckCheck } from 'lucide-react';
import { cn } from '@renderer/lib/utils';
import { useTimingViolationStore, type AISuggestion } from '@renderer/stores/timing-violation';
import { useProjectStore } from '@renderer/stores/project';
import { formatTimeDisplay } from '@renderer/lib/tv-utils';

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

export function TVAISuggestionCard({ content, violationId }: TVAISuggestionCardProps) {
  const projectId = useProjectStore((s) => s.currentProjectId);
  const violations = useTimingViolationStore((s) => s.violations);
  const applyAISuggestion = useTimingViolationStore((s) => s.applyAISuggestion);
  const clearAISuggestion = useTimingViolationStore((s) => s.clearAISuggestion);
  const startAISuggestion = useTimingViolationStore((s) => s.startAISuggestion);

  const [actionLoading, setActionLoading] = useState(false);
  const [applied, setApplied] = useState(false);
  const [rejected, setRejected] = useState(false);

  // 解析 AI 响应 JSON
  const suggestion = useMemo(() => parseSuggestionJson(content), [content]);

  // 当 content 变化（新的 AI 响应）时重置 applied/rejected 状态
  useEffect(() => {
    setApplied(false);
    setRejected(false);
  }, [content]);

  // 查找当前违例信息
  const violation = useMemo(
    () => violations.find((v) => v.id === violationId),
    [violations, violationId],
  );

  // 如果违例已被确认（状态为 confirmed），标记为已应用
  const isConfirmed = violation?.status === 'confirmed';
  const isApplied = applied || isConfirmed;
  // 如果无法解析为 TV 建议 JSON，返回 null（让调用方回退到普通渲染）
  if (!suggestion) return null;

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
    <div className="rounded-lg border border-primary/30 bg-primary/5 p-3">
      {/* 当前违例标识 */}
      {violation && (
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
      )}

      {/* AI 建议标题 + 置信度 */}
      <div className="mb-2 flex items-center gap-1.5">
        <Sparkles className="size-3 text-primary" />
        <span className="text-xs font-semibold text-primary">AI 分析建议</span>
        {suggestion.confidence > 0 && (
          <div className="ml-auto flex items-center gap-1">
            <span className="text-[10px] text-muted-foreground">置信度</span>
            <div className="h-1.5 w-16 overflow-hidden rounded-full bg-muted">
              <div
                className={cn(
                  'h-full rounded-full transition-all',
                  suggestion.confidence >= 0.7
                    ? 'bg-green-500'
                    : suggestion.confidence >= 0.4
                      ? 'bg-amber-500'
                      : 'bg-red-500',
                )}
                style={{ width: `${Math.round(suggestion.confidence * 100)}%` }}
              />
            </div>
            <span className="text-[10px] font-medium text-muted-foreground">
              {Math.round(suggestion.confidence * 100)}%
            </span>
          </div>
        )}
      </div>

      {/* 结构化展示 */}
      <div className="space-y-1.5">
        {suggestion.confirmer && (
          <div className="flex items-start gap-2 text-[11px]">
            <span className="shrink-0 text-muted-foreground">确认人:</span>
            <span className="text-foreground">{suggestion.confirmer}</span>
          </div>
        )}
        {suggestion.result && (
          <div className="flex items-start gap-2 text-[11px]">
            <span className="shrink-0 text-muted-foreground">确认结果:</span>
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
          </div>
        )}
        {suggestion.reason && (
          <div className="text-[11px]">
            <span className="text-muted-foreground">分析理由: </span>
            <span className="text-foreground">{suggestion.reason}</span>
          </div>
        )}
        {suggestion.analysis && (
          <div className="text-[11px]">
            <span className="text-muted-foreground">详细分析: </span>
            <span className="text-muted-foreground">{suggestion.analysis}</span>
          </div>
        )}
      </div>

      {/* 操作按钮 */}
      <div className="mt-2.5 flex items-center gap-1.5">
        {suggestion.confirmer && suggestion.result && (
          <button
            onClick={handleConfirm}
            disabled={actionLoading || isApplied || rejected}
            className={cn(
              'flex items-center gap-0.5 rounded px-2.5 py-1 text-[10px] font-medium transition-colors',
              isApplied || rejected
                ? 'bg-muted text-muted-foreground cursor-not-allowed'
                : 'bg-primary text-primary-foreground hover:bg-primary/90 disabled:opacity-50',
            )}
          >
            {isApplied ? (
              <>
                <CheckCheck className="size-2.5" />
                已应用
              </>
            ) : rejected ? (
              <>
                <XCircle className="size-2.5" />
                已拒绝
              </>
            ) : actionLoading ? (
              <Loader2 className="size-2.5 animate-spin" />
            ) : (
              <>
                <Check className="size-2.5" />
                确认并应用
              </>
            )}
          </button>
        )}
        <button
          onClick={handleReanalyze}
          disabled={actionLoading || isApplied || rejected}
          className="flex items-center gap-0.5 rounded border border-primary/40 bg-primary/5 px-2.5 py-1 text-[10px] font-medium text-primary hover:bg-primary/10 transition-colors disabled:opacity-50"
        >
          <RefreshCw className="size-2.5" />
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
          拒绝
        </button>
      </div>
    </div>
  );
}
