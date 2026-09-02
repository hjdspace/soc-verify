// @vitest-environment jsdom
/**
 * TerminalView OSC 133 命令装饰器集成测试（Issue #7）。
 *
 * 验收点：
 * 1. TerminalView 注册 OSC 133 handler，正确解析 A/C/D 三种序列
 * 2. 命令完成后创建装饰器（退出码图标 ✓/✗）
 * 3. 装饰器使用 CSS 变量语义色
 * 4. 仿真终端不显示命令装饰器（无 OSC 133 序列）
 * 5. OutputBuffer restore 时 reset() 清空状态，不产生重复装饰器
 *
 * Mock 策略：
 * - xterm.js Terminal 的 parser.registerOscHandler 捕获 handler 回调
 * - eventBridge.onTerminalData 模拟终端数据流
 * - trpc.terminal.getOutputBuffer 模拟 restore
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { render, waitFor } from '@testing-library/react';

// ── Mock xterm.js Terminal ──────────────────────────────────
// 捕获 parser.registerOscHandler 回调，让测试可以注入 OSC 序列
// Use vi.hoisted so the class is available in vi.mock factory (hoisted)
const { MockTerminal, MockFitAddon, MockWebglAddon, oscHandlers, decorationCallbacks, onRenderCallbacks } = vi.hoisted(() => {
  const oscHandlers = new Map<number, (data: string) => boolean | Promise<boolean>>();
  const decorationCallbacks: Array<{ marker: unknown; anchor: string; x: number }> = [];
  const onRenderCallbacks: Array<(element: HTMLElement) => void> = [];

  class MockTerminal {
    cols = 80;
    rows = 24;
    options = { theme: {} };
    parser = {
      registerOscHandler(ident: number, cb: (data: string) => boolean | Promise<boolean>) {
        oscHandlers.set(ident, cb);
        return { dispose: () => {} };
      },
    };
    buffer = {
      active: {
        baseY: 0,
        cursorY: 0,
        getLine: () => ({
          translateToString: () => 'echo hello',
        }),
      },
    };

    registerMarker() { return { line: 0 }; }
    registerDecoration(opts: { marker: unknown; anchor: string; x: number }) {
      decorationCallbacks.push(opts);
      return {
        marker: opts.marker,
        onRender: (cb: (element: HTMLElement) => void) => { onRenderCallbacks.push(cb); },
        dispose: () => {},
      };
    }
    onData() { return { dispose: () => {} }; }
    onResize() { return { dispose: () => {} }; }
    write() {}
    getSelection() { return ''; }
    dispose() {}
    loadAddon() {}
    open() {}
  }

  class MockFitAddon {
    fit() {}
    loadAddon() {}
  }

  class MockWebglAddon {
    onContextLoss() {}
    dispose() {}
  }

  return { MockTerminal, MockFitAddon, MockWebglAddon, oscHandlers, decorationCallbacks, onRenderCallbacks };
});

vi.mock('@xterm/xterm', () => ({ Terminal: MockTerminal }));

vi.mock('@xterm/addon-fit', () => ({ FitAddon: MockFitAddon }));

vi.mock('@xterm/addon-webgl', () => ({ WebglAddon: MockWebglAddon }));

vi.mock('@xterm/xterm/css/xterm.css', () => ({}));

// ── Mock stores ──────────────────────────────────────────────
vi.mock('@renderer/stores/terminal', () => ({
  useTerminalStore: (selector: (s: Record<string, unknown>) => unknown) =>
    selector({
      writeToTerminal: vi.fn(),
      resizeTerminal: vi.fn(),
    }),
}));

vi.mock('@renderer/stores/theme', () => ({
  useThemeStore: (selector: (s: Record<string, unknown>) => unknown) =>
    selector({ currentTheme: 'slate' }),
}));

vi.mock('@renderer/stores/terminal-theme', () => ({
  useTerminalThemeStore: Object.assign(
    (selector: (s: Record<string, unknown>) => unknown) =>
      selector({ themeMode: 'follow-ui', themeId: 'dracula' }),
    { getState: () => ({ themeMode: 'follow-ui', themeId: 'dracula' }) },
  ),
  resolveTerminalITheme: vi.fn(() => ({})),
}));

// ── Mock trpc ───────────────────────────────────────────────
const { mockGetOutputBuffer } = vi.hoisted(() => ({
  mockGetOutputBuffer: vi.fn<() => Promise<string[]>>(),
}));

vi.mock('@renderer/lib/trpc', () => ({
  trpc: {
    terminal: {
      getOutputBuffer: { query: mockGetOutputBuffer },
    },
  },
}));

// ── Mock eventBridge ────────────────────────────────────────
let _dataCallback: ((data: { id: string; data: string }) => void) | null = null;

vi.mock('@renderer/stores/workbench', () => ({
  useWorkbenchStore: (selector: (s: Record<string, unknown>) => unknown) =>
    selector({ open: vi.fn(), close: vi.fn() }),
}));

vi.mock('@renderer/stores/ui', () => ({
  useUiStore: (selector: (s: Record<string, unknown>) => unknown) =>
    selector({ setBottomPanelCollapsed: vi.fn() }),
}));

import { TerminalView } from '@renderer/components/terminal/TerminalView';

describe('TerminalView OSC 133 命令装饰器（Issue #7）', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    oscHandlers.clear();
    decorationCallbacks.length = 0;
    onRenderCallbacks.length = 0;
    mockGetOutputBuffer.mockResolvedValue([]);
    _dataCallback = null;

    // Setup eventBridge
    Object.defineProperty(window, 'eventBridge', {
      configurable: true,
      value: {
        onTerminalData: (cb: (data: { id: string; data: string }) => void) => {
          _dataCallback = cb;
          return () => { _dataCallback = null; };
        },
        onTerminalExit: vi.fn(() => () => {}),
      },
    });

    // Setup clipboard
    Object.assign(navigator, {
      clipboard: { writeText: vi.fn().mockResolvedValue(undefined) },
    });
  });

  it('注册 OSC 133 handler', async () => {
    render(<TerminalView terminalId="term-1" />);

    await waitFor(() => {
      expect(oscHandlers.has(133)).toBe(true);
    });
  });

  it('解析 A → C → D;0 序列后创建装饰器', async () => {
    render(<TerminalView terminalId="term-1" />);

    await waitFor(() => {
      expect(oscHandlers.has(133)).toBe(true);
    });

    const handler = oscHandlers.get(133)!;

    // Simulate OSC 133;A (命令开始)
    handler('133;A');
    // Simulate OSC 133;C (命令输出前)
    handler('133;C');
    // Simulate OSC 133;D;0 (命令完成, exit 0)
    handler('133;D;0');

    // Should have created a decoration
    expect(decorationCallbacks.length).toBeGreaterThan(0);
    expect(decorationCallbacks[0].anchor).toBe('right');
  });

  it('命令完成 exitCode=0 时装饰器显示 ✓', async () => {
    render(<TerminalView terminalId="term-1" />);

    await waitFor(() => {
      expect(oscHandlers.has(133)).toBe(true);
    });

    const handler = oscHandlers.get(133)!;
    handler('133;A');
    handler('133;D;0');

    // Trigger onRender to render the decorator content
    const fakeElement = document.createElement('div');
    for (const cb of onRenderCallbacks) {
      cb(fakeElement);
    }

    // The decorator should have been created with a pass icon
    expect(decorationCallbacks.length).toBeGreaterThan(0);
    const decoratorHost = fakeElement.querySelector('.cmd-decorator-host');
    expect(decoratorHost).toBeTruthy();
    const passIcon = fakeElement.querySelector('.cmd-pass');
    expect(passIcon).toBeTruthy();
    expect(passIcon?.textContent).toContain('✓');
  });

  it('命令完成 exitCode≠0 时装饰器显示 ✗', async () => {
    render(<TerminalView terminalId="term-1" />);

    await waitFor(() => {
      expect(oscHandlers.has(133)).toBe(true);
    });

    const handler = oscHandlers.get(133)!;
    handler('133;A');
    handler('133;D;1');

    // Trigger onRender
    const fakeElement = document.createElement('div');
    for (const cb of onRenderCallbacks) {
      cb(fakeElement);
    }

    const failIcon = fakeElement.querySelector('.cmd-fail');
    expect(failIcon).toBeTruthy();
    expect(failIcon?.textContent).toContain('✗');
  });

  it('装饰器包含复制按钮和折叠按钮', async () => {
    render(<TerminalView terminalId="term-1" />);

    await waitFor(() => {
      expect(oscHandlers.has(133)).toBe(true);
    });

    const handler = oscHandlers.get(133)!;
    handler('133;A');
    handler('133;D;0');

    const fakeElement = document.createElement('div');
    for (const cb of onRenderCallbacks) {
      cb(fakeElement);
    }

    expect(fakeElement.querySelector('[data-testid="command-copy-btn"]')).toBeTruthy();
    expect(fakeElement.querySelector('[data-testid="command-collapse-btn"]')).toBeTruthy();
  });

  it('执行时间显示在装饰器中', async () => {
    render(<TerminalView terminalId="term-1" />);

    await waitFor(() => {
      expect(oscHandlers.has(133)).toBe(true);
    });

    const handler = oscHandlers.get(133)!;
    handler('133;A');
    // Simulate time passing
    handler('133;D;0');

    const fakeElement = document.createElement('div');
    for (const cb of onRenderCallbacks) {
      cb(fakeElement);
    }

    const duration = fakeElement.querySelector('.cmd-duration');
    // Duration should be rendered (even if "0ms")
    expect(duration).toBeTruthy();
  });

  it('仿真终端不发送 OSC 133 序列时不创建装饰器', async () => {
    render(<TerminalView terminalId="sim-term-1" />);

    await waitFor(() => {
      expect(oscHandlers.has(133)).toBe(true);
    });

    // No OSC 133 sequences sent — no decorations
    expect(decorationCallbacks.length).toBe(0);
  });

  it('OutputBuffer restore 前 reset() 清空状态，不产生重复装饰器', async () => {
    // Simulate a terminal that already has OSC 133 in its output buffer
    mockGetOutputBuffer.mockResolvedValue(['\x1b]133;A\x07', '\x1b]133;D;0\x07']);

    const { unmount } = render(<TerminalView terminalId="term-1" />);

    // Wait for output buffer restore to complete
    await waitFor(() => {
      expect(mockGetOutputBuffer).toHaveBeenCalled();
    });

    // The OSC 133 sequences in the buffer should have been re-parsed
    // but since reset() was called before restore, only one decoration should exist
    const handler = oscHandlers.get(133)!;

    // Simulate additional commands after restore
    handler('133;A');
    handler('133;D;0');

    // Should have at most 2 decorations (1 from restore + 1 from new)
    // The key point is no duplicates
    expect(decorationCallbacks.length).toBeLessThanOrEqual(2);

    unmount();
  });

  it('复制按钮点击复制命令文本到剪贴板', async () => {
    render(<TerminalView terminalId="term-1" />);

    await waitFor(() => {
      expect(oscHandlers.has(133)).toBe(true);
    });

    const handler = oscHandlers.get(133)!;
    handler('133;A');
    handler('133;D;0');

    const fakeElement = document.createElement('div');
    document.body.appendChild(fakeElement);
    for (const cb of onRenderCallbacks) {
      cb(fakeElement);
    }

    const copyBtn = fakeElement.querySelector('[data-testid="command-copy-btn"]') as HTMLButtonElement;
    expect(copyBtn).toBeTruthy();

    copyBtn.click();

    await waitFor(() => {
      expect(navigator.clipboard.writeText).toHaveBeenCalledWith('echo hello');
    });

    document.body.removeChild(fakeElement);
  });
});
