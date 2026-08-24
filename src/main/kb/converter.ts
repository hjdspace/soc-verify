/**
 * Knowledge Base Converter — 转换编排层。
 *
 * 引擎只产出「Markdown + 按引用顺序的图片字节」；本模块负责：
 *  1. 读取 kb-settings 选定引擎（anydoc）
 *  2. 读取源文件字节，调用引擎转换
 *  3. 清理旧产物（同名覆盖）
 *  4. Assets 按序落盘到 docs/assets/<文档名>/image-NNN.<ext>
 *  5. Markdown 图片占位 `![alt](imageN)` 替换为相对路径链接
 *  6. Markdown 落盘到 docs/<文档名>.md
 *
 * @see ADR 0021 — anydoc 文档知识库
 */

import { readFile, writeFile, mkdir, rm } from 'node:fs/promises';
import { join, basename, extname, dirname } from 'node:path';
import { getActiveConvertEngine } from './engines';
import type { EngineConvertError } from './engines/types';

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
export type KBConvertError = EngineConvertError;

// ── 辅助函数 ──────────────────────────────────────────────────────

/**
 * 从文件路径提取文档名（不含扩展名）。
 * `sources/验证计划.docx` → `验证计划`
 */
function docNameFromPath(sourcePath: string): string {
  const base = basename(sourcePath);
  const ext = extname(base);
  return ext ? base.slice(0, -ext.length) : base;
}

// ── Markdown 图片占位替换 ────────────────────────────────────────

/**
 * 将 Markdown 中的图片占位替换为相对路径链接。
 *
 * 引擎输出的 Markdown 中，嵌入图片以 `![alt](imageN)` 格式出现
 * （N 为序号）。我们将其替换为 `![alt](assets/<docName>/image-NNN.<ext>)`
 * 格式的相对路径。
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

// ── 主函数 ─────────────────────────────────────────────────────

/**
 * 转换文档为 Markdown 并落盘。
 *
 * 端到端路径：
 * 1. 选定转换引擎（用户设置，默认 anydoc）
 * 2. 扩展名预检（引擎不支持 → 结构化 unsupported，提示切换引擎）
 * 3. 读取源文件字节
 * 4. 引擎转换 → Markdown + 按引用顺序的图片字节
 * 5. 清理旧产物（同名覆盖）
 * 6. Assets 按序落盘到 docs/assets/<文档名>/image-NNN.<ext>
 * 7. Markdown 图片占位替换为相对路径
 * 8. Markdown 落盘到 docs/<文档名>.md
 */
export async function convertDocument(
  sourcePath: string,
  docsDir: string,
): Promise<ConvertResult> {
  const docName = docNameFromPath(sourcePath);
  const markdownPath = join(docsDir, `${docName}.md`);
  const assetsDir = join(docsDir, 'assets', docName);

  // 引擎预检：扩展名不在引擎支持列表时直接给可操作的错误
  const engine = await getActiveConvertEngine();
  const ext = extname(sourcePath).toLowerCase();
  if (!engine.supportedExtensions.includes(ext)) {
    return {
      ok: false,
      error: {
        code: 'unsupported',
        message: `当前转换引擎（${engine.label}）不支持 ${ext || '该格式'}，可在设置 → 知识库切换引擎`,
        detail: `engine=${engine.id} ext=${ext || '(none)'}`,
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
        message: '文件读取失败',
        detail: (e as Error).message,
      },
    };
  }

  // 引擎转换
  const result = await engine.convert(bytes, sourcePath);
  if (!result.ok) {
    return { ok: false, error: result.error };
  }
  const { markdown, assets } = result.output;

  // 清理旧产物（同名覆盖）
  await cleanupOldArtifacts(markdownPath, assetsDir);

  // 落盘 assets（按引用顺序编号）
  const assetFileNames: string[] = [];
  if (assets.length > 0) {
    await mkdir(assetsDir, { recursive: true });
    for (let i = 0; i < assets.length; i++) {
      const asset = assets[i];
      const seq = String(i + 1).padStart(3, '0');
      const fileName = `image-${seq}.${asset.ext}`;
      await writeFile(join(assetsDir, fileName), asset.data);
      assetFileNames.push(fileName);
    }
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
 * 内部复用当前选定引擎，但不创建文件、不写入 docs/ 目录。
 *
 * 图片占位保留为 `![alt](imageN)` 格式（不落盘 assets），
 * Agent 能感知图片位置但无法查看图片字节。
 */
export async function convertDocumentToMarkdownString(
  sourcePath: string,
): Promise<ConvertToStringResult> {
  const engine = await getActiveConvertEngine();
  const ext = extname(sourcePath).toLowerCase();
  if (!engine.supportedExtensions.includes(ext)) {
    return {
      ok: false,
      error: {
        code: 'unsupported',
        message: `当前转换引擎（${engine.label}）不支持 ${ext || '该格式'}，可在设置 → 知识库切换引擎`,
        detail: `engine=${engine.id} ext=${ext || '(none)'}`,
      },
    };
  }

  let bytes: Uint8Array;
  try {
    const buf = await readFile(sourcePath);
    bytes = new Uint8Array(buf);
  } catch (e) {
    return {
      ok: false,
      error: {
        code: 'io',
        message: '文件读取失败',
        detail: (e as Error).message,
      },
    };
  }

  const result = await engine.convert(bytes, sourcePath);
  if (!result.ok) {
    return { ok: false, error: result.error };
  }
  return { ok: true, markdown: result.output.markdown };
}
