/**
 * anydoc 转换引擎 — @firecrawl/anydoc（Rust NAPI 模块）封装。
 *
 * 调用 anydoc 的 `toDocument()` 获取 document model（含 assets 字节），
 * 同时调用 `toMarkdownBytes()` 获取 Markdown 文本。
 * assets 按 document model 中被引用的顺序返回，与 toMarkdownBytes
 * 输出的 `imageN` 占位顺序一致。
 *
 * PDF 特殊处理：toDocument 对 PDF 抛 unsupported，
 * 改用 toMarkdownBytes 直接获取 Markdown（无 assets）。
 *
 * @see ADR 0021 — anydoc 文档知识库
 */

import {
  toDocument,
  toMarkdownBytes,
  formatFromPath,
  type Document,
  type Block,
  type Inline,
  type Asset,
} from '@firecrawl/anydoc';
import type { ConvertEngine, EngineResult, ConvertErrorCode } from './types';

// ── 错误码 → 用户可读信息映射 ────────────────────────────────────

const ERROR_MESSAGES: Record<ConvertErrorCode, string> = {
  unsupported: '不支持的格式或无法转换（扫描版 PDF 无文字层，需 OCR（不支持））',
  malformed: '文档结构损坏，无法提取有效内容',
  encrypted: '文档已加密或受密码保护',
  resourceLimit: '文档超出资源限制（过大或嵌套层级过深）',
  missingPart: '文档缺少部件，无法完整转换',
  io: '文件读取失败',
};

// ── media type → 扩展名映射 ──────────────────────────────────────

const MEDIA_TYPE_EXTENSIONS: Record<string, string> = {
  'image/png': 'png',
  'image/jpeg': 'jpeg',
  'image/gif': 'gif',
  'image/bmp': 'bmp',
  'image/tiff': 'tiff',
  'image/webp': 'webp',
  'image/svg+xml': 'svg',
  'image/x-emf': 'emf',
  'image/x-wmf': 'wmf',
};

function extFromMediaType(mediaType: string): string {
  return MEDIA_TYPE_EXTENSIONS[mediaType] ?? 'bin';
}

// ── 从 document model 提取被引用的 asset ────────────────────────

/**
 * 递归遍历 blocks，按出现顺序收集所有 image inline 引用的 assetId。
 * 只收集 source.kind === 'asset' 的图片。
 */
function collectReferencedAssetIds(blocks: Block[]): number[] {
  const ids: number[] = [];

  function visitInline(inlines: Inline[] | undefined): void {
    if (!inlines) return;
    for (const inline of inlines) {
      if (inline.kind === 'image' && inline.source?.kind === 'asset' && inline.source.assetId !== undefined) {
        ids.push(inline.source.assetId);
      }
      // link 内嵌内容也递归
      if (inline.content) {
        visitInline(inline.content);
      }
    }
  }

  function visitBlocks(bs: Block[]): void {
    for (const block of bs) {
      if (block.content) visitInline(block.content);
      if (block.blocks) visitBlocks(block.blocks);
      if (block.list?.items) {
        for (const item of block.list.items) {
          visitBlocks(item.blocks);
        }
      }
      if (block.table?.grid) {
        for (const row of block.table.grid) {
          for (const slot of row) {
            if (slot.cell?.blocks) visitBlocks(slot.cell.blocks);
          }
        }
      }
    }
  }

  visitBlocks(blocks);
  return ids;
}

// ── 从 document model 生成简单 Markdown ─────────────────────────

/** toMarkdownBytes 失败但 toDocument 成功的降级路径 */
function docToSimpleMarkdown(blocks: Block[], docName: string): string {
  const lines: string[] = [`# ${docName}`, ''];

  function visitBlocks(bs: Block[]): void {
    for (const block of bs) {
      if (block.content) {
        const textParts: string[] = [];
        for (const inline of block.content) {
          if (inline.kind === 'text' && inline.text) {
            textParts.push(inline.text);
          }
        }
        if (textParts.length > 0) {
          lines.push(textParts.join(''));
        }
      }
      if (block.blocks) visitBlocks(block.blocks);
      if (block.list?.items) {
        for (const item of block.list.items) {
          visitBlocks(item.blocks);
        }
      }
      if (block.table?.grid) {
        for (const row of block.table.grid) {
          for (const slot of row) {
            if (slot.cell?.blocks) visitBlocks(slot.cell.blocks);
          }
        }
      }
      lines.push('');
    }
  }

  visitBlocks(blocks);
  return lines.join('\n');
}

