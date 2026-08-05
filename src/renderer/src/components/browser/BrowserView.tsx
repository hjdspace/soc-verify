/**
 * BrowserView — 浏览器标签容器。
 *
 * 职责：
 *   1. 在 mount 时创建 browser store 条目，unmount 时移除
 *   2. 监听全局 surface 事件，将 URL/title/loading/navigation/failure/crash 投影到 browser store
 *   3. url 为空时显示 NewTabPage（新标签首页）
 *   4. url 非空时显示 NavigationBar + SurfaceLayer（Browser Surface）
 *   5. 提供 onNavigate 回调：标准化 URL → 标签复用检查 → 更新 workbench destination
 *   6. 页面崩溃时显示 React 错误页和手动重载按钮
 *
 * 标签复用：提交 URL 时检查是否已有标签加载了相同标准化 URL，
 * 若有则激活已有标签并关闭当前空标签（仅当当前标签 url 为空时）。
 */
import { useEffect, useCallback } from 'react';
import { AlertCircle, RotateCw, ShieldAlert } from 'lucide-react';
import type { SurfaceEvent } from '@shared/surface-types';
import { useBrowserStore } from '@renderer/stores/browser';
import { useWorkbenchStore } from '@renderer/stores/workbench';
import { SurfaceLayer } from '@renderer/components/surface/SurfaceLayer';
import { NewTabPage } from './NewTabPage';
import { NavigationBar } from './NavigationBar';
import { FindBar } from './FindBar';

export type BrowserViewProps = {
  surfaceId: string;
  url: string;
};

