/**
 * Text Chunker — Markdown 分块（spec §8/§10，issue 21/22）。
 *
 * 参考 R10 (text-chunker.ts) 的设计原则但不直接复制：
 *  - 标题面包屑：每个块携带从顶层到当前 heading 的路径
 *  - 去 frontmatter：frontmatter 不参与分块
 *  - 代码块/表格为原子块：不按字符切分
 *  - oversized 原子块保留全文不截短，标记 oversize=true（issue 22：不静默截短成功）
 *  - CRLF 归一化、Unicode 安全、overlap
 *  - 原文偏移：每个块记录在 body 中的 start/end 字符偏移（issue 22）
 *
 * @see docs/prd/knowledge-base-llm-wiki-spec.md §8
 */

import type { ChunkCoverageReport, EmbeddingChunk } from '@shared/kb-types';

/** 判断行是否是围栏代码块标记 */
function fenceMarker(line: string): { marker: string; width: number } | null {
  const trimmed = line.trimStart();
  const ch = trimmed[0];
  if (ch !== '`' && ch !== '~') return null;
  let width = 0;
  for (let i = 0; i < trimmed.length; i++) {
    if (trimmed[i] === ch) width++;
    else break;
  }
  return width >= 3 ? { marker: ch, width } : null;
}

/** 解析 ATX 标题行（`# Title` → level 1, `### Sub` → level 3） */
function parseHeading(line: string): { level: number; title: string } | null {
  let hashes = 0;
  for (let i = 0; i < line.length; i++) {
    if (line[i] === '#' && i < 6) hashes++;
    else break;
  }
  if (hashes < 1 || hashes > 6) return null;
  if (line[hashes] !== ' ') return null;
  const title = line.slice(hashes + 1).trim();
  if (!title) return null;
  return { level: hashes, title };
}

/** 判断行是否是表格行（以 | 开头，或 GFM 无外侧竖线格式） */
function isTableRow(line: string): boolean {
  const trimmed = line.trim();
  if (!trimmed) return false;
  // 标准 Markdown 表格行：以 | 开头
  if (trimmed.startsWith('|')) return true;
  // GFM 无外侧竖线格式：包含 | 且看起来像表格行
  if (trimmed.includes('|')) {
    // 排除代码行
    if (trimmed.startsWith('`') || trimmed.startsWith('~')) return false;
    // 至少有一个 | 分隔
    return true;
  }
  return false;
}

/** 判断行是否是分隔行（`| --- | --- |` 或 `--- | ---`） */
function isTableSeparator(line: string): boolean {
  const trimmed = line.trim();
  if (!trimmed.includes('-')) return false;
  // 移除 | 后检查是否都是 - 和空格
  const cleaned = trimmed.replace(/\|/g, ' ').trim();
  return /^[\s-]+$/.test(cleaned) && cleaned.includes('-');
}

/** 提取并去除 frontmatter，返回 {body, bodyStart} */
function stripFrontmatter(content: string): { body: string; bodyStart: number } {
  const normalized = content.replace(/\r\n/g, '\n');
  if (!normalized.startsWith('---\n')) return { body: normalized, bodyStart: 0 };

  // 从第 4 个字符开始查找关闭的 ---
  const rest = normalized.slice(4);
  let pos = 0;
  for (const line of rest.split('\n')) {
    if (line.trim() === '---') {
      // 找到关闭 fence
      const after = rest.slice(pos + line.length + 1); // +1 for \n
      const body = after.startsWith('\n') ? after.slice(1) : after;
      // bodyStart = offset of body in normalized
      const bodyStart = 4 + pos + line.length + 1 + (after.startsWith('\n') ? 1 : 0);
      return { body, bodyStart };
    }
    pos += line.length + 1; // +1 for \n
  }
  // 没找到关闭 — 不是有效 frontmatter，返回原文
  return { body: normalized, bodyStart: 0 };
}

