import { useEffect, useRef, useState, useCallback } from 'react';
import { Terminal } from '@xterm/xterm';
import type { IDecoration } from '@xterm/xterm';
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
import { Osc133Parser, type CommandBoundary } from './osc133-parser';
import { formatDuration } from './osc133-parser';

interface TerminalViewProps {
  terminalId: string;
}

/** 装饰器实例 + 关联的命令边界 */
type DecorationEntry = {
  decoration: IDecoration;
  command: CommandBoundary;
  /** 命令行文本缓存（onRender 后从 buffer 读取一次） */
  commandText: string;
  /** 装饰器容器 div */
  container: HTMLDivElement;
  /** 折叠状态 */
  collapsed: boolean;
};

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

  // ── OSC 133 命令装饰器状态（Issue #7）──────────────────────
  const oscParserRef = useRef<Osc133Parser>(new Osc133Parser());
  const decorationsRef = useRef<Map<number, DecorationEntry>>(new Map());
  // decoratorVersion 仅用于触发 re-render（装饰器状态变化时更新计数）
  const [, setDecoratorVersion] = useState(0);

  /** 从 xterm.js buffer 读取指定行的文本 */
  const readLineText = useCallback((term: Terminal, line: number): string => {
    const buffer = term.buffer.active;
    const lineData = buffer.getLine(line);
    if (!lineData) return '';
    return lineData.translateToString(true);
  }, []);

  /**
   * 用原生 DOM 渲染装饰器内容到给定元素。
   *
   * xterm.js Decoration 的 onRender 回调提供 HTMLElement，我们在此元素上
   * 渲染退出码图标、执行时间、复制按钮、折叠按钮。
   * 装饰器不写入 xterm.js buffer，不干扰终端正常输入/输出。
   * 配色用 CSS 变量语义色（--status-pass / --status-fail）。
   */
  const renderDecoratorContent = useCallback((
    el: HTMLElement,
    command: CommandBoundary,
    commandText: string,
    collapsed: boolean,
    onToggleCollapse: (collapsed: boolean) => void,
  ) => {
    const isPass = command.exitCode === 0;
    const hasEndTime = command.endTime !== null;
    const duration = hasEndTime
      ? formatDuration(command.startTime, command.endTime!)
      : '';

    el.className = 'cmd-decorator-inner';
    el.innerHTML = '';

    // ── 退出码图标 ──────────────────────────────────
    const exitIcon = document.createElement('span');
    exitIcon.className = `cmd-exit-code ${isPass ? 'cmd-pass' : 'cmd-fail'}`;
    exitIcon.title = isPass ? '命令成功 (exit 0)' : `命令失败 (exit ${command.exitCode})`;
    exitIcon.textContent = isPass ? '✓' : '✗';
    if (!isPass && command.exitCode !== null && command.exitCode >= 0) {
      const exitNum = document.createElement('span');
      exitNum.className = 'cmd-exit-num';
      exitNum.textContent = String(command.exitCode);
      exitIcon.appendChild(exitNum);
    }
    el.appendChild(exitIcon);

    // ── 执行时间 ────────────────────────────────────
    if (duration) {
      const durationEl = document.createElement('span');
      durationEl.className = 'cmd-duration';
      durationEl.title = '执行时间';
      durationEl.textContent = duration;
      el.appendChild(durationEl);
    }

    // ── 复制按钮 ────────────────────────────────────
    const copyBtn = document.createElement('button');
    copyBtn.className = 'cmd-copy-btn';
    copyBtn.title = '复制命令';
    copyBtn.setAttribute('data-testid', 'command-copy-btn');
    copyBtn.textContent = '⎘';
    copyBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      void navigator.clipboard.writeText(commandText).then(() => {
        copyBtn.textContent = '✓';
        copyBtn.classList.add('cmd-copied');
        setTimeout(() => {
          copyBtn.textContent = '⎘';
          copyBtn.classList.remove('cmd-copied');
        }, 1500);
      }).catch(() => {});
    });
    el.appendChild(copyBtn);

    // ── 折叠/展开按钮 ───────────────────────────────
    const collapseBtn = document.createElement('button');
    collapseBtn.className = 'cmd-collapse-btn';
    collapseBtn.title = collapsed ? '展开输出' : '折叠输出';
    collapseBtn.setAttribute('data-testid', 'command-collapse-btn');
    collapseBtn.textContent = collapsed ? '▸' : '▾';
    collapseBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      onToggleCollapse(!collapsed);
    });
    el.appendChild(collapseBtn);
  }, []);

  /** 为命令创建 xterm.js Decoration 并渲染装饰器内容 */
  const createDecoration = useCallback((
    term: Terminal,
    command: CommandBoundary,
  ): DecorationEntry | null => {
    // 使用 marker 方式（而非固定行号），确保终端 scroll 后装饰器位置自动跟随
    const marker = term.registerMarker(command.startLine - term.buffer.active.baseY);
    if (!marker) return null;

    const decoration = term.registerDecoration({
      marker,
      anchor: 'right',
      x: 0,
    });

    if (!decoration) return null;

    // 创建容器 div 用于挂载到 xterm.js Decoration DOM 元素
    const container = document.createElement('div');
    container.className = 'cmd-decorator-host';
    container.style.position = 'absolute';
    container.style.zIndex = '10';
    container.style.pointerEvents = 'auto';

    let commandText = '';
    let collapsed = false;

    decoration.onRender((element: HTMLElement) => {
      // 将装饰器容器挂载到 xterm.js 提供的 DOM 元素
      if (!element.contains(container)) {
        element.style.position = 'relative';
        element.appendChild(container);
      }

      // 首次渲染时读取命令行文本
      if (!commandText) {
        commandText = readLineText(term, command.startLine);
      }

      // 渲染装饰器内容
      const innerEl = container.querySelector('.cmd-decorator-inner') as HTMLElement | null;
      const targetEl = innerEl ?? document.createElement('div');
      if (!innerEl) {
        container.appendChild(targetEl);
      }

      renderDecoratorContent(targetEl, command, commandText, collapsed, (next) => {
        collapsed = next;
        if (collapsed) {
          container.classList.add('cmd-decorator-collapsed');
        } else {
          container.classList.remove('cmd-decorator-collapsed');
        }
        // 重新渲染以更新折叠按钮图标
        renderDecoratorContent(targetEl, command, commandText, collapsed, (n) => {
          collapsed = n;
          if (collapsed) {
            container.classList.add('cmd-decorator-collapsed');
          } else {
            container.classList.remove('cmd-decorator-collapsed');
          }
        });
      });
    });

    return {
      decoration,
      command,
      commandText,
      container,
      collapsed: false,
    };
  }, [readLineText, renderDecoratorContent]);

  /** Copy the current terminal selection to clipboard. Returns true if text was copied. */
  const copySelection = useCallback(async (): Promise<boolean> => {
    const term = termRef.current;
    if (!term) return false;
    const selection = term.getSelection();
    if (!selection) return false;
    try {
      await navigator.clipboard.writeText(selection);
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

    // ── OSC 133 状态重置（OutputBuffer restore 前清空）──────────
    // TerminalManager 的 outputBuffer 包含所有 PTY 输出（含 OSC 133 转义序列）。
    // remount 时 restore 的文本会重新写入 xterm.js，OSC 133 序列会被二次解析。
    // 在 effect 开头（restore 前）清空命令装饰器状态，让重新解析重建装饰器。
    oscParserRef.current.reset();
    decorationsRef.current.clear();
    setDecoratorVersion(0);

    const term = new Terminal({
      cursorBlink: true,
      fontSize: 13,
      fontFamily:
        "'JetBrainsMono Nerd Font', 'MesloLGS NF', 'Consolas', 'Courier New', monospace",
      scrollback: 100000,
      allowProposedApi: true,
      theme: resolveTerminalITheme(useTerminalThemeStore.getState()),
    });

    const fitAddon = new FitAddon();
    term.loadAddon(fitAddon);
    term.open(containerRef.current);

    // ── WebGL GPU 加速渲染（Issue #2）────────────────────────
    try {
      const webglAddon = new WebglAddon();
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

    // ── OSC 133 handler 注册（Issue #7）──────────────────────
    // 解析 Shell Integration 脚本发送的 A/C/D 序列，维护命令边界状态。
    // 命令完成后创建 xterm.js Decoration 渲染装饰器。
    // 仅 Enhanced Terminal 会发送 OSC 133 序列；仿真终端不发送，不会创建装饰器。
    const oscDisposable = term.parser.registerOscHandler(133, (data: string): boolean => {
      const cursorLine = term.buffer.active.baseY + term.buffer.active.cursorY;
      const handled = oscParserRef.current.handle(data, cursorLine);

      if (handled) {
        // 检查是否有新完成的命令需要创建装饰器
        const commands = oscParserRef.current.commands;
        const existingCount = decorationsRef.current.size;

        for (let i = existingCount; i < commands.length; i++) {
          const cmd = commands[i];
          if (cmd.exitCode === null) continue;
          const entry = createDecoration(term, cmd);
          if (entry) {
            decorationsRef.current.set(i, entry);
          }
        }

        if (commands.length > existingCount) {
          setDecoratorVersion((v) => v + 1);
        }
      }

      return handled;
    });

    // ── Output buffer restoration ──────────────────────────
    // 注意：outputBuffer 包含 OSC 133 转义序列，restore 时会被二次解析。
    // oscParserRef 已在 effect 开头 reset()，重新解析将重建命令边界和装饰器。
    let outputRestored = false;
    const pendingData: string[] = [];

    const inputDisposable = term.onData((data) => {
      void writeToTerminalRef(terminalId, data);
    });

    const resizeDisposable = term.onResize(({ cols, rows }) => {
      void resizeTerminalRef(terminalId, cols, rows);
    });

    let cleanup: (() => void) | undefined;
    if (window.eventBridge) {
      cleanup = window.eventBridge.onTerminalData(({ id, data }) => {
        if (id === terminalId && termRef.current) {
          if (outputRestored) {
            termRef.current.write(data);
          } else {
            pendingData.push(data);
          }
        }
      });
    }

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
        if (pendingData.length > 0) {
          for (const data of pendingData) {
            termRef.current.write(data);
          }
        }
        outputRestored = true;
      })
      .catch((err) => {
        console.warn(`[TerminalView] Failed to restore output buffer for ${terminalId}:`, err);
        outputRestored = true;
      });

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

    void resizeTerminalRef(terminalId, term.cols, term.rows);

    // ── Right-click copy ──
    const handleContextMenu = (e: MouseEvent): void => {
      const selection = term.getSelection();
      if (selection) {
        e.preventDefault();
        void navigator.clipboard.writeText(selection).then(() => {
          setCopied(true);
          if (copiedTimerRef.current) clearTimeout(copiedTimerRef.current);
          copiedTimerRef.current = setTimeout(() => setCopied(false), 1500);
        }).catch(() => {});
      }
    };
    containerRef.current.addEventListener('contextmenu', handleContextMenu);

    // ── Ctrl+Shift+C / Ctrl+Insert keyboard copy ──
    const handleKeyDown = (e: KeyboardEvent): void => {
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
    containerRef.current.addEventListener('keydown', handleKeyDown);

    const container = containerRef.current;

    return () => {
      oscDisposable.dispose();
      inputDisposable.dispose();
      resizeDisposable.dispose();
      cleanup?.();
      resizeObserver.disconnect();
      container?.removeEventListener('contextmenu', handleContextMenu);
      container?.removeEventListener('keydown', handleKeyDown);
      // 清理装饰器 DOM 元素
      for (const entry of decorationsRef.current.values()) {
        entry.container.remove();
      }
      decorationsRef.current.clear();
      term.dispose();
      termRef.current = null;
      fitRef.current = null;
    };
  }, [terminalId, writeToTerminalRef, resizeTerminalRef, createDecoration]);

  // 主题切换时同步终端配色（Issue #3）
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
