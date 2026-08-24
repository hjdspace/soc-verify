import '@testing-library/jest-dom/vitest';

// Polyfill ResizeObserver for jsdom — 虚拟滚动组件依赖此 API
class ResizeObserverMock {
  observe(): void {}
  unobserve(): void {}
  disconnect(): void {}
}
globalThis.ResizeObserver = ResizeObserverMock as unknown as typeof ResizeObserver;

// Mock electronTRPC global — trpc.ts 在模块加载时调用 ipcLink()，需要此全局。
// 测试环境无 Electron preload，用空操作 stub 避免 throw。
// 依赖真实 tRPC 调用的测试应自行 vi.mock('@renderer/lib/trpc')。
const noop = (): void => {};
(globalThis as Record<string, unknown>).electronTRPC = {
  sendMessage: noop,
  onMessage: noop,
};