function docNameFromPath(sourcePath: string): string {
  const base = sourcePath.replace(/^.*[\\/]/, '');
  const dot = base.lastIndexOf('.');
  return dot > 0 ? base.slice(0, dot) : base;
}

// ── 引擎实现 ─────────────────────────────────────────────────────

export const anydocEngine: ConvertEngine = {
  id: 'anydoc',
  label: 'anydoc（默认）',
  description: 'Rust 原生引擎，格式覆盖最全（doc/ppt 旧格式、odt/ods/odp/rtf/epub），PDF 需要文字层。',
  // 与 @firecrawl/anydoc 的 Format 枚举对齐（不含 .xls/.html）
  supportedExtensions: [
    '.pdf', '.doc', '.docx', '.ppt', '.pptx',
    '.xlsx', '.ods', '.odp', '.odt', '.rtf', '.epub', '.csv',
  ],

  async convert(bytes: Uint8Array, sourcePath: string): Promise<EngineResult> {
    const docName = docNameFromPath(sourcePath);

    // 检测格式
    const format = formatFromPath(sourcePath);
    if (!format) {
      return {
        ok: false,
        error: {
          code: 'unsupported',
          message: ERROR_MESSAGES.unsupported,
          detail: `未知格式：${sourcePath.replace(/^.*(\.[^.]+)$/, '$1') || '无扩展名'}`,
        },
      };
    }

    // 阶段 1：toMarkdownBytes 取 Markdown 文本（doc_to_markdown 的主路径）
    let markdown = '';
    let mdErrorCode: ConvertErrorCode | undefined;
    let mdErrorDetail = '';
    try {
      markdown = await toMarkdownBytes(bytes, format);
    } catch (e) {
      const code = (e as Error & { code?: string }).code as ConvertErrorCode | undefined;
      mdErrorCode = code ?? 'io';
      mdErrorDetail = (e as Error).message;
    }

    // 阶段 2：toDocument 取 document model（assets 用；上传流水线的主路径）。
    // PDF 的 toDocument 必然抛 unsupported（设计如此，pdf-inspector 直接产出
    // Markdown），不算失败。
    let doc: Document | null = null;
    let docErrorCode: ConvertErrorCode | undefined;
    let docErrorDetail = '';
    try {
      doc = await toDocument(bytes, format);
    } catch (e) {
      const code = (e as Error & { code?: string }).code as ConvertErrorCode | undefined;
      if (!code) {
        return {
          ok: false,
          error: { code: 'io', message: ERROR_MESSAGES.io, detail: (e as Error).message },
        };
      }
      docErrorCode = code;
      docErrorDetail = (e as Error).message;
    }

    // 组合：任一来源可用即成功；文本缺失时从 document model 生成
    if (doc) {
      const finalMarkdown = markdown || docToSimpleMarkdown(doc.blocks, docName);
      const referencedIds = collectReferencedAssetIds(doc.blocks);
      const outputAssets = referencedIds.flatMap((assetId) => {
        const asset: Asset | undefined = doc!.assets.find((a) => a.id === assetId);
        return asset ? [{ ext: extFromMediaType(asset.mediaType), data: asset.data }] : [];
      });
      return { ok: true, output: { markdown: finalMarkdown, assets: outputAssets } };
    }
    if (markdown) {
      return { ok: true, output: { markdown, assets: [] } };
    }

    // 双失败：PDF 以 toMarkdownBytes 的错误为准（toDocument 的 unsupported 是预期）；
    // 其余格式优先 toDocument 的错误（上传流水线语义）
    const pdfExpected = format === 'pdf' && docErrorCode === 'unsupported';
    const code = (pdfExpected ? mdErrorCode : docErrorCode ?? mdErrorCode) ?? 'io';
    const detail = pdfExpected ? mdErrorDetail || docErrorDetail : docErrorDetail || mdErrorDetail;
    return {
      ok: false,
      error: {
        code,
        message: ERROR_MESSAGES[code] ?? `转换失败（${code}）`,
        detail,
      },
    };
  },
};
