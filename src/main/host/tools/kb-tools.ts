/**
 * KB Host Tools — doc_to_markdown + kb_doc_read/grep/outline + kb_search + kb_read。
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
 *  - kb_read(kind, id, ...)：wiki 布局只读证据读取（issue 15，spec §8）——
 *    按 pageId/sourceId/revision/assetId 身份解析（无任意路径输入），
 *    分页返回 hash/行号/next，历史引用与原图可开，失败给结构化错误。
 *
 * 工具描述写清适用场景与参数格式，Agent 能自主决策何时调用。
 *
 * @see ADR 0021 — anydoc 文档知识库
 */

import { isAbsolute, resolve } from 'node:path';
import { existsSync } from 'node:fs';
import { convertDocumentToMarkdownString } from '../../kb/converter';
import { searchKb } from '../../kb/searcher';
import { searchWiki } from '../../kb/wiki-search';
import { readWikiEvidence } from '../../kb/wiki-read';
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
import type { KbStatus } from '@shared/kb-types';

// ── 辅助函数 ─────────────────────────────────────────────────────

/**
 * 获取当前挂载的知识库（含格式）。每次调用都动态查询注册表——
 * 项目切换/切库后旧挂载信息不再是读取授权。
 */
async function getMountedKb(projectRoot: string): Promise<KbStatus['mounted']> {
  try {
    const status = await kbRegistry.status(projectRoot);
    return status.mounted;
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
      'Search the mounted knowledge base (LLM Wiki layout) for published knowledge pages and current parsed source full-text. One merged keyword ranking over page metadata (title/summary/keywords/tags) and page/source body text; Chinese queries are matched by adjacent character bigrams (low-weight single chars), and exact tokens like AWLEN, [7:0], 0x10, tRCD are matched as-is. Returns a ranked list of hits: kind (wiki=published page, parsed=source full-text), stable id, library-relative path and runtime absolute path (use absolutePath directly with your read tool), snippet for body matches, page type/tags/source refs, and a stale flag when the page cites an outdated source revision. Optional filters: pageType (one of source/entity/concept/comparison/synthesis/query/pitfall/interface), tag (exact match), kind (wiki or parsed). topK limits results (default 20, max 50). The mounted library is re-checked on every call — results always come from the currently mounted library. If no knowledge base is mounted, returns an error.',
      {
        type: 'object',
        properties: {
          query: {
            type: 'string',
            description: 'Search query. Multi-word (space-separated) supported; Chinese matched by bigrams; tokens like [7:0] or 0x10 are matched as-is.',
          },
          pageType: {
            type: 'string',
            enum: ['source', 'entity', 'concept', 'comparison', 'synthesis', 'query', 'pitfall', 'interface'],
            description: 'Restrict hits to one wiki page type. Omit to search all types.',
          },
          tag: {
            type: 'string',
            description: 'Restrict wiki hits to pages carrying this exact tag. Omit to search all tags.',
          },
          kind: {
            type: 'string',
            enum: ['wiki', 'parsed'],
            description: "Restrict to published pages ('wiki') or source full-text ('parsed'). Omit to search both.",
          },
          topK: {
            type: 'number',
            description: 'Maximum number of results to return (default 20, range 1-50).',
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

        const topK = typeof args.topK === 'number' && args.topK > 0 ? args.topK : undefined;
        const pageType = typeof args.pageType === 'string' && args.pageType.trim() ? args.pageType.trim() : undefined;
        const tag = typeof args.tag === 'string' && args.tag.trim() ? args.tag.trim() : undefined;
        const kind = args.kind === 'wiki' || args.kind === 'parsed' ? args.kind : undefined;

        // 动态核对当前挂载：项目切换/切库后返回的必然是当前挂载库的数据；
        // 旧会话系统提示里注入的库信息不是跨库读取授权。
        const mounted = await getMountedKb(ctx.cwd);
        if (!mounted) {
          return TEXT(JSON.stringify({
            error: 'No knowledge base mounted. Mount a knowledge base first.',
            code: 'notMounted',
          }));
        }

        // wiki 布局 → 统一检索服务（UI 与 Agent 共用同一排序）；
        // 旧布局（legacy/未声明 format）→ 旧 searcher（issue 28 退役）。
        if (mounted.format === 'wiki') {
          const outcome = await searchWiki(mounted.path, {
            query,
            ...(topK !== undefined ? { topK } : {}),
            ...(pageType !== undefined ? { pageType: pageType as Parameters<typeof searchWiki>[1]['pageType'] } : {}),
            ...(tag !== undefined ? { tag } : {}),
            ...(kind !== undefined ? { kind } : {}),
          });
          if (!outcome.ok) {
            return TEXT(JSON.stringify({ error: outcome.error.message, code: outcome.error.code }));
          }
          const r = outcome.result;
          return TEXT(JSON.stringify({
            mode: r.mode,
            kbId: r.kbId,
            coverage: r.coverage,
            graphExpansion: r.graphExpansion ?? null,
            total: r.hits.length,
            results: r.hits.map((h) => ({
              kind: h.kind,
              id: h.id,
              title: h.title,
              // 绝对路径 — Agent 的 read 工具按会话 cwd 解析相对路径，
              // 库目录与 cwd 往往不同，相对路径会读到 "Path not found"。
              path: h.absolutePath,
              relativePath: h.relativePath,
              snippet: h.snippet,
              pageType: h.pageType ?? null,
              tags: h.tags ?? [],
              keywords: h.keywords ?? [],
              sourceRefs: h.sourceRefs ?? [],
              stale: h.stale,
              sourceRevision: h.sourceRevision ?? null,
              score: h.score,
              graphRelatedTo: h.graphRelatedTo ?? null,
            })),
          }));
        }

        const category = typeof args.category === 'string' && args.category.trim() ? args.category.trim() : undefined;
        const results = await searchKb(mounted.path, query, { limit: topK, category });

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

    // ─── kb_read（issue 15，spec §8）────────────────────────

    defineTool(
      'kb_read',
      'Read evidence from the mounted LLM Wiki knowledge base by identity (no arbitrary file paths). Three kinds: kind="wiki" reads a published knowledge page by its page id (e.g. "concepts/axi-outstanding" — the stable id returned by kb_search); kind="parsed" reads the mechanical full-text of an imported source by its sourceId, optionally at a historical revision: pass revision + parsedHash from the page\'s sourceRefs to open the exact old evidence a page cited; kind="asset" returns the original image bytes for an assetId (image SHA256 from the asset list). Text kinds are paginated: returns the full-text hash, total lines/chars, startLine, endLine, the page content, and "next" (the startLine of the next page, null when done). Pages are exact slices of the original — concatenate pages in order with "\\n" between them to reproduce the full text with zero loss or duplication. Oversized single lines occupy one page and are returned at their true length (never truncated). A startLine beyond the document is rejected with a structured outOfRange error — unknown pages are never fabricated. Unknown ids, unknown revisions, invalid assetIds, cross-library references and expired citations all return structured errors — nothing is made up. For kind="asset" the result carries an image block plus a metadata text block (page number, extraction method). The mounted library is re-checked on every call; reads are refused while an unfinished publish transaction blocks the read gate. doc_to_markdown/kb_doc_* remain the tools for ad-hoc documents NOT in the knowledge base — kb_read never ingests anything.',
      {
        type: 'object',
        properties: {
          kind: {
            type: 'string',
            enum: ['wiki', 'parsed', 'asset'],
            description: 'What to read: wiki = published knowledge page (id = pageId); parsed = source full-text (id = sourceId); asset = original image (id = sourceId, also pass assetId).',
          },
          id: {
            type: 'string',
            description: 'Stable identity: pageId for kind=wiki (from kb_search results), sourceId for kind=parsed/asset (64-hex SHA256, from kb_search sourceRefs).',
          },
          revision: {
            type: 'string',
            description: 'kind=parsed/asset only: source revision (64-hex) from a page\'s sourceRefs.sourceRevision. Omit for the current revision. Old cited evidence stays readable at its cited revision.',
          },
          parsedHash: {
            type: 'string',
            description: 'kind=parsed only: parsed snapshot hash (64-hex) from sourceRefs.parsedHash to locate the exact historical full-text; omit for the current full-text.',
          },
          assetId: {
            type: 'string',
            description: 'kind=asset only: asset content hash (64-hex) identifying the image bytes.',
          },
          startLine: {
            type: 'number',
            description: '1-based line to start reading from (default 1). Set this to the previous page\'s "next" value to read the following page. A value beyond the document is rejected with a structured outOfRange error.',
          },
          maxChars: {
            type: 'number',
            description: 'Character budget for this page (default 20000, capped at 50000). Pages contain whole lines; an oversized single line occupies one page at its true length.',
          },
        },
        required: ['kind', 'id'],
        additionalProperties: false,
      },
      async (args) => {
        // 手工收窄：schema 已约束 enum/number，但 Agent 实参运行时仍可能越界
        const rawKind = typeof args.kind === 'string' ? args.kind : '';
        if (rawKind !== 'wiki' && rawKind !== 'parsed' && rawKind !== 'asset') {
          return TEXT(JSON.stringify({ error: `kind 必须是 wiki/parsed/asset: ${rawKind || '(missing)'}`, code: 'invalidKind' }));
        }
        const kind = rawKind;
        const id = typeof args.id === 'string' ? args.id : '';
        if (!id.trim()) {
          return TEXT(JSON.stringify({ error: 'id is required', code: 'emptyId' }));
        }

        const startLine = typeof args.startLine === 'number' ? args.startLine : undefined;
        const maxChars = typeof args.maxChars === 'number' ? args.maxChars : undefined;

        // 动态核对当前挂载：切库后旧提示不是跨库读取授权（与 kb_search 一致）
        const mounted = await getMountedKb(ctx.cwd);
        if (!mounted) {
          return TEXT(JSON.stringify({
            error: 'No knowledge base mounted. Mount a knowledge base first.',
            code: 'notMounted',
          }));
        }
        // 旧布局挂载：kb_read 只服务 wiki 布局；旧库继续用 docId 工具（issue 28 退役）
        if (mounted.format !== 'wiki') {
          return TEXT(JSON.stringify({
            error: 'The mounted knowledge base is not in the LLM Wiki layout. kb_read only supports wiki-layout libraries; use doc_to_markdown / kb_doc_* for legacy libraries.',
            code: 'notWikiLayout',
          }));
        }

        const outcome = await readWikiEvidence(mounted.path, {
          kind,
          id,
          ...(typeof args.revision === 'string' && args.revision.trim() ? { revision: args.revision.trim() } : {}),
          ...(typeof args.parsedHash === 'string' && args.parsedHash.trim() ? { parsedHash: args.parsedHash.trim() } : {}),
          ...(typeof args.assetId === 'string' && args.assetId.trim() ? { assetId: args.assetId.trim() } : {}),
          ...(startLine !== undefined ? { startLine } : {}),
          ...(maxChars !== undefined ? { maxChars } : {}),
        });

        if (!outcome.ok) {
          return TEXT(JSON.stringify({ error: outcome.error.message, code: outcome.error.code }));
        }

        const page = outcome.page;
        // asset：图像内容块 + 元数据文本块（视觉模型直接读图）
        if (page.kind === 'asset') {
          return {
            content: [
              {
                type: 'text',
                text: JSON.stringify({
                  kind: page.kind,
                  id: page.id,
                  kbId: page.kbId,
                  assetId: page.assetId,
                  hash: page.hash,
                  revision: page.revision,
                  relativePath: page.relativePath,
                  mimeType: page.mimeType,
                  sizeBytes: page.sizeBytes,
                  page: page.page,
                  method: page.method,
                }),
              },
              { type: 'image', data: page.dataBase64, mimeType: page.mimeType },
            ],
          };
        }

        return TEXT(JSON.stringify(page));
      },
    ),
  ];
}
