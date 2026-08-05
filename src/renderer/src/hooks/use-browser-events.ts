/**
 * useBrowserEvents — listens for browser-related IPC events from the main process.
 *
 * Issue #9: Handle window.open → new tab routing and auth popup notifications.
 * Issue #10: Handle download lifecycle events (start/progress/complete/fail/cancel).
 *
 * This hook should be called once at the app root level.
 */
import { useEffect, useRef } from 'react';
import { useToastStore } from '@renderer/stores/toast';
import { openInBrowser } from '@renderer/lib/browser-actions';

export function useBrowserEvents(): void {
  const toast = useToastStore();
  const activeDownloads = useRef<Map<string, string>>(new Map()); // filename → toast tracking

  useEffect(() => {
    // Issue #9: window.open → new browser tab (uses unified openInBrowser seam)
    const unlistenNewTab = window.eventBridge?.onBrowserOpenNewTab((data) => {
      openInBrowser(data.url);
    });

    // Issue #9: Auth popup notifications
    const unlistenAuthPopup = window.eventBridge?.onAuthPopup((data) => {
      if (data.type === 'opened') {
        toast.info('认证窗口已打开', data.url);
      }
      // 'closed' is silently handled — the popup is destroyed by the main process
    });

    // Issue #10: Download lifecycle events
    const unlistenDownload = window.eventBridge?.onDownloadEvent((data) => {
      switch (data.type) {
        case 'started':
          activeDownloads.current.set(data.filename, data.filename);
          toast.info('下载已开始', data.filename);
          break;
        case 'completed':
          activeDownloads.current.delete(data.filename);
          toast.success('下载完成', `${data.filename} 已保存到 ${data.savedPath ?? '下载文件夹'}`);
          break;
        case 'failed':
          activeDownloads.current.delete(data.filename);
          toast.error('下载失败', `${data.filename}: ${data.error ?? '未知错误'}`);
          break;
        case 'cancelled':
          activeDownloads.current.delete(data.filename);
          // Cancelled downloads don't show an error — user intentionally cancelled
          break;
        // 'progress' events are silently handled (no toast spam)
      }
    });

    return () => {
      unlistenNewTab?.();
      unlistenAuthPopup?.();
      unlistenDownload?.();
    };
  }, [toast]);
}
