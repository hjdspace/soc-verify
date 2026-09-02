import { useEffect, useRef, useState, useCallback } from 'react';
import { Terminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import { WebglAddon } from '@xterm/addon-webgl';
import '@xterm/xterm/css/xterm.css';
import { useTerminalStore } from '@renderer/stores/terminal';
import { useThemeStore } from '@renderer/stores/theme';
import {
  useTerminalThemeStore,
  resolveTerminalITheme,
} from '@renderer/stores/terminal-theme';
import { trpc } from '@renderer/lib/trpc';
import { Copy, Check } from 'lucide-react';

interface TerminalViewProps {
  terminalId: string;
}

export function TerminalView({ terminalId }: TerminalViewProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const termRef = useRef<Terminal | null>(null);
  const fitRef = useRef<FitAddon | null>(null);
  // Use refs for stable store functions so they don't enter the useEffect
  // dependency array — the effect should only re-run when terminalId changes.
  const writeToTerminalRef = useTerminalStore((s) => s.writeToTerminal);
  const resizeTerminalRef = useTerminalStore((s) => s.resizeTerminal);
  const currentTheme = useThemeStore((s) => s.currentTheme);
  // 终端主题模式（Issue #3）：follow-ui 跟随 UI 主题，independent 用内置主题
  const terminalThemeMode = useTerminalThemeStore((s) => s.themeMode);
  const terminalThemeId = useTerminalThemeStore((s) => s.themeId);

  // Copy button feedback state
  const [copied, setCopied] = useState(false);
  const copiedTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  /** Copy the current terminal selection to clipboard. Returns true if text was copied. */
  const copySelection = useCallback(async (): Promise<boolean> => {
    const term = termRef.current;
    if (!term) return false;
    const selection = term.getSelection();
    if (!selection) return false;
    try {
      await navigator.clipboard.writeText(selection);
      // Show "已复制" feedback
      setCopied(true);
      if (copiedTimerRef.current) clearTimeout(copiedTimerRef.current);
      copiedTimerRef.current = setTimeout(() => setCopied(false), 1500);
      return true;
    } catch {
      return false;
    }
  }, []);

  useEffect(() => {
    if (!containerRef.current) return;

    const term = new Terminal({
      cursorBlink: true,
      fontSize: 13,
      // Nerd Font 优先级链（Issue #1 打包注册；未下载时 CSS font-family
      // 自然回退到 Consolas / monospace，不崩溃）
      fontFamily:
        "'JetBrainsMono Nerd Font', 'MesloLGS NF', 'Consolas', 'Courier New', monospace",
      scrollback: 100000,
      allowProposedApi: true,
      // 双模式取色：independent → 内置主题定义；follow-ui → CSS 变量
      theme: resolveTerminalITheme(useTerminalThemeStore.getState()),
    });

    const fitAddon = new FitAddon();
    term.loadAddon(fitAddon);
    term.open(containerRef.current);

    // ── WebGL GPU 加速渲染（Issue #2）────────────────────────
    // 应对百万行仿真日志滚动场景。加载顺序：open() → webgl → fit()。
    // 无 GPU / 上下文创建失败时 try-catch 降级为默认 Canvas 渲染。
    try {
      const webglAddon = new WebglAddon();
      // WebGL 上下文丢失（如 GPU 驱动重置）时释放 addon，xterm 回退 Canvas
      webglAddon.onContextLoss(() => {
        webglAddon.dispose();
      });
      term.loadAddon(webglAddon);
    } catch (err) {
      console.warn('[TerminalView] WebGL renderer unavailable, falling back to canvas:', err);
    }

    fitAddon.fit();

    termRef.current = term;
    fitRef.current = fitAddon;

    // ── Output buffer restoration ──────────────────────────
    // When the TerminalView is remounted (e.g., user switched to another tab
    // and came back), the xterm.js instance is recreated and starts empty.
    // Fetch the terminal's output buffer from the main process and write it
    // to restore the previous output.
    //
    // To avoid duplicates: buffer incoming IPC data until the output buffer
    // is restored, then flush the buffered data.
    let outputRestored = false;
    const pendingData: string[] = [];

    // Handle user input → send to main process
    const inputDisposable = term.onData((data) => {
      // Intercept Ctrl+Shift+C for copy
      // xterm.js sends \x1b[97;2;9u or similar for Ctrl+Shift+C with modifyOtherKeys
      // Simpler: check for the raw Ctrl+Shift+C sequence
      void writeToTerminalRef(terminalId, data);
    });

    // Handle resize → send new size to main process
    const resizeDisposable = term.onResize(({ cols, rows }) => {
      void resizeTerminalRef(terminalId, cols, rows);
    });

    // Listen for terminal data from main process
    let cleanup: (() => void) | undefined;
    if (window.eventBridge) {
      cleanup = window.eventBridge.onTerminalData(({ id, data }) => {
        if (id === terminalId && termRef.current) {
          if (outputRestored) {
            // Output buffer already restored — write directly
            termRef.current.write(data);
          } else {
            // Buffer incoming data until output buffer is restored
            pendingData.push(data);
          }
        }
      });
    }

    // Restore output buffer from main process.
    // When the TerminalView is remounted (e.g., user switched to another tab
    // and came back), the xterm.js instance is recreated and starts empty.
    // Fetch the terminal's output buffer from the main process and write it
    // to restore the previous output.
    trpc.terminal.getOutputBuffer
      .query({ terminalId })
      .then((chunks) => {
        if (!termRef.current) {
          outputRestored = true;
          return;
        }
        if (chunks.length > 0) {
          termRef.current.write(chunks.join(''));
        }
        // Flush any data that arrived while fetching the output buffer
        if (pendingData.length > 0) {
          for (const data of pendingData) {
            termRef.current.write(data);
          }
        }
        outputRestored = true;
      })
      .catch((err) => {
        // Terminal session might not exist (e.g., already destroyed)
        console.warn(`[TerminalView] Failed to restore output buffer for ${terminalId}:`, err);
        outputRestored = true;
      });

    // Handle container resize
    const resizeObserver = new ResizeObserver(() => {
      if (fitRef.current && termRef.current) {
        try {
          fitRef.current.fit();
        } catch {
          // ignore fit errors during teardown
        }
      }
    });
    resizeObserver.observe(containerRef.current);

    // Initial resize notification
    void resizeTerminalRef(terminalId, term.cols, term.rows);

    // ── Right-click copy: intercept contextmenu on the terminal container ──
    // When the user right-clicks with a selection, copy it to clipboard.
    // This matches the behaviour of Windows Terminal, PuTTY, etc.
    const handleContextMenu = (e: MouseEvent): void => {
      const selection = term.getSelection();
      if (selection) {
        e.preventDefault();
        void navigator.clipboard.writeText(selection).then(() => {
          setCopied(true);
          if (copiedTimerRef.current) clearTimeout(copiedTimerRef.current);
          copiedTimerRef.current = setTimeout(() => setCopied(false), 1500);
        }).catch(() => {
          // clipboard write failed — let default context menu show
        });
      }
    };
    containerRef.current.addEventListener('contextmenu', handleContextMenu);

    // ── Ctrl+Shift+C / Ctrl+Insert keyboard copy shortcut ──
    const handleKeyDown = (e: KeyboardEvent): void => {
      // Ctrl+Shift+C (standard terminal copy) or Ctrl+Insert (Windows copy)
      if ((e.ctrlKey && e.shiftKey && e.key === 'C') || (e.ctrlKey && e.key === 'Insert')) {
        const selection = term.getSelection();
        if (selection) {
          e.preventDefault();
          void navigator.clipboard.writeText(selection).then(() => {
            setCopied(true);
            if (copiedTimerRef.current) clearTimeout(copiedTimerRef.current);
            copiedTimerRef.current = setTimeout(() => setCopied(false), 1500);
          }).catch(() => {});
        }
      }
    };
    // Attach to the container so it captures keyboard events from the terminal
    containerRef.current.addEventListener('keydown', handleKeyDown);

    // Capture the container element for the cleanup function — containerRef.current
    // may have changed by the time the cleanup runs.
    const container = containerRef.current;

    return () => {
      inputDisposable.dispose();
      resizeDisposable.dispose();
      cleanup?.();
      resizeObserver.disconnect();
      container?.removeEventListener('contextmenu', handleContextMenu);
      container?.removeEventListener('keydown', handleKeyDown);
      term.dispose();
      termRef.current = null;
      fitRef.current = null;
    };
  }, [terminalId, writeToTerminalRef, resizeTerminalRef]);

  // 主题切换时同步终端配色（Issue #3）：
  // - follow-ui 模式：UI 主题切换（currentTheme 变化）后 CSS 变量联动
  // - independent 模式：选择内置主题 / 切换模式后立即应用新调色盘
  //   themeId 未命中内置主题时回退 CSS 变量（resolveTerminalITheme 内处理）
  useEffect(() => {
    if (termRef.current) {
      termRef.current.options.theme = resolveTerminalITheme(useTerminalThemeStore.getState());
    }
  }, [currentTheme, terminalThemeMode, terminalThemeId]);

  // Cleanup copied feedback timer on unmount
  useEffect(() => {
    return () => {
      if (copiedTimerRef.current) clearTimeout(copiedTimerRef.current);
    };
  }, []);

  return (
    <div className="relative h-full w-full overflow-hidden bg-background">
      <div
        ref={containerRef}
        className="h-full w-full"
      />
      {/* Copy button — always visible in the top-right corner */}
      <button
        onClick={() => void copySelection()}
        className="absolute right-2 top-2 z-10 flex items-center gap-1 rounded-md border border-border/50 bg-background/80 px-2 py-1 text-[10px] text-muted-foreground shadow-sm backdrop-blur-sm transition-all hover:bg-accent hover:text-foreground"
        title="复制选中内容 (右键或 Ctrl+Shift+C)"
      >
        {copied ? (
          <>
            <Check className="h-3 w-3 text-status-pass-foreground" />
            <span className="text-status-pass-foreground">已复制</span>
          </>
        ) : (
          <>
            <Copy className="h-3 w-3" />
            <span>复制</span>
          </>
        )}
      </button>
    </div>
  );
}