/** 按字符数切分长文本，带 overlap */
function splitWithOverlap(text: string, targetChars: number, overlapChars: number): string[] {
  if (text.length <= targetChars) return [text];

  const chunks: string[] = [];
  let start = 0;
  while (start < text.length) {
    const hardEnd = Math.min(start + targetChars, text.length);
    let end = hardEnd;

    if (end < text.length) {
      // 在后一半范围找句子/词边界
      const searchStart = start + Math.floor(targetChars / 2);
      for (let i = hardEnd - 1; i >= searchStart; i--) {
        const ch = text[i];
        if (/\s|[。！？.!?;；]/.test(ch)) {
          end = i + 1;
          break;
        }
      }
    }

    const piece = text.slice(start, end).trim();
    if (piece) chunks.push(piece);

    if (end >= text.length) break;
    start = Math.max(end - overlapChars, start + 1);
  }

  return chunks;
}

/** chunkMarkdown 返回类型 */
export type ChunkMarkdownResult = {
  chunks: EmbeddingChunk[];
  coverage?: ChunkCoverageReport;
};

/** chunkMarkdown 选项 */
export type ChunkMarkdownOptions = {
  /** 返回覆盖报告 */
  reportCoverage?: boolean;
};

/**
 * 将 Markdown 内容分块。
 *
 * 不带 options 时返回 EmbeddingChunk[]（向后兼容）。
 * 带 { reportCoverage: true } 时返回 { chunks, coverage }。
 *
 * @param content Markdown 全文（可含 frontmatter）
 * @param targetChars 每块目标字符数
 * @param overlapChars 块间重叠字符数
 */
export function chunkMarkdown(
  content: string,
  targetChars: number,
  overlapChars: number,
): EmbeddingChunk[];
export function chunkMarkdown(
  content: string,
  targetChars: number,
  overlapChars: number,
  options: { reportCoverage: true },
): ChunkMarkdownResult;
export function chunkMarkdown(
  content: string,
  targetChars: number,
  overlapChars: number,
  options?: ChunkMarkdownOptions,
): EmbeddingChunk[] | ChunkMarkdownResult;
export function chunkMarkdown(
  content: string,
  targetChars: number,
  overlapChars: number,
  options?: ChunkMarkdownOptions,
): EmbeddingChunk[] | ChunkMarkdownResult {
  const { body } = stripFrontmatter(content);
  if (!body.trim()) {
    if (options?.reportCoverage) {
      return {
        chunks: [],
        coverage: { totalChunks: 0, coveredChunks: 0, skippedChunks: 0, skipReasons: [] },
      };
    }
    return [];
  }

  const lines = body.split('\n');
  const chunks: EmbeddingChunk[] = [];
  const skipReasons: string[] = [];

  // Track the character offset of the start of each line in the body
  const lineOffsets: number[] = [];
  let charPos = 0;
  for (const line of lines) {
    lineOffsets.push(charPos);
    charPos += line.length + 1; // +1 for \n
  }

  const headingStack: Array<{ level: number; title: string }> = [];
  let headingPath = '';
  let section = '';
  let sectionStartOffset = 0;
  let openFence: { marker: string; width: number } | null = null;

  function flushSection(): void {
    const text = section.trim();
    if (!text) {
      section = '';
      return;
    }

    // 在 section 内进一步按原子块切分
    const pieces = splitPreservingAtomicBlocks(text, targetChars, overlapChars);
    for (const piece of pieces) {
      if (piece.trim()) {
        // Calculate offset of this piece within the body
        // piece is a substring of section (which is built from lines)
        // We need to find the piece's position in the body
        const pieceTrimmed = piece.trim();
        const pieceStartInSection = text.indexOf(pieceTrimmed);
        const pieceStartInBody = sectionStartOffset + pieceStartInSection;
        const pieceEndInBody = pieceStartInBody + pieceTrimmed.length;

        const isOversize = pieceTrimmed.length > targetChars;

        chunks.push({
          index: chunks.length,
          text: pieceTrimmed,
          headingPath,
          start: pieceStartInBody,
          end: pieceEndInBody,
          ...(isOversize ? { oversize: true } : {}),
        });

        if (isOversize) {
          skipReasons.push(
            `Chunk ${chunks.length - 1}: oversized atomic block (${pieceTrimmed.length} chars > ${targetChars} target)`,
          );
        }
      }
    }
    section = '';
  }

  section = '';
  sectionStartOffset = 0;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const lineOffset = lineOffsets[i];

    // 围栏代码块检测
    const fence = fenceMarker(line);
    if (fence) {
      if (openFence === null) {
        // 进入代码块 — 先刷新当前 section
        flushSection();
        openFence = fence;
        section = line;
        sectionStartOffset = lineOffset;
        continue;
      } else if (openFence.marker === fence.marker && fence.width >= openFence.width) {
        // 关闭代码块
        section += '\n' + line;
        openFence = null;
        // 代码块作为一个整体 section
        flushSection();
        continue;
      } else {
        // 围栏内的围栏标记 — 不处理
        section += '\n' + line;
        continue;
      }
    }

    if (openFence !== null) {
      section += '\n' + line;
      continue;
    }

    // 标题检测（仅在非代码块内）
    const heading = parseHeading(line);
    if (heading) {
      flushSection();
      // 弹出同级或更深的 heading
      while (headingStack.length > 0 && headingStack[headingStack.length - 1].level >= heading.level) {
        headingStack.pop();
      }
      headingStack.push({ level: heading.level, title: heading.title });
      headingPath = headingStack
        .map((h) => `${'#'.repeat(h.level)} ${h.title}`)
        .join(' > ');
      continue;
    }

    // 表格行检测
    if (isTableRow(line) || isTableSeparator(line)) {
      // 确保当前 section 刷掉非表格内容
      if (section.trim() && !isTableRow(section.split('\n').pop() ?? '')) {
        flushSection();
        sectionStartOffset = lineOffset;
      }
      if (!section) {
        sectionStartOffset = lineOffset;
      }
      section += (section ? '\n' : '') + line;
      continue;
    }

    // 普通行
    if (!section) {
      sectionStartOffset = lineOffset;
    }
    section += (section ? '\n' : '') + line;
  }

  // 刷新最后的 section
  flushSection();

  if (options?.reportCoverage) {
    const coveredChunks = chunks.filter((c) => !c.oversize).length;
    const skippedChunks = chunks.filter((c) => c.oversize).length;
    return {
      chunks,
      coverage: {
        totalChunks: chunks.length,
        coveredChunks,
        skippedChunks,
        skipReasons,
      },
    };
  }

  return chunks;
}

