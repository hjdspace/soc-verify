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
 *
 * officecli 不可用时，procedure 返回明确的 `OfficeCLI not available` 错误
 * （TRPCError INTERNAL_SERVER_ERROR with cause），不抛未捕获异常。
 */

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
});
