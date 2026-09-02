/**
 * OSC 133 序列解析器（Issue #7）—— 命令装饰器的前端状态管理。
 *
 * Shell Integration 脚本（osc133.zsh / osc133.ps1）在命令边界发送三种 OSC 序列：
 *   OSC 133;A              — 命令行开始（Prompt 渲染完成后、用户输入前）
 *   OSC 133;C              — 命令输出前（用户按下 Enter 后、命令输出前）
 *   OSC 133;D;<exit_code>  — 命令完成（命令结束后，携带退出码）
 *
 * 本模块维护命令边界状态，供 TerminalView 注册 xterm.js OSC handler 使用。
 * 装饰器渲染由 CommandDecorator 组件基于此状态完成。
 *
 * 仅对 Enhanced Terminal（交互式终端）生效。仿真终端不发送 OSC 133 序列，
 * 不创建命令记录。
 */

/** 一条命令的完整边界信息 */
export type CommandBoundary = {
  /** 命令开始时 xterm.js buffer 的行号（A 标记时的 cursor 行） */
  startLine: number;
  /** 命令输出开始时的行号（C 标记时的 cursor 行） */
  outputStartLine: number | null;
  /** 命令退出码（D 标记携带；null 表示命令尚未完成） */
  exitCode: number | null;
  /** 命令开始时间戳（A 标记时记录） */
  startTime: number;
  /** 命令完成时间戳（D 标记时记录） */
  endTime: number | null;
};

/**
 * OSC 133 状态机——解析 A/C/D 序列，维护命令边界列表。
 *
 * 使用方式：
 * 1. TerminalView 注册 `term.parser.registerOscHandler(133, (data) => parser.handle(data, term))`
 * 2. 命令完成后从 `parser.commands` 读取边界信息，使用 `term.registerDecoration()` 渲染装饰器
 * 3. OutputBuffer restore 前调用 `parser.reset()` 清空状态，避免二次解析产生重复装饰器
 */
export class Osc133Parser {
  private _commands: CommandBoundary[] = [];
  private _currentCommand: CommandBoundary | null = null;

  /** 已完成的命令边界列表（只读） */
  get commands(): readonly CommandBoundary[] {
    return this._commands;
  }

  /**
   * 处理一条 OSC 133 序列。
   *
   * @param data - OSC payload（如 `133;A`、`133;C`、`133;D;0`）
   * @param cursorLine - 当前的 cursor 行号（由 TerminalView 从 term.buffer 提供）
   * @returns true 表示已处理，false 表示非 133 序列
   */
  handle(data: string, cursorLine: number): boolean {
    // xterm.js OSC handler 收到的 data 是 ST 之前的部分（如 "133;A"）
    if (!data.startsWith('133;')) return false;

    const payload = data.slice(4); // 去掉 "133;" 前缀

    if (payload === 'A') {
      // 命令行开始 — 如果上一个命令还没收到 D，先关闭它（安全兜底）
      if (this._currentCommand && this._currentCommand.exitCode === null) {
        this._currentCommand.endTime = Date.now();
        this._currentCommand.exitCode = -1; // 未知退出码
        this._commands.push(this._currentCommand);
      }
      this._currentCommand = {
        startLine: cursorLine,
        outputStartLine: null,
        exitCode: null,
        startTime: Date.now(),
        endTime: null,
      };
      return true;
    }

    if (payload === 'C') {
      // 命令输出前 — 记录输出起始行
      if (this._currentCommand) {
        this._currentCommand.outputStartLine = cursorLine;
      }
      return true;
    }

    if (payload.startsWith('D')) {
      // 命令完成 — 携带退出码
      const exitCodeStr = payload.slice(2); // 去掉 "D;"
      const exitCode = exitCodeStr === '' ? -1 : parseInt(exitCodeStr, 10);
      if (this._currentCommand) {
        this._currentCommand.exitCode = Number.isNaN(exitCode) ? -1 : exitCode;
        this._currentCommand.endTime = Date.now();
        this._commands.push(this._currentCommand);
        this._currentCommand = null;
      }
      return true;
    }

    return false;
  }

  /**
   * 重置所有状态——OutputBuffer restore 前调用。
   *
   * TerminalManager 的 outputBuffer 包含所有 PTY 输出（含 OSC 133 转义序列）。
   * TerminalView remount 时 restore 的文本会重新写入 xterm.js，OSC 133 序列
   * 会被二次解析。在 restore 前调用 reset() 清空命令装饰器状态，
   * 让重新解析重建命令边界，避免重复 / 混乱的装饰器。
   */
  reset(): void {
    this._commands = [];
    this._currentCommand = null;
  }

  /** 获取当前未完成的命令（用于调试 / 测试） */
  get currentCommand(): CommandBoundary | null {
    return this._currentCommand;
  }
}

/**
 * 格式化执行时间为人类可读字符串。
 *
 * @param startTime - 命令开始时间戳
 * @param endTime - 命令完成时间戳
 * @returns 如 `2.3s`、`150ms`、`1m 23s`
 */
export function formatDuration(startTime: number, endTime: number): string {
  const ms = endTime - startTime;
  if (ms < 1000) return `${Math.round(ms)}ms`;
  const seconds = ms / 1000;
  if (seconds < 60) return `${seconds.toFixed(1)}s`;
  const minutes = Math.floor(seconds / 60);
  const remainingSeconds = Math.round(seconds % 60);
  return `${minutes}m ${remainingSeconds}s`;
}