export function BrowserView({ surfaceId, url }: BrowserViewProps) {
  const tab = useBrowserStore((s) => s.tabs[surfaceId]);
  const createTab = useBrowserStore((s) => s.createTab);
  const removeTab = useBrowserStore((s) => s.removeTab);
  const setUrl = useBrowserStore((s) => s.setUrl);
  const applyEvent = useBrowserStore((s) => s.applyEvent);
  const findByUrl = useBrowserStore((s) => s.findByUrl);
  const reloadTab = useBrowserStore((s) => s.reloadTab);
  const clearCertificateError = useBrowserStore((s) => s.clearCertificateError);
  const findActive = useBrowserStore((s) => s.tabs[surfaceId]?.findActive ?? false);

  const openDestination = useWorkbenchStore((s) => s.open);
  const activateTab = useWorkbenchStore((s) => s.activate);
  const closeWorkbenchTab = useWorkbenchStore((s) => s.close);
  const updateTabTitle = useWorkbenchStore((s) => s.updateTabTitle);

  // Create browser store entry on mount, remove on unmount
  useEffect(() => {
    createTab(surfaceId);
    if (url) setUrl(surfaceId, url);
    return () => removeTab(surfaceId);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [surfaceId]);

  // Sync url from props to browser store when it changes
  useEffect(() => {
    if (url && (!tab || tab.url !== url)) {
      setUrl(surfaceId, url);
    }
  }, [surfaceId, url, tab, setUrl]);

  // Listen to surface events for this surface
  useEffect(() => {
    const unlisten = window.eventBridge?.onSurfaceEvent((event) => {
      const surfaceEvent = event as SurfaceEvent;
      if (surfaceEvent.id !== surfaceId) return;
      applyEvent(surfaceEvent);
    });
    return unlisten;
  }, [surfaceId, applyEvent]);

  // Sync browser store title to workbench tab title
  useEffect(() => {
    if (tab?.title) {
      updateTabTitle(`browser:${surfaceId}`, tab.title);
    }
  }, [surfaceId, tab?.title, updateTabTitle]);

  // Navigate to a URL: normalize, check reuse, update destination
  const handleNavigate = useCallback((targetUrl: string) => {
    // Check if another tab already has this URL
    const existing = findByUrl(targetUrl);
    if (existing && existing.surfaceId !== surfaceId) {
      // Activate the existing tab and close this one (only if this is a new-tab homepage)
      activateTab(`browser:${existing.surfaceId}`);
      if (!url) {
        closeWorkbenchTab(`browser:${surfaceId}`);
      }
      return;
    }

    // Update this tab's destination with the new URL
    openDestination({ type: 'browser', surfaceId, url: targetUrl });
  }, [surfaceId, url, findByUrl, activateTab, closeWorkbenchTab, openDestination]);

  // Handle manual reload from crash error page
  const handleCrashReload = useCallback(() => {
    reloadTab(surfaceId);
    void window.surfaceBridge?.reload(surfaceId);
  }, [surfaceId, reloadTab]);

  // Issue #9: Handle certificate error — user clicks "继续访问 (不安全)"
  // This grants a single-continue for the current URL, then reloads the surface.
  // No permanent trust is written.
  const handleCertificateProceed = useCallback(async () => {
    const certError = tab?.certificateError;
    if (!certError) return;
    await window.surfaceBridge?.proceedCertificate(surfaceId, certError.url);
    clearCertificateError(surfaceId);
    void window.surfaceBridge?.reload(surfaceId);
  }, [surfaceId, tab?.certificateError, clearCertificateError]);

  const currentUrl = tab?.url ?? url;
  const hasUrl = currentUrl !== '';
  const isCrashed = tab?.crashed === true;
  const hasCertificateError = tab?.certificateError != null;

  if (!hasUrl) {
    return <NewTabPage onNavigate={handleNavigate} />;
  }

  // Issue #9: Certificate error — show risk page with single-continue option
  if (hasCertificateError) {
    return (
      <div className="flex h-full w-full flex-col">
        <NavigationBar
          surfaceId={surfaceId}
          url={currentUrl}
          title={tab?.title}
          loading={tab?.loading ?? false}
          canGoBack={tab?.canGoBack ?? false}
          canGoForward={tab?.canGoForward ?? false}
          error={tab?.error ?? null}
          onNavigate={handleNavigate}
        />
        <div className="flex flex-1 flex-col items-center justify-center gap-4 bg-background px-4">
          <ShieldAlert className="h-10 w-10 text-status-warn-foreground" />
          <div className="text-center">
            <h2 className="text-sm font-semibold text-foreground">证书风险</h2>
            <p className="mt-1 max-w-md text-xs text-muted-foreground">
              此网站的安全证书存在问题：{tab?.certificateError?.error}
            </p>
            <p className="mt-1 text-xs text-muted-foreground">
              继续访问可能不安全。此操作仅对当前访问生效，不会写入永久信任。
            </p>
          </div>
          <div className="flex gap-2">
            <button
              onClick={() => void handleCertificateProceed()}
              className="flex items-center gap-1.5 rounded-md border border-status-warn-foreground/50 bg-status-warn/10 px-3 py-1.5 text-xs text-status-warn-foreground transition-colors hover:bg-status-warn/20"
            >
              <ShieldAlert className="h-3.5 w-3.5" />
              <span>继续访问 (不安全)</span>
            </button>
          </div>
        </div>
      </div>
    );
  }

  if (isCrashed) {
    return (
      <div className="flex h-full w-full flex-col">
        <NavigationBar
          surfaceId={surfaceId}
          url={currentUrl}
          title={tab?.title}
          loading={tab?.loading ?? false}
          canGoBack={tab?.canGoBack ?? false}
          canGoForward={tab?.canGoForward ?? false}
          error={tab?.error ?? null}
          onNavigate={handleNavigate}
        />
        <div className="flex flex-1 flex-col items-center justify-center gap-4 bg-background px-4">
          <AlertCircle className="h-10 w-10 text-status-fail-foreground" />
          <div className="text-center">
            <h2 className="text-sm font-semibold text-foreground">页面崩溃</h2>
            <p className="mt-1 text-xs text-muted-foreground">
              {tab?.error ?? '页面渲染进程意外退出'}
            </p>
          </div>
          <button
            onClick={handleCrashReload}
            className="flex items-center gap-1.5 rounded-md border border-border bg-secondary/30 px-3 py-1.5 text-xs text-foreground transition-colors hover:bg-accent"
          >
            <RotateCw className="h-3.5 w-3.5" />
            <span>重新加载</span>
          </button>
        </div>
      </div>
    );
  }

return (
<div className="flex h-full w-full flex-col">
<NavigationBar
surfaceId={surfaceId}
url={currentUrl}
title={tab?.title}
loading={tab?.loading ?? false}
canGoBack={tab?.canGoBack ?? false}
canGoForward={tab?.canGoForward ?? false}
error={tab?.error ?? null}
        onNavigate={handleNavigate}
      />
      {findActive && <FindBar surfaceId={surfaceId} />}
      <SurfaceLayer
        surfaceId={surfaceId}
        kind="browser"
        source={{ type: 'url', url: currentUrl }}
        visible
      />
    </div>
  );
}
