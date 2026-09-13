/**
 * 长来源分段编译（issue 10，spec §4）— 原子证据分段 + 覆盖清单。
 *
 * spec §4：
 *  - 「来源全文在预算内时输出简洁结构化分析；超预算则按章节分段、分析各段并
 *    保存 checkpoint，再归并分析」；
 *  - 「表格与围栏为**原子证据**；过大时编译可以按行分批并重复表头/保留行号，
 *    或按代码行窗口保留完整原文定位，输出清单必须证明所有行处理过；不能用
 *    普通字符切片假装语义分块」；
 *  - 「若配置预算不足以放最小原子证据，进入可操作的 contextBudgetExceeded，
 *    不能截掉参数表后继续」。
 *
 * 本模块只做**确定性**工作：按结构切分、按行窗口分批、产出可核对的覆盖清单。
 * 它不调用模型、不写盘；模型调用与 checkpoint 见 compile.ts / long-source-checkpoint.ts。
 *
 * 与 embedding 分块的边界（F09）：本模块为**编译分段**，目标是覆盖全文并保留
 * 证据；embedding 的 chunk 契约（R10）用于召回，两者不共用实现。
 */

import {
  estimateTokens,
  chunkTargetTokens,
  chunkOverlapTokens,
  chunkDigestReserveTokens,
  MIN_ATOMIC_EVIDENCE_TOKENS,
  MIN_CHUNK_TOKENS,
} from './token-budget';

/** 句子/分句边界（切分与重叠都只落在这些边界后） */
const SENTENCE_BOUNDARY_RE = /(?<=[。！？；.!?;])\s*/;

// ── 类型 ────────────────────────────────────────────────────────

export type SourceSliceKind = 'heading' | 'prose' | 'table' | 'code';

/** 送入模型的原子证据切片（表格/代码的最小不可分单元或行窗口） */
export type SourceSlice = {
  kind: SourceSliceKind;
  /** 切片覆盖的源文档行号（1-based 闭区间；含窗口注解对应的原文行） */
  startLine: number;
  endLine: number;
  /** 切片正文。超大表格/代码的行窗口含应用注解行（`<!-- … -->`），原文行逐字保留 */
  text: string;
  /** 该切片生效的章节路径（标题栈，`>` 连接） */
  headingPath: string;
  /** 是否为超大原子块（表格/代码）按行窗口分批的产物 */
  windowed: boolean;
  /** 窗口内重复保留的表头行号（表格窗口；非表格为空数组） */
  repeatedHeaderLines: number[];
};

export type SourceChunk = {
  index: number;
  total: number;
  /** 段首生效的章节路径 */
  headingPath: string;
  startLine: number;
  endLine: number;
  /** 本段正文的 token 估算 */
  estimatedTokens: number;
  slices: SourceSlice[];
  /** 上一段末尾的重叠上下文（段落/句子边界内）。仅作上下文，不进覆盖清单 */
  overlapText: string;
  /** 本段正文（切片按序拼接） */
  text: string;
};

/** 覆盖清单：证明所有行与章节都被处理（不是「读了前若干字符」） */
export type SourceCoverage = {
  totalLines: number;
  coveredLines: number;
  /** 未被任何切片覆盖的源行（必须为空；非空即证明分段有遗漏） */
  uncoveredLines: number[];
  /** 全文章节（标题栈路径，按出现顺序） */
  sections: string[];
  /** 实际送入模型的章节（应等于 sections） */
  coveredSections: string[];
  tableBlocks: number;
  codeBlocks: number;
  tableRowLines: number;
  coveredTableRowLines: number;
  codeLines: number;
  coveredCodeLines: number;
  /** 按行窗口分批的表格 / 代码块数量 */
  windowedTables: number;
  windowedCodeBlocks: number;
  /** 超大 prose 按句/行边界分片产生的切片数（非字符切片的说明性计数） */
  splitProseSlices: number;
};

