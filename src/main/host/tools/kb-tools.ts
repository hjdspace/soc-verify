/**
 * KB Host Tools — doc_to_markdown + kb_search。
 *
 * 把文档能力暴露给 AI Agent：
 *  - doc_to_markdown(path)：按需转换任意支持格式文档，返回 Markdown 内容字符串，
 *    不入库、不落盘产物。
 *  - kb_search(query)：跨挂载知识库检索，先匹配 index.md 条目（标题/摘要/关键词），
 *    再对 docs/ Markdown 全文匹配，返回匹配文档路径 + 摘要列表。
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
      'Convert any supported document format (docx, xlsx, pptx, pdf, csv, etc.) to Markdown text. Returns the Markdown content directly without saving to the knowledge base. Use this when you need to read the content of a Word/PDF/Excel/PowerPoint document that is not yet in the knowledge base. The conversion is instant (local, no network). Supported formats include .docx, .xlsx, .pptx, .pdf, .csv, .html, and more. If the document is encrypted, scanned (image-only PDF without text layer), or corrupted, a structured error is returned with a readable error code.',
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

        return TEXT(JSON.stringify({
          path: absPath,
          markdown: result.markdown,
        }));
      },
    ),

    // ─── kb_search ─────────────────────────────────────────

    defineTool(
      'kb_search',
      'Search the mounted knowledge base for documents matching a query. Searches document titles, summaries, keywords (from the index), and full-text content of all Markdown files. Returns a ranked list of matching documents with paths and summaries. Use this to find relevant documents in the knowledge base before reading them. If no knowledge base is mounted, returns an error. Results are limited to 20 entries by default.',
      {
        type: 'object',
        properties: {
          query: {
            type: 'string',
            description: 'Search query. Supports multi-word queries (space-separated). Chinese text is tokenized by character. Matches document titles, summaries, keywords, and full-text content.',
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

        const kbPath = await getMountedKbPath(ctx.cwd);
        if (!kbPath) {
          return TEXT(JSON.stringify({ error: 'No knowledge base mounted. Mount a knowledge base first.' }));
        }

        const results = await searchKb(kbPath, query, { limit });

        return TEXT(JSON.stringify({
          query,
          total: results.length,
          results: results.map((r) => ({
            title: r.title,
            path: r.path,
            category: r.category,
            summary: r.summary,
            keywords: r.keywords,
            score: r.score,
            matchedBy: r.matchedBy,
          })),
        }));
      },
    ),
  ];
}
