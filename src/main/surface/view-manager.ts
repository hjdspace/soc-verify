import { pathToFileURL } from 'node:url';
import type { SurfaceBounds, SurfaceDeclaration, SurfaceEvent } from '@shared/surface-types';

type SurfaceListener = (...args: never[]) => void;

export interface SurfaceWebContents {
  on(event: string, listener: SurfaceListener): this;
  off(event: string, listener: SurfaceListener): this;
  loadURL(url: string): Promise<void>;
  getURL(): string;
  getTitle(): string;
  isDestroyed(): boolean;
  destroy(): void;
  insertCSS?(css: string): Promise<string>;
  canGoBack?(): boolean;
  canGoForward?(): boolean;
  goBack?(): void;
  goForward?(): void;
  reload?(): void;
  getNavigationHistory?(): { canGoBack: boolean; canGoForward: boolean };
  findInPage?(text: string, options?: { forward?: boolean }): void;
  stopFindInPage?(action: 'clearSelection' | 'keepSelection' | 'activateSelection'): void;
}

export interface SurfaceView {
  webContents: SurfaceWebContents;
  setBounds(bounds: SurfaceBounds): void;
  setVisible(visible: boolean): void;
}

export interface SurfaceHost {
  contentView: {
    addChildView(view: SurfaceView): void;
    removeChildView(view: SurfaceView): void;
  };
  getContentBounds(): SurfaceBounds;
  isDestroyed(): boolean;
}

export interface ViewManagerOptions {
  createView: (declaration: SurfaceDeclaration) => SurfaceView;
  emit: (event: SurfaceEvent) => void;
  /** Issue #9: Check whether the user has granted a single-continue for a certificate error. */
  shouldProceedCertificate?: (surfaceId: string, url: string) => boolean;
  /** Issue #9: Consume (remove) a single-use certificate proceed after it has been used. */
  consumeProceedCertificate?: (surfaceId: string, url: string) => void;
}

interface SurfaceEntry {
  declaration: SurfaceDeclaration;
  view: SurfaceView;
  attached: boolean;
  currentURL: string;
  listeners: Array<{ event: string; listener: SurfaceListener }>;
}

function sourceURL(declaration: SurfaceDeclaration): string {
  const { source } = declaration;
  if (source.type === 'local-file') return pathToFileURL(source.path).toString();
  return source.url;
}

function isAllowedSource(declaration: SurfaceDeclaration, url: string): boolean {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return false;
  }

  if (declaration.kind === 'browser') {
    return declaration.source.type === 'url' && (parsed.protocol === 'http:' || parsed.protocol === 'https:');
  }

  // Document surfaces only accept local-file and local-server sources.
  // url-type sources are rejected to prevent document surfaces from loading
  // arbitrary remote URLs.
  if (declaration.source.type === 'local-file') return parsed.protocol === 'file:';
  if (declaration.source.type === 'local-server') {
    return (parsed.protocol === 'http:' || parsed.protocol === 'https:')
      && (parsed.hostname === 'localhost' || parsed.hostname === '127.0.0.1' || parsed.hostname === '[::1]');
  }
  return false;
}

export function constrainSurfaceBounds(bounds: SurfaceBounds | undefined, hostBounds: SurfaceBounds): SurfaceBounds | null {
  if (!bounds) return null;
  const values = [bounds.x, bounds.y, bounds.width, bounds.height, hostBounds.width, hostBounds.height];
  if (!values.every(Number.isFinite) || bounds.width <= 0 || bounds.height <= 0 || hostBounds.width <= 0 || hostBounds.height <= 0) {
    return null;
  }

  const x = Math.max(0, Math.round(bounds.x));
  const y = Math.max(0, Math.round(bounds.y));
  if (x >= hostBounds.width || y >= hostBounds.height) return null;

  const width = Math.min(Math.round(bounds.width), Math.round(hostBounds.width) - x);
  const height = Math.min(Math.round(bounds.height), Math.round(hostBounds.height) - y);
  if (width <= 0 || height <= 0) return null;
  return { x, y, width, height };
}

export class ViewManager {
  private readonly surfaces = new Map<string, SurfaceEntry>();
  private overlayHidden = false;

  constructor(
    private readonly host: SurfaceHost,
    private readonly options: ViewManagerOptions,
  ) {}

