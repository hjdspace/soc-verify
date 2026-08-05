/**
 * Document router — officecli 文档预览与查看能力。
 *
 * Procedure 列表：
 *  - document.checkInstalled：检查 officecli 二进制可用性
 *  - document.getVersion：获取 officecli 版本号
 *  - document.viewHtml：渲染文档为 HTML
 *  - document.viewScreenshot：渲染文档为 PNG 截图
 *  - document.watchStart：启动 watch 模式
 *  - document.watchStop：停止指定 watch
 *  - document.watchStopAll：停止所有 watch
 *  - document.listWatches：列出活跃 watch
 *  - document.readImageAsDataURL：读图为 base64 data URL
 *  - document.loadXlsx：读取 xlsx 文件并转为 Fortune-sheet 工作簿数据
 *  - document.saveXlsx：将 Fortune-sheet 工作簿数据写回 xlsx 文件
 *  - document.registerEditor：注册文件正在前端编辑（XlsxEditor mount）
 *  - document.unregisterEditor：注销文件的前端编辑状态（XlsxEditor unmount）
 *  - document.flushDone：前端 flush 完成后回复主进程
 *  - document.downloadBinary：下载 officecli 二进制（仅开发模式，进度通过 IPC 推送）
 *
 * officecli 不可用时，procedure 返回明确的 `OfficeCLI not available` 错误
 * （TRPCError INTERNAL_SERVER_ERROR with cause），不抛未捕获异常。
 */

import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { t, TRPCError } from '../router-context';
import {
  checkInstalled,
  getVersion,
  viewHtml,
  viewScreenshot,
  watchStart,
  watchStop,
  watchStopAll,
  listWatches,
  readImageAsDataURL,
} from '../../officecli/service';
import { OfficeCliNotAvailableError } from '../../officecli/executor';
import { excelToFortune, fortuneToExcel, type WorkbookData } from '../../document/fortune-sheet-bridge';
import { readXlsxWorkbook } from '../../document/xlsx-reader';
import {
  registerEditor,
  unregisterEditor,
  notifyFlushDone,
} from '../../document/editor-registry';
import { downloadOfficeCliBinary } from '../../officecli/downloader';

const __dirname = dirname(fileURLToPath(import.meta.url));

/** 开发模式下 download-officecli.mjs 的路径（<projectRoot>/scripts/download-officecli.mjs） */
function devDownloadScriptPath(): string {
  // src/main/ipc/routers/ → ../../../scripts/download-officecli.mjs
  return resolve(__dirname, '../../../scripts/download-officecli.mjs');
}

/** 将 service 层错误映射为 tRPC 错误，保持 officecli 不可用时错误信息明确 */
function toTrpcError(err: unknown, operation: string): TRPCError {
  if (err instanceof OfficeCliNotAvailableError) {
    return new TRPCError({
      code: 'INTERNAL_SERVER_ERROR',
      message: 'OfficeCLI not available',
      cause: err,
    });
  }
  if (err instanceof Error) {
    return new TRPCError({
      code: 'INTERNAL_SERVER_ERROR',
      message: `${operation} failed: ${err.message}`,
      cause: err,
    });
  }
  return new TRPCError({
    code: 'INTERNAL_SERVER_ERROR',
    message: `${operation} failed: ${String(err)}`,
  });
}

