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
  /**
   * 容器是否处于隐藏状态（keep-alive 常驻但 display:none）。
   * 隐藏期间跳过 fit（对零尺寸容器 fit 会抛错/全量重算），restore 的
   * 输出暂不写入 xterm，等重新可见时再重放，避免不可见终端白白占用
   * 渲染帧。再次可见后由 ResizeObserver 触发一次 fit。
   */
  hidden?: boolean;
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

/** Scrollback lines configured on the xterm.js instance (must stay in sync with `new Terminal({ scrollback })`). */
const SCROLLBACK_LINES = 100000;
/**
 * Restore budget in characters: covers the scrollback above, bounded by
 * worst-case line length. 6M chars ≈ 60% of the full 10万行 scrollback at
 * an average 60-char log line — the tail beyond what a remounted terminal
 * can display is discarded server-side instead of crossing IPC.
 */
const RESTORE_MAX_CHARS = 6 * 1024 * 1024;

export function TerminalView({ terminalId, hidden = false }: TerminalViewProps) {
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

  // 恢复中状态：从 outputBuffer 重放到完成之间，覆盖占位层（避免用户看到长时间空白）
  const [restoring, setRestoring] = useState(true);

  // 主 effect 注册的 deferred 重放句柄（见主 effect 内 flushDeferred）
  const flushDeferredRef = useRef<(() => void) | null>(null);
  // hidden prop 的 ref 镜像：effect 闭包（data 回调、restore 回调）读取
  // 的是最新值，避免闭包过期；hidden 变化本身由 visibility effect 响应。
  const hiddenRef = useRef(hidden);
  hiddenRef.current = hidden;

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
      scrollback: SCROLLBACK_LINES,
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

    // 隐藏挂载（keep-alive）：容器 display:none 时 fit 会因零尺寸报错，
    // 跳过初始 fit，等重新可见时由 ResizeObserver / 可见性 effect 补一次。
    if (!hidden) {
      try {
        fitRef.current.fit();
      } catch {
        // ignore fit errors during teardown
      }
    }

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
    /**
     * Restore 期间已到达但尚未写入的数据（含 restore 输出自身 + 实时
     * IPC 数据）。hidden 挂载时 restore 结果也暂存在这里，不写入
     * xterm，直到组件变为可见再重放。
     */
    const deferredWrites: string[] = [];
    /**
     * 主 effect 向可见性 effect 暴露的重放句柄：把 deferredWrites
     * 里暂存的 restore 输出 + 隐藏期实时数据一次性写入 xterm。
     * 两 effect 无法共享局部数组，通过 ref 传递闭包。
     */
    const flushDeferred = (): void => {
      const term = termRef.current;
      if (!term) return;
      while (deferredWrites.length > 0) {
        const batch = deferredWrites.splice(0, 50);
        for (const data of batch) term.write(data);
      }
    };
    flushDeferredRef.current = flushDeferred;

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
            // hidden 挂载的终端暂存数据（不可见终端写入只占渲染帧），
            // 变为可见时在 visibility effect 中统一重放
            if (hiddenRef.current) {
              deferredWrites.push(data);
            } else {
              termRef.current.write(data);
            }
          } else {
            pendingData.push(data);
          }
        }
      });
    }

    trpc.terminal.getOutputBuffer
      .query({ terminalId, maxChars: RESTORE_MAX_CHARS })
      .then((chunks) => {
        if (!termRef.current) {
          outputRestored = true;
          return;
        }
        // 分块顺序 write，不再 join 成一份完整大字符串拷贝。
        // 隐藏挂载时 restore 结果也进 deferredWrites，等可见时重放。
        if (hiddenRef.current) {
          for (const chunk of chunks) deferredWrites.push(chunk);
          for (const data of pendingData) deferredWrites.push(data);
        } else {
          for (const chunk of chunks) termRef.current.write(chunk);
          for (const data of pendingData) termRef.current.write(data);
        }
        outputRestored = true;
        if (!hiddenRef.current) setRestoring(false);
      })
      .catch((err) => {
        console.warn(`[TerminalView] Failed to restore output buffer for ${terminalId}:`, err);
        outputRestored = true;
        if (!hiddenRef.current) setRestoring(false);
      });

    // ── 窗口 resize 期间的 fit 防抖 ─────────────────────────────
    // fit() 每次调用都全量重算网格并整屏重绘。拖拽窗口边框 / 最大化时
    // ResizeObserver 每帧回调，同步 fit 会让 10 万行 scrollback 的
    // 整屏重绘挤占主线程（掉帧直到 resize 结束）。聚到一帧只在尺寸
    // 停稳后做一次。隐藏（keep-alive display:none）时容器尺寸为 0，
    // fit 既无意义又会抛错，直接跳过。
    let fitPending = false;
    const scheduleFit = () => {
      if (fitPending || hiddenRef.current) return;
      fitPending = true;
      window.requestAnimationFrame(() => {
        fitPending = false;
        if (fitRef.current && termRef.current) {
          try {
            fitRef.current.fit();
          } catch {
            // ignore fit errors during teardown
          }
        }
      });
    };

    const resizeObserver = new ResizeObserver(scheduleFit);
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
    // Capture decorations ref for cleanup — decorationsRef.current may
    // have changed by the time cleanup runs.
    const decorations = decorationsRef.current;

    return () => {
      oscDisposable.dispose();
      inputDisposable.dispose();
      resizeDisposable.dispose();
      cleanup?.();
      resizeObserver.disconnect();
      container?.removeEventListener('contextmenu', handleContextMenu);
      container?.removeEventListener('keydown', handleKeyDown);
      // 清理装饰器 DOM 元素
      for (const entry of decorations.values()) {
        entry.container.remove();
      }
      decorations.clear();
      term.dispose();
      termRef.current = null;
      fitRef.current = null;
      flushDeferredRef.current = null;
    };
    // hidden 有意不进依赖：hidden 变化只应触发可见性 effect（重放 +
    // fit），重建 xterm 实例会销毁 10 万行 scrollback，恰恰是要避免的。
    // 当前隐藏状态经 hiddenRef 读取。
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [terminalId, writeToTerminalRef, resizeTerminalRef, createDecoration]);

  // ── 可见性切换：keep-alive 隐藏 → 可见 ───────────────────────
  // hidden 挂载期间 restore 输出与实时数据都暂存在主 effect 的
  // deferredWrites；变为可见时经 flushDeferredRef 统一写入 xterm、
  // 补一次 fit（隐藏期跳过了初始 fit），并揭掉恢复占位层。
  useEffect(() => {
    if (hidden) return;
    flushDeferredRef.current?.();
    try {
      fitRef.current?.fit();
    } catch {
      // ignore fit errors during teardown
    }
    setRestoring(false);
  }, [hidden, terminalId]);

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
      {/* 恢复期占位层：remount 后从 outputBuffer 重放期间覆盖终端，
          避免用户盯着空白等几秒；restore 完成后淡出 */}
      {restoring && (
        <div className="absolute inset-0 z-20 flex items-center justify-center bg-background">
          <div className="flex items-center gap-2 text-xs text-muted-foreground">
            <span className="inline-block h-3 w-3 animate-spin rounded-full border-2 border-muted-foreground/30 border-t-muted-foreground" />
            <span>正在恢复终端输出…</span>
          </div>
        </div>
      )}
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