export type LongSourceSplit = {
  chunks: SourceChunk[];
  coverage: SourceCoverage;
  /** 最小原子证据（表头 + 1 行 / 单行代码窗口）的最大 token 估算 */
  largestMinimalAtomicTokens: number;
  /** 触发该上界的证据位置（可读；无则为 null） */
  largestMinimalAtomicAt: string | null;
};

export type LongSourcePlan =
  | { mode: 'single'; sourceTokens: number }
  | {
      mode: 'chunked';
      sourceTokens: number;
      chunks: SourceChunk[];
      coverage: SourceCoverage;
      /** 单段目标 token */
      targetTokens: number;
      /** 段间重叠上下文 token */
      overlapTokens: number;
      /** 每次调用中累计摘要可占用的 token（提示词据此裁剪，超出即告警） */
      digestTokens: number;
    }
  | { mode: 'blocked'; sourceTokens: number; reason: string };

// ── 行级解析 ────────────────────────────────────────────────────

const FENCE_RE = /^(\s{0,3})(`{3,}|~{3,})\s*([^\s`]*)/;
const HEADING_RE = /^(#{1,6})\s+(.+?)\s*$/;

/** 行窗口注解（`<!-- … -->`）占用的 token 预留，保证窗口不超硬上限 */
const WINDOW_ANNOTATION_RESERVE_TOKENS = 40;

function normalizeNewlines(text: string): string {
  return text.replace(/\r\n?/g, '\n');
}

function isTableSeparator(line: string): boolean {
  const t = line.trim();
  return t.length > 0 && t.includes('|') && t.includes('-') && /^[\s|:-]+$/.test(t);
}

function isTableRow(line: string): boolean {
  const t = line.trim();
  return t.length > 0 && t.includes('|') && !FENCE_RE.test(line);
}

type RawBlock = {
  kind: SourceSliceKind;
  startLine: number;
  endLine: number;
  lines: string[];
  headingPath: string;
  /** 表格：表头行号（含分隔行） */
  tableHeaderLines: number[];
  /** 表格：数据行行号 */
  tableRowLines: number[];
  /** 代码：围栏语言标记与开合行号 */
  fenceLang: string;
  fenceOpenLine: number | null;
  fenceCloseLine: number | null;
  /** 代码：正文（围栏内）行号 */
  codeBodyLines: number[];
};

type LineKind = 'table-header' | 'table-separator' | 'table-row' | 'code' | 'code-fence';

/**
 * 把来源切成连续、互不重叠、覆盖全部行的结构块。
 * 空行并入前一块（文档开头无前块时并入第一块），因此块范围构成对 1..N 的划分。
 */
function blockify(content: string): { blocks: RawBlock[]; lines: string[]; lineKinds: Map<number, LineKind> } {
  const lines = normalizeNewlines(content).split('\n');
  const lineKinds = new Map<number, LineKind>();
  const blocks: RawBlock[] = [];
  const headingStack: string[] = [];
  const headingPath = (): string => headingStack.filter(Boolean).join(' > ');

  const make = (kind: SourceSliceKind, from: number, to: number): RawBlock => ({
    kind,
    startLine: from + 1,
    endLine: to + 1,
    lines: lines.slice(from, to + 1),
    headingPath: headingPath(),
    tableHeaderLines: [],
    tableRowLines: [],
    fenceLang: '',
    fenceOpenLine: null,
    fenceCloseLine: null,
    codeBodyLines: [],
  });

  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    const blank = line.trim() === '';

    // 围栏代码块（跨行原子）
    const fence = FENCE_RE.exec(line);
    if (fence) {
      const marker = fence[2][0];
      const minLen = fence[2].length;
      let j = i + 1;
      let close = -1;
      while (j < lines.length) {
        const m = FENCE_RE.exec(lines[j]);
        if (m && m[2][0] === marker && m[2].length >= minLen && m[3] === '') {
          close = j;
          break;
        }
        j += 1;
      }
      const block = make('code', i, close >= 0 ? close : lines.length - 1);
      block.fenceLang = fence[3] ?? '';
      block.fenceOpenLine = i + 1;
      block.fenceCloseLine = close >= 0 ? close + 1 : null;
      for (let k = i + 1; k < (close >= 0 ? close : lines.length); k += 1) {
        block.codeBodyLines.push(k + 1);
        lineKinds.set(k + 1, 'code');
      }
      lineKinds.set(i + 1, 'code-fence');
      if (close >= 0) lineKinds.set(close + 1, 'code-fence');
      blocks.push(block);
      i = (close >= 0 ? close : lines.length - 1) + 1;
      continue;
    }

    // 标题
    const heading = HEADING_RE.exec(line);
    if (heading && !blank) {
      const depth = heading[1].length;
      headingStack.length = depth - 1;
      headingStack[depth - 1] = heading[2].trim();
      const block = make('heading', i, i);
      block.headingPath = headingPath();
      blocks.push(block);
      i += 1;
      continue;
    }

    // 表格（GFM，含无外侧竖线形式）
    if (!blank && isTableRow(line)) {
      let j = i;
      while (j < lines.length && (isTableRow(lines[j]) || isTableSeparator(lines[j]))) j += 1;
      const run = lines.slice(i, j);
      const sepIdx = run.findIndex((l) => isTableSeparator(l));
      const outerPipes = run.length >= 2 && run.every((l) => l.trim().startsWith('|'));
      if (sepIdx > 0 || (sepIdx < 0 && outerPipes)) {
        const headerEnd = sepIdx >= 0 ? sepIdx : 0;
        const block = make('table', i, j - 1);
        for (let k = 0; k <= headerEnd; k += 1) {
          block.tableHeaderLines.push(i + k + 1);
          lineKinds.set(i + k + 1, isTableSeparator(lines[i + k]) ? 'table-separator' : 'table-header');
        }
        for (let k = headerEnd + 1; k < run.length; k += 1) {
          if (isTableSeparator(lines[i + k])) {
            lineKinds.set(i + k + 1, 'table-separator');
            continue;
          }
          block.tableRowLines.push(i + k + 1);
          lineKinds.set(i + k + 1, 'table-row');
        }
        blocks.push(block);
        i = j;
        continue;
      }
    }

    if (blank) {
      i += 1;
      continue;
    }

    // 段落（连续非空行）。首行必然归本块 —— 若从上方的表格判定失败回落到此，
    // 从 i+1 开始扫描可保证每次迭代都前进（不会构造空块而死循环）。
    let j = i + 1;
    while (j < lines.length) {
      const l = lines[j];
      if (l.trim() === '') break;
      if (HEADING_RE.test(l)) break;
      if (FENCE_RE.test(l)) break;
      if (isTableRow(l)) break;
      j += 1;
    }
    blocks.push(make('prose', i, j - 1));
    i = j;
  }

  if (blocks.length === 0) {
    return { blocks, lines, lineKinds };
  }

  // 空行并入前一块（文档开头并入第一块）→ 块范围构成对 1..N 的划分
  let next = 1;
  for (const b of blocks) {
    if (b.startLine > next) b.startLine = next;
    next = b.endLine + 1;
  }
  const last = blocks[blocks.length - 1];
  if (last.endLine < lines.length) last.endLine = lines.length;
  for (const b of blocks) b.lines = lines.slice(b.startLine - 1, b.endLine);

  return { blocks, lines, lineKinds };
}

