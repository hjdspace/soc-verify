/**
 * XlsxEditor 组件测试。
 *
 * 验证：
 *  - mount 时调用 document.loadXlsx 加载数据
 *  - 加载中 / 加载完成 / 加载失败的状态展示
 *  - Fortune-sheet Workbook 渲染（通过 mock 验证 data 传递）
 *  - onChange 防抖 2 秒后调用 document.saveXlsx
 *  - 保存中 / 已保存 / 保存失败的状态展示
 *
 * Fortune-sheet 的 Workbook 组件依赖 canvas 等 jsdom 不支持的 API，
 * 通过 vi.mock 替换为仅暴露 data-testid 的占位组件。
 */
// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, waitFor, act } from '@testing-library/react';
import type { Sheet } from '@fortune-sheet/core';

// ── mock Fortune-sheet Workbook ──────────────────────────────
// 用 hoisted 容器保存 onChange 回调，让测试可以手动触发 onChange
const { onChangeRef } = vi.hoisted(() => ({
  onChangeRef: { current: null as ((data: Sheet[]) => void) | null },
}));

vi.mock('@fortune-sheet/react', () => ({
  Workbook: ({ data, onChange }: { data: Sheet[]; onChange?: (data: Sheet[]) => void }) => {
    // 捕获 onChange 回调，供测试触发
    onChangeRef.current = onChange ?? null;
    return (
      <div
        data-testid="fortune-workbook"
        data-sheet-count={data?.length ?? 0}
      >
        FortuneSheet Mock
      </div>
    );
  },
}));

// ── mock tRPC ────────────────────────────────────────────────
const { loadXlsxMock, saveXlsxMock } = vi.hoisted(() => ({
  loadXlsxMock: vi.fn(),
  saveXlsxMock: vi.fn(),
}));

vi.mock('@renderer/lib/trpc', () => ({
  trpc: {
    document: {
      loadXlsx: { query: loadXlsxMock },
      saveXlsx: { mutate: saveXlsxMock },
    },
  },
}));

import { XlsxEditor } from '@renderer/components/office/XlsxEditor';

/** 模拟用户编辑触发 Fortune-sheet onChange 回调 */
function triggerOnChange(data: Sheet[]): void {
  act(() => {
    onChangeRef.current?.(data);
  });
}

