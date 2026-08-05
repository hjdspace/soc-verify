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
        if (!this.surfaces.has(declaration.id)) return;
        this.options.emit({
          id: declaration.id,
          type: 'failure',
          errorCode: -1,
          errorDescription: error instanceof Error ? error.message : String(error),
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
    bind('did-stop-loading', () => this.options.emit({ id, type: 'loading', loading: false }));
    const emitURL = (_event: unknown, url: string) => this.options.emit({ id, type: 'url', url });
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