// ── 切片生成 ────────────────────────────────────────────────────

type SplitState = {
  slices: SourceSlice[];
  covered: Set<number>;
  coveredTableRows: Set<number>;
  coveredCodeLines: Set<number>;
  tables: number;
  codeBlocks: number;
  windowedTables: number;
  windowedCodeBlocks: number;
  splitProseSlices: number;
  largestMinimalAtomicTokens: number;
  largestMinimalAtomicAt: string | null;
};

function noteMinimal(state: SplitState, tokens: number, at: string): void {
  if (tokens > state.largestMinimalAtomicTokens) {
    state.largestMinimalAtomicTokens = tokens;
    state.largestMinimalAtomicAt = at;
  }
}

function pushSlice(state: SplitState, slice: SourceSlice): void {
  state.slices.push(slice);
  for (let l = slice.startLine; l <= slice.endLine; l += 1) state.covered.add(l);
}

/** 贪心按 token 上限把单元切成窗口（保持单元顺序，单元不可再分） */
function packWindows(unitTokens: number[], budget: number): Array<[number, number]> {
  const out: Array<[number, number]> = [];
  let start = 0;
  let used = 0;
  for (let i = 0; i < unitTokens.length; i += 1) {
    const t = unitTokens[i];
    if (i > start && used + t > budget) {
      out.push([start, i - 1]);
      start = i;
      used = 0;
    }
    used += t;
  }
  if (start < unitTokens.length) out.push([start, unitTokens.length - 1]);
  return out;
}

