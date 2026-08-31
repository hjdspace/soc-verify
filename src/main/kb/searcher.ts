/**
 * Knowledge Base Searcher — kb_search 匹配逻辑。
 *
 * 核心职责：
 *  1. 解析 index.md 条目（标题/摘要/关键词）
 *  2. 对 docs/ Markdown 全文匹配
 *  3. 评分排序，限量返回路径 + 摘要列表
 *
 * 搜索策略：
 *  - 先匹配 index.md 条目（标题/摘要/关键词命中得分高）
 *  - 再对 docs/ Markdown 全文匹配（正文命中得分较低，附带命中片段 snippet）
 *  - 中文按相邻双字（bigram）匹配，单字保留但大幅降权（抑制单字噪音）
 *  - 合并去重，按得分降序排列
 *  - 限量返回（默认前 20 条），支持按分类过滤，结果附带绝对路径
 *
 * @see ADR 0021 — anydoc 文档知识库
 */

import { readFile, readdir } from 'node:fs/promises';
import { join, relative } from 'node:path';
import { existsSync } from 'node:fs';
import { parseIndexMd } from './indexer';
import { kbLayout } from './layout';
import type { IndexEntry } from './types';

// ── 类型定义 ──────────────────────────────────────────────────────

/** 搜索结果单条 */
export type SearchResult = {
  /** 文档标题 */
  title: string;
  /** Markdown 文件相对于 docs/ 的路径 */
  path: string;
  /** 分类名称 */
  category: string;
  /** 一句话摘要 */
  summary: string;
  /** 关键词列表 */
  keywords: string[];
  /** 匹配得分（越高越相关） */
  score: number;
  /** 匹配来源（index / fulltext） */
  matchedBy: 'index' | 'fulltext' | 'both';
  /** 全文命中片段（帮助 Agent 快速判断相关性；index 命中且正文未命中时为空） */
  snippet?: string;
  /** Markdown 文件绝对路径（由 searchKb 统一附加，Agent 可直接读取） */
  absolutePath?: string;
};

/** 搜索选项 */
export type SearchOptions = {
  /** 最大返回条数（默认 20） */
  limit?: number;
  /** 限定分类（精确匹配 index 条目的分类名 / docs/ 顶层目录名），不传则全库搜索 */
  category?: string;
};

// ── 常量 ────────────────────────────────────────────────────────

const DEFAULT_LIMIT = 20;

// ── 评分权重 ────────────────────────────────────────────────────

/** 标题命中得分 */
const SCORE_TITLE = 10;
/** 关键词命中得分（每个关键词） */
const SCORE_KEYWORD = 5;
/** 摘要命中得分 */
const SCORE_SUMMARY = 3;
/** 全文命中得分（加权命中次数，CJK 单字按权重折算） */
const SCORE_FULLTEXT = 1;
/** CJK 单字 token 的得分权重（单字命中噪音大，如"率"会命中所有含"率"字的文档） */
const SCORE_CJK_CHAR_WEIGHT = 0.2;

// ── 辅助函数 ────────────────────────────────────────────────────

/**
 * 将查询字符串拆分为搜索词（按空格/标点分词，中文按相邻双字 bigram 拆分）。
 * 返回去重后的搜索词列表（小写）。
 *
 * 中文用 bigram 而非单字：搜"复位时序"能整体/局部命中含"复位时序""时序"的文档，
 * 而纯单字方案会让任何含"序"或"时"字的文档都得高分。单字仍保留（低权重兜底，
 * 见 tokenWeight），覆盖 bigram 拆不出的场景。
 */
function tokenize(query: string): string[] {
  const lower = query.toLowerCase().trim();
  if (!lower) return [];

  // 按空格/标点分词
  const tokens = lower.split(/[\s,，、;；|/]+/).filter(Boolean);

  const result = new Set<string>();
  for (const token of tokens) {
    result.add(token);
    const chineseChars = token.match(/[\u4e00-\u9fa5]/g);
    if (chineseChars && chineseChars.length > 1) {
      // 相邻双字 bigram
      for (let i = 0; i < chineseChars.length - 1; i++) {
        result.add(chineseChars[i] + chineseChars[i + 1]);
      }
      // 单字兜底（得分时按 SCORE_CJK_CHAR_WEIGHT 降权）
      for (const ch of chineseChars) {
        result.add(ch);
      }
    }
  }

  return Array.from(result);
}

