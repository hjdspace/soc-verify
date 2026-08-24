/**
 * 转换引擎契约 — KB 文档转 Markdown 的可插拔引擎接口。
 *
 * 引擎只负责「字节 → Markdown + 图片字节序列」，不落盘：
 *  - Markdown 中嵌入图片以 `![alt](imageN)` 占位（N 为引用序号），
 *    assets 按同一顺序返回图片字节；
 *  - 落盘（docs/assets/<文档名>/image-NNN.<ext>）与占位替换由
 *    converter.ts 统一编排，两个引擎共享同一套产物布局。
 *
 * 错误码沿用 anydoc 的联合（下游 UI / 测试已按此分支），非 anydoc
 * 引擎将自己的错误映射到同一联合。
 *
 * @see ADR 0021 — anydoc 文档知识库
 */

/** 引擎 ID（设置页可切换） — 跨进程共享，从 @shared/kb-types 导入 */
export type { ConvertEngineId } from '@shared/kb-types';
import type { ConvertEngineId } from '@shared/kb-types';

/** 结构化转换错误码（与 @firecrawl/anydoc 的 ConvertErrorCode 对齐） */
export type ConvertErrorCode =
  | 'unsupported'
  | 'malformed'
  | 'encrypted'
  | 'resourceLimit'
  | 'missingPart'
  | 'io';

/** 结构化转换错误 */
export type EngineConvertError = {
  code: ConvertErrorCode;
  /** 用户可读的中文错误信息 */
  message: string;
  /** 原始错误诊断 */
  detail: string;
};

/** 图片字节（ext 不含点，如 'png'） */
export type EngineAsset = {
  ext: string;
  data: Uint8Array;
};

/** 引擎转换产物 */
export type EngineOutput = {
  markdown: string;
  /** 按文档内引用顺序排列的图片 */
  assets: EngineAsset[];
};

/** 引擎转换结果 */
export type EngineResult =
  | { ok: true; output: EngineOutput }
  | { ok: false; error: EngineConvertError };

/** 转换引擎接口 */
export type ConvertEngine = {
  id: ConvertEngineId;
  /** UI 显示名 */
  label: string;
  /** UI 描述（设置页引擎卡片） */
  description: string;
  /** 支持的文件扩展名（小写含点） */
  supportedExtensions: readonly string[];
  /**
   * 转换文档字节为 Markdown + 图片序列。
   * @param bytes 源文件字节
   * @param sourcePath 源文件路径（用于判断格式，不读取该文件）
   */
  convert(bytes: Uint8Array, sourcePath: string): Promise<EngineResult>;
};

/** 引擎元信息（tRPC 输出，剥离 convert 函数） — 跨进程共享，从 @shared/kb-types 导入 */
export type { ConvertEngineInfo } from '@shared/kb-types';