/** 单行超预算：按句/分句边界切分；单句仍超预算时按 token 上界硬切（最后手段） */
function splitSentences(text: string, maxTokens: number): string[] {
  const parts = text.split(SENTENCE_BOUNDARY_RE).filter((s) => s.length > 0);
  const out: string[] = [];
  let current = '';
  for (const part of parts) {
    if (current && estimateTokens(current + part) > maxTokens) {
      out.push(current);
      current = part;
    } else {
      current += part;
    }
  }
  if (current) out.push(current);
  const pieces = out.length > 0 ? out : [text];
  return pieces.flatMap((s) => (estimateTokens(s) <= maxTokens ? [s] : hardSplitByTokens(s, maxTokens)));
}

/** 无句读极长行的最后手段：按 token 上界硬切（覆盖清单仍标出同一源行） */
function hardSplitByTokens(text: string, maxTokens: number): string[] {
  const out: string[] = [];
  let current = '';
  for (const ch of text) {
    if (current && estimateTokens(current + ch) > maxTokens) {
      out.push(current);
      current = '';
    }
    current += ch;
  }
  if (current) out.push(current);
  return out;
}

/**
 * 超大段落：先把「单行超预算」的行按句原子化，再按 token 打包成片。
 * 片只由行/句边界构成，不使用任意字符切片；行内分片的片共享同一源行范围。
 */
function splitProseBlock(block: RawBlock, maxTokens: number): RawBlock[] {
  const atoms: Array<{ text: string; lineNo: number }> = [];
  for (let idx = 0; idx < block.lines.length; idx += 1) {
    const lineNo = block.startLine + idx;
    const text = block.lines[idx];
    if (estimateTokens(text) <= maxTokens) {
      atoms.push({ text, lineNo });
      continue;
    }
    for (const piece of splitSentences(text, maxTokens)) atoms.push({ text: piece, lineNo });
  }
  if (atoms.length === 0) return [block];

  const sizes = atoms.map((a) => Math.max(1, estimateTokens(a.text)));
  return packWindows(sizes, maxTokens).map(([a, b]) => ({
    ...block,
    startLine: atoms[a].lineNo,
    endLine: atoms[b].lineNo,
    lines: atoms.slice(a, b + 1).map((x) => x.text),
  }));
}

function sliceToChunks(slices: SourceSlice[], maxTokens: number, overlapTokens: number): SourceChunk[] {
  const groups: SourceSlice[][] = [];
  let current: SourceSlice[] = [];
  let currentText = '';
  for (const s of slices) {
    const candidate = currentText ? `${currentText}\n\n${s.text}` : s.text;
    if (current.length > 0 && estimateTokens(candidate) > maxTokens) {
      groups.push(current);
      current = [];
      currentText = '';
    }
    current.push(s);
    currentText = currentText ? `${currentText}\n\n${s.text}` : s.text;
  }
  if (current.length > 0) groups.push(current);

  const chunks = groups.map((group) => {
    const text = group.map((s) => s.text).join('\n\n');
    return {
      index: 0,
      total: groups.length,
      headingPath: group[0].headingPath,
      startLine: group[0].startLine,
      endLine: group[group.length - 1].endLine,
      estimatedTokens: estimateTokens(text),
      slices: group,
      overlapText: '',
      text,
    } satisfies SourceChunk;
  });

  return chunks.map((c, idx) => ({
    ...c,
    index: idx + 1,
    overlapText: idx > 0 ? overlapSuffix(chunks[idx - 1].text, overlapTokens) : '',
  }));
}