/** 单个 token 的得分权重：CJK 单字大幅降权，其余为 1 */
function tokenWeight(token: string): number {
  return token.length === 1 && /[\u4e00-\u9fa5]/.test(token) ? SCORE_CJK_CHAR_WEIGHT : 1;
}

/**
 * 计算字符串中搜索词的加权命中得分（每次命中记 1，CJK 单字按 0.2 折算）。
 */
function countMatches(text: string, tokens: string[]): number {
  const lower = text.toLowerCase();
  let score = 0;
  for (const token of tokens) {
    if (!token) continue;
    const weight = tokenWeight(token);
    let idx = lower.indexOf(token);
    while (idx >= 0) {
      score += weight;
      idx = lower.indexOf(token, idx + token.length);
    }
  }
  return score;
}

/**
 * 从全文内容中提取首个命中位置的片段（snippet）。
 * 全文命中的结果没有索引摘要可用，snippet 让 Agent 不读全文也能判断相关性。
 */
export function extractSnippet(content: string, tokens: string[], maxLen = 160): string {
  const lower = content.toLowerCase();
  let firstIdx = -1;
  let matchedLen = 0;

  for (const token of tokens) {
    if (!token) continue;
    const idx = lower.indexOf(token);
    if (idx >= 0 && (firstIdx === -1 || idx < firstIdx)) {
      firstIdx = idx;
      matchedLen = token.length;
    }
  }

  if (firstIdx < 0) return '';

  const radius = Math.max(20, Math.floor((maxLen - matchedLen) / 2));
  const start = Math.max(0, firstIdx - radius);
  const end = Math.min(content.length, firstIdx + matchedLen + radius);
  const body = content.slice(start, end).replace(/\s+/g, ' ').trim();
  return (start > 0 ? '…' : '') + body + (end < content.length ? '…' : '');
}

/**
 * 检查字符串是否包含任一搜索词。
 */
function containsAny(text: string, tokens: string[]): boolean {
  const lower = text.toLowerCase();
  return tokens.some((t) => t && lower.includes(t));
}

// ── index.md 条目匹配 ────────────────────────────────────────────

/**
 * 在 index.md 条目中搜索匹配项。
 *
 * 评分规则：
 *  - 标题命中：+10 分/次
 *  - 关键词命中：+5 分/每个匹配的关键词
 *  - 摘要命中：+3 分/次
 */
export function searchInEntries(entries: IndexEntry[], query: string): Array<SearchResult & { matchedBy: 'index' | 'both' }> {
  const tokens = tokenize(query);
  if (tokens.length === 0) return [];

  const results: Array<SearchResult & { matchedBy: 'index' | 'both' }> = [];

  for (const entry of entries) {
    let score = 0;

    // 标题匹配
    const titleMatches = countMatches(entry.title, tokens);
    score += titleMatches * SCORE_TITLE;

    // 关键词匹配
    let keywordMatches = 0;
    for (const kw of entry.keywords) {
      if (containsAny(kw, tokens)) {
        keywordMatches++;
      }
    }
    score += keywordMatches * SCORE_KEYWORD;

    // 摘要匹配
    const summaryMatches = countMatches(entry.summary, tokens);
    score += summaryMatches * SCORE_SUMMARY;

    if (score > 0) {
      results.push({
        title: entry.title,
        path: entry.path,
        category: entry.category,
        summary: entry.summary,
        keywords: entry.keywords,
        score,
        matchedBy: 'index',
      });
    }
  }

  return results;
}

// ── 全文匹配 ────────────────────────────────────────────────────

/**
 * 递归扫描目录，返回所有 .md 文件路径。
 */
async function scanMarkdownFiles(dir: string, basePath: string): Promise<string[]> {
  const results: string[] = [];
  if (!existsSync(dir)) return results;

  const entries = await readdir(dir, { withFileTypes: true });
  for (const entry of entries) {
    const fullPath = join(dir, entry.name);
    if (entry.isDirectory()) {
      // 跳过 assets 目录
      if (entry.name === 'assets') continue;
      const subResults = await scanMarkdownFiles(fullPath, basePath);
      results.push(...subResults);
    } else if (entry.isFile() && entry.name.endsWith('.md')) {
      results.push(fullPath);
    }
  }

  return results;
}

