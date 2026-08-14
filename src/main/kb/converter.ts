/**
 * Knowledge Base Converter — anydoc 转换封装。
 *
 * 调用 anydoc 的 `toDocument()` 获取 document model（含 assets 字节），
 * 同时调用 `toMarkdownBytes()` 获取 Markdown 文本。
 * Assets 按出现顺序写入 `docs/assets/<文档名>/image-NNN.<ext>`，
 * Markdown 内图片占位替换为相对路径链接。
 *
 * 错误处理：透传 anydoc 的 `ConvertErrorCode` 联合，
 * 映射为带用户可读信息的 KBConvertError。
 *
 * 同名覆盖：转换前清理该文档旧的 Markdown 与旧 assets 目录。
 */

import { readFile, writeFile, mkdir, rm } from 'node:fs/promises';
import { join, basename, extname, dirname } from 'node:path';
import {
  toDocument,
  toMarkdownBytes,
  formatFromPath,
  type Document,
  type Block,
  type Inline,
  type Asset,
  type ConvertErrorCode,
} from '@firecrawl/anydoc';

// ── 类型定义 ──────────────────────────────────────────────────────

/** 转换结果（成功） */
export type ConvertSuccess = {
  ok: true;
  /** Markdown 文件落盘路径 */
  markdownPath: string;
  /** 实际落盘的图片数量 */
  assetCount: number;
};

/** 转换结果（失败） */
export type ConvertFailure = {
  ok: false;
  error: KBConvertError;
};

/** 转换结果联合类型 */
export type ConvertResult = ConvertSuccess | ConvertFailure;

/** 结构化转换错误 */
export type KBConvertError = {
  /** anydoc 错误码 */
  code: ConvertErrorCode;
  /** 用户可读的中文错误信息 */
  message: string;
  /** 原始错误消息（anydoc 诊断） */
  detail: string;
};

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

/**
 * 从 media type 推断文件扩展名。
 * 未知类型回退到 'bin'。
 */
function extFromMediaType(mediaType: string): string {
  return MEDIA_TYPE_EXTENSIONS[mediaType] ?? 'bin';
}

/**
 * 从文件路径提取文档名（不含扩展名）。
 * `sources/验证计划.docx` → `验证计划`
 */
function docNameFromPath(sourcePath: string): string {
  const base = basename(sourcePath);
  const ext = extname(base);
  return ext ? base.slice(0, -ext.length) : base;
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

// ── Markdown 图片占位替换 ────────────────────────────────────────

/**
 * 将 Markdown 中的图片占位替换为相对路径链接。
 *
 * anydoc 的 toMarkdownBytes 输出的 Markdown 中，嵌入图片以
 * `![alt](imageN)` 格式出现（N 为序号）。我们将其替换为
 * `![alt](assets/<docName>/image-NNN.<ext>) 格式的相对路径。
 *
 * 同时处理任意 `![alt](非 URL)` 模式，将非 URL 的图片引用
 * 按顺序映射到落盘的 asset 文件名。
 */
function replaceImagePlaceholders(
  markdown: string,
  docName: string,
  assetFileNames: string[],
): string {
  if (assetFileNames.length === 0) return markdown;

  let idx = 0;
  // 匹配 ![alt](ref) 模式，其中 ref 不是 http/https URL
  return markdown.replace(
    /!\[([^\]]*)\]\(([^)]+)\)/g,
    (match, alt: string, ref: string) => {
      // 跳过外部 URL
      if (ref.startsWith('http://') || ref.startsWith('https://')) {
        return match;
      }
      if (idx >= assetFileNames.length) {
        return match;
      }
      const fileName = assetFileNames[idx];
      idx++;
      const relativePath = `assets/${docName}/${fileName}`;
      return `![${alt}](${relativePath})`;
    },
  );
}

// ── 同名覆盖：清理旧产物 ────────────────────────────────────────

/**
 * 清理旧的 Markdown 文件和 assets 目录。
 * 不存在则静默跳过。
 */
async function cleanupOldArtifacts(markdownPath: string, assetsDir: string): Promise<void> {
  await Promise.all([
    rm(markdownPath, { force: true }),
    rm(assetsDir, { recursive: true, force: true }),
  ]);
}

// ── 主函数 ───────────────────────────────────────────────────────