/** 上一段末尾的重叠上下文（在段落/句子边界切断，token 有界） */
function overlapSuffix(text: string, maxTokens: number): string {
  if (!text || maxTokens <= 0) return '';
  const paragraphs = text.split(/\n{2,}/);
  let acc = '';
  for (let i = paragraphs.length - 1; i >= 0; i -= 1) {
    const candidate = acc ? `${paragraphs[i]}\n\n${acc}` : paragraphs[i];
    if (estimateTokens(candidate) > maxTokens) break;
    acc = candidate;
  }
  if (acc) return acc;
  const sentences = text.split(SENTENCE_BOUNDARY_RE).filter((s) => s.length > 0);
  acc = '';
  for (let i = sentences.length - 1; i >= 0; i -= 1) {
    const candidate = sentences[i] + acc;
    if (acc && estimateTokens(candidate) > maxTokens) break;
    acc = candidate;
    if (estimateTokens(acc) > maxTokens) break;
  }
  if (acc) return acc.trim();
  // 兜底：按 token 上界截取尾部（重叠只是上下文，允许截断）
  let tail = '';
  for (let i = text.length - 1; i >= 0; i -= 1) {
    tail = text[i] + tail;
    if (estimateTokens(tail) > maxTokens) break;
  }
  return tail.trim();
}

/**
 * 切分来源：表格/围栏代码保持原子（过大则按行窗口分批，重复表头/保留行号），
 * 并产出覆盖清单。
 *
 * @param maxTokens 单段目标 token（窗口规模也以此为界）
 * @param overlapTokens 段间重叠上下文 token（默认按目标比例）
 * @param limitTokens 单段硬上限（可用输入预算）；窗口不会超过它
 */
