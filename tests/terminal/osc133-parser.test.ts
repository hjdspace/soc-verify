import { describe, it, expect, beforeEach, vi } from 'vitest';
import { Osc133Parser, formatDuration } from '../../src/renderer/src/components/terminal/osc133-parser';

describe('Osc133Parser', () => {
  let parser: Osc133Parser;

  beforeEach(() => {
    parser = new Osc133Parser();
    // Mock Date.now for deterministic timing
    vi.spyOn(Date, 'now').mockReturnValue(1000);
  });

  // ── A 标记（命令行开始）─────────────────────────────────
  describe('A 标记（命令行开始）', () => {
    it('收到 A 标记后创建当前命令，记录 startLine 和 startTime', () => {
      const handled = parser.handle('133;A', 5);
      expect(handled).toBe(true);
      expect(parser.currentCommand).not.toBeNull();
      expect(parser.currentCommand!.startLine).toBe(5);
      expect(parser.currentCommand!.startTime).toBe(1000);
      expect(parser.currentCommand!.exitCode).toBeNull();
    });

    it('连续两个 A 标记时，第一个未完成的命令被关闭（安全兜底）', () => {
      parser.handle('133;A', 1);
      vi.spyOn(Date, 'now').mockReturnValue(2000);
      parser.handle('133;A', 3);

      // 第一个命令应被关闭并加入 commands 列表
      expect(parser.commands).toHaveLength(1);
      expect(parser.commands[0].exitCode).toBe(-1); // 未知退出码
      expect(parser.commands[0].endTime).toBe(2000);
      // 第二个 A 标记创建新的当前命令
      expect(parser.currentCommand).not.toBeNull();
      expect(parser.currentCommand!.startLine).toBe(3);
    });
  });

  // ── C 标记（命令输出前）─────────────────────────────────
  describe('C 标记（命令输出前）', () => {
    it('收到 C 标记后记录 outputStartLine', () => {
      parser.handle('133;A', 1);
      const handled = parser.handle('133;C', 2);
      expect(handled).toBe(true);
      expect(parser.currentCommand!.outputStartLine).toBe(2);
    });

    it('无当前命令时收到 C 标记不影响状态', () => {
      const handled = parser.handle('133;C', 2);
      expect(handled).toBe(true);
      expect(parser.currentCommand).toBeNull();
      expect(parser.commands).toHaveLength(0);
    });
  });

  // ── D 标记（命令完成）───────────────────────────────────
  describe('D 标记（命令完成）', () => {
    it('收到 D;0 后关闭命令，exitCode=0', () => {
      parser.handle('133;A', 1);
      vi.spyOn(Date, 'now').mockReturnValue(1500);
      const handled = parser.handle('133;D;0', 5);
      expect(handled).toBe(true);
      expect(parser.commands).toHaveLength(1);
      expect(parser.commands[0].exitCode).toBe(0);
      expect(parser.commands[0].endTime).toBe(1500);
      expect(parser.currentCommand).toBeNull();
    });

    it('收到 D;1 后关闭命令，exitCode=1', () => {
      parser.handle('133;A', 1);
      parser.handle('133;D;1', 5);
      expect(parser.commands[0].exitCode).toBe(1);
    });

    it('收到 D;127 后关闭命令，exitCode=127', () => {
      parser.handle('133;A', 1);
      parser.handle('133;D;127', 5);
      expect(parser.commands[0].exitCode).toBe(127);
    });

    it('收到 D 无退出码时 exitCode=-1（未知）', () => {
      parser.handle('133;A', 1);
      parser.handle('133;D;', 5);
      expect(parser.commands[0].exitCode).toBe(-1);
    });

    it('无当前命令时收到 D 标记不影响状态', () => {
      const handled = parser.handle('133;D;0', 5);
      expect(handled).toBe(true);
      expect(parser.commands).toHaveLength(0);
    });
  });

  // ── 完整命令生命周期 A → C → D ─────────────────────────
  describe('完整命令生命周期', () => {
    it('A → C → D;0 完整序列', () => {
      vi.spyOn(Date, 'now').mockReturnValue(1000);
      parser.handle('133;A', 1);  // 命令开始，行 1
      vi.spyOn(Date, 'now').mockReturnValue(1010);
      parser.handle('133;C', 2);  // 命令输出，行 2
      vi.spyOn(Date, 'now').mockReturnValue(2500);
      parser.handle('133;D;0', 5);  // 命令完成，行 5

      expect(parser.commands).toHaveLength(1);
      const cmd = parser.commands[0];
      expect(cmd.startLine).toBe(1);
      expect(cmd.outputStartLine).toBe(2);
      expect(cmd.exitCode).toBe(0);
      expect(cmd.startTime).toBe(1000);
      expect(cmd.endTime).toBe(2500);
    });

    it('多条命令连续解析', () => {
      // 命令 1
      vi.spyOn(Date, 'now').mockReturnValue(1000);
      parser.handle('133;A', 1);
      parser.handle('133;C', 2);
      vi.spyOn(Date, 'now').mockReturnValue(1500);
      parser.handle('133;D;0', 3);

      // 命令 2（新的 A 标记）
      vi.spyOn(Date, 'now').mockReturnValue(2000);
      parser.handle('133;A', 4);
      parser.handle('133;C', 5);
      vi.spyOn(Date, 'now').mockReturnValue(3000);
      parser.handle('133;D;1', 6);

      expect(parser.commands).toHaveLength(2);
      expect(parser.commands[0].exitCode).toBe(0);
      expect(parser.commands[0].startTime).toBe(1000);
      expect(parser.commands[1].exitCode).toBe(1);
      expect(parser.commands[1].startTime).toBe(2000);
    });
  });

  // ── 非 133 序列 ─────────────────────────────────────────
  describe('非 133 序列', () => {
    it('不以 133; 开头的序列返回 false', () => {
      expect(parser.handle('0;some', 1)).toBe(false);
      expect(parser.handle('999', 1)).toBe(false);
      expect(parser.handle('', 1)).toBe(false);
    });

    it('133; 后跟未知子标记返回 false', () => {
      expect(parser.handle('133;X', 1)).toBe(false);
      expect(parser.handle('133;Z;extra', 1)).toBe(false);
    });
  });

  // ── reset() ───────────────────────────────────────────
  describe('reset()', () => {
    it('清空所有命令和当前命令状态', () => {
      parser.handle('133;A', 1);
      parser.handle('133;D;0', 3);
      expect(parser.commands).toHaveLength(1);
      expect(parser.currentCommand).toBeNull();

      parser.reset();
      expect(parser.commands).toHaveLength(0);
      expect(parser.currentCommand).toBeNull();
    });

    it('reset 后可以重新解析序列（模拟 OutputBuffer restore 二次解析）', () => {
      // 第一轮解析
      parser.handle('133;A', 1);
      parser.handle('133;D;0', 3);
      expect(parser.commands).toHaveLength(1);

      // reset（模拟 remount 前清空）
      parser.reset();

      // 第二轮解析（restore 的 outputBuffer 重新写入 xterm.js）
      vi.spyOn(Date, 'now').mockReturnValue(5000);
      parser.handle('133;A', 1);
      vi.spyOn(Date, 'now').mockReturnValue(6000);
      parser.handle('133;D;0', 3);

      // 应只有一条命令，无重复
      expect(parser.commands).toHaveLength(1);
      expect(parser.commands[0].startTime).toBe(5000);
    });
  });
});

// ── formatDuration 工具函数 ───────────────────────────────
describe('formatDuration', () => {
  it('小于 1 秒时显示 ms', () => {
    expect(formatDuration(1000, 1050)).toBe('50ms');
    expect(formatDuration(1000, 1999)).toBe('999ms');
  });

  it('大于等于 1 秒且小于 60 秒时显示 s（1 位小数）', () => {
    expect(formatDuration(1000, 2300)).toBe('1.3s');
    expect(formatDuration(1000, 11200)).toBe('10.2s');
    expect(formatDuration(1000, 60000)).toBe('59.0s');
  });

  it('大于等于 60 秒时显示 m + s', () => {
    expect(formatDuration(1000, 84000)).toBe('1m 23s');
    expect(formatDuration(1000, 361000)).toBe('6m 0s');
  });
});
