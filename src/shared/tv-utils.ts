/**
 * 时序违例共享工具函数
 *
 * 主进程和渲染端共同使用，避免重复实现。
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
