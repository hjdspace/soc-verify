/**
 * Drawio router — .drawio 框图预览读取与 CLI 导出。
 *
 * Procedure 列表：
 *  - drawio.checkInstalled：检查 draw.io desktop CLI 可用性（返回路径供展示）
 *  - drawio.readDiagram：读取 .drawio 文件 XML 内容（渲染端 viewer 用）
 *  - drawio.export：CLI 导出 PNG / SVG / PDF / JPG
 *  - drawio.pickExportPath：原生保存对话框选择导出路径
 *
 * 导出不依赖 draw.io CLI 的路径读取（预览离线可用）；
 * CLI 缺失时 export 返回明确的 `draw.io CLI not available` 错误。
 */

import { readFile } from 'node:fs/promises';
import { basename, dirname, join, parse } from 'node:path';
import { dialog } from 'electron';
import { t, TRPCError } from '../router-context';
import { isDrawioInstalled, resolveDrawioPath, DRAWIO_DOWNLOAD_URL } from '../../drawio/binary';
import {
  exportDiagram,
  formatExtension,
  DrawioExportError,
  DrawioNotAvailableError,
  type DrawioExportFormat,
} from '../../drawio/exporter';

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
  /** 检查 draw.io CLI 是否可用。 */
  checkInstalled: t.procedure.query(() => {
    return {
      installed: isDrawioInstalled(),
      path: resolveDrawioPath(),
      downloadUrl: DRAWIO_DOWNLOAD_URL,
      /** 内置二进制仅在 Linux 打包（Windows/macOS 需本机安装） */
      bundledPlatform: 'linux' as const,
    };
  }),

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

  /** CLI 导出。outputPath 省略时默认与输入同目录、同名换扩展名。 */
  export: t.procedure
    .input(parseExportInput)
    .mutation(async ({ input }) => {
      try {
        const result = await exportDiagram(input);
        return result;
      } catch (err) {
        if (err instanceof DrawioNotAvailableError) {
          throw new TRPCError({ code: 'INTERNAL_SERVER_ERROR', message: 'draw.io CLI not available', cause: err });
        }
        if (err instanceof DrawioExportError) {
          throw new TRPCError({
            code: 'INTERNAL_SERVER_ERROR',
            message: `drawio export failed: ${err.message}${err.stderr ? ` (${err.stderr.trim().slice(0, 500)})` : ''}`,
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
