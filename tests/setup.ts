import '@testing-library/jest-dom/vitest';

// Polyfill ResizeObserver for jsdom — 虚拟滚动组件依赖此 API
class ResizeObserverMock {
  observe(): void {}
  unobserve(): void {}
  disconnect(): void {}
}
globalThis.ResizeObserver = ResizeObserverMock as unknown as typeof ResizeObserver;
