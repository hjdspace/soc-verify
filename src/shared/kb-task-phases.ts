/**
 * 任务阶段分类（spec §5；issue 10 引入 blocked）—— 主进程队列与渲染端**共用同一份规则**。
 *
 * 为什么单独成文件：`done/failed/cancelled/blocked` 的停机判定、可重试判定与
 * 「进行中」判定同时被队列调度（主进程）和任务面板（渲染端）消费；分散在两处
 * 写同一组 `!== 'x'` 判断会随新阶段漂移（issue 10 加 blocked 时已经出现三处）。
 * 这里保持 `@shared/kb-types` 仅含类型，把运行时规则集中在本模块。
 */

import type { WikiIngestPhase } from './kb-types';

/**
 * 停机阶段：不再参与调度、不因重启自动恢复。
 * - done/failed/cancelled：常规终态；
 * - blocked：预算/配置不足（spec §5），等待用户动作，**可重试**但不自动重跑。
 */
export const STOPPED_PHASES: ReadonlySet<WikiIngestPhase> = new Set<WikiIngestPhase>([
  'done',
  'failed',
  'cancelled',
  'blocked',
]);

/** 可重试阶段：failed/cancelled 常规重试；blocked 在用户补齐预算/配置后继续 */
export const RETRYABLE_PHASES: ReadonlySet<WikiIngestPhase> = new Set<WikiIngestPhase>([
  'failed',
  'cancelled',
  'blocked',
]);

/** 是否为停机阶段（不再调度） */
export function isStoppedPhase(phase: WikiIngestPhase): boolean {
  return STOPPED_PHASES.has(phase);
}

/** 是否可重试（新 attempt；已完成的分段/转换产物可复用） */
export function isRetryablePhase(phase: WikiIngestPhase): boolean {
  return RETRYABLE_PHASES.has(phase);
}

/** 是否为「进行中」（面板计数用：非停机即进行中） */
export function isActivePhase(phase: WikiIngestPhase): boolean {
  return !STOPPED_PHASES.has(phase);
}
