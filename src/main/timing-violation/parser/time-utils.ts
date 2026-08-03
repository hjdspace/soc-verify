/**
 * 时间单位转换工具
 *
 * 参考 Python parser.py 中 convert_time_to_fs / convert_time_to_ns。
 *
 * 规则：
 * - FS (飞秒) → 1
 * - PS (皮秒) → ×1000
 * - NS (纳秒) → ×1000000
 * - 无单位   → 假设为飞秒 (×1)
 *
 * formatTimeDisplay 的共享实现在 @shared/tv-utils，此处重新导出以保持现有导入路径不变。
 */

export { formatTimeDisplay } from '@shared/tv-utils';

const TIME_PATTERN = /(\d+(?:\.\d+)?)\s*([A-Za-z]*)/;

const UNIT_MULTIPLIERS: Record<string, number> = {
  FS: 1,
  '': 1,
  PS: 1000,
  NS: 1000000,
};

const UNIT_DIVISORS_NS: Record<string, number> = {
  NS: 1.0,
  '': 1.0,
  PS: 1000.0,
  FS: 1000000.0,
};

/**
 * 将时间字符串转换为飞秒（整数）。
 *
 * @example
 * convertTimeToFs('1523423 FS') → 1523423
 * convertTimeToFs('100 PS') → 100000
 * convertTimeToFs('1 NS') → 1000000
 */
export function convertTimeToFs(timeStr: string): number {
  const trimmed = timeStr.toUpperCase().trim();
  const match = TIME_PATTERN.exec(trimmed);
  if (!match) return 0;

  const value = parseFloat(match[1]);
  if (!Number.isFinite(value)) return 0;

  const unit = match[2];
  const multiplier = UNIT_MULTIPLIERS[unit];
  if (multiplier !== undefined) {
    return Math.round(value * multiplier);
  }
  // 未知单位，假设为飞秒
  return Math.round(value);
}

/**
 * 将时间字符串转换为纳秒（浮点数）。
 *
 * @example
 * convertTimeToNs('1523423 FS') → 1.523423
 * convertTimeToNs('100 PS') → 0.1
 * convertTimeToNs('1 NS') → 1.0
 */
export function convertTimeToNs(timeStr: string): number {
  const trimmed = timeStr.toUpperCase().trim();
  const match = TIME_PATTERN.exec(trimmed);
  if (!match) return 0.0;

  const value = parseFloat(match[1]);
  if (!Number.isFinite(value)) return 0.0;

  const unit = match[2];
  const divisor = UNIT_DIVISORS_NS[unit];
  if (divisor !== undefined) {
    return value / divisor;
  }
  return value;
}
