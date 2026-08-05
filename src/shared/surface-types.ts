export type SurfaceKind = 'browser' | 'document';

export type SurfaceSource =
  | { type: 'url'; url: string }
  | { type: 'local-file'; path: string }
  | { type: 'local-server'; url: string };

export interface SurfaceBounds {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface SurfaceDeclaration {
  id: string;
  kind: SurfaceKind;
  source: SurfaceSource;
  visible: boolean;
  bounds?: SurfaceBounds;
  /** CSS to inject into the page after dom-ready (e.g. viewport-fill for Document Surfaces). */
  injectCSS?: string;
}

export type SurfaceEvent =
  | { id: string; type: 'url'; url: string }
  | { id: string; type: 'title'; title: string }
  | { id: string; type: 'loading'; loading: boolean }
  | { id: string; type: 'failure'; errorCode: number; errorDescription: string; validatedURL: string; isMainFrame: boolean }
  | { id: string; type: 'crash'; reason?: string; exitCode?: number }
  | { id: string; type: 'navigation'; canGoBack: boolean; canGoForward: boolean }
  // Issue #9: certificate error — emitted when a TLS certificate validation fails.
  // Default policy is deny; user can single-continue via browser.proceedCertificate.
  | { id: string; type: 'certificate-error'; url: string; error: string; isMainFrame: boolean };
