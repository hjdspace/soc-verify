/**
 * BrowserView — 浏览器标签容器。
 *
 * 职责：
 *   1. 在 mount 时创建 browser store 条目，unmount 时移除
 *   2. 监听全局 surface 事件，将 URL/title/loading/navigation/failure/crash 投影到 browser store
 *   3. url 为空时显示 NewTabPage（新标签首页）
 *   4. url 非空时显示 NavigationBar + SurfaceLayer（Browser Surface）
 *   5. 提供 onNavigate 回调：标准化 URL → 标签复用检查 → 更新 workbench destination
 *
 * 标签复用：提交 URL 时检查是否已有标签加载了相同标准化 URL，
 * 若有则激活已有标签并关闭当前空标签（仅当当前标签 url 为空时）。
 */
import { useEffect, useCallback } from 'react';
import type { SurfaceEvent } from '@shared/surface-types';
import { useBrowserStore } from '@renderer/stores/browser';
import { useWorkbenchStore } from '@renderer/stores/workbench';
import { SurfaceLayer } from '@renderer/components/surface/SurfaceLayer';
import { NewTabPage } from './NewTabPage';
import { NavigationBar } from './NavigationBar';

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

  const currentUrl = tab?.url ?? url;
  const hasUrl = currentUrl !== '';

  if (!hasUrl) {
    return <NewTabPage onNavigate={handleNavigate} />;
  }

  return (
    <div className="flex h-full w-full flex-col">
      <NavigationBar
        surfaceId={surfaceId}
        url={currentUrl}
        loading={tab?.loading ?? false}
        canGoBack={tab?.canGoBack ?? false}
        canGoForward={tab?.canGoForward ?? false}
        error={tab?.error ?? null}
        onNavigate={handleNavigate}
      />
      <SurfaceLayer
        surfaceId={surfaceId}
        kind="browser"
        source={{ type: 'url', url: currentUrl }}
        visible
      />
    </div>
  );
}
