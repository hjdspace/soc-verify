/**
 * KB Host Tools — doc_to_markdown + kb_doc_read/grep/outline + kb_search。
 *
 * 把文档能力暴露给 AI Agent：
 *  - doc_to_markdown(path)：按需转换任意支持格式文档。
 *    小文档（≤ INLINE_THRESHOLD_CHARS）直接返回全文；
 *    大文档全文落盘缓存（零丢失），返回轻量句柄
 *    （doc_id + 分块数 + 大纲 + 预览），上下文占用与文档大小解耦。
 *  - kb_doc_read(doc_id, chunk, count?)：按分块回读缓存全文。
 *  - kb_doc_grep(doc_id, pattern)：正则/字面量检索缓存全文，返回命中行 + 所在分块。
 *  - kb_doc_outline(doc_id)：返回缓存全文的标题大纲（含分块映射）。
 *  - kb_search(query)：跨挂载知识库检索，先匹配 index.md 条目（标题/摘要/关键词），
 *    再对 docs/ Markdown 全文匹配，返回文档路径（相对 + 绝对）、摘要与命中片段，
 *    支持按分类过滤。中文按 bigram 匹配（单字低权重兜底）。
 *
 * 工具描述写清适用场景与参数格式，Agent 能自主决策何时调用。
 *
 * @see ADR 0021 — anydoc 文档知识库
 */

import { isAbsolute, resolve } from 'node:path';
import { existsSync } from 'node:fs';
import { convertDocumentToMarkdownString } from '../../kb/converter';
import { searchKb } from '../../kb/searcher';
import { kbRegistry } from '../../kb/registry';
import {
  cacheDocMarkdown,
  readCachedDoc,
  chunkMarkdown,
  extractOutline,
  grepDoc,
  CHUNK_CHARS,
  MAX_READ_CHARS,
  MAX_GREP_MATCHES,
} from '../../kb/doc-cache';
import { TEXT, defineTool, type HostToolEntry, type ToolContext } from './shared';

// ── 辅助函数 ─────────────────────────────────────────────────────

/**
 * 获取当前挂载的知识库路径。
 * projectRoot 为会话工作目录（即项目根目录，与 context-injector 读取
 * .socverify/kb-mounts.json 的路径同源）。
 * 返回 null 表示未挂载知识库。
 */
async function getMountedKbPath(projectRoot: string): Promise<string | null> {
  try {
    const status = await kbRegistry.status(projectRoot);
    return status.mounted?.path ?? null;
  } catch {
    return null;
  }
}

/**
 * 将路径解析为绝对路径（相对于 cwd）。
 */
function resolvePath(inputPath: string, cwd: string): string {
  return isAbsolute(inputPath) ? inputPath : resolve(cwd, inputPath);
}

// ── 常量 ─────────────────────────────────────────────────────────

/**
 * doc_to_markdown 内联返回阈值（字符）。
 * ≤ 此值直接返回全文；超过则全文落盘缓存（零丢失）并返回轻量句柄，
 * Agent 通过 kb_doc_read / kb_doc_grep / kb_doc_outline 按需取回。
 */
const INLINE_THRESHOLD_CHARS = 50_000;

/** 大文档句柄中的预览字符数 */
const PREVIEW_CHARS = 600;

/** 大文档句柄中直接附带的大纲条数上限（完整大纲用 kb_doc_outline 获取） */
const HANDLE_OUTLINE_ENTRIES = 80;

// ── 工具创建 ─────────────────────────────────────────────────────

/**
 * 创建知识库相关 Host Tools。
 *
 * 依赖 ctx.cwd（会话工作目录 = 项目根目录）用于解析相对路径与
 * 查询项目挂载的知识库（运行时动态查询，无静态依赖）。
 */