/**
 * 转换文档为 Markdown 并落盘。
 *
 * 端到端路径：
 * 1. 读取源文件字节
 * 2. 检测格式（不支持 → 返回 unsupported 错误）
 * 3. 调用 toDocument 获取 document model（含 assets）
 * 4. 调用 toMarkdownBytes 获取 Markdown 文本
 * 5. 清理旧产物（同名覆盖）
 * 6. Assets 按序落盘到 docs/assets/<文档名>/image-NNN.<ext>
 * 7. Markdown 图片占位替换为相对路径
 * 8. Markdown 落盘到 docs/<文档名>.md
 *
 * PDF 特殊处理：toDocument 对 PDF 抛 unsupported，
 * 改用 toMarkdownBytes 直接获取 Markdown（无 assets）。
 */
export async function convertDocument(
  sourcePath: string,
  docsDir: string,
): Promise<ConvertResult> {
  const docName = docNameFromPath(sourcePath);
  const markdownPath = join(docsDir, `${docName}.md`);
  const assetsDir = join(docsDir, 'assets', docName);

  // 检测格式
  const format = formatFromPath(sourcePath);
  if (!format) {
    return {
      ok: false,
      error: {
        code: 'unsupported',
        message: ERROR_MESSAGES.unsupported,
        detail: `未知格式：${extname(sourcePath) || '无扩展名'}`,
      },
    };
  }

  // 读取源文件字节
  let bytes: Uint8Array;
  try {
    const buf = await readFile(sourcePath);
    bytes = new Uint8Array(buf);
  } catch (e) {
    return {
      ok: false,
      error: {
        code: 'io',
        message: ERROR_MESSAGES.io,
        detail: (e as Error).message,
      },
    };
  }

  // 尝试获取 document model（含 assets）
  // PDF 的 toDocument 会抛 unsupported，此时改用 toMarkdownBytes
  let doc: Document | null = null;
  let markdown = '';

  try {
    doc = await toDocument(bytes, format);
    // document model 成功，再获取 Markdown 文本
    try {
      markdown = await toMarkdownBytes(bytes, format);
    } catch {
      // toMarkdownBytes 失败但 toDocument 成功：从 document model 获取的信息仍可用
      // 此时 markdown 为空字符串，后续处理时图片替换仍会执行
    }
  } catch (e) {
    const code = (e as Error & { code?: string }).code as ConvertErrorCode | undefined;
    if (!code) {
      // 非 anydoc 错误，透传为 io
      return {
        ok: false,
        error: {
          code: 'io',
          message: ERROR_MESSAGES.io,
          detail: (e as Error).message,
        },
      };
    }

    // PDF 格式：toDocument 抛 unsupported 是预期的，改用 toMarkdownBytes
    if (format === 'pdf' && code === 'unsupported') {
      try {
        markdown = await toMarkdownBytes(bytes, format);
        // PDF via toMarkdownBytes：无 assets，直接落盘
        await cleanupOldArtifacts(markdownPath, assetsDir);
        await mkdir(dirname(markdownPath), { recursive: true });
        await writeFile(markdownPath, markdown, 'utf-8');
        return { ok: true, markdownPath, assetCount: 0 };
      } catch (e2) {
        const code2 = (e2 as Error & { code?: string }).code as ConvertErrorCode | undefined;
        const finalCode = code2 ?? 'io';
        return {
          ok: false,
          error: {
            code: finalCode,
            message: ERROR_MESSAGES[finalCode] ?? ERROR_MESSAGES.io,
            detail: (e2 as Error).message,
          },
        };
      }
    }

    // 其他错误码：透传
    return {
      ok: false,
      error: {
        code,
        message: ERROR_MESSAGES[code] ?? `转换失败（${code}）`,
        detail: (e as Error).message,
      },
    };
  }

  // 清理旧产物（同名覆盖）
  await cleanupOldArtifacts(markdownPath, assetsDir);

  // 从 document model 提取被引用的 asset（按出现顺序）
  const referencedIds = doc ? collectReferencedAssetIds(doc.blocks) : [];
  const assets = doc ? doc.assets : [];

  // 落盘 assets
  const assetFileNames: string[] = [];
  if (referencedIds.length > 0) {
    await mkdir(assetsDir, { recursive: true });

    for (let i = 0; i < referencedIds.length; i++) {
      const assetId = referencedIds[i];
      const asset: Asset | undefined = assets.find((a) => a.id === assetId);
      if (!asset) continue;

      const seq = String(i + 1).padStart(3, '0');
      const ext = extFromMediaType(asset.mediaType);
      const fileName = `image-${seq}.${ext}`;
      const filePath = join(assetsDir, fileName);

      await writeFile(filePath, asset.data);
      assetFileNames.push(fileName);
    }
  }

  // 如果 markdown 为空（toMarkdownBytes 失败但 toDocument 成功），生成占位
  if (!markdown) {
    markdown = `# ${docName}\n\n（文档内容提取不完整）\n`;
  }

  // 替换 Markdown 中的图片占位为相对路径
  const finalMarkdown = replaceImagePlaceholders(markdown, docName, assetFileNames);

  // 落盘 Markdown
  await mkdir(dirname(markdownPath), { recursive: true });
  await writeFile(markdownPath, finalMarkdown, 'utf-8');

  return {
    ok: true,
    markdownPath,
    assetCount: assetFileNames.length,
  };
}

