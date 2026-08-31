/**
 * Drawio router — .drawio 框图预览读取与导出。
 *
 * Procedure 列表：
 *  - drawio.readDiagram：读取 .drawio 文件 XML 内容（渲染端 viewer 用）
 *  - drawio.export：导出 PNG / SVG / PDF / JPG（内置 viewer 渲染，不依赖 draw.io Desktop）
 *  - drawio.pickExportPath：原生保存对话框选择导出路径
 *
 * 预览与导出共用包内 viewer-static.min.js 渲染内核，离线可用、无需外部 CLI。
 */

import { readFile } from 'node:fs/promises';
import { basename, dirname, join, parse } from 'node:path';
import { dialog } from 'electron';
import { t, TRPCError } from '../router-context';
import { DrawioExportError } from '../../drawio/export-types';
import { exportDiagram, formatExtension, type DrawioExportFormat } from '../../drawio/viewer-exporter';

const EXPORT_FORMATS = new Set<DrawioExportFormat>(['png', 'svg', 'pdf', 'jpg']);

/** 校验并规范化 export 输入 */
function parseExportInput(raw: unknown): {
  inputPath: string;
  format: DrawioExportFormat;
  outputPath: string;
  scale?: number;
  transparent?: boolean;
  crop?: boolean;
} {
  const r = raw as Record<string, unknown>;
  if (typeof r.inputPath !== 'string' || r.inputPath.length === 0) {
    throw new TRPCError({ code: 'BAD_REQUEST', message: 'inputPath is required' });
  }
  if (typeof r.format !== 'string' || !EXPORT_FORMATS.has(r.format as DrawioExportFormat)) {
    throw new TRPCError({ code: 'BAD_REQUEST', message: 'format must be one of png|svg|pdf|jpg' });
  }
  const format = r.format as DrawioExportFormat;

  // outputPath 可选：默认与输入同目录、同名换扩展名
  let outputPath: string;
  if (typeof r.outputPath === 'string' && r.outputPath.length > 0) {
    outputPath = r.outputPath;
  } else {
    const parsed = parse(r.inputPath);
    outputPath = join(parsed.dir, `${parsed.name}.${formatExtension(format)}`);
  }

  const scale = typeof r.scale === 'number' && r.scale > 0 ? r.scale : undefined;
  const transparent = r.transparent === true ? true : undefined;
  const crop = r.crop === true ? true : undefined;

  return { inputPath: r.inputPath, format, outputPath, scale, transparent, crop };
}

export const drawioRouter = t.router({
  /** 读取 .drawio 文件 XML 内容。 */
  readDiagram: t.procedure
    .input((raw): { filePath: string } => {
      const r = raw as Record<string, unknown>;
      if (typeof r.filePath !== 'string' || r.filePath.length === 0) {
        throw new TRPCError({ code: 'BAD_REQUEST', message: 'filePath is required' });
      }
      return { filePath: r.filePath };
    })
    .query(async ({ input }) => {
      try {
        const content = await readFile(input.filePath, 'utf-8');
        return { content, name: basename(input.filePath) };
      } catch (err) {
        throw new TRPCError({
          code: 'INTERNAL_SERVER_ERROR',
          message: `readDiagram failed: ${err instanceof Error ? err.message : String(err)}`,
        });
      }
    }),

  /** 导出（内置 viewer 渲染）。outputPath 省略时默认与输入同目录、同名换扩展名。 */
  export: t.procedure
    .input(parseExportInput)
    .mutation(async ({ input }) => {
      try {
        const result = await exportDiagram(input);
        return result;
      } catch (err) {
        if (err instanceof DrawioExportError) {
          throw new TRPCError({
            code: 'INTERNAL_SERVER_ERROR',
            message: `drawio export failed: ${err.message}`,
            cause: err,
          });
        }
        throw new TRPCError({
          code: 'INTERNAL_SERVER_ERROR',
          message: `export failed: ${err instanceof Error ? err.message : String(err)}`,
        });
      }
    }),

  /** 弹出原生保存对话框选择导出路径。用户取消时返回 null。 */
  pickExportPath: t.procedure
    .input((raw): { sourcePath: string; format: DrawioExportFormat } => {
      const r = raw as Record<string, unknown>;
      if (typeof r.sourcePath !== 'string' || r.sourcePath.length === 0) {
        throw new TRPCError({ code: 'BAD_REQUEST', message: 'sourcePath is required' });
      }
      if (typeof r.format !== 'string' || !EXPORT_FORMATS.has(r.format as DrawioExportFormat)) {
        throw new TRPCError({ code: 'BAD_REQUEST', message: 'format must be one of png|svg|pdf|jpg' });
      }
      return { sourcePath: r.sourcePath, format: r.format as DrawioExportFormat };
    })
    .mutation(async ({ input }) => {
      const ext = formatExtension(input.format);
      const parsed = parse(input.sourcePath);
      const result = await dialog.showSaveDialog({
        title: `导出 ${ext.toUpperCase()}`,
        defaultPath: join(dirname(input.sourcePath), `${parsed.name}.${ext}`),
        filters: [
          { name: ext.toUpperCase() + ' 文件', extensions: [ext] },
          { name: '所有文件', extensions: ['*'] },
        ],
      });
      if (result.canceled || !result.filePath) return { outputPath: null };
      return { outputPath: result.filePath };
    }),
});