describe('XlsxEditor', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    onChangeRef.current = null;
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  // ─── 加载状态（真实 timers，Promise 正常 resolve）────────

  describe('加载状态', () => {
    it('加载中显示加载状态', () => {
      loadXlsxMock.mockReturnValue(new Promise(() => {}));

      render(<XlsxEditor filePath="/tmp/sheet.xlsx" />);

      expect(screen.getByText(/加载中/)).toBeInTheDocument();
      expect(screen.queryByTestId('fortune-workbook')).not.toBeInTheDocument();
    });

    it('加载完成后渲染 Fortune-sheet Workbook', async () => {
      const workbook = {
        name: 'Workbook',
        sheets: [{ name: 'Sheet1', celldata: [] }],
      };
      loadXlsxMock.mockResolvedValue({ workbook });

      render(<XlsxEditor filePath="/tmp/sheet.xlsx" />);

      await waitFor(() => {
        expect(screen.getByTestId('fortune-workbook')).toBeInTheDocument();
      });
      expect(screen.getByTestId('fortune-workbook')).toHaveAttribute('data-sheet-count', '1');
    });

    it('加载失败显示错误信息', async () => {
      loadXlsxMock.mockRejectedValue(new Error('File not found'));

      render(<XlsxEditor filePath="/tmp/missing.xlsx" />);

      await waitFor(() => {
        expect(screen.getByText(/加载失败/)).toBeInTheDocument();
      });
      expect(screen.queryByTestId('fortune-workbook')).not.toBeInTheDocument();
    });

    it('loadXlsx 接收正确的 filePath 入参', async () => {
      loadXlsxMock.mockResolvedValue({
        workbook: { name: 'Workbook', sheets: [] },
      });

      render(<XlsxEditor filePath="/path/to/data.xlsx" />);

      await waitFor(() => {
        expect(loadXlsxMock).toHaveBeenCalledWith({ filePath: '/path/to/data.xlsx' });
      });
    });
  });

  // ─── 自动保存（防抖 2 秒，使用 fake timers）──────────────

  describe('自动保存', () => {
    beforeEach(() => {
      vi.useFakeTimers();
    });

    it('onChange 后防抖 2 秒调用 saveXlsx', async () => {
      const workbook = {
        name: 'Workbook',
        sheets: [{ name: 'Sheet1', celldata: [] }],
      };
      loadXlsxMock.mockResolvedValue({ workbook });
      saveXlsxMock.mockResolvedValue({ success: true });

      render(<XlsxEditor filePath="/tmp/sheet.xlsx" />);

      // 刷新微任务让 loadXlsx resolve
      await vi.advanceTimersByTimeAsync(0);
      expect(screen.getByTestId('fortune-workbook')).toBeInTheDocument();

      // 模拟用户编辑触发 onChange
      triggerOnChange([{ name: 'Sheet1', celldata: [{ r: 0, c: 0, v: { v: 'new', m: 'new' } }] }]);

      // 防抖窗口内不应调用 saveXlsx
      expect(saveXlsxMock).not.toHaveBeenCalled();

      // 推进 2 秒触发防抖
      await vi.advanceTimersByTimeAsync(2000);

      expect(saveXlsxMock).toHaveBeenCalledTimes(1);
      expect(saveXlsxMock).toHaveBeenCalledWith({
        filePath: '/tmp/sheet.xlsx',
        workbook: expect.objectContaining({
          name: 'Workbook',
          sheets: expect.any(Array),
        }),
      });
    });

    it('连续编辑只触发一次保存（防抖）', async () => {
      const workbook = {
        name: 'Workbook',
        sheets: [{ name: 'Sheet1', celldata: [] }],
      };
      loadXlsxMock.mockResolvedValue({ workbook });
      saveXlsxMock.mockResolvedValue({ success: true });

      render(<XlsxEditor filePath="/tmp/sheet.xlsx" />);

      await vi.advanceTimersByTimeAsync(0);
      expect(screen.getByTestId('fortune-workbook')).toBeInTheDocument();

      // 连续触发 3 次 onChange，每次间隔 500ms（均在 2 秒防抖窗口内）
      triggerOnChange([{ name: 'Sheet1', celldata: [] }]);
      await vi.advanceTimersByTimeAsync(500);
      triggerOnChange([{ name: 'Sheet1', celldata: [] }]);
      await vi.advanceTimersByTimeAsync(500);
      triggerOnChange([{ name: 'Sheet1', celldata: [] }]);

      expect(saveXlsxMock).not.toHaveBeenCalled();

      // 最后一次 onChange 后 2 秒触发保存
      await vi.advanceTimersByTimeAsync(2000);

      expect(saveXlsxMock).toHaveBeenCalledTimes(1);
    });
  });

  // ─── 保存状态指示器（使用 fake timers）──────────────────

  describe('保存状态指示器', () => {
    beforeEach(() => {
      vi.useFakeTimers();
    });

    it('保存中显示保存状态', async () => {
      const workbook = {
        name: 'Workbook',
        sheets: [{ name: 'Sheet1', celldata: [] }],
      };
      loadXlsxMock.mockResolvedValue({ workbook });
      // saveXlsx 永不 resolve，保持 saving 状态
      saveXlsxMock.mockReturnValue(new Promise(() => {}));

      render(<XlsxEditor filePath="/tmp/sheet.xlsx" />);

      await vi.advanceTimersByTimeAsync(0);
      expect(screen.getByTestId('fortune-workbook')).toBeInTheDocument();

      triggerOnChange([{ name: 'Sheet1', celldata: [] }]);
      await vi.advanceTimersByTimeAsync(2000);
      // 刷新微任务让 setSaveState('saving') 渲染到 DOM
      await vi.advanceTimersByTimeAsync(0);

      expect(screen.getByText(/保存中/)).toBeInTheDocument();
    });

    it('保存完成显示已保存状态', async () => {
      const workbook = {
        name: 'Workbook',
        sheets: [{ name: 'Sheet1', celldata: [] }],
      };
      loadXlsxMock.mockResolvedValue({ workbook });
      saveXlsxMock.mockResolvedValue({ success: true });

      render(<XlsxEditor filePath="/tmp/sheet.xlsx" />);

      await vi.advanceTimersByTimeAsync(0);
      expect(screen.getByTestId('fortune-workbook')).toBeInTheDocument();

      triggerOnChange([{ name: 'Sheet1', celldata: [] }]);
      await vi.advanceTimersByTimeAsync(2000);

      // 刷新微任务让 saveXlsx resolve
      await vi.advanceTimersByTimeAsync(0);

      expect(screen.getByText(/已保存/)).toBeInTheDocument();
    });

    it('保存失败显示错误状态', async () => {
      const workbook = {
        name: 'Workbook',
        sheets: [{ name: 'Sheet1', celldata: [] }],
      };
      loadXlsxMock.mockResolvedValue({ workbook });
      saveXlsxMock.mockRejectedValue(new Error('Permission denied'));

      render(<XlsxEditor filePath="/tmp/sheet.xlsx" />);

      await vi.advanceTimersByTimeAsync(0);
      expect(screen.getByTestId('fortune-workbook')).toBeInTheDocument();

      triggerOnChange([{ name: 'Sheet1', celldata: [] }]);
      await vi.advanceTimersByTimeAsync(2000);
      await vi.advanceTimersByTimeAsync(0);

      expect(screen.getByText(/保存失败/)).toBeInTheDocument();
    });
  });
});
