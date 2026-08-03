/**
 * XlsxEditor — 基于 Fortune-sheet 的 xlsx 原地编辑器。
 *
 * mount 时调用 document.loadXlsx 加载 xlsx 文件 → Fortune-sheet 数据格式，
 * 用 <Workbook> 渲染电子表格。onChange 回调防抖 2 秒后调用 document.saveXlsx
 * 将当前工作簿数据写回文件，用户无感知，不会丢数据。
 *
 * 保存状态指示器：加载中... / 编辑中 / 保存中... / 已保存 / 保存失败
 */

import { useEffect, useState, useRef, useCallback } from 'react';
import { Workbook } from '@fortune-sheet/react';
import type { Sheet } from '@fortune-sheet/core';
import { trpc } from '@renderer/lib/trpc';
import { cn } from '@renderer/lib/utils';

export type XlsxEditorProps = {
  filePath: string;
};

type LoadState = 'loading' | 'loaded' | 'error';
type SaveState = 'idle' | 'saving' | 'saved' | 'error';

/** 防抖延迟（毫秒） */
const SAVE_DEBOUNCE_MS = 2000;

export function XlsxEditor({ filePath }: XlsxEditorProps) {
  const [loadState, setLoadState] = useState<LoadState>('loading');
  const [saveState, setSaveState] = useState<SaveState>('idle');
  const [sheets, setSheets] = useState<Sheet[] | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);

  // 用 ref 存储防抖定时器、最新编辑数据和工作簿名，避免闭包过期
  const debounceTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const latestDataRef = useRef<Sheet[]>([]);
  const workbookNameRef = useRef('Workbook');

  // 加载 xlsx 文件
  useEffect(() => {
    let cancelled = false;
    setLoadState('loading');
    setLoadError(null);
    setSaveState('idle');

    trpc.document.loadXlsx
      .query({ filePath })
      .then((result) => {
        if (cancelled) return;
        setSheets(result.workbook.sheets);
        workbookNameRef.current = result.workbook.name;
        latestDataRef.current = result.workbook.sheets;
        setLoadState('loaded');
      })
      .catch((err) => {
        if (cancelled) return;
        setLoadError(err instanceof Error ? err.message : String(err));
        setLoadState('error');
      });

    return () => {
      cancelled = true;
    };
  }, [filePath]);

  // 防抖保存：onChange 后 2 秒触发 saveXlsx
  const handleChange = useCallback(
    (data: Sheet[]) => {
      latestDataRef.current = data;
      setSaveState('idle');

      if (debounceTimerRef.current) {
        clearTimeout(debounceTimerRef.current);
      }

      debounceTimerRef.current = setTimeout(() => {
        setSaveState('saving');
        trpc.document.saveXlsx
          .mutate({
            filePath,
            workbook: { name: workbookNameRef.current, sheets: latestDataRef.current },
          })
          .then(() => setSaveState('saved'))
          .catch(() => setSaveState('error'));
      }, SAVE_DEBOUNCE_MS);
    },
    [filePath],
  );

  // 卸载时清理防抖定时器
  useEffect(() => {
    return () => {
      if (debounceTimerRef.current) {
        clearTimeout(debounceTimerRef.current);
      }
    };
  }, []);

  if (loadState === 'loading') {
    return (
      <div className="flex flex-1 items-center justify-center text-xs text-muted-foreground">
        加载中...
      </div>
    );
  }

  if (loadState === 'error') {
    return (
      <div className="flex flex-1 flex-col items-center justify-center gap-2 p-6 text-center text-sm text-muted-foreground">
        <div className="font-medium text-destructive">加载失败</div>
        {loadError && <p className="text-xs">{loadError}</p>}
      </div>
    );
  }

  if (loadState === 'loaded' && sheets) {
    return (
      <div className="flex flex-1 flex-col overflow-hidden">
        <div className="flex shrink-0 items-center gap-2 border-b bg-secondary/30 px-3 py-1">
          <span
            className={cn(
              'text-xs',
              saveState === 'error' ? 'text-destructive' : 'text-muted-foreground',
            )}
          >
            {saveState === 'idle' && '编辑中'}
            {saveState === 'saving' && '保存中...'}
            {saveState === 'saved' && '已保存'}
            {saveState === 'error' && '保存失败'}
          </span>
        </div>
        <div className="flex flex-1 overflow-hidden">
          <Workbook
            key={filePath}
            data={sheets}
            onChange={handleChange}
            showToolbar
            showFormulaBar
            showSheetTabs
          />
        </div>
      </div>
    );
  }

  return null;
}
