import { useEffect, useState } from 'react';
import { cn } from '@renderer/lib/utils';

/**
 * AI 列逐行计算 — 开始后每 stepMs 推进一行（resolved 递增），未解析行渲染
 * CalcCell（"计算中…" + 脉动点），全部完成 done 置位（宿主落页脚统计）。
 * 摘取自 beautiful-ui RecordsTable（不整体引入）：
 * D:\AI\beautiful-ui\components\primitives\RecordsTable.tsx
 * （calc effect 约 L502–511；CalcCell L271–278）
 *
 * 参考实现以 `calc = {col, resolved}` 单状态承载多列（每列一个 calc），
 * 此处泛化为每列一个 hook 实例（col 字段由宿主实例天然区分）；推进节奏
 * setTimeout 链原样保留——每步重挂定时器，行数变化时自然顺延。
 */

/** 参考实现的逐行推进节拍 */
export const DEFAULT_STEP_MS = 110;

export type StaggeredRun = {
  /** 已解析行数（0..rowCount）：行 i 已解析 ⇔ i < resolved */
  resolved: number;
  /** 逐行推进进行中 */
  running: boolean;
  /** 本轮全部行解析完成 */
  done: boolean;
  /** 开始（或重置重跑）一轮逐行解析 */
  start: () => void;
};

/**
 * 逐行解析状态机。start() 从 0 重置推进；rowCount 为 0 或行数缩减至
 * resolved 以下时立即落定 done（不悬挂定时器）。
 */
export function useStaggeredRows(rowCount: number, stepMs: number = DEFAULT_STEP_MS): StaggeredRun {
  const [resolved, setResolved] = useState(0);
  const [running, setRunning] = useState(false);
  const [done, setDone] = useState(false);

  useEffect(() => {
    if (!running) return;
    if (resolved >= rowCount) {
      setRunning(false);
      setDone(true);
      return;
    }
    const timer = setTimeout(() => setResolved((current) => current + 1), stepMs);
    return () => clearTimeout(timer);
  }, [running, resolved, rowCount, stepMs]);

  return {
    resolved,
    running,
    done,
    start: () => {
      setResolved(0);
      setDone(false);
      setRunning(true);
    },
  };
}

type CalcCellProps = {
  /** 缺省「计算中…」 */
  label?: string;
  className?: string;
};

/** 计算中单元格：灰字 + 右缘脉动圆点（状态指示，reduced-motion 下同 animate-pulse 先例保留） */
export function CalcCell({ label = '计算中…', className }: CalcCellProps) {
  return (
    <span className={cn('ap-calc', className)}>
      <span className="ap-calc-label">{label}</span>
      <span className="ap-calc-pulse" />
    </span>
  );
}
