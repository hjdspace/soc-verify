/**
 * ErrorBoundary — React 全局错误边界。
 *
 * 设计要点（codebase-design: deep module）:
 * - Interface: <ErrorBoundary>{children}</ErrorBoundary> — 一个组件，零配置
 * - Implementation: componentDidCatch 捕获渲染异常 → 展示可恢复错误 UI
 * - 提供「重试」按钮（重置 state）和「重新加载」按钮（调用 location.reload）
 * - 监听主进程 global:error IPC 通道（通过 eventBridge），展示后端未捕获异常
 */

import { Component, type ErrorInfo, type ReactNode } from 'react';

type ErrorBoundaryProps = {
  children: ReactNode;
};

type GlobalErrorPayload = {
  type: 'uncaughtException' | 'unhandledRejection';
  message: string;
  stack?: string;
  timestamp: string;
};

type ErrorBoundaryState = {
  hasError: boolean;
  error: Error | null;
  errorInfo: ErrorInfo | null;
  /** 来自主进程的全局错误（非渲染层抛出） */
  globalError: GlobalErrorPayload | null;
};

export class ErrorBoundary extends Component<ErrorBoundaryProps, ErrorBoundaryState> {
  private unsubscribeGlobalError: (() => void) | null = null;

  constructor(props: ErrorBoundaryProps) {
    super(props);
    this.state = {
      hasError: false,
      error: null,
      errorInfo: null,
      globalError: null,
    };
  }

  componentDidMount(): void {
    // 监听主进程发送的全局错误（uncaughtException / unhandledRejection）
    // 通过 preload contextBridge 暴露的 eventBridge.onGlobalError
    const bridge = window.eventBridge;
    if (bridge?.onGlobalError) {
      this.unsubscribeGlobalError = bridge.onGlobalError((payload: GlobalErrorPayload) => {
        this.setState({ globalError: payload });
      });
    }
  }

  componentWillUnmount(): void {
    this.unsubscribeGlobalError?.();
  }

  static getDerivedStateFromError(error: Error): Partial<ErrorBoundaryState> {
    return { hasError: true, error };
  }

  componentDidCatch(error: Error, errorInfo: ErrorInfo): void {
    console.error('[ErrorBoundary] Caught render error:', error, errorInfo);
    this.setState({ errorInfo });
  }

  /** 用户点击「重试」：重置 state，让 React 重新渲染 */
  handleRetry = (): void => {
    this.setState({ hasError: false, error: null, errorInfo: null });
  };

  /** 用户点击「重新加载」：强制刷新页面 */
  handleReload = (): void => {
    window.location.reload();
  };

  /** 用户点击「关闭」：清除全局错误提示 */
  handleDismissGlobalError = (): void => {
    this.setState({ globalError: null });
  };

  render(): ReactNode {
    // 1. 渲染层错误（React 组件抛出）
    if (this.state.hasError && this.state.error) {
      return (
        <div className="flex h-screen w-screen flex-col items-center justify-center gap-6 bg-background p-8 text-foreground">
          <div className="flex flex-col items-center gap-2 text-center">
            <div className="text-2xl font-semibold text-destructive">应用发生错误</div>
            <p className="max-w-md text-sm text-muted-foreground">
              UI 组件渲染时发生异常。你可以尝试重试或重新加载应用。
            </p>
          </div>
          <div className="max-w-2xl rounded-lg border border-border bg-muted p-4">
            <div className="mb-2 text-xs font-mono font-semibold text-destructive">
              {this.state.error.name}: {this.state.error.message}
            </div>
            {this.state.errorInfo?.componentStack && (
              <pre className="max-h-48 overflow-auto text-xs font-mono text-muted-foreground">
                {this.state.errorInfo.componentStack.trim()}
              </pre>
            )}
            {this.state.error.stack && (
              <pre className="mt-2 max-h-48 overflow-auto text-xs font-mono text-muted-foreground">
                {this.state.error.stack}
              </pre>
            )}
          </div>
          <div className="flex gap-3">
            <button
              type="button"
              onClick={this.handleRetry}
              className="rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground transition hover:opacity-90"
            >
              重试
            </button>
            <button
              type="button"
              onClick={this.handleReload}
              className="rounded-md border border-border bg-background px-4 py-2 text-sm font-medium text-foreground transition hover:bg-muted"
            >
              重新加载应用
            </button>
          </div>
        </div>
      );
    }

    // 2. 主进程全局错误（非渲染层，显示为浮动通知条）
    if (this.state.globalError) {
      const ge = this.state.globalError;
      return (
        <>
          {/* top-9 = TitleBar 高度（36px），避免与窗口控制按钮重叠 */}
          <div className="fixed top-9 left-0 right-0 z-[9999] flex items-start gap-3 border-b border-destructive/30 bg-destructive/15 p-3 backdrop-blur-sm">
            <div className="flex-1">
              <div className="text-sm font-medium text-destructive">
                {ge.type === 'uncaughtException' ? '主进程异常' : '未处理的 Promise 拒绝'}
              </div>
              <div className="text-xs text-muted-foreground">{ge.message}</div>
              {ge.stack && (
                <details className="mt-1">
                  <summary className="cursor-pointer text-xs text-muted-foreground">堆栈详情</summary>
                  <pre className="max-h-32 overflow-auto text-xs font-mono text-muted-foreground">
                    {ge.stack}
                  </pre>
                </details>
              )}
            </div>
            <button
              type="button"
              onClick={this.handleDismissGlobalError}
              className="shrink-0 rounded p-1 text-muted-foreground transition-colors hover:bg-foreground/10 hover:text-foreground"
              aria-label="关闭错误提示"
            >
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <path d="M18 6 6 18M6 6l12 12" />
              </svg>
            </button>
          </div>
          {this.props.children}
        </>
      );
    }

    return this.props.children;
  }
}
