/**
 * XlsxEditor — 基于 Fortune-sheet 的 xlsx 原地编辑器。
 *
 * mount 时调用 document.loadXlsx 加载 xlsx 文件 → Fortune-sheet 数据格式，
 * 用 <Workbook> 渲染电子表格。onChange 回调防抖 2 秒后调用 document.saveXlsx
 * 将当前工作簿数据写回文件，用户无感知，不会丢数据。
 *
 * Issue #7 集成 flush 机制：
 *  - mount 时调用 document.registerEditor 注册文件正在编辑
 *  - unmount 时调用 document.unregisterEditor 注销
 *  - 监听 'document:flush-request' IPC 事件，立即 flush Fortune-sheet 状态
 *    （取消防抖定时器，立即保存），完成后调用 document.flushDone 回复
 *  - 监听 'document:file-changed' IPC 事件，重新加载文件（AI 修改后同步）
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
  /** 文件版本号，AI 修改后递增以触发重载 */
  const [fileVersion, setFileVersion] = useState(0);

  // 用 ref 存储防抖定时器、最新编辑数据和工作簿名，避免闭包过期
  const debounceTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const latestDataRef = useRef<Sheet[]>([]);
  const workbookNameRef = useRef('Workbook');
  const filePathRef = useRef(filePath);
  filePathRef.current = filePath;

  // 加载 xlsx 文件（filePath 或 fileVersion 变化时重新加载）
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
  }, [filePath, fileVersion]);

  // 立即保存（取消防抖定时器，立即执行保存）
  const flushNow = useCallback(async () => {
    const currentFilePath = filePathRef.current;
    if (debounceTimerRef.current) {
      clearTimeout(debounceTimerRef.current);
      debounceTimerRef.current = null;
    }
    setSaveState('saving');
    try {
      await trpc.document.saveXlsx.mutate({
        filePath: currentFilePath,
        workbook: { name: workbookNameRef.current, sheets: latestDataRef.current },
      });
      setSaveState('saved');
    } catch {
      setSaveState('error');
    }
    // 通知主进程 flush 完成
    try {
      await trpc.document.flushDone.mutate({ filePath: currentFilePath });
    } catch {
      // flushDone 失败不影响主流程
    }
  }, []);

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

  // 注册/注销编辑器 + 监听 IPC 事件（flush-request / file-changed）
  useEffect(() => {
    // 注册文件正在前端编辑
    trpc.document.registerEditor.mutate({ filePath }).catch(() => {
      // 注册失败不阻断编辑
    });

    // 监听 flush-request：立即保存并回复 flush-done
    // 通过 window.eventBridge（preload contextBridge 暴露）接收主进程事件
    const unlistenFlush = window.eventBridge?.onDocumentFlushRequest?.((path: string) => {
      if (path === filePath) {
        void flushNow();
      }
    });

    // 监听 file-changed：AI 修改文件后触发重载
    const unlistenFileChanged = window.eventBridge?.onDocumentFileChanged?.((path: string) => {
      if (path === filePath) {
        setFileVersion((v) => v + 1);
      }
    });

    return () => {
      unlistenFlush?.();
      unlistenFileChanged?.();
      // 注销编辑器
      trpc.document.unregisterEditor.mutate({ filePath }).catch(() => {
        // 注销失败不影响主流程
      });
      // 清理防抖定时器
      if (debounceTimerRef.current) {
        clearTimeout(debounceTimerRef.current);
      }
    };
  }, [filePath, flushNow]);

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
            key={`${filePath}-${fileVersion}`}
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
