/**
 * document-router 端到端测试。
 *
 * 测试缝：tRPC server-side caller（router.createCaller）。
 * mock officecli service 层（viewHtml / viewScreenshot / watchStart / 等），
 * 验证 procedure 的输入校验、成功路径、officecli 不可用降级。
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

// Mock service 层（避免真实 officecli 调用）
vi.mock('../../src/main/officecli/service', () => ({
  checkInstalled: vi.fn(),
  getVersion: vi.fn(),
  viewHtml: vi.fn(),
  viewScreenshot: vi.fn(),
  watchStart: vi.fn(),
  watchStop: vi.fn(),
  watchStopAll: vi.fn(),
  listWatches: vi.fn(),
  readImageAsDataURL: vi.fn(),
}));

// Mock executor 的 OfficeCliNotAvailableError（用于 service 层抛出后由 router 捕获）
vi.mock('../../src/main/officecli/executor', () => ({
  OfficeCliNotAvailableError: class OfficeCliNotAvailableError extends Error {
    constructor() {
      super('OfficeCLI not available');
      this.name = 'OfficeCliNotAvailableError';
    }
  },
}));

// Mock exceljs：构造函数返回带 xlsx.readFile/writeFile 的实例
const { ExcelJSWorkbookMock } = vi.hoisted(() => {
  const instance = {
    xlsx: {
      readFile: vi.fn(),
      writeFile: vi.fn(),
    },
  };
  return {
    ExcelJSWorkbookMock: {
      instance,
      // 使用常规 function 而非箭头函数，使其可被 new 调用
      ctor: vi.fn(function () {
        return instance;
      }),
    },
  };
});

vi.mock('exceljs', () => ({
  default: { Workbook: ExcelJSWorkbookMock.ctor },
}));

// Mock fortune-sheet-bridge：隔离 exceljs ↔ fortune-sheet 转换逻辑
const { excelToFortuneMock, fortuneToExcelMock } = vi.hoisted(() => ({
  excelToFortuneMock: vi.fn(),
  fortuneToExcelMock: vi.fn(),
}));

vi.mock('../../src/main/document/fortune-sheet-bridge', () => ({
  excelToFortune: excelToFortuneMock,
  fortuneToExcel: fortuneToExcelMock,
}));

import { documentRouter } from '../../src/main/ipc/routers/document-router';
import * as service from '../../src/main/officecli/service';

const caller = documentRouter.createCaller({});

const mocked = {
  checkInstalled: vi.mocked(service.checkInstalled),
  getVersion: vi.mocked(service.getVersion),
  viewHtml: vi.mocked(service.viewHtml),
  viewScreenshot: vi.mocked(service.viewScreenshot),
  watchStart: vi.mocked(service.watchStart),
  watchStop: vi.mocked(service.watchStop),
  watchStopAll: vi.mocked(service.watchStopAll),
  listWatches: vi.mocked(service.listWatches),
  readImageAsDataURL: vi.mocked(service.readImageAsDataURL),
};

/** 提取 TRPCError 的 message 用于断言 */
async function trpcError(fn: () => Promise<unknown>): Promise<{ message: string }> {
  try {
    await fn();
    throw new Error('Expected procedure to throw, but it succeeded');
  } catch (err) {
    if (err instanceof Error) {
      return { message: err.message };
    }
    throw err;
  }
}