export function splitLongSource(
  content: string,
  opts: { maxTokens: number; overlapTokens?: number; limitTokens?: number },
): LongSourceSplit {
  const maxTokens = Math.max(1, Math.floor(opts.maxTokens));
  const limitTokens = Math.max(1, Math.floor(opts.limitTokens ?? maxTokens));
  const overlapTokens = opts.overlapTokens ?? chunkOverlapTokens(maxTokens);
  const windowBudget = Math.min(maxTokens, limitTokens);

  const { blocks, lines, lineKinds } = blockify(content);
  const state: SplitState = {
    slices: [],
    covered: new Set<number>(),
    coveredTableRows: new Set<number>(),
    coveredCodeLines: new Set<number>(),
    tables: 0,
    codeBlocks: 0,
    windowedTables: 0,
    windowedCodeBlocks: 0,
    splitProseSlices: 0,
    largestMinimalAtomicTokens: 0,
    largestMinimalAtomicAt: null,
  };

  const sectionOrder: string[] = [];
  for (const b of blocks) {
    if (b.kind === 'heading' && !sectionOrder.includes(b.headingPath)) sectionOrder.push(b.headingPath);
  }

  for (const block of blocks) {
    if (block.kind === 'heading') {
      pushSlice(state, {
        kind: 'heading',
        startLine: block.startLine,
        endLine: block.endLine,
        text: block.lines.join('\n'),
        headingPath: block.headingPath,
        windowed: false,
        repeatedHeaderLines: [],
      });
      continue;
    }

    if (block.kind === 'table') {
      state.tables += 1;
      const whole = block.lines.join('\n');
      if (estimateTokens(whole) <= windowBudget) {
        pushSlice(state, {
          kind: 'table',
          startLine: block.startLine,
          endLine: block.endLine,
          text: whole,
          headingPath: block.headingPath,
          windowed: false,
          repeatedHeaderLines: [],
        });
        for (const l of block.tableRowLines) state.coveredTableRows.add(l);
        continue;
      }

      // 超大表格：表头 + 行窗口，窗口重复表头并标注源行号
      const headerLineNos = block.tableHeaderLines;
      const headerText = headerLineNos.map((no) => lines[no - 1]).join('\n');
      const headerTokens = estimateTokens(headerText);
      const rows = block.tableRowLines.map((no) => ({ no, text: lines[no - 1] }));
      const rowTokens = rows.map((r) => Math.max(1, estimateTokens(r.text)) + 1);
      const rowBudget = Math.max(1, windowBudget - headerTokens - WINDOW_ANNOTATION_RESERVE_TOKENS);
      const windows = packWindows(rowTokens, rowBudget);
      state.windowedTables += 1;
      noteMinimal(
        state,
        headerTokens + (rowTokens[0] ?? 1) + WINDOW_ANNOTATION_RESERVE_TOKENS,
        `表格 源行 ${block.startLine}-${block.endLine}`,
      );

      windows.forEach(([a, b], idx) => {
        const firstRow = rows[a];
        const lastRow = rows[b];
        const annotation = `<!-- 表格窗口 ${idx + 1}/${windows.length}：源行 ${firstRow.no}-${lastRow.no}`
          + `（原文行号保留；重复表头 源行 ${headerLineNos[0]}-${headerLineNos[headerLineNos.length - 1]}） -->`;
        const text = [annotation, headerText, ...rows.slice(a, b + 1).map((r) => r.text)].join('\n');
        pushSlice(state, {
          kind: 'table',
          startLine: idx === 0 ? block.startLine : firstRow.no,
          endLine: idx === windows.length - 1 ? block.endLine : lastRow.no,
          text,
          headingPath: block.headingPath,
          windowed: true,
          repeatedHeaderLines: [...headerLineNos],
        });
        for (const r of rows.slice(a, b + 1)) state.coveredTableRows.add(r.no);
      });
      continue;
    }

    if (block.kind === 'code') {
      state.codeBlocks += 1;
      const whole = block.lines.join('\n');
      if (estimateTokens(whole) <= windowBudget || block.codeBodyLines.length === 0) {
        pushSlice(state, {
          kind: 'code',
          startLine: block.startLine,
          endLine: block.endLine,
          text: whole,
          headingPath: block.headingPath,
          windowed: false,
          repeatedHeaderLines: [],
        });
        for (const l of block.codeBodyLines) state.coveredCodeLines.add(l);
        continue;
      }

      // 超大代码块：按行窗口，保留原始行号与原文（注解在围栏外）
      const body = block.codeBodyLines.map((no) => ({ no, text: lines[no - 1] }));
      const bodyTokens = body.map((b) => Math.max(1, estimateTokens(b.text)));
      const fenceOverhead = 8 + WINDOW_ANNOTATION_RESERVE_TOKENS;
      const windows = packWindows(bodyTokens, Math.max(1, windowBudget - fenceOverhead));
      state.windowedCodeBlocks += 1;
      noteMinimal(
        state,
        (bodyTokens[0] ?? 1) + fenceOverhead,
        `代码块 源行 ${block.startLine}-${block.endLine}`,
      );

      windows.forEach(([a, b], idx) => {
        const first = body[a];
        const last = body[b];
        const annotation = `<!-- 代码窗口 ${idx + 1}/${windows.length}：源行 ${first.no}-${last.no}`
          + `（原文行号保留，窗口内代码逐字未改） -->`;
        const fence = '```' + block.fenceLang;
        const text = [annotation, fence, ...body.slice(a, b + 1).map((r) => r.text), '```'].join('\n');
        pushSlice(state, {
          kind: 'code',
          startLine: idx === 0 ? block.startLine : first.no,
          endLine: idx === windows.length - 1 ? block.endLine : last.no,
          text,
          headingPath: block.headingPath,
          windowed: true,
          repeatedHeaderLines: [],
        });
        for (const r of body.slice(a, b + 1)) state.coveredCodeLines.add(r.no);
      });
      continue;
    }

    // 段落
    const pieces = estimateTokens(block.lines.join('\n')) <= maxTokens
      ? [block]
      : splitProseBlock(block, maxTokens);
    if (pieces.length > 1) state.splitProseSlices += pieces.length;
    for (const piece of pieces) {
      pushSlice(state, {
        kind: 'prose',
        startLine: piece.startLine,
        endLine: piece.endLine,
        text: piece.lines.join('\n'),
        headingPath: piece.headingPath,
        windowed: false,
        repeatedHeaderLines: [],
      });
    }
  }

  const chunks = sliceToChunks(state.slices, maxTokens, overlapTokens);

  const uncoveredLines: number[] = [];
  for (let l = 1; l <= lines.length; l += 1) {
    if (!state.covered.has(l)) uncoveredLines.push(l);
  }

  const tableRowLineNos = [...lineKinds.entries()].filter(([, k]) => k === 'table-row').map(([l]) => l);
  const codeLineNos = [...lineKinds.entries()].filter(([, k]) => k === 'code').map(([l]) => l);
  const coveredSections = [...new Set(state.slices.map((s) => s.headingPath))].filter((p) => p.length > 0);

  const coverage: SourceCoverage = {
    totalLines: lines.length,
    coveredLines: state.covered.size,
    uncoveredLines,
    sections: sectionOrder,
    coveredSections,
    tableBlocks: state.tables,
    codeBlocks: state.codeBlocks,
    tableRowLines: tableRowLineNos.length,
    coveredTableRowLines: tableRowLineNos.filter((l) => state.coveredTableRows.has(l)).length,
    codeLines: codeLineNos.length,
    coveredCodeLines: codeLineNos.filter((l) => state.coveredCodeLines.has(l)).length,
    windowedTables: state.windowedTables,
    windowedCodeBlocks: state.windowedCodeBlocks,
    splitProseSlices: state.splitProseSlices,
  };

  return {
    chunks,
    coverage,
    largestMinimalAtomicTokens: state.largestMinimalAtomicTokens,
    largestMinimalAtomicAt: state.largestMinimalAtomicAt,
  };
}

