/**
 * 行级 LCS diff — 主进程与渲染端共用的纯函数。
 *
 * 此前 `main/diff/diff-engine.ts`、`renderer/components/chat/tool-helpers.ts`
 * 各自实现了一份同构的 DP + 回溯；知识审阅的 before/proposed 合成又需要第三份。
 * 这里收口为单一定义，三处引用同一算法（性能保护阈值由调用方通过 `maxLines` 表达）。
 *
 * @see src/main/diff/diff-engine.ts
 * @see src/renderer/src/components/chat/tool-helpers.ts
 */

export type LcsDiffLine = {
  type: 'ctx' | 'add' | 'del';
  content: string;
  /** 原文件行号（del / ctx 行有值） */
  oldLine?: number;
  /** 新文件行号（add / ctx 行有值） */
  newLine?: number;
};

/**
 * 对两个行数组求 LCS 编辑脚本。
 *
 * `maxLines` 为性能保护：两侧行数之和超过阈值时退化为「先全删再全增」
 * （仍是有序结果，只是不追求最小脚本）。
 */
export function lcsDiff(oldLines: string[], newLines: string[], maxLines = 5000): LcsDiffLine[] {
  const m = oldLines.length;
  const n = newLines.length;
  const result: LcsDiffLine[] = [];

  const pushAll = (): LcsDiffLine[] => {
    oldLines.forEach((line, i) => result.push({ type: 'del', content: line, oldLine: i + 1 }));
    newLines.forEach((line, i) => result.push({ type: 'add', content: line, newLine: i + 1 }));
    return result;
  };
  if (m + n > maxLines) return pushAll();

  // dp[i][j] = oldLines[i..] 与 newLines[j..] 的最长公共子序列长度
  const dp: number[][] = Array(m + 1).fill(null).map(() => Array(n + 1).fill(0));
  for (let i = m - 1; i >= 0; i--) {
    for (let j = n - 1; j >= 0; j--) {
      dp[i][j] = oldLines[i] === newLines[j]
        ? dp[i + 1][j + 1] + 1
        : Math.max(dp[i + 1][j], dp[i][j + 1]);
    }
  }

  let i = 0;
  let j = 0;
  let oldLn = 1;
  let newLn = 1;
  while (i < m && j < n) {
    if (oldLines[i] === newLines[j]) {
      result.push({ type: 'ctx', content: oldLines[i], oldLine: oldLn, newLine: newLn });
      i++; j++; oldLn++; newLn++;
    } else if (dp[i + 1][j] >= dp[i][j + 1]) {
      result.push({ type: 'del', content: oldLines[i], oldLine: oldLn });
      i++; oldLn++;
    } else {
      result.push({ type: 'add', content: newLines[j], newLine: newLn });
      j++; newLn++;
    }
  }
  while (i < m) {
    result.push({ type: 'del', content: oldLines[i], oldLine: oldLn });
    i++; oldLn++;
  }
  while (j < n) {
    result.push({ type: 'add', content: newLines[j], newLine: newLn });
    j++; newLn++;
  }

  return result;
}