/**
 * 在 docs/ Markdown 文件中全文搜索。
 *
 * 评分规则：
 *  - 正文中每次命中搜索词：+1 分
 *
 * 已在 index.md 条目中匹配的文档，追加全文得分并标记 matchedBy: 'both'。
 */
export async function searchInFullText(
  docsDir: string,
  query: string,
  indexResults: Map<string, SearchResult>,
  categoryFilter?: string,
): Promise<SearchResult[]> {
  const tokens = tokenize(query);
  if (tokens.length === 0) return [];

  const mdFiles = await scanMarkdownFiles(docsDir, docsDir);
  const results: SearchResult[] = [];

  for (const mdFile of mdFiles) {
    const relPath = relative(docsDir, mdFile).replace(/\\/g, '/');
    const fileCategory = relPath.includes('/') ? relPath.split('/')[0] : '';
    if (categoryFilter && fileCategory !== categoryFilter) continue;

    try {
      const content = await readFile(mdFile, 'utf-8');
      const matches = countMatches(content, tokens);

      if (matches > 0) {
        const snippet = extractSnippet(content, tokens);
        const existing = indexResults.get(relPath);
        if (existing) {
          // 已在 index 匹配中，追加全文得分 + 补充命中片段
          existing.score += matches * SCORE_FULLTEXT;
          existing.matchedBy = 'both';
          existing.snippet = snippet;
        } else {
          // 仅全文匹配：从文件名提取标题，附命中片段
          const fileName = relPath.split('/').pop() ?? relPath;
          const title = fileName.replace(/\.md$/, '');

          results.push({
            title,
            path: relPath,
            category: fileCategory,
            summary: '',
            keywords: [],
            score: matches * SCORE_FULLTEXT,
            matchedBy: 'fulltext',
            snippet,
          });
        }
      }
    } catch {
      // 文件读取失败，跳过
    }
  }

  return results;
}

// ── 主搜索函数 ────────────────────────────────────────────────────

/**
 * 跨知识库搜索：先匹配 index.md 条目，再对 docs/ Markdown 全文匹配。
 *
 * @param kbPath 知识库根目录
 * @param query 搜索查询字符串
 * @param options 搜索选项
 * @returns 匹配文档路径 + 摘要列表（按得分降序，限量）
 */
export async function searchKb(
  kbPath: string,
  query: string,
  options?: SearchOptions,
): Promise<SearchResult[]> {
  const limit = options?.limit ?? DEFAULT_LIMIT;
  const category = options?.category?.trim() || undefined;
  const layout = kbLayout(kbPath);

  // 1. 解析 index.md 条目
  let entries: IndexEntry[] = [];
  if (existsSync(layout.indexMdPath)) {
    const content = await readFile(layout.indexMdPath, 'utf-8');
    const parsed = parseIndexMd(content);
    entries = parsed.entries;
  }

  // 1.5 分类过滤（精确匹配分类名）
  if (category) {
    entries = entries.filter((e) => e.category === category);
  }

  // 2. 在 index 条目中搜索
  const indexResults = searchInEntries(entries, query);

  // 构建 path → result 的 Map（用于全文阶段追加得分）
  const indexMap = new Map<string, SearchResult>();
  const allResults: SearchResult[] = [];

  for (const r of indexResults) {
    indexMap.set(r.path, r);
    allResults.push(r);
  }

  // 3. 全文搜索（同一分类过滤生效）
  const fulltextResults = await searchInFullText(layout.docsDir, query, indexMap, category);

  // 全文阶段可能更新了 indexMap 中的得分，也可能新增了结果
  for (const r of fulltextResults) {
    if (!indexMap.has(r.path)) {
      allResults.push(r);
    }
  }

  // 4. 排序 + 限量 + 附带绝对路径（Agent 可直接读取，不必自己拼 docsDir）
  allResults.sort((a, b) => b.score - a.score);
  return allResults.slice(0, limit).map((r) => ({
    ...r,
    absolutePath: join(layout.docsDir, r.path),
  }));
}
