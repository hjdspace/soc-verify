/**
 * WatchPreview — 用 webview 加载 officecli watch 模式启动的本地 HTTP 服务。
 *
 * 流程：
 *   1. 调用 trpc.document.watchStart.mutate({ filePath }) 获取 { id, url }
 *   2. 用 <webview> 加载 http://localhost:PORT 的 url
 *   3. 组件卸载时调用 trpc.document.watchStop.mutate({ watchId: id }) 停止 watch
 *
 * watch 模式支持文档热更新：源文件改动后浏览器自动刷新。
 */
import { useEffect, useRef, useState } from 'react';
import { trpc } from '@renderer/lib/trpc';

export type WatchPreviewProps = {
  filePath: string;
};

type WatchState =
  | { status: 'starting' }
  | { status: 'ready'; watchId: string; url: string }
  | { status: 'error'; message: string };

export function WatchPreview({ filePath }: WatchPreviewProps) {
  const [state, setState] = useState<WatchState>({ status: 'starting' });
  // 用 ref 持有当前 watchId，确保卸载时能拿到最新值并 stop
  const watchIdRef = useRef<string | null>(null);

  useEffect(() => {
    let cancelled = false;

    trpc.document.watchStart
      .mutate({ filePath })
      .then((info) => {
        if (cancelled) {
          // 组件已卸载：watch 已无意义，立即停止避免泄漏
          void trpc.document.watchStop.mutate({ watchId: info.id }).catch(() => {});
          return;
        }
        watchIdRef.current = info.id;
        setState({ status: 'ready', watchId: info.id, url: info.url });
      })
      .catch((err: unknown) => {
        if (cancelled) return;
        const message = err instanceof Error ? err.message : String(err);
        setState({ status: 'error', message });
      });

    return () => {
      cancelled = true;
      const id = watchIdRef.current;
      if (id) {
        // 卸载时停止 watch，best-effort（失败不影响 UI）
        void trpc.document.watchStop.mutate({ watchId: id }).catch(() => {});
        watchIdRef.current = null;
      }
    };
  }, [filePath]);

  if (state.status === 'starting') {
    return (
      <div className="flex flex-1 items-center justify-center text-xs text-muted-foreground">
        启动 watch 服务...
      </div>
    );
  }

  if (state.status === 'error') {
    return (
      <div className="flex flex-1 flex-col items-center justify-center gap-1 text-xs text-status-fail-foreground">
        <span>watch 启动失败</span>
        <span className="max-w-md text-center text-[11px] text-muted-foreground">
          {state.message}
        </span>
      </div>
    );
  }

  return (
    <webview
      src={state.url}
      partition="persist:office-preview"
      className="h-full w-full flex-1 border-0"
    />
  );
}
