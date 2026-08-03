/**
 * TVAutoConfirmDialog — 自动确认对话框
 *
 * 用户输入复位时间（纳秒）和/或复位区间（起止时间），
 * 平台自动确认符合条件的 pending 违例。
 * 支持同时使用复位时间和复位区间条件（OR 关系）。
 */

import { useState } from 'react';
import { X, Loader2, Zap } from 'lucide-react';
import { cn } from '@renderer/lib/utils';

type AutoConfirmDialogProps = {
  open: boolean;
  confirming: boolean;
  defaultResetTimeNs?: number;
  onSubmit: (opts: { resetTimeNs?: number; intervalStartNs?: number; intervalEndNs?: number }) => void;
  onClose: () => void;
};

export function TVAutoConfirmDialog({
  open,
  confirming,
  defaultResetTimeNs,
  onSubmit,
  onClose,
}: AutoConfirmDialogProps) {
  const [useResetTime, setUseResetTime] = useState(true);
  const [useInterval, setUseInterval] = useState(false);
  const [resetTimeNs, setResetTimeNs] = useState(
    defaultResetTimeNs !== undefined ? String(defaultResetTimeNs) : '1000',
  );
  const [intervalStartNs, setIntervalStartNs] = useState('');
  const [intervalEndNs, setIntervalEndNs] = useState('');

  if (!open) return null;

  const canSubmit = () => {
    if (confirming) return false;
    if (useResetTime && resetTimeNs && parseFloat(resetTimeNs) >= 0) return true;
    if (useInterval && intervalStartNs && intervalEndNs
      && parseFloat(intervalStartNs) >= 0 && parseFloat(intervalEndNs) >= 0) return true;
    return false;
  };

  const handleSubmit = () => {
    const opts: { resetTimeNs?: number; intervalStartNs?: number; intervalEndNs?: number } = {};
    if (useResetTime && resetTimeNs) {
      opts.resetTimeNs = parseFloat(resetTimeNs);
    }
    if (useInterval && intervalStartNs && intervalEndNs) {
      opts.intervalStartNs = parseFloat(intervalStartNs);
      opts.intervalEndNs = parseFloat(intervalEndNs);
    }
    onSubmit(opts);
  };

  const inputClass =
    'w-full rounded-md border border-border bg-background px-3 py-1.5 text-xs text-foreground focus:outline-none focus:ring-1 focus:ring-primary';

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50" onClick={onClose}>
      <div
        className="w-[440px] max-w-[90vw] rounded-lg border border-border bg-background shadow-lg"
        onClick={(e) => e.stopPropagation()}
      >
        {/* Header */}
        <div className="flex items-center justify-between border-b px-4 py-3">
          <h3 className="flex items-center gap-2 text-sm font-semibold text-foreground">
            <Zap className="h-4 w-4 text-amber-500" />
            自动确认
          </h3>
          <button onClick={onClose} className="text-muted-foreground hover:text-foreground">
            <X className="h-4 w-4" />
          </button>
        </div>

        {/* Body */}
        <div className="space-y-3 px-4 py-3">
          <p className="text-[11px] text-muted-foreground">
            自动确认符合条件的待确认违例。确认记录标记为"系统自动"。
          </p>

          {/* 复位时间 */}
          <div className="space-y-1.5">
            <label className="flex items-center gap-2 text-xs font-medium text-foreground">
              <input
                type="checkbox"
                checked={useResetTime}
                onChange={(e) => setUseResetTime(e.target.checked)}
                className="h-3.5 w-3.5"
              />
              复位时间（纳秒）
            </label>
            {useResetTime && (
              <div className="pl-5">
                <input
                  type="number"
                  value={resetTimeNs}
                  onChange={(e) => setResetTimeNs(e.target.value)}
                  placeholder="如 1000"
                  className={inputClass}
                  min="0"
                  step="any"
                />
                <p className="mt-1 text-[10px] text-muted-foreground">
                  确认 time ≤ {resetTimeNs || '?'} ns 的违例
                </p>
              </div>
            )}
          </div>

          {/* 复位区间 */}
          <div className="space-y-1.5">
            <label className="flex items-center gap-2 text-xs font-medium text-foreground">
              <input
                type="checkbox"
                checked={useInterval}
                onChange={(e) => setUseInterval(e.target.checked)}
                className="h-3.5 w-3.5"
              />
              复位区间（纳秒）
            </label>
            {useInterval && (
              <div className="pl-5 flex items-center gap-2">
                <input
                  type="number"
                  value={intervalStartNs}
                  onChange={(e) => setIntervalStartNs(e.target.value)}
                  placeholder="起始"
                  className={inputClass}
                  min="0"
                  step="any"
                />
                <span className="text-xs text-muted-foreground">~</span>
                <input
                  type="number"
                  value={intervalEndNs}
                  onChange={(e) => setIntervalEndNs(e.target.value)}
                  placeholder="结束"
                  className={inputClass}
                  min="0"
                  step="any"
                />
              </div>
            )}
          </div>

          {useResetTime && useInterval && (
            <p className="text-[10px] text-amber-600 dark:text-amber-400">
              两个条件为 OR 关系：满足任一条件的违例都会被确认
            </p>
          )}
        </div>

        {/* Footer */}
        <div className="flex items-center justify-end gap-2 border-t px-4 py-3">
          <button
            onClick={onClose}
            disabled={confirming}
            className="rounded-md border border-border px-3 py-1.5 text-xs font-medium text-muted-foreground hover:bg-accent hover:text-foreground"
          >
            取消
          </button>
          <button
            onClick={handleSubmit}
            disabled={!canSubmit()}
            className={cn(
              'flex items-center gap-1.5 rounded-md bg-primary px-3 py-1.5 text-xs font-medium text-primary-foreground transition-colors',
              'hover:bg-primary/90',
              (!canSubmit()) && 'opacity-50 cursor-not-allowed',
            )}
          >
            {confirming && <Loader2 className="h-3 w-3 animate-spin" />}
            自动确认
          </button>
        </div>
      </div>
    </div>
  );
}