/**
 * 决定单次分析、分段分析还是 blocked。
 *
 * - 全文估算 ≤ 可用输入 → single（沿用既有两阶段单次编译）；
 * - 超预算 → chunked（按章节分段 + 覆盖清单）；
 * - 可用输入低于**最小分段预算**（放不下最小原子证据的可用区间），或最小原子窗口
 *   放不下 → blocked，**不**静默裁掉参数表后继续。
 */
export function planLongSource(
  content: string,
  opts: { availableInputTokens: number; minAtomicTokens?: number },
): LongSourcePlan {
  const sourceTokens = estimateTokens(content);
  const available = Math.max(0, opts.availableInputTokens);
  const minAtomic = opts.minAtomicTokens ?? MIN_ATOMIC_EVIDENCE_TOKENS;

  if (sourceTokens <= available) return { mode: 'single', sourceTokens };

  if (available < MIN_CHUNK_TOKENS) {
    return {
      mode: 'blocked',
      sourceTokens,
      reason: `可用输入预算 ${available} tokens 低于最小分段预算 ${MIN_CHUNK_TOKENS} tokens`
        + `（来源约 ${sourceTokens} tokens；最小原子证据下界 ${minAtomic} tokens）。`
        + `请提高模型上下文或减少规则/既有页读入后再编译；本票不会截掉参数表后继续。`,
    };
  }

  // 分段调用的输入 = 规则 + 已有知识 + 累计摘要 + 重叠上下文 + 本段原文，
  // 五项都必须落在可用输入内 —— 单段目标因此要为摘要与重叠留出余量。
  const overlapBound = chunkOverlapTokens(chunkTargetTokens(available));
  const digestTokens = chunkDigestReserveTokens(available);
  const headroom = available - digestTokens - overlapBound;
  if (headroom < MIN_CHUNK_TOKENS) {
    return {
      mode: 'blocked',
      sourceTokens,
      reason: `可用输入预算 ${available} tokens 扣掉累计摘要预留 ${digestTokens} 与重叠上下文 ${overlapBound} 后`
        + `只剩 ${Math.max(0, headroom)} tokens，低于最小分段预算 ${MIN_CHUNK_TOKENS} tokens`
        + `（来源约 ${sourceTokens} tokens）。请提高模型上下文或减少规则/既有页读入后再编译；`
        + `本步骤不会通过裁剪摘要来凑预算。`,
    };
  }

  let targetTokens = Math.min(chunkTargetTokens(available), headroom);
  const overlapTokens = chunkOverlapTokens(targetTokens);
  if (targetTokens + digestTokens + overlapTokens > available) {
    targetTokens = Math.max(1, available - digestTokens - overlapTokens);
  }
  if (targetTokens < MIN_CHUNK_TOKENS) {
    return {
      mode: 'blocked',
      sourceTokens,
      reason: `可用输入预算 ${available} tokens 无法同时容纳最小分段 ${MIN_CHUNK_TOKENS} tokens、`
        + `累计摘要 ${digestTokens} tokens 与重叠上下文 ${overlapTokens} tokens（来源约 ${sourceTokens} tokens）。`,
    };
  }

  const split = splitLongSource(content, {
    maxTokens: targetTokens,
    overlapTokens,
    limitTokens: Math.max(1, available - digestTokens - overlapTokens),
  });

  if (split.chunks.length <= 1) return { mode: 'single', sourceTokens };

  if (split.largestMinimalAtomicTokens > available) {
    return {
      mode: 'blocked',
      sourceTokens,
      reason: `最小原子证据需要 ${split.largestMinimalAtomicTokens} tokens（${split.largestMinimalAtomicAt ?? '未知位置'}），`
        + `可用输入仅 ${available} tokens — 不能按行窗口放下一行证据，请提高模型上下文后再编译。`,
    };
  }

  return {
    mode: 'chunked',
    sourceTokens,
    chunks: split.chunks,
    coverage: split.coverage,
    targetTokens,
    overlapTokens,
    digestTokens,
  };
}