  async sync(declaration: SurfaceDeclaration): Promise<void> {
    if (!declaration.id.trim()) throw new Error('Surface id must not be empty');
    const url = sourceURL(declaration);
    if (!isAllowedSource(declaration, url)) throw new Error(`Surface source is not allowed: ${url}`);

    let entry = this.surfaces.get(declaration.id);
    if (!entry) {
      const view = this.options.createView(declaration);
      entry = {
        declaration,
        view,
        attached: false,
        currentURL: '',
        listeners: [],
      };
      this.surfaces.set(declaration.id, entry);
      this.bindEvents(entry);
    } else if (entry.declaration.kind !== declaration.kind) {
      throw new Error(`Surface kind cannot change for id ${declaration.id}`);
    }

    entry.declaration = declaration;
    this.applyPresentation(entry);

    if (entry.currentURL !== url) {
      entry.currentURL = url;
      try {
        await entry.view.webContents.loadURL(url);
      } catch (error) {
        // The renderer can tear down and recreate the same surface id while
        // React StrictMode is mounting. Ignore results from that stale view,
        // or from a URL that has already been superseded on this view.
        if (this.surfaces.get(declaration.id) !== entry || entry.currentURL !== url) return;
        // Extract the Chromium error code from the rejection.
        // Electron attaches `errno` to loadURL rejections; fall back to -1 if absent.
        const errno = (error as { errno?: number })?.errno;
        const errorDescription = error instanceof Error ? error.message : String(error);
        // ERR_ABORTED (-3) is normal during redirects (e.g., http→https).
        // The did-fail-load event handler already emitted a filtered event with
        // errorCode: -3. Don't emit a second event here that would bypass the
        // SurfaceLayer filter with a different error code.
        if (errno === -3 || errorDescription.includes('ERR_ABORTED')) return;
        this.options.emit({
          id: declaration.id,
          type: 'failure',
          errorCode: errno ?? -1,
          errorDescription,
          validatedURL: url,
          isMainFrame: true,
        });
      }
    }
  }

  show(id: string): void {
    const entry = this.surfaces.get(id);
    if (!entry) return;
    entry.declaration = { ...entry.declaration, visible: true };
    this.applyPresentation(entry);
  }

  hide(id: string): void {
    const entry = this.surfaces.get(id);
    if (!entry) return;
    entry.declaration = { ...entry.declaration, visible: false };
    this.applyPresentation(entry);
  }

  setOverlayHidden(hidden: boolean): void {
    if (this.overlayHidden === hidden) return;
    this.overlayHidden = hidden;
    for (const entry of this.surfaces.values()) this.applyPresentation(entry);
  }

  destroy(id: string): void {
    const entry = this.surfaces.get(id);
    if (!entry) return;
    this.surfaces.delete(id);
    this.cleanupEntry(entry);
  }

  destroyAll(): void {
    for (const id of [...this.surfaces.keys()]) this.destroy(id);
  }

  has(id: string): boolean {
    return this.surfaces.has(id);
  }

  goBack(id: string): void {
    const entry = this.surfaces.get(id);
    if (!entry || entry.view.webContents.isDestroyed()) return;
    entry.view.webContents.goBack?.();
    this.emitNavigation(id);
  }

  goForward(id: string): void {
    const entry = this.surfaces.get(id);
    if (!entry || entry.view.webContents.isDestroyed()) return;
    entry.view.webContents.goForward?.();
    this.emitNavigation(id);
  }

  reload(id: string): void {
    const entry = this.surfaces.get(id);
    if (!entry || entry.view.webContents.isDestroyed()) return;
    entry.view.webContents.reload?.();
  }

  /** Issue #11: Search for text in the page. */
  findInPage(id: string, searchText: string, options?: { forward?: boolean }): void {
    const entry = this.surfaces.get(id);
    if (!entry || entry.view.webContents.isDestroyed()) return;
    const forward = options?.forward ?? true;
    entry.view.webContents.findInPage?.(searchText, { forward });
  }

  /** Issue #11: Stop the current find-in-page session. */
  stopFindInPage(id: string, action: 'clearSelection' | 'keepSelection' | 'activateSelection' = 'clearSelection'): void {
    const entry = this.surfaces.get(id);
    if (!entry || entry.view.webContents.isDestroyed()) return;
    entry.view.webContents.stopFindInPage?.(action);
  }

