/**
 * Doc Cache — doc_to_markdown 大文档落盘缓存与按需取回。
 *
 * 设计动机（ADR 0021 后续优化）：几百页 PDF 转出的 Markdown 可达数 MB，
 * 直接返回会撑爆 Agent 上下文；简单截断又有损（Agent 拿到残缺内容且
 * 无从得知缺了什么）。本模块采用「落盘 + 句柄 + 按需取回」方案：
 *  - 全文写入系统临时目录缓存（内容哈希寻址，同文档重复转换命中缓存）
 *  - doc_to_markdown 返回轻量句柄（doc_id + 分块数 + 大纲 + 预览）
 *  - Agent 通过 kb_doc_read / kb_doc_grep / kb_doc_outline 按需取回
 *
 * 上下文占用与文档大小解耦，信息零丢失。
 *
 * @see ADR 0021 — anydoc 文档知识库
 */

import { createHash } from 'node:crypto';
import { readFile, writeFile, mkdir, readdir, rm, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

// ── 常量 ─────────────────────────────────────────────────────────

/** 缓存目录（系统临时目录下，跨会话复用） */
const CACHE_DIR = join(tmpdir(), 'soc-verify-doc-cache');

/** 分块目标大小（字符）。按行边界切分，单行超长时硬切。 */
export const CHUNK_CHARS = 8_000;

/** kb_doc_read 单次返回的最大字符数（防止单次调用撑爆上下文） */
export const MAX_READ_CHARS = 50_000;

/** 缓存过期时间：7 天（访问时惰性清理） */
const CACHE_TTL_MS = 7 * 24 * 60 * 60 * 1000;

/** 大纲最多返回条数 */
const MAX_OUTLINE_ENTRIES = 200;

/** grep 最多返回匹配数 */
export const MAX_GREP_MATCHES = 50;

/** doc_id 合法格式（sha1 前 12 位 hex） */
const DOC_ID_RE = /^[a-f0-9]{12}$/;

// ── 类型 ─────────────────────────────────────────────────────────

/** 缓存写入结果（句柄元数据） */
export interface CachedDocMeta {
  docId: string;
  cachePath: string;
  sourcePath: string;
  totalChars: number;
  totalChunks: number;
  cachedAt: number;
}

/** 分块：1-based 行号区间 [startLine, endLine]，index 为 0-based 块号 */
export interface DocChunk {
  index: number;
  startLine: number;
  endLine: number;
  text: string;
}

/** Markdown 标题大纲条目 */
export interface OutlineEntry {
  /** 1-based 行号 */
  line: number;
  /** 标题级别 1-6（# 数量） */
  level: number;
  /** 标题文本（截断至 120 字符） */
  text: string;
  /** 所在分块（0-based，可直接传给 kb_doc_read） */
  chunk: number;
}

/** grep 匹配条目 */
export interface GrepMatch {
  line: number;
  chunk: number;
  /** 命中行文本（截断至 200 字符） */
  text: string;
}

export interface GrepResult {
  mode: 'regex' | 'literal';
  /** 全文命中总数（不因返回条数上限而少计） */
  totalMatches: number;
  /** 返回的匹配（最多 MAX_GREP_MATCHES 条） */
  matches: GrepMatch[];
}

// ── doc_id ───────────────────────────────────────────────────────

/** 内容哈希寻址：同文档内容得到同一 doc_id，重复转换命中缓存 */
function docIdFromContent(markdown: string): string {
  return createHash('sha1').update(markdown, 'utf-8').digest('hex').slice(0, 12);
}

// ── 分块 ─────────────────────────────────────────────────────────

/**
 * 将 Markdown 按行边界切分为固定目标大小的分块。
 *
 * 规则：累积行直到超过 CHUNK_CHARS 即成块；单行超过 CHUNK_CHARS 时
 * 硬切为多段（保证块大小上限，避免超大表格/代码行撑爆返回）。
 * 纯函数、确定性：缓存与读取两侧用同一算法，块号含义一致。
 */
export function chunkMarkdown(markdown: string): DocChunk[] {
  const lines = markdown.split('\n');
  const chunks: DocChunk[] = [];
  let cur: string[] = [];
  let curLen = 0;
  let chunkStart = 1;

  const flush = (endLine: number): void => {
    if (cur.length === 0) return;
    chunks.push({ index: chunks.length, startLine: chunkStart, endLine, text: cur.join('\n') });
    cur = [];
    curLen = 0;
  };

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const lineNo = i + 1;

    if (line.length > CHUNK_CHARS) {
      flush(lineNo - 1);
      for (let off = 0; off < line.length; off += CHUNK_CHARS) {
        chunks.push({
          index: chunks.length,
          startLine: lineNo,
          endLine: lineNo,
          text: line.slice(off, off + CHUNK_CHARS),
        });
      }
      chunkStart = lineNo + 1;
      continue;
    }

    if (cur.length === 0) chunkStart = lineNo;
    cur.push(line);
    curLen += line.length + 1;
    if (curLen >= CHUNK_CHARS) flush(lineNo);
  }
  flush(lines.length);

  return chunks.length > 0 ? chunks : [{ index: 0, startLine: 1, endLine: 1, text: '' }];
}