export const documentRouter = t.router({
  /** 检查 officecli 是否已安装且可用。 */
  checkInstalled: t.procedure.query(() => {
    return { installed: checkInstalled() };
  }),

  /** 获取 officecli 版本号。 */
  getVersion: t.procedure.query(async () => {
    try {
      const version = await getVersion();
      return { version };
    } catch (err) {
      throw toTrpcError(err, 'getVersion');
    }
  }),

  /** 渲染文档为 HTML，返回 HTML 文件路径。 */
  viewHtml: t.procedure
    .input((raw): { filePath: string; outputDir?: string } => {
      const r = raw as Record<string, unknown>;
      if (typeof r.filePath !== 'string' || r.filePath.length === 0) {
        throw new TRPCError({ code: 'BAD_REQUEST', message: 'filePath is required' });
      }
      const outputDir = typeof r.outputDir === 'string' ? r.outputDir : undefined;
      return { filePath: r.filePath, outputDir };
    })
    .mutation(async ({ input }) => {
      try {
        const htmlPath = await viewHtml(input.filePath, input.outputDir);
        return { htmlPath };
      } catch (err) {
        throw toTrpcError(err, 'viewHtml');
      }
    }),

  /** 渲染文档为 PNG 截图，返回 PNG 文件路径数组。 */
  viewScreenshot: t.procedure
    .input((raw): { filePath: string; outputDir: string; page?: number } => {
      const r = raw as Record<string, unknown>;
      if (typeof r.filePath !== 'string' || r.filePath.length === 0) {
        throw new TRPCError({ code: 'BAD_REQUEST', message: 'filePath is required' });
      }
      if (typeof r.outputDir !== 'string' || r.outputDir.length === 0) {
        throw new TRPCError({ code: 'BAD_REQUEST', message: 'outputDir is required' });
      }
      const page = typeof r.page === 'number' ? r.page : undefined;
      return { filePath: r.filePath, outputDir: r.outputDir, page };
    })
    .mutation(async ({ input }) => {
      try {
        const paths = await viewScreenshot(input.filePath, input.outputDir, input.page);
        return { paths };
      } catch (err) {
        throw toTrpcError(err, 'viewScreenshot');
      }
    }),

  /** 启动 watch 模式，返回 watch id 和 url。 */
  watchStart: t.procedure
    .input((raw): { filePath: string; port?: number } => {
      const r = raw as Record<string, unknown>;
      if (typeof r.filePath !== 'string' || r.filePath.length === 0) {
        throw new TRPCError({ code: 'BAD_REQUEST', message: 'filePath is required' });
      }
      const port = typeof r.port === 'number' ? r.port : undefined;
      return { filePath: r.filePath, port };
    })
    .mutation(async ({ input }) => {
      try {
        const info = await watchStart(input.filePath, input.port);
        return info;
      } catch (err) {
        throw toTrpcError(err, 'watchStart');
      }
    }),

  /** 停止指定 watch 进程。 */
  watchStop: t.procedure
    .input((raw): { watchId: string } => {
      const r = raw as Record<string, unknown>;
      if (typeof r.watchId !== 'string' || r.watchId.length === 0) {
        throw new TRPCError({ code: 'BAD_REQUEST', message: 'watchId is required' });
      }
      return { watchId: r.watchId };
    })
    .mutation(({ input }) => {
      const stopped = watchStop(input.watchId);
      return { stopped };
    }),

  /** 停止所有 watch 进程，返回停止的数量。 */
  watchStopAll: t.procedure.mutation(() => {
    const count = watchStopAll();
    return { stopped: count };
  }),

  /** 列出当前活跃的 watch 进程。 */
  listWatches: t.procedure.query(() => {
    return { watches: listWatches() };
  }),

  /** 读取图片文件为 base64 data URL。 */
  readImageAsDataURL: t.procedure
    .input((raw): { filePath: string } => {
      const r = raw as Record<string, unknown>;
      if (typeof r.filePath !== 'string' || r.filePath.length === 0) {
        throw new TRPCError({ code: 'BAD_REQUEST', message: 'filePath is required' });
      }
      return { filePath: r.filePath };
    })
    .query(({ input }) => {
      try {
        const dataUrl = readImageAsDataURL(input.filePath);
        return { dataUrl };
      } catch (err) {
        throw toTrpcError(err, 'readImageAsDataURL');
      }
    }),

  /** 读取 xlsx 文件并转为 Fortune-sheet 工作簿数据。 */
  loadXlsx: t.procedure
    .input((raw): { filePath: string } => {
      const r = raw as Record<string, unknown>;
      if (typeof r.filePath !== 'string' || r.filePath.length === 0) {
        throw new TRPCError({ code: 'BAD_REQUEST', message: 'filePath is required' });
      }
      return { filePath: r.filePath };
    })
    .query(async ({ input }) => {
      try {
        const workbook = await readXlsxWorkbook(input.filePath);
        const data = excelToFortune(workbook);
        return { workbook: data };
      } catch (err) {
        if (err instanceof TRPCError) throw err;
        throw toTrpcError(err, 'loadXlsx');
      }
    }),

  /** 将 Fortune-sheet 工作簿数据写回 xlsx 文件。 */
  saveXlsx: t.procedure
    .input((raw): { filePath: string; workbook: WorkbookData } => {
      const r = raw as Record<string, unknown>;
      if (typeof r.filePath !== 'string' || r.filePath.length === 0) {
        throw new TRPCError({ code: 'BAD_REQUEST', message: 'filePath is required' });
      }
      if (typeof r.workbook !== 'object' || r.workbook === null || !Array.isArray((r.workbook as { sheets?: unknown }).sheets)) {
        throw new TRPCError({ code: 'BAD_REQUEST', message: 'workbook is required' });
      }
      return { filePath: r.filePath, workbook: r.workbook as WorkbookData };
    })
    .mutation(async ({ input }) => {
      try {
        const workbook = await fortuneToExcel(input.workbook);
        await workbook.xlsx.writeFile(input.filePath);
        return { success: true };
      } catch (err) {
        if (err instanceof TRPCError) throw err;
        throw toTrpcError(err, 'saveXlsx');
      }
    }),

  /** 注册文件正在前端编辑（XlsxEditor mount 时调用）。 */
  registerEditor: t.procedure
    .input((raw): { filePath: string } => {
      const r = raw as Record<string, unknown>;
      if (typeof r.filePath !== 'string' || r.filePath.length === 0) {
        throw new TRPCError({ code: 'BAD_REQUEST', message: 'filePath is required' });
      }
      return { filePath: r.filePath };
    })
    .mutation(({ input }) => {
      registerEditor(input.filePath);
      return { registered: true };
    }),

  /** 注销文件的前端编辑状态（XlsxEditor unmount 时调用）。 */
  unregisterEditor: t.procedure
    .input((raw): { filePath: string } => {
      const r = raw as Record<string, unknown>;
      if (typeof r.filePath !== 'string' || r.filePath.length === 0) {
        throw new TRPCError({ code: 'BAD_REQUEST', message: 'filePath is required' });
      }
      return { filePath: r.filePath };
    })
    .mutation(({ input }) => {
      unregisterEditor(input.filePath);
      return { unregistered: true };
    }),

  /** 前端 flush 完成后回复主进程（XlsxEditor 立即保存后调用）。 */
  flushDone: t.procedure
    .input((raw): { filePath: string } => {
      const r = raw as Record<string, unknown>;
      if (typeof r.filePath !== 'string' || r.filePath.length === 0) {
        throw new TRPCError({ code: 'BAD_REQUEST', message: 'filePath is required' });
      }
      return { filePath: r.filePath };
    })
    .mutation(({ input }) => {
      notifyFlushDone(input.filePath);
      return { flushed: true };
    }),

  /**
   * 下载 officecli 二进制（仅开发模式）。
   *
   * 调用 scripts/download-officecli.mjs 脚本，通过 'officecli:download-progress'
   * IPC 事件推送进度（stage、message、percent）。
   *
   * 生产模式返回错误，提示用户通过应用安装包获取 officecli。
   */
  downloadBinary: t.procedure.mutation(async () => {
    const result = await downloadOfficeCliBinary(devDownloadScriptPath());
    if (!result.success) {
      throw new TRPCError({
        code: 'INTERNAL_SERVER_ERROR',
        message: result.error ?? 'Download failed',
      });
    }
    return { success: true, path: result.path };
  }),
});
