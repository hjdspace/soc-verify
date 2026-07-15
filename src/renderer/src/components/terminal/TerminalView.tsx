import { useEffect, useRef } from 'react';
import { Terminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import '@xterm/xterm/css/xterm.css';
import { useTerminalStore } from '@renderer/stores/terminal';
import { trpc } from '@renderer/lib/trpc';

interface TerminalViewProps {
  terminalId: string;
}

export function TerminalView({ terminalId }: TerminalViewProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const termRef = useRef<Terminal | null>(null);
  const fitRef = useRef<FitAddon | null>(null);
  const writeToTerminal = useTerminalStore((s) => s.writeToTerminal);
  const resizeTerminal = useTerminalStore((s) => s.resizeTerminal);

  useEffect(() => {
    if (!containerRef.current) return;

    const term = new Terminal({
      cursorBlink: true,
      fontSize: 13,
      fontFamily: 'Consolas, "Courier New", monospace',
      scrollback: 100000,
      allowProposedApi: true,
      theme: {
        background: '#1e1e2e',
        foreground: '#cdd6f4',
        cursor: '#f5e0dc',
        selectionBackground: '#585b70',
      },
    });

    const fitAddon = new FitAddon();
    term.loadAddon(fitAddon);
    term.open(containerRef.current);
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
      void writeToTerminal(terminalId, data);
    });

    // Handle resize → send new size to main process
    const resizeDisposable = term.onResize(({ cols, rows }) => {
      void resizeTerminal(terminalId, cols, rows);
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

    // Restore output buffer from main process
    trpc.terminal.getOutputBuffer
      .query({ terminalId })
      .then((chunks) => {
        if (termRef.current && chunks.length > 0) {
          termRef.current.write(chunks.join(''));
        }
        // Flush any data that arrived while fetching the output buffer
        if (termRef.current && pendingData.length > 0) {
          for (const data of pendingData) {
            termRef.current.write(data);
          }
        }
        outputRestored = true;
      })
      .catch(() => {
        // Terminal session might not exist (e.g., already destroyed)
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
    void resizeTerminal(terminalId, term.cols, term.rows);

    return () => {
      inputDisposable.dispose();
      resizeDisposable.dispose();
      cleanup?.();
      resizeObserver.disconnect();
      term.dispose();
      termRef.current = null;
      fitRef.current = null;
    };
  }, [terminalId, writeToTerminal, resizeTerminal]);

  return (
    <div
      ref={containerRef}
      className="h-full w-full overflow-hidden bg-[#1e1e2e]"
    />
  );
}