// ── 覆盖清单文本 ────────────────────────────────────────────────

function summarizeList(items: readonly string[], max = 24): string {
  if (items.length <= max) return items.join('、');
  return `${items.slice(0, max).join('、')} …（共 ${items.length} 项）`;
}

/** 覆盖清单文本（写入 changeSet.warnings，让「全部处理过」可核对） */
export function formatCoverageManifest(
  plan: Extract<LongSourcePlan, { mode: 'chunked' }>,
): string {
  const { coverage, chunks, targetTokens, overlapTokens } = plan;
  const lines: string[] = [];
  lines.push('【长来源分段覆盖清单】');
  lines.push(
    `- 来源行数 ${coverage.totalLines}；已覆盖 ${coverage.coveredLines}；未覆盖 ${coverage.uncoveredLines.length}`
    + (coverage.uncoveredLines.length > 0
      ? `（${summarizeList(coverage.uncoveredLines.map(String), 20)}）`
      : ''),
  );
  lines.push(
    `- 分段 ${chunks.length} 段（目标 ≤ ${targetTokens} tokens/段，重叠 ${overlapTokens} tokens）`
    + `：全部送入模型分析并逐段保留结论`,
  );
  lines.push(
    `- 章节：覆盖 ${coverage.coveredSections.length}/${coverage.sections.length}`
    + `（${summarizeList(coverage.sections)}）`,
  );
  lines.push(
    `- 原子证据：表格 ${coverage.tableBlocks} 个（数据行 ${coverage.coveredTableRowLines}/${coverage.tableRowLines}`
    + `，其中 ${coverage.windowedTables} 个按行窗口分批并重复表头）；`
    + `代码块 ${coverage.codeBlocks} 个（代码行 ${coverage.coveredCodeLines}/${coverage.codeLines}`
    + `，其中 ${coverage.windowedCodeBlocks} 个按行窗口保留原行号）`,
  );
  const perChunk = chunks
    .map((c) => `${c.index}/${c.total} 源行 ${c.startLine}-${c.endLine}${c.headingPath ? `「${c.headingPath}」` : ''}`)
    .join('；');
  lines.push(`- 逐段：${perChunk}`);
  return lines.join('\n');
}