/**
 * 在 section 内按原子块（代码块/表格）切分。
 * 非原子文本按 targetChars + overlapChars 切分。
 * 超大原子块（> targetChars）保留全文不截短（issue 22）。
 */
function splitPreservingAtomicBlocks(
  text: string,
  targetChars: number,
  overlapChars: number,
): string[] {
  const lines = text.split('\n');
  const chunks: string[] = [];
  let normal: string[] = [];
  let i = 0;

  function flushNormal(): void {
    if (normal.length === 0) return;
    const joined = normal.join('\n');
    chunks.push(...splitWithOverlap(joined, targetChars, overlapChars));
    normal = [];
  }

  while (i < lines.length) {
    // 围栏代码块
    const fence = fenceMarker(lines[i]);
    if (fence) {
      flushNormal();
      const start = i;
      i++;
      while (i < lines.length) {
        const closeFence = fenceMarker(lines[i]);
        if (closeFence && closeFence.marker === fence.marker && closeFence.width >= fence.width) {
          i++;
          break;
        }
        i++;
      }
      const block = lines.slice(start, i).join('\n');
      // issue 22: 超大原子块保留全文不截短
      pushAtomicChunk(chunks, block, targetChars, overlapChars);
      continue;
    }

    // 表格块
    if (isTableRow(lines[i]) || isTableSeparator(lines[i])) {
      flushNormal();
      const start = i;
      while (i < lines.length && (isTableRow(lines[i]) || isTableSeparator(lines[i]))) {
        i++;
      }
      const block = lines.slice(start, i).join('\n');
      // issue 22: 超大原子块保留全文不截短
      pushAtomicChunk(chunks, block, targetChars, overlapChars);
      continue;
    }

    normal.push(lines[i]);
    i++;
  }

  flushNormal();

  return chunks.filter((c) => c.trim());
}

/**
 * 原子块推送（issue 22：超大原子块保留全文不截短）。
 *
 * - block ≤ targetChars：直接推送
 * - block > targetChars：保留全文不截短，标记为 oversize（由调用方处理标记）
 *   不再像 issue 21 那样按 hard limit 切分
 */
function pushAtomicChunk(
  chunks: string[],
  block: string,
  _targetChars: number,
  _overlapChars: number,
): void {
  // issue 22: 超大原子块保留全文，不截短
  // 调用方（flushSection）会根据 piece.length > targetChars 设置 oversize 标记
  chunks.push(block);
}