describe('document-router', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  // ─── checkInstalled ────────────────────────────────────────

  describe('checkInstalled', () => {
    it('officecli 可用时返回 installed=true', async () => {
      mocked.checkInstalled.mockReturnValue(true);
      const result = await caller.checkInstalled();
      expect(result).toEqual({ installed: true });
    });

    it('officecli 不可用时返回 installed=false', async () => {
      mocked.checkInstalled.mockReturnValue(false);
      const result = await caller.checkInstalled();
      expect(result).toEqual({ installed: false });
    });
  });

  // ─── getVersion ────────────────────────────────────────────

  describe('getVersion', () => {
    it('返回 officecli 版本号', async () => {
      mocked.getVersion.mockResolvedValue('officecli 1.0.143');
      const result = await caller.getVersion();
      expect(result).toEqual({ version: 'officecli 1.0.143' });
    });

    it('officecli 不可用时返回明确错误', async () => {
      const { OfficeCliNotAvailableError } = await import('../../src/main/officecli/executor');
      mocked.getVersion.mockRejectedValue(new OfficeCliNotAvailableError());
      const err = await trpcError(() => caller.getVersion());
      expect(err.message).toBe('OfficeCLI not available');
    });

    it('版本检查失败时返回错误信息', async () => {
      mocked.getVersion.mockRejectedValue(new Error('Version check failed: exit code 1'));
      const err = await trpcError(() => caller.getVersion());
      expect(err.message).toContain('getVersion failed');
    });
  });

  // ─── viewHtml ──────────────────────────────────────────────

  describe('viewHtml', () => {
    it('渲染成功返回 htmlPath', async () => {
      mocked.viewHtml.mockResolvedValue('/tmp/doc.html');
      const result = await caller.viewHtml({ filePath: '/docs/test.docx' });
      expect(result).toEqual({ htmlPath: '/tmp/doc.html' });
      expect(mocked.viewHtml).toHaveBeenCalledWith('/docs/test.docx', undefined);
    });

    it('传入 outputDir 时透传给 service', async () => {
      mocked.viewHtml.mockResolvedValue('/output/test.html');
      await caller.viewHtml({ filePath: '/docs/test.docx', outputDir: '/output' });
      expect(mocked.viewHtml).toHaveBeenCalledWith('/docs/test.docx', '/output');
    });

    it('缺少 filePath 时返回 BAD_REQUEST', async () => {
      const err = await trpcError(() => caller.viewHtml({ filePath: '' }));
      expect(err.message).toContain('filePath is required');
    });

    it('officecli 不可用时返回明确错误', async () => {
      const { OfficeCliNotAvailableError } = await import('../../src/main/officecli/executor');
      mocked.viewHtml.mockRejectedValue(new OfficeCliNotAvailableError());
      const err = await trpcError(() => caller.viewHtml({ filePath: '/docs/test.docx' }));
      expect(err.message).toBe('OfficeCLI not available');
    });

    it('渲染失败时返回错误信息', async () => {
      mocked.viewHtml.mockRejectedValue(new Error('HTML render failed: exit 1'));
      const err = await trpcError(() => caller.viewHtml({ filePath: '/docs/test.docx' }));
      expect(err.message).toContain('viewHtml failed');
    });
  });

  // ─── viewScreenshot ────────────────────────────────────────

  describe('viewScreenshot', () => {
    it('渲染成功返回 paths 数组', async () => {
      mocked.viewScreenshot.mockResolvedValue(['/output/test-page-1.png']);
      const result = await caller.viewScreenshot({
        filePath: '/docs/test.pptx',
        outputDir: '/output',
      });
      expect(result).toEqual({ paths: ['/output/test-page-1.png'] });
    });

    it('传入 page 时透传给 service', async () => {
      mocked.viewScreenshot.mockResolvedValue(['/output/test-page-2.png']);
      await caller.viewScreenshot({
        filePath: '/docs/test.pptx',
        outputDir: '/output',
        page: 2,
      });
      expect(mocked.viewScreenshot).toHaveBeenCalledWith('/docs/test.pptx', '/output', 2);
    });

    it('缺少 outputDir 时返回 BAD_REQUEST', async () => {
      const err = await trpcError(() =>
        caller.viewScreenshot({ filePath: '/docs/test.pptx', outputDir: '' }),
      );
      expect(err.message).toContain('outputDir is required');
    });

    it('officecli 不可用时返回明确错误', async () => {
      const { OfficeCliNotAvailableError } = await import('../../src/main/officecli/executor');
      mocked.viewScreenshot.mockRejectedValue(new OfficeCliNotAvailableError());
      const err = await trpcError(() =>
        caller.viewScreenshot({ filePath: '/docs/test.pptx', outputDir: '/output' }),
      );
      expect(err.message).toBe('OfficeCLI not available');
    });
  });

  // ─── watchStart / watchStop / watchStopAll / listWatches ───

  describe('watchStart', () => {
    it('启动成功返回 watch 信息', async () => {
      mocked.watchStart.mockResolvedValue({
        id: 'watch-123',
        filePath: '/docs/test.docx',
        port: 26315,
        url: 'http://localhost:26315',
      });
      const result = await caller.watchStart({ filePath: '/docs/test.docx' });
      expect(result).toEqual({
        id: 'watch-123',
        filePath: '/docs/test.docx',
        port: 26315,
        url: 'http://localhost:26315',
      });
    });

    it('传入 port 时透传给 service', async () => {
      mocked.watchStart.mockResolvedValue({
        id: 'watch-456',
        filePath: '/docs/test.docx',
        port: 8080,
        url: 'http://localhost:8080',
      });
      await caller.watchStart({ filePath: '/docs/test.docx', port: 8080 });
      expect(mocked.watchStart).toHaveBeenCalledWith('/docs/test.docx', 8080);
    });

    it('缺少 filePath 时返回 BAD_REQUEST', async () => {
      const err = await trpcError(() => caller.watchStart({ filePath: '' }));
      expect(err.message).toContain('filePath is required');
    });

    it('officecli 不可用时返回明确错误', async () => {
      const { OfficeCliNotAvailableError } = await import('../../src/main/officecli/executor');
      mocked.watchStart.mockRejectedValue(new OfficeCliNotAvailableError());
      const err = await trpcError(() => caller.watchStart({ filePath: '/docs/test.docx' }));
      expect(err.message).toBe('OfficeCLI not available');
    });
  });

  describe('watchStop', () => {
    it('停止存在的 watch 返回 stopped=true', async () => {
      mocked.watchStop.mockReturnValue(true);
      const result = await caller.watchStop({ watchId: 'watch-123' });
      expect(result).toEqual({ stopped: true });
    });

    it('停止不存在的 watch 返回 stopped=false', async () => {
      mocked.watchStop.mockReturnValue(false);
      const result = await caller.watchStop({ watchId: 'unknown' });
      expect(result).toEqual({ stopped: false });
    });

    it('缺少 watchId 时返回 BAD_REQUEST', async () => {
      const err = await trpcError(() => caller.watchStop({ watchId: '' }));
      expect(err.message).toContain('watchId is required');
    });
  });

  describe('watchStopAll', () => {
    it('返回停止的 watch 数量', async () => {
      mocked.watchStopAll.mockReturnValue(3);
      const result = await caller.watchStopAll();
      expect(result).toEqual({ stopped: 3 });
    });
  });

  describe('listWatches', () => {
    it('返回当前活跃的 watch 列表', async () => {
      mocked.listWatches.mockReturnValue([
        { id: 'watch-1', filePath: '/docs/a.docx', port: 26315, url: 'http://localhost:26315' },
        { id: 'watch-2', filePath: '/docs/b.docx', port: 26316, url: 'http://localhost:26316' },
      ]);
      const result = await caller.listWatches();
      expect(result.watches).toHaveLength(2);
      expect(result.watches[0].id).toBe('watch-1');
    });
  });

  // ─── readImageAsDataURL ────────────────────────────────────

  describe('readImageAsDataURL', () => {
    it('返回 base64 data URL', async () => {
      mocked.readImageAsDataURL.mockReturnValue('data:image/png;base64,iVBORw0KGgo=');
      const result = await caller.readImageAsDataURL({ filePath: '/tmp/screenshot.png' });
      expect(result).toEqual({ dataUrl: 'data:image/png;base64,iVBORw0KGgo=' });
    });

    it('缺少 filePath 时返回 BAD_REQUEST', async () => {
      const err = await trpcError(() => caller.readImageAsDataURL({ filePath: '' }));
      expect(err.message).toContain('filePath is required');
    });

    it('文件不存在时返回错误', async () => {
      mocked.readImageAsDataURL.mockImplementation(() => {
        throw new Error('Image file not found: /tmp/missing.png');
      });
      const err = await trpcError(() =>
        caller.readImageAsDataURL({ filePath: '/tmp/missing.png' }),
      );
      expect(err.message).toContain('readImageAsDataURL failed');
      expect(err.message).toContain('Image file not found');
    });
  });

  // ─── loadXlsx ──────────────────────────────────────────────

  describe('loadXlsx', () => {
    it('读取 xlsx 文件并返回 Fortune-sheet 工作簿数据', async () => {
      ExcelJSWorkbookMock.instance.xlsx.readFile.mockResolvedValue(undefined);
      const fortuneData = { name: 'Workbook', sheets: [{ name: 'Sheet1', celldata: [] }] };
      excelToFortuneMock.mockReturnValue(fortuneData);

      const result = await caller.loadXlsx({ filePath: '/tmp/sheet.xlsx' });

      expect(ExcelJSWorkbookMock.ctor).toHaveBeenCalledTimes(1);
      expect(ExcelJSWorkbookMock.instance.xlsx.readFile).toHaveBeenCalledWith('/tmp/sheet.xlsx');
      expect(excelToFortuneMock).toHaveBeenCalledTimes(1);
      expect(result).toEqual({ workbook: fortuneData });
    });

    it('缺少 filePath 时返回 BAD_REQUEST', async () => {
      const err = await trpcError(() => caller.loadXlsx({ filePath: '' }));
      expect(err.message).toContain('filePath is required');
    });

    it('文件读取失败时返回错误信息', async () => {
      ExcelJSWorkbookMock.instance.xlsx.readFile.mockRejectedValue(
        new Error('File not found: /tmp/missing.xlsx'),
      );

      const err = await trpcError(() => caller.loadXlsx({ filePath: '/tmp/missing.xlsx' }));
      expect(err.message).toContain('loadXlsx failed');
      expect(err.message).toContain('File not found');
    });
  });

  // ─── saveXlsx ──────────────────────────────────────────────

  describe('saveXlsx', () => {
    it('将 Fortune-sheet 工作簿数据写回 xlsx 文件', async () => {
      const mockWorkbook = { xlsx: { writeFile: vi.fn().mockResolvedValue(undefined) } };
      fortuneToExcelMock.mockResolvedValue(mockWorkbook);
      const workbookData = { name: 'Workbook', sheets: [{ name: 'Sheet1', celldata: [] }] };

      const result = await caller.saveXlsx({
        filePath: '/tmp/sheet.xlsx',
        workbook: workbookData,
      });

      expect(fortuneToExcelMock).toHaveBeenCalledWith(workbookData);
      expect(mockWorkbook.xlsx.writeFile).toHaveBeenCalledWith('/tmp/sheet.xlsx');
      expect(result).toEqual({ success: true });
    });

    it('缺少 filePath 时返回 BAD_REQUEST', async () => {
      const err = await trpcError(() =>
        caller.saveXlsx({ filePath: '', workbook: { name: 'x', sheets: [] } }),
      );
      expect(err.message).toContain('filePath is required');
    });

    it('缺少 workbook 时返回 BAD_REQUEST', async () => {
      const err = await trpcError(() =>
        // @ts-expect-error — 测试缺少 workbook 的非法输入
        caller.saveXlsx({ filePath: '/tmp/sheet.xlsx' }),
      );
      expect(err.message).toContain('workbook is required');
    });

    it('文件写入失败时返回错误信息', async () => {
      const mockWorkbook = {
        xlsx: { writeFile: vi.fn().mockRejectedValue(new Error('Permission denied')) },
      };
      fortuneToExcelMock.mockResolvedValue(mockWorkbook);

      const err = await trpcError(() =>
        caller.saveXlsx({
          filePath: '/readonly/sheet.xlsx',
          workbook: { name: 'x', sheets: [] },
        }),
      );
      expect(err.message).toContain('saveXlsx failed');
      expect(err.message).toContain('Permission denied');
    });
  });
});
