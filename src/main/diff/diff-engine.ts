/**
 * Diff Engine — 计算 AI Agent 代码改动的结构化 diff。
 *
 * 核心流程：
 * 1. 读取当前文件（已含所有 AI 改动）
 * 2. 逆序撤销所有 tool call 的 newText→oldText 来重建 before 状态
 * 3. 对 before 和 after 做行级 LCS diff
 * 4. 将连续的 add/del 行分组为 hunks，关联到来源 tool call
 * 5. 检测 overwritten hunks（newText 在文件中未找到的 tool call）
 */

import { readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import type { DiffToolCall, DiffLine, DiffHunkInfo, FileDiffResult, ApplyRejectionsResult, DiffRejection } from '@shared/types';

// ─── LCS Diff ──────────────────────────────────────────────

type RawDiffLine = {
  type: 'ctx' | 'add' | 'del';
  content: string;
  oldLine?: number;
  newLine?: number;
};

function computeLcsDiff(oldText: string, newText: string): RawDiffLine[] {
  const oldLines = oldText.split('\n');
  const newLines = newText.split('\n');
  const m = oldLines.length;
  const n = newLines.length;
  const result: RawDiffLine[] = [];

  // 性能保护：超大 diff 直接全删全增
  if (m + n > 5000) {
    oldLines.forEach((line, i) => result.push({ type: 'del', content: line, oldLine: i + 1 }));
    newLines.forEach((line, i) => result.push({ type: 'add', content: line, newLine: i + 1 }));
    return result;
  }

  // LCS DP table
  const dp: number[][] = Array(m + 1).fill(null).map(() => Array(n + 1).fill(0));
  for (let i = m - 1; i >= 0; i--) {
    for (let j = n - 1; j >= 0; j--) {
      if (oldLines[i] === newLines[j]) {
        dp[i][j] = dp[i + 1][j + 1] + 1;
      } else {
        dp[i][j] = Math.max(dp[i + 1][j], dp[i][j + 1]);
      }
    }
  }

  let i = 0, j = 0, oldLn = 1, newLn = 1;
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

// ─── Before Reconstruction ─────────────────────────────────

/**
 * 从当前文件内容逆序撤销所有 tool call，重建 before 状态。
 * 返回 { beforeContent, overwrittenToolCallIds }
 * - beforeContent: 重建的原始文件内容（若全部成功撤销）
 * - overwrittenToolCallIds: newText 在文件中未找到的 tool call ID 集合
 */
function reconstructBefore(
  currentContent: string,
  toolCalls: DiffToolCall[],
): { beforeContent: string; overwrittenToolCallIds: Set<string> } {
  let content = currentContent;
  const overwritten = new Set<string>();

  // 逆序处理（最后执行的先撤销）
  const sorted = [...toolCalls].sort((a, b) => b.timestamp - a.timestamp);

  for (const tc of sorted) {
    if (tc.isNewFile) {
      // WRITE: before 状态是文件不存在（空）
      // 整个文件是新增的，before = 空
      content = '';
      continue;
    }

    // EDIT: 在当前内容中找到 newText，替换回 oldText
    if (tc.newText != null && tc.oldText != null) {
      const idx = content.indexOf(tc.newText);
      if (idx === -1) {
        // newText 未找到——被后续编辑覆盖
        overwritten.add(tc.id);
        continue;
      }
      content = content.slice(0, idx) + tc.oldText + content.slice(idx + tc.newText.length);
    }
  }

  return { beforeContent: content, overwrittenToolCallIds: overwritten };
}

// ─── Hunk Grouping ─────────────────────────────────────────

/**
 * 将 RawDiffLine 数组按连续 add/del 行分组为 hunks。
 * 每个 hunk 关联到其来源 tool call。
 *
 * 策略：先按 tool call 的 oldText/newText 在 diff 中定位 hunk 归属。
 * 如果无法精确归属（多个 tool call 改动相同区域），按位置近似归属。
 */
function groupHunks(
  diffLines: RawDiffLine[],
  toolCalls: DiffToolCall[],
  overwrittenToolCallIds: Set<string>,
): { lines: DiffLine[]; hunks: DiffHunkInfo[] } {
  // 找出所有 add/del 连续段的边界
  type Segment = { start: number; end: number; addCount: number; delCount: number };
  const segments: Segment[] = [];
  let segStart = -1;
  let addCount = 0;
  let delCount = 0;

  for (let i = 0; i < diffLines.length; i++) {
    const line = diffLines[i];
    if (line.type === 'add' || line.type === 'del') {
      if (segStart === -1) {
        segStart = i;
        addCount = 0;
        delCount = 0;
      }
      if (line.type === 'add') addCount++;
      else delCount++;
    } else {
      // ctx 行——如果之前有 segment，结束它
      if (segStart !== -1) {
        segments.push({ start: segStart, end: i, addCount, delCount });
        segStart = -1;
      }
    }
  }
  // 处理末尾 segment
  if (segStart !== -1) {
    segments.push({ start: segStart, end: diffLines.length, addCount, delCount });
  }

  // 为每个 segment 关联 tool call
  // 策略：如果只有一个 tool call，直接关联
  // 如果多个，按 newText 在 diff add 行中匹配
  const lines: DiffLine[] = diffLines.map((l) => ({
    type: l.type,
    content: l.content,
    oldLine: l.oldLine,
    newLine: l.newLine,
  }));

  const hunks: DiffHunkInfo[] = [];
  let hunkId = 0;

  for (const seg of segments) {
    hunkId++;
    const segAddContent = lines
      .slice(seg.start, seg.end)
      .filter((l) => l.type === 'add')
      .map((l) => l.content)
      .join('\n');

    // 尝试匹配 tool call
    let matchedTc: DiffToolCall | undefined;
    if (toolCalls.length === 1) {
      matchedTc = toolCalls[0];
    } else {
      // 按 newText 匹配
      matchedTc = toolCalls.find((tc) => {
        if (tc.isNewFile) return false;
        if (!tc.newText) return false;
        return tc.newText.includes(segAddContent) || segAddContent.includes(tc.newText.trim());
      });
      // 如果没匹配到，用位置近似（按时间排序的第 N 个）
      if (!matchedTc) {
        matchedTc = toolCalls[hunkId - 1] ?? toolCalls[0];
      }
    }

    // WRITE 文件：整个文件就是一个 hunk
    const isOverwritten = matchedTc ? overwrittenToolCallIds.has(matchedTc.id) : false;

    // 设置 hunk 信息
    hunks.push({
      id: hunkId,
      toolCallId: matchedTc?.id ?? '',
      toolName: matchedTc?.toolName ?? 'edit',
      overwritten: isOverwritten,
      startLineIndex: seg.start,
      endLineIndex: seg.end,
      addCount: seg.addCount,
      delCount: seg.delCount,
    });

    // 为 diff 行标注 hunkId
    for (let i = seg.start; i < seg.end; i++) {
      lines[i].hunkId = hunkId;
    }
  }

  return { lines, hunks };
}

// ─── Public API ────────────────────────────────────────────

/**
 * 计算指定文件的完整 diff（before vs after）。
 *
 * @param filePath 文件绝对路径
 * @param toolCalls 该文件的所有 tool call（按时间正序）
 * @returns 结构化 diff 结果
 */
export async function getFileDiff(
  filePath: string,
  toolCalls: DiffToolCall[],
): Promise<FileDiffResult> {
  const isNewFile = toolCalls.some((tc) => tc.isNewFile);

  // 读取当前文件内容（已含所有 AI 改动）
  let currentContent = '';
  if (existsSync(filePath)) {
    currentContent = await readFile(filePath, 'utf-8');
  }

  // 重建 before
  const { beforeContent, overwrittenToolCallIds } = reconstructBefore(
    currentContent,
    toolCalls,
  );

  // 计算行级 diff
  const rawDiff = computeLcsDiff(beforeContent, currentContent);

  // 分组 hunks
  const { lines, hunks } = groupHunks(rawDiff, toolCalls, overwrittenToolCallIds);

  const totalAdd = lines.filter((l) => l.type === 'add').length;
  const totalDel = lines.filter((l) => l.type === 'del').length;

  return {
    filePath,
    isNewFile,
    lines,
    hunks,
    totalAdd,
    totalDel,
  };
}

/**
 * 应用拒绝列表：将拒绝的 hunks 撤销（newText→oldText 或删除文件）。
 *
 * @param filePath 文件绝对路径
 * @param rejections 拒绝项列表
 * @returns 应用结果
 */
export async function applyRejections(
  filePath: string,
  rejections: DiffRejection[],
): Promise<ApplyRejectionsResult> {
  const { writeFile, unlink } = await import('node:fs/promises');
  const failures: Array<{ hunkId: number; reason: string }> = [];
  let appliedCount = 0;

  // 处理删除文件（WRITE 拒绝）
  const deleteRejections = rejections.filter((r) => r.deleteFile);
  if (deleteRejections.length > 0) {
    try {
      if (existsSync(filePath)) {
        await unlink(filePath);
        appliedCount += deleteRejections.length;
      }
    } catch {
      deleteRejections.forEach((r) => failures.push({ hunkId: r.hunkId, reason: '删除文件失败' }));
    }
    return { ok: failures.length === 0, appliedCount, failures };
  }

  // 处理 EDIT 拒绝：逆序撤销 newText→oldText
  if (!existsSync(filePath)) {
    return {
      ok: false,
      appliedCount: 0,
      failures: rejections.map((r) => ({ hunkId: r.hunkId, reason: '文件不存在' })),
    };
  }

  let content = await readFile(filePath, 'utf-8');

  // 逆序处理（最后执行的先撤销）
  const sorted = [...rejections].sort((a, b) => {
    // 按 hunkId 逆序（假设 hunkId 大 = 后执行）
    return b.hunkId - a.hunkId;
  });

  for (const rej of sorted) {
    if (!rej.newText || !rej.oldText) {
      failures.push({ hunkId: rej.hunkId, reason: '缺少 oldText/newText' });
      continue;
    }
    const idx = content.indexOf(rej.newText);
    if (idx === -1) {
      failures.push({ hunkId: rej.hunkId, reason: 'newText 在文件中未找到（可能已被覆盖）' });
      continue;
    }
    content = content.slice(0, idx) + rej.oldText + content.slice(idx + rej.newText.length);
    appliedCount++;
  }

  // 写回文件
  if (appliedCount > 0) {
    await writeFile(filePath, content, 'utf-8');
  }

  return { ok: failures.length === 0, appliedCount, failures };
}
