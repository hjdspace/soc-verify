/**
 * drawio 导出共享类型。
 */

/** 支持的导出格式 */
export type DrawioExportFormat = 'png' | 'svg' | 'pdf' | 'jpg';

export type DrawioExportOptions = {
  /** 输入 .drawio 文件绝对路径 */
  inputPath: string;
  /** 导出格式 */
  format: DrawioExportFormat;
  /** 输出文件绝对路径（调用方已确认扩展名） */
  outputPath: string;
  /** PNG/JPG 放大倍数（默认 1；2 即 2x 分辨率） */
  scale?: number;
  /** PNG 透明背景（仅 png 有效，默认白底） */
  transparent?: boolean;
  /** 超时毫秒数（默认 60s） */
  timeoutMs?: number;
};

export type DrawioExportResult = {
  success: boolean;
  outputPath: string;
  sizeBytes: number;
};

/** 导出失败（渲染/捕获/写文件） */
export class DrawioExportError extends Error {
  constructor(
    message: string,
    readonly cause?: unknown,
  ) {
    super(message);
    this.name = 'DrawioExportError';
  }
}

/** 格式对应的文件扩展名 */
export function formatExtension(format: DrawioExportFormat): string {
  return format === 'jpg' ? 'jpg' : format;
}