export function createKbTools(ctx: ToolContext): HostToolEntry[] {
  return [
    // ─── doc_to_markdown ───────────────────────────────────

    defineTool(
      'doc_to_markdown',
      'Convert any supported document format (docx, xlsx, pptx, pdf, csv, etc.) to Markdown text. Use this when you need to read the content of a Word/PDF/Excel/PowerPoint document that is not yet in the knowledge base. The conversion is instant (local, no network). Supported formats include .docx, .xlsx, .pptx, .pdf, .csv, .html, and more. If the document is encrypted, scanned (image-only PDF without text layer), or corrupted, a structured error is returned with a readable error code. Behavior depends on document size: small documents return the full Markdown inline; large documents are cached in full on disk (nothing is lost) and a lightweight handle is returned containing doc_id, chunk count, a heading outline and a preview — then use kb_doc_read(doc_id, chunk) to read sections on demand, kb_doc_grep(doc_id, pattern) to locate keywords, and kb_doc_outline(doc_id) for the complete outline. Do not re-convert the same file: reuse the doc_id from the handle.',
      {
        type: 'object',
        properties: {
          path: {
            type: 'string',
            description: 'Document file path (absolute or relative to project root). Supported formats: .docx, .xlsx, .pptx, .pdf, .csv, .html, etc.',
          },
        },
        required: ['path'],
        additionalProperties: false,
      },
      async (args) => {
        const inputPath = typeof args.path === 'string' ? args.path : '';
        if (!inputPath) {
          return TEXT(JSON.stringify({ error: 'path is required' }));
        }

        const absPath = resolvePath(inputPath, ctx.cwd);

        if (!existsSync(absPath)) {
          return TEXT(JSON.stringify({ error: `File not found: ${absPath}` }));
        }

        const result = await convertDocumentToMarkdownString(absPath);

        if (!result.ok) {
          return TEXT(JSON.stringify({
            error: result.error.message,
            code: result.error.code,
            detail: result.error.detail,
          }));
        }

        const totalChars = result.markdown.length;

        // 小文档：直接内联返回全文（零额外往返）
        if (totalChars <= INLINE_THRESHOLD_CHARS) {
          return TEXT(JSON.stringify({
            path: absPath,
            cached: false,
            totalChars,
            markdown: result.markdown,
          }));
        }

        // 大文档：全文落盘缓存（零丢失），返回轻量句柄。
        // 上下文只装"目录 + 索引"，Agent 按需取回，占用与文档大小解耦。
        const meta = await cacheDocMarkdown(result.markdown, absPath);
        const chunks = chunkMarkdown(result.markdown);
        const outline = extractOutline(result.markdown, chunks);

        return TEXT(JSON.stringify({
          path: absPath,
          cached: true,
          docId: meta.docId,
          totalChars,
          totalChunks: meta.totalChunks,
          chunkChars: CHUNK_CHARS,
          preview: result.markdown.slice(0, PREVIEW_CHARS),
          outline: outline.slice(0, HANDLE_OUTLINE_ENTRIES),
          outlineTruncated: outline.length > HANDLE_OUTLINE_ENTRIES,
          note: `Large document (${totalChars} chars, ${meta.totalChunks} chunks). The FULL content is cached on disk — nothing is truncated. Read on demand: kb_doc_read(docId="${meta.docId}", chunk=N) to read chunk N (1-based, use count for consecutive chunks); kb_doc_grep(docId="${meta.docId}", pattern) to locate keywords by line and chunk; kb_doc_outline(docId="${meta.docId}") for the complete heading outline. Start with the outline below to locate relevant sections.`,
        }));
      },
    ),

    // ─── kb_doc_read ───────────────────────────────────────

    defineTool(
      'kb_doc_read',
      'Read one or more consecutive chunks of a large document previously converted by doc_to_markdown (returned with cached: true and a docId). Chunks are split at line boundaries, each about 8000 characters. Start from the outline in the doc_to_markdown handle or kb_doc_outline to pick the chunk you need. Returns the chunk content with its 1-based line range.',
      {
        type: 'object',
        properties: {
          doc_id: {
            type: 'string',
            description: 'The docId returned by doc_to_markdown for large documents.',
          },
          chunk: {
            type: 'number',
            description: 'Chunk number to read, 1-based (default: 1). Total chunks is in the doc_to_markdown handle.',
          },
          count: {
            type: 'number',
            description: 'Number of consecutive chunks to read starting at chunk (default: 1, capped so the response stays under 50k characters).',
          },
        },
        required: ['doc_id'],
        additionalProperties: false,
      },
      async (args) => {
        const docId = typeof args.doc_id === 'string' ? args.doc_id : '';
        if (!docId) {
          return TEXT(JSON.stringify({ error: 'doc_id is required' }));
        }

        const markdown = await readCachedDoc(docId);
        if (markdown === null) {
          return TEXT(JSON.stringify({
            error: `Unknown or expired doc_id: ${docId}. The cache may have been cleaned up — re-run doc_to_markdown on the source file to get a fresh doc_id.`,
          }));
        }

        const chunks = chunkMarkdown(markdown);
        const totalChunks = chunks.length;

        const startChunk = Math.max(1, Math.floor(typeof args.chunk === 'number' ? args.chunk : 1));
        if (startChunk > totalChunks) {
          return TEXT(JSON.stringify({
            error: `chunk ${startChunk} out of range: document has ${totalChunks} chunks`,
            docId,
            totalChunks,
          }));
        }

        // count 默认 1，上限以 MAX_READ_CHARS 为准（防止单次调用撑爆上下文）
        const requested = typeof args.count === 'number' && args.count > 0 ? Math.floor(args.count) : 1;
        const maxByChars = Math.max(1, Math.floor(MAX_READ_CHARS / CHUNK_CHARS));
        const count = Math.min(requested, maxByChars, totalChunks - startChunk + 1);

        const selected = chunks.slice(startChunk - 1, startChunk - 1 + count);
        const content = selected.map((c) => c.text).join('\n');

        return TEXT(JSON.stringify({
          docId,
          chunkStart: startChunk,
          chunkEnd: startChunk + count - 1,
          totalChunks,
          totalChars: markdown.length,
          startLine: selected[0].startLine,
          endLine: selected[selected.length - 1].endLine,
          markdown: content,
        }));
      },
    ),

    // ─── kb_doc_grep ───────────────────────────────────────

    defineTool(
      'kb_doc_grep',
      'Search a cached large document (converted by doc_to_markdown, identified by docId) for lines matching a pattern. Prefers JavaScript regex syntax; falls back to case-insensitive literal matching if the pattern is not a valid regex. Returns every match total plus up to 50 match details (line number, chunk number, line text) so you can jump straight to relevant sections with kb_doc_read. This is the fastest way to locate specific terms in a large PDF/DOCX conversion.',
      {
        type: 'object',
        properties: {
          doc_id: {
            type: 'string',
            description: 'The docId returned by doc_to_markdown for large documents.',
          },
          pattern: {
            type: 'string',
            description: 'Search pattern: a JavaScript regular expression (e.g. "带宽|Bandwidth") or plain text. Matching is case-insensitive.',
          },
          limit: {
            type: 'number',
            description: 'Maximum number of match details to return (default and cap: 50). The totalMatches field always reports the real total.',
          },
        },
        required: ['doc_id', 'pattern'],
        additionalProperties: false,
      },
      async (args) => {
        const docId = typeof args.doc_id === 'string' ? args.doc_id : '';
        const pattern = typeof args.pattern === 'string' ? args.pattern : '';
        if (!docId) {
          return TEXT(JSON.stringify({ error: 'doc_id is required' }));
        }
        if (!pattern) {
          return TEXT(JSON.stringify({ error: 'pattern is required' }));
        }

        const markdown = await readCachedDoc(docId);
        if (markdown === null) {
          return TEXT(JSON.stringify({
            error: `Unknown or expired doc_id: ${docId}. The cache may have been cleaned up — re-run doc_to_markdown on the source file to get a fresh doc_id.`,
          }));
        }

        const result = grepDoc(markdown, chunkMarkdown(markdown), pattern);
        const limit = typeof args.limit === 'number' && args.limit > 0
          ? Math.min(Math.floor(args.limit), MAX_GREP_MATCHES)
          : MAX_GREP_MATCHES;

        return TEXT(JSON.stringify({
          docId,
          pattern,
          mode: result.mode,
          totalMatches: result.totalMatches,
          matches: result.matches.slice(0, limit),
          matchesTruncated: result.totalMatches > limit,
          hint: result.totalMatches > 0
            ? 'Use kb_doc_read(docId, chunk) with the chunk numbers above to read the surrounding content.'
            : 'No matches. Try a broader pattern or check spelling.',
        }));
      },
    ),

    // ─── kb_doc_outline ────────────────────────────────────

    defineTool(
      'kb_doc_outline',
      'Return the complete heading outline (# to ###### lines) of a cached large document (converted by doc_to_markdown, identified by docId). Each entry carries its 1-based line number, heading level, text, and chunk number for kb_doc_read. Use this to navigate the document structure before reading specific chunks.',
      {
        type: 'object',
        properties: {
          doc_id: {
            type: 'string',
            description: 'The docId returned by doc_to_markdown for large documents.',
          },
        },
        required: ['doc_id'],
        additionalProperties: false,
      },
      async (args) => {
        const docId = typeof args.doc_id === 'string' ? args.doc_id : '';
        if (!docId) {
          return TEXT(JSON.stringify({ error: 'doc_id is required' }));
        }

        const markdown = await readCachedDoc(docId);
        if (markdown === null) {
          return TEXT(JSON.stringify({
            error: `Unknown or expired doc_id: ${docId}. The cache may have been cleaned up — re-run doc_to_markdown on the source file to get a fresh doc_id.`,
          }));
        }

        const chunks = chunkMarkdown(markdown);
        const outline = extractOutline(markdown, chunks);

        return TEXT(JSON.stringify({
          docId,
          totalChunks: chunks.length,
          totalChars: markdown.length,
          outlineCount: outline.length,
          outline,
          hint: outline.length === 0
            ? 'This document has no Markdown headings. Use kb_doc_grep or read chunks sequentially instead.'
            : 'Use kb_doc_read(docId, chunk) with the chunk numbers above to read each section.',
        }));
      },
    ),

    // ─── kb_search ─────────────────────────────────────────

    defineTool(
      'kb_search',
      'Search the mounted knowledge base for documents matching a query. Searches document titles, summaries, keywords (from the index), and full-text content of all Markdown files. Returns a ranked list; the path field of each result is the absolute file path of the document — use it directly with your read tool (relative paths will not resolve because the knowledge base directory usually differs from your working directory). A content snippet is included for full-text matches so you can judge relevance before reading. Use this to find relevant documents in the knowledge base before reading them. If no knowledge base is mounted, returns an error. Results are limited to 20 entries by default.',
      {
        type: 'object',
        properties: {
          query: {
            type: 'string',
            description: 'Search query. Supports multi-word queries (space-separated). Chinese queries are matched by adjacent character bigrams with low-weight single characters. Matches document titles, summaries, keywords, and full-text content.',
          },
          category: {
            type: 'string',
            description: 'Restrict the search to one category (exact category name, e.g. "协议手册"). Omit to search all categories.',
          },
          limit: {
            type: 'number',
            description: 'Maximum number of results to return (default: 20).',
          },
        },
        required: ['query'],
        additionalProperties: false,
      },
      async (args) => {
        const query = typeof args.query === 'string' ? args.query : '';
        if (!query) {
          return TEXT(JSON.stringify({ error: 'query is required' }));
        }

        const limit = typeof args.limit === 'number' && args.limit > 0 ? args.limit : undefined;
        const category = typeof args.category === 'string' && args.category.trim() ? args.category.trim() : undefined;

        const kbPath = await getMountedKbPath(ctx.cwd);
        if (!kbPath) {
          return TEXT(JSON.stringify({ error: 'No knowledge base mounted. Mount a knowledge base first.' }));
        }

        const results = await searchKb(kbPath, query, { limit, category });

        return TEXT(JSON.stringify({
          query,
          category: category ?? null,
          total: results.length,
          results: results.map((r) => ({
            title: r.title,
            // 绝对路径 — Agent 的 read 工具按会话 cwd 解析相对路径，
            // 库目录与 cwd 往往不同，相对路径会读到 "Path not found"。
            path: r.absolutePath,
            category: r.category,
            summary: r.summary,
            snippet: r.snippet ?? null,
            keywords: r.keywords,
            score: r.score,
            matchedBy: r.matchedBy,
          })),
        }));
      },
    ),
  ];
}
