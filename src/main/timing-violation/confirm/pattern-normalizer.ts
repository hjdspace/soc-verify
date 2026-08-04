/**
 * Pattern Normalizer — Check 信息标准化
 *
 * 完全复刻 Python models.py 中 `_normalize_check_info` 的模糊匹配逻辑。
 *
 * 规则：
 * 1. 括号前的内容必须完全匹配（检查类型必须相同）
 * 2. 括号内按逗号分割为三部分：
 *    - 第 1 部分：去除冒号后的时间信息，只匹配冒号前内容
 *    - 第 2 部分：同上
 *    - 第 3 部分：完全忽略
 * 3. 如果没有括号、或括号内不足三部分，返回原始信息
 *
 * 示例：
 *   setup( posedge clk: 1523423 FS, negedge data: 100 PS, margin: -50 PS)
 *   → setup( posedge clk, negedge data)
 */

/**
 * 标准化 check_info，用于模糊匹配。
 *
 * @param checkInfo 原始检查信息
 * @returns 标准化后的检查信息
 */
export function normalizeCheckInfo(checkInfo: string): string {
  // 查找括号内容
  const startIdx = checkInfo.indexOf('(');
  const endIdx = checkInfo.lastIndexOf(')');

  if (startIdx === -1 || endIdx === -1 || startIdx >= endIdx) {
    // 如果没有找到括号，返回原始信息
    return checkInfo;
  }

  // 提取括号前的部分（包含开括号），这部分必须完全匹配
  const prefix = checkInfo.slice(0, startIdx + 1);
  const bracketContent = checkInfo.slice(startIdx + 1, endIdx);

  // 按逗号分割括号内容
  const parts = bracketContent.split(',');

  if (parts.length < 3) {
    // 如果分割后少于3部分，返回原始信息
    return checkInfo;
  }

  const normalizedParts: string[] = [];

  // 处理第一部分：移除冒号后的时间信息（不 trim，保留括号后空格）
  const colonIdx1 = parts[0].indexOf(':');
  normalizedParts.push(colonIdx1 !== -1 ? parts[0].slice(0, colonIdx1) : parts[0]);

  // 处理第二部分：移除冒号后的时间信息（不 trim，保留逗号后空格）
  const colonIdx2 = parts[1].indexOf(':');
  normalizedParts.push(colonIdx2 !== -1 ? parts[1].slice(0, colonIdx2) : parts[1]);

  // 第三部分忽略，不添加到标准化结果中

  // 重新组装：prefix + normalized parts + ')'
  const normalizedBracketContent = normalizedParts.join(',');
  return prefix + normalizedBracketContent + ')';
}
