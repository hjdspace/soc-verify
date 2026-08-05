/**
 * TVConfirmationDialog — 确认对话框
 *
 * 用于手动确认单条或批量确认多条违例。
 * 包含确认人、确认结果（pass/issue）、确认理由。
 * 支持将违例标记为"忽略"（ignored 状态）。
 */

import { useState, useEffect } from 'react';
import { X, Loader2 } from 'lucide-react';
import { cn } from '@renderer/lib/utils';
import type { ViolationWithConfirmation, ConfirmationStatus, ConfirmResult } from '@renderer/stores/timing-violation';

type ConfirmationDialogProps = {
  open: boolean;
  violation: ViolationWithConfirmation | null;
  batchIds: number[];
  confirming: boolean;
  onSubmit: (status: ConfirmationStatus, confirmer: string, result: ConfirmResult, reason: string) => void;
  onClose: () => void;
};

export function TVConfirmationDialog({
  open,
  violation,
  batchIds,
  confirming,
  onSubmit,
  onClose,
}: ConfirmationDialogProps) {
  const [confirmer, setConfirmer] = useState('');
  const [result, setResult] = useState<ConfirmResult>('pass');
  const [reason, setReason] = useState('');
  const [_status, setStatus] = useState<ConfirmationStatus>('confirmed');

  // 当对话框打开或违例变化时，预填充已有确认信息
  useEffect(() => {
    if (open) {
      if (violation) {
        setConfirmer(violation.confirmer ?? '');
        setResult((violation.result as ConfirmResult) ?? 'pass');
        setReason(violation.reason ?? '');
        setStatus(violation.status === 'ignored' ? 'ignored' : 'confirmed');
      } else {
        // 批量确认时重置
        setConfirmer('');
        setResult('pass');
        setReason('');
        setStatus('confirmed');
      }
    }
  }, [open, violation]);

  if (!open) return null;

  const isBatch = batchIds.length > 0;
  const title = isBatch
    ? `批量确认 ${batchIds.length} 条违例`
    : violation
      ? `确认违例 #${violation.num}`
      : '确认违例';

  const handleSubmit = (targetStatus: ConfirmationStatus) => {
    onSubmit(targetStatus, confirmer, result, reason);
  };

  const inputClass =
    'w-full rounded-md border border-border bg-background px-3 py-1.5 text-xs text-foreground focus:outline-none focus:ring-1 focus:ring-primary';

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50" onClick={confirming ? undefined : onClose}>
      <div
        className="w-[480px] max-w-[90vw] rounded-lg border border-border bg-background shadow-lg"
        onClick={(e) => e.stopPropagation()}
      >
        {/* Header */}
        <div className="flex items-center justify-between border-b px-4 py-3">
          <h3 className="text-sm font-semibold text-foreground">{title}</h3>
          <button type="button" onClick={onClose} disabled={confirming} className="text-muted-foreground hover:text-foreground disabled:opacity-40">
            <X className="h-4 w-4" />
          </button>
        </div>

        {/* Body */}
        <div className="space-y-3 px-4 py-3">
          {/* 违例信息预览（单条确认时） */}
          {violation && !isBatch && (
            <div className="rounded-md border border-border/50 bg-secondary/20 p-2 text-[11px]">
              <div className="truncate font-mono text-foreground">{violation.hier}</div>
              <div className="mt-1 truncate text-muted-foreground">{violation.checkInfo}</div>
              <div className="mt-1 text-muted-foreground">
                时间: {violation.timeDisplay} · Corner: {violation.corner ?? '—'}
              </div>
            </div>
          )}

          {/* 确认人 */}
          <div>
            <label className="mb-1 block text-[11px] font-medium text-muted-foreground">确认人</label>
            <input
              type="text"
              value={confirmer}
              onChange={(e) => setConfirmer(e.target.value)}
              placeholder="输入确认人姓名"
              className={inputClass}
              autoFocus
            />
          </div>

          {/* 确认结果 */}
          <div>
            <label className="mb-1 block text-[11px] font-medium text-muted-foreground">确认结果</label>
            <div className="flex gap-2">
              <button
                type="button"
                onClick={() => setResult('pass')}
                className={cn(
                  'flex-1 rounded-md border px-3 py-1.5 text-xs font-medium transition-colors',
                  result === 'pass'
                    ? 'border-green-500/40 bg-green-500/10 text-green-600 dark:text-green-400'
                    : 'border-border text-muted-foreground hover:bg-accent',
                )}
              >
                Pass
              </button>
              <button
                type="button"
                onClick={() => setResult('issue')}
                className={cn(
                  'flex-1 rounded-md border px-3 py-1.5 text-xs font-medium transition-colors',
                  result === 'issue'
                    ? 'border-red-500/40 bg-red-500/10 text-red-600 dark:text-red-400'
                    : 'border-border text-muted-foreground hover:bg-accent',
                )}
              >
                Issue
              </button>
            </div>
          </div>

          {/* 确认理由 */}
          <div>
            <label className="mb-1 block text-[11px] font-medium text-muted-foreground">确认理由</label>
            <textarea
              value={reason}
              onChange={(e) => setReason(e.target.value)}
              placeholder="输入确认理由..."
              rows={3}
              className={cn(inputClass, 'resize-none')}
            />
          </div>
        </div>

        {/* Footer */}
        <div className="flex items-center justify-end gap-2 border-t px-4 py-3">
          <button
            type="button"
            onClick={() => handleSubmit('ignored')}
            disabled={confirming}
            className={cn(
              'rounded-md border border-border px-3 py-1.5 text-xs font-medium text-muted-foreground transition-colors',
              'hover:bg-accent hover:text-foreground',
              confirming && 'opacity-50 cursor-not-allowed',
            )}
          >
            标记忽略
          </button>
          <button
            type="button"
            onClick={onClose}
            disabled={confirming}
            className="rounded-md border border-border px-3 py-1.5 text-xs font-medium text-muted-foreground hover:bg-accent hover:text-foreground disabled:opacity-40 disabled:cursor-not-allowed"
          >
            取消
          </button>
          <button
            type="button"
            onClick={() => handleSubmit('confirmed')}
            disabled={confirming || !confirmer.trim()}
            className={cn(
              'flex items-center gap-1.5 rounded-md bg-primary px-3 py-1.5 text-xs font-medium text-primary-foreground transition-colors',
              'hover:bg-primary/90',
              (confirming || !confirmer.trim()) && 'opacity-50 cursor-not-allowed',
            )}
          >
            {confirming && <Loader2 className="h-3 w-3 animate-spin" />}
            确认
          </button>
        </div>
      </div>
    </div>
  );
}