  private emitNavigation(id: string): void {
    const entry = this.surfaces.get(id);
    if (!entry || entry.view.webContents.isDestroyed()) return;
    const wc = entry.view.webContents;
    const canGoBack = typeof wc.canGoBack === 'function' ? wc.canGoBack() : false;
    const canGoForward = typeof wc.canGoForward === 'function' ? wc.canGoForward() : false;
    this.options.emit({ id, type: 'navigation', canGoBack, canGoForward });
  }

  private applyPresentation(entry: SurfaceEntry): void {
    if (this.host.isDestroyed() || entry.view.webContents.isDestroyed()) return;
    const bounds = constrainSurfaceBounds(entry.declaration.bounds, this.host.getContentBounds());
    const visible = entry.declaration.visible && !this.overlayHidden && bounds !== null;

    if (bounds) entry.view.setBounds(bounds);
    if (!entry.attached) {
      this.host.contentView.addChildView(entry.view);
      entry.attached = true;
    }
    entry.view.setVisible(visible);
  }

  private bindEvents(entry: SurfaceEntry): void {
    const { id } = entry.declaration;
    const bind = (event: string, listener: SurfaceListener) => {
      entry.view.webContents.on(event, listener);
      entry.listeners.push({ event, listener });
    };

    bind('dom-ready', () => {
      const css = entry.declaration.injectCSS;
      if (css && typeof entry.view.webContents.insertCSS === 'function') {
        entry.view.webContents.insertCSS(css).catch(() => {
          // CSS injection failure is non-fatal; the page still renders.
        });
      }
    });
    bind('did-start-loading', () => this.options.emit({ id, type: 'loading', loading: true }));
    bind('did-stop-loading', () => {
      this.options.emit({ id, type: 'loading', loading: false });
      this.emitNavigation(id);
    });
    const emitURL = (_event: unknown, url: string) => {
      this.options.emit({ id, type: 'url', url });
      this.emitNavigation(id);
    };
    bind('did-navigate', emitURL);
    bind('did-navigate-in-page', emitURL);
    bind('page-title-updated', (_event: unknown, title: string) => this.options.emit({ id, type: 'title', title }));
    bind('did-fail-load', (
      _event: unknown,
      errorCode: number,
      errorDescription: string,
      validatedURL: string,
      isMainFrame: boolean,
    ) => this.options.emit({ id, type: 'failure', errorCode, errorDescription, validatedURL, isMainFrame }));
    bind('render-process-gone', (_event: unknown, details?: { reason?: string; exitCode?: number }) => {
      this.options.emit({ id, type: 'crash', reason: details?.reason, exitCode: details?.exitCode });
      entry.view.setVisible(false);
    });
    // Issue #11: found-in-page — emit find-result surface event with match count
    bind('found-in-page', (_event: unknown, result: { activeMatchOrdinal: number; matches: number; finalUpdate: boolean }) => {
      this.options.emit({ id, type: 'find-result', activeMatchOrdinal: result.activeMatchOrdinal, matches: result.matches, finalUpdate: result.finalUpdate });
    });
    // Issue #9: certificate-error — deny by default, emit event for renderer to show risk UI.
    // User can single-continue via browser.proceedCertificate IPC.
    bind('certificate-error', (
      evt: unknown,
      url: string,
      error: string,
      _certificate: unknown,
      callback: (allow: boolean) => void,
    ) => {
      const e = evt as { preventDefault?: () => void };
      e?.preventDefault?.();
      if (this.options.shouldProceedCertificate?.(id, url)) {
        this.options.consumeProceedCertificate?.(id, url);
        callback(true);
      } else {
        callback(false);
        this.options.emit({ id, type: 'certificate-error', url, error, isMainFrame: true });
      }
    });
  }

  private cleanupEntry(entry: SurfaceEntry): void {
    if (entry.attached && !this.host.isDestroyed()) {
      this.host.contentView.removeChildView(entry.view);
      entry.attached = false;
    }
    for (const { event, listener } of entry.listeners) {
      entry.view.webContents.off(event, listener);
    }
    entry.listeners.length = 0;
    if (!entry.view.webContents.isDestroyed()) entry.view.webContents.destroy();
  }
}