// ── 缓存写入 / 读取 ──────────────────────────────────────────────

/**
 * 将转换后的 Markdown 全文写入缓存，返回句柄元数据。
 * 内容哈希寻址：同内容重复写入直接覆盖同一文件（幂等）。
 * 同时触发过期缓存惰性清理（fire-and-forget，不阻塞调用）。
 */
export async function cacheDocMarkdown(markdown: string, sourcePath: string): Promise<CachedDocMeta> {
  await mkdir(CACHE_DIR, { recursive: true });

  const docId = docIdFromContent(markdown);
  const cachePath = join(CACHE_DIR, `${docId}.md`);
  const metaPath = join(CACHE_DIR, `${docId}.json`);
  const cachedAt = Date.now();

  await Promise.all([
    writeFile(cachePath, markdown, 'utf-8'),
    writeFile(metaPath, JSON.stringify({ sourcePath, cachedAt, totalChars: markdown.length }), 'utf-8'),
  ]);

  void pruneExpiredCache().catch(() => undefined);

  return {
    docId,
    cachePath,
    sourcePath,
    totalChars: markdown.length,
    totalChunks: chunkMarkdown(markdown).length,
    cachedAt,
  };
}

/**
 * 读取缓存的全文。doc_id 不存在或已过期清理时返回 null。
 */
export async function readCachedDoc(docId: string): Promise<string | null> {
  if (!DOC_ID_RE.test(docId)) return null;
  try {
    return await readFile(join(CACHE_DIR, `${docId}.md`), 'utf-8');
  } catch {
    return null;
  }
}

/**
 * 惰性清理：删除修改时间超过 TTL 的缓存文件。
 * 出错静默忽略（清理失败不影响功能）。
 */
async function pruneExpiredCache(): Promise<void> {
  let entries: string[];
  try {
    entries = await readdir(CACHE_DIR);
  } catch {
    return;
  }
  const now = Date.now();
  for (const name of entries) {
    if (!name.endsWith('.md') && !name.endsWith('.json')) continue;
    try {
      const filePath = join(CACHE_DIR, name);
      const s = await stat(filePath);
      if (now - s.mtimeMs > CACHE_TTL_MS) {
        await rm(filePath, { force: true });
      }
    } catch {
      // 单个文件清理失败不影响其余
    }
  }
}

// ── 大纲 ─────────────────────────────────────────────────────────

/**
 * 提取 Markdown 标题大纲（#/##/... 行），并标注每个标题所在分块。
 * 最多返回 MAX_OUTLINE_ENTRIES 条（超大文档的目录足够导航用）。
 */
export function extractOutline(markdown: string, chunks: DocChunk[]): OutlineEntry[] {
  const lines = markdown.split('\n');

  // 行号 → 块号映射（chunk 的行区间互不重叠且有序，线性填充即可）
  const lineToChunk = new Array<number>(lines.length + 1).fill(0);
  for (const c of chunks) {
    for (let l = c.startLine; l <= c.endLine && l <= lines.length; l++) {
      lineToChunk[l] = c.index;
    }
  }

  const entries: OutlineEntry[] = [];
  for (let i = 0; i < lines.length && entries.length < MAX_OUTLINE_ENTRIES; i++) {
    const m = /^(#{1,6})\s+(.+?)\s*$/.exec(lines[i]);
    if (m) {
      entries.push({
        line: i + 1,
        level: m[1].length,
        text: m[2].slice(0, 120),
        chunk: lineToChunk[i + 1],
      });
    }
  }
  return entries;
}

// ── grep ─────────────────────────────────────────────────────────

/**
 * 在文档内检索：优先按正则表达式匹配；正则非法时退化为
 * 大小写不敏感的字面量匹配。返回命中总数（全量统计）与前
 * MAX_GREP_MATCHES 条详情（含所在分块号，可直接跳读）。
 */
export function grepDoc(markdown: string, chunks: DocChunk[], pattern: string): GrepResult {
  let re: RegExp;
  let mode: GrepResult['mode'];
  try {
    re = new RegExp(pattern, 'i');
    mode = 'regex';
  } catch {
    re = new RegExp(pattern.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i');
    mode = 'literal';
  }

  const lineToChunk = new Array<number>(0);
  const chunkOfLine = (line: number): number => {
    if (lineToChunk.length === 0) {
      const lines = markdown.split('\n');
      lineToChunk.length = lines.length + 1;
      for (const c of chunks) {
        for (let l = c.startLine; l <= c.endLine && l <= lines.length; l++) {
          lineToChunk[l] = c.index;
        }
      }
    }
    return lineToChunk[line] ?? 0;
  };

  const lines = markdown.split('\n');
  let totalMatches = 0;
  const matches: GrepMatch[] = [];

  for (let i = 0; i < lines.length; i++) {
    if (!re.test(lines[i])) continue;
    totalMatches++;
    if (matches.length < MAX_GREP_MATCHES) {
      matches.push({
        line: i + 1,
        chunk: chunkOfLine(i + 1),
        text: lines[i].trim().slice(0, 200),
      });
    }
  }

  return { mode, totalMatches, matches };
}