// ── 临时转换（不入库） ──────────────────────────────────────────

/** 临时转换结果（成功） */
export type ConvertToStringSuccess = {
  ok: true;
  /** Markdown 内容字符串 */
  markdown: string;
};

/** 临时转换结果（失败） */
export type ConvertToStringFailure = {
  ok: false;
  error: KBConvertError;
};

/** 临时转换结果联合类型 */
export type ConvertToStringResult = ConvertToStringSuccess | ConvertToStringFailure;

/**
 * 将文档转换为 Markdown 字符串，**不入库、不落盘产物**。
 *
 * 用于 doc_to_markdown Host Tool：Agent 承接"看 word/pdf 文档"任务时，
 * 按需转换任意支持格式文档，直接返回 Markdown 内容字符串。
 *
 * 内部复用 anydoc 的 toDocument / toMarkdownBytes，
 * 但不创建文件、不写入 docs/ 目录。
 *
 * 图片占位保留为 `![alt](imageN)` 格式（不落盘 assets），
 * Agent 能感知图片位置但无法查看图片字节。
 */
export async function convertDocumentToMarkdownString(
  sourcePath: string,
): Promise<ConvertToStringResult> {
  const docName = docNameFromPath(sourcePath);

  // 检测格式
  const format = formatFromPath(sourcePath);
  if (!format) {
    return {
      ok: false,
      error: {
        code: 'unsupported',
        message: ERROR_MESSAGES.unsupported,
        detail: `未知格式：${extname(sourcePath) || '无扩展名'}`,
      },
    };
  }

  // 读取源文件字节
  let bytes: Uint8Array;
  try {
    const buf = await readFile(sourcePath);
    bytes = new Uint8Array(buf);
  } catch (e) {
    return {
      ok: false,
      error: {
        code: 'io',
        message: ERROR_MESSAGES.io,
        detail: (e as Error).message,
      },
    };
  }

  // 尝试获取 Markdown 文本
  let markdown = '';

  try {
    // 优先尝试 toMarkdownBytes（直接获取 Markdown）
    markdown = await toMarkdownBytes(bytes, format);
  } catch (e) {
    const code = (e as Error & { code?: string }).code as ConvertErrorCode | undefined;
    if (!code) {
      return {
        ok: false,
        error: {
          code: 'io',
          message: ERROR_MESSAGES.io,
          detail: (e as Error).message,
        },
      };
    }

    // PDF 格式：toMarkdownBytes 可能抛 unsupported，尝试 toDocument
    if (format === 'pdf' && code === 'unsupported') {
      try {
        const doc = await toDocument(bytes, format);
        // 从 document model 生成简单 Markdown
        markdown = docToSimpleMarkdown(doc.blocks, docName);
      } catch (e2) {
        const code2 = (e2 as Error & { code?: string }).code as ConvertErrorCode | undefined;
        const finalCode = code2 ?? 'io';
        return {
          ok: false,
          error: {
            code: finalCode,
            message: ERROR_MESSAGES[finalCode] ?? ERROR_MESSAGES.io,
            detail: (e2 as Error).message,
          },
        };
      }
    } else {
      // 其他错误码：透传
      return {
        ok: false,
        error: {
          code,
          message: ERROR_MESSAGES[code] ?? `转换失败（${code}）`,
          detail: (e as Error).message,
        },
      };
    }
  }

  // 如果 markdown 为空，尝试从 toDocument 获取
  if (!markdown) {
    try {
      const doc = await toDocument(bytes, format);
      markdown = docToSimpleMarkdown(doc.blocks, docName);
    } catch {
      // 降级为占位
      markdown = `# ${docName}\n\n（文档内容提取不完整）\n`;
    }
  }

  return { ok: true, markdown };
}

/**
 * 从 document model 的 blocks 生成简单 Markdown。
 * 用于 toDocument 成功但 toMarkdownBytes 失败的降级场景。
 */
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
