/**
 * Renderer-side timing violation utilities
 *
 * formatTimeDisplay 的副本（主进程版本在 src/main/timing-violation/parser/time-utils.ts）。
 * 渲染端不能直接导入主进程模块，因此在此提供等价实现。
 */

/**
 * 将飞秒值格式化为人类可读的时间字符串。
 *
 * - >= 1,000,000 fs → 显示为 ns
 * - >= 1,000 fs → 显示为 ps
 * - < 1,000 fs → 显示为 fs
 */
export function formatTimeDisplay(timeFs: number): string {
  if (timeFs >= 1_000_000) {
    return `${(timeFs / 1_000_000).toFixed(3)} ns`;
  }
  if (timeFs >= 1_000) {
    return `${(timeFs / 1_000).toFixed(3)} ps`;
  }
  return `${timeFs} fs`;
}
