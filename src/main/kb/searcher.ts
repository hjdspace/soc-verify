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
 *  - 再对 docs/ Markdown 全文匹配（正文命中得分较低）
 *  - 合并去重，按得分降序排列
 *  - 限量返回（默认前 20 条）
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
};

/** 搜索选项 */
export type SearchOptions = {
  /** 最大返回条数（默认 20） */
  limit?: number;
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
/** 全文命中得分（每次出现） */
const SCORE_FULLTEXT = 1;

// ── 辅助函数 ────────────────────────────────────────────────────

/**
 * 将查询字符串拆分为搜索词（按空格分词，中文按字分词）。
 * 返回去重后的搜索词列表（小写）。
 */
function tokenize(query: string): string[] {
  const lower = query.toLowerCase().trim();
  if (!lower) return [];

  // 按空格/标点分词
  const tokens = lower.split(/[\s,，、;；|/]+/).filter(Boolean);

  // 如果分词后只有一项且包含中文，额外按单字拆分
  const result = new Set<string>();
  for (const token of tokens) {
    result.add(token);
    // 对中文部分按单字拆分（每个中文字符单独作为一个搜索词）
    const chineseChars = token.match(/[\u4e00-\u9fa5]/g);
    if (chineseChars && chineseChars.length > 1) {
      for (const ch of chineseChars) {
        result.add(ch);
      }
    }
  }

  return Array.from(result);
}

/**
 * 计算字符串中搜索词的命中次数。
 */
function countMatches(text: string, tokens: string[]): number {
  const lower = text.toLowerCase();
  let count = 0;
  for (const token of tokens) {
    if (!token) continue;
    let idx = lower.indexOf(token);
    while (idx >= 0) {
      count++;
      idx = lower.indexOf(token, idx + token.length);
    }
  }
  return count;
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
): Promise<SearchResult[]> {
  const tokens = tokenize(query);
  if (tokens.length === 0) return [];

  const mdFiles = await scanMarkdownFiles(docsDir, docsDir);
  const results: SearchResult[] = [];

  for (const mdFile of mdFiles) {
    const relPath = relative(docsDir, mdFile).replace(/\\/g, '/');

    try {
      const content = await readFile(mdFile, 'utf-8');
      const matches = countMatches(content, tokens);

      if (matches > 0) {
        const existing = indexResults.get(relPath);
        if (existing) {
          // 已在 index 匹配中，追加全文得分
          existing.score += matches * SCORE_FULLTEXT;
          existing.matchedBy = 'both';
        } else {
          // 仅全文匹配
          // 从文件名提取标题
          const fileName = relPath.split('/').pop() ?? relPath;
          const title = fileName.replace(/\.md$/, '');

          results.push({
            title,
            path: relPath,
            category: relPath.includes('/') ? relPath.split('/')[0] : '',
            summary: '',
            keywords: [],
            score: matches * SCORE_FULLTEXT,
            matchedBy: 'fulltext',
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
  const layout = kbLayout(kbPath);

  // 1. 解析 index.md 条目
  let entries: IndexEntry[] = [];
  if (existsSync(layout.indexMdPath)) {
    const content = await readFile(layout.indexMdPath, 'utf-8');
    const parsed = parseIndexMd(content);
    entries = parsed.entries;
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

  // 3. 全文搜索
  const fulltextResults = await searchInFullText(layout.docsDir, query, indexMap);

  // 全文阶段可能更新了 indexMap 中的得分，也可能新增了结果
  for (const r of fulltextResults) {
    if (!indexMap.has(r.path)) {
      allResults.push(r);
    }
  }

  // 4. 排序 + 限量
  allResults.sort((a, b) => b.score - a.score);
  return allResults.slice(0, limit);
}
