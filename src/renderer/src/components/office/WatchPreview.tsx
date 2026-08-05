/**
 * WatchPreview — 用 Document Surface (WebContentsView) 加载 officecli watch 模式启动的本地 HTTP 服务。
 *
 * 流程：
 *   1. 调用 trpc.document.watchStart.mutate({ filePath }) 获取 { id, url }
 *   2. 用 SurfaceLayer (kind='document', source='local-server') 加载 http://localhost:PORT
 *   3. 组件卸载时调用 trpc.document.watchStop.mutate({ watchId: id }) 停止 watch
 *   4. SurfaceHost unmount 时自动销毁 Document Surface
 *
 * 生命周期协调（ADR 0016 Issue #4）：
 *   - 模式切换 / 标签关闭 / 窗口关闭 → 组件 unmount → watchStop + surface destroy
 *   - 启动竞态：watchStart 尚未完成时切走 → cancelled 标志 → 成功返回后立即 watchStop
 *   - 启动失败 → 显示错误占位，不创建 Surface
 *   - 重复销毁安全：watchStop 对不存在 id 返回 false，bridge.destroy 对不存在 surface 无操作
 *
 * watch 模式支持文档热更新：officecli 内部通过 WebSocket 推送文件变更刷新。
 *
 * 迁移自旧 <webview> 实现（ADR 0016 Issue #4）。
 */
import { useEffect, useRef, useState } from 'react';
import { trpc } from '@renderer/lib/trpc';
import { SurfaceLayer } from '@renderer/components/surface/SurfaceLayer';

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
          // 组件已卸载：watch 已无意义，立即停止避免泄漏进程
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

  // Document Surface 加载 local-server (localhost) URL
  // surfaceId 包含 watchId 以确保唯一性；SurfaceHost unmount 时自动销毁 Surface
  return (
    <SurfaceLayer
      surfaceId={`doc-watch:${state.watchId}`}
      kind="document"
      source={{ type: 'local-server', url: state.url }}
      visible
    />
  );
}
