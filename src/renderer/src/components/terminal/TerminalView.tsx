import { useEffect, useRef } from 'react';
import { Terminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import '@xterm/xterm/css/xterm.css';
import { useTerminalStore } from '@renderer/stores/terminal';

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
          termRef.current.write(data);
        }
      });
    }

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
