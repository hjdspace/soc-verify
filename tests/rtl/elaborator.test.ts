/**
 * elaborator.ts 单元测试（issue 08 补齐）。
 *
 * 测试缝：parseDiagnostics + renderYosysScript 纯函数边界。
 * 不测 elaborate() spawn（那在 rtl-router.test.ts 的 mock spawn 模式覆盖）。
 *
 * 覆盖：
 *   - parseDiagnostics：slang 诊断行格式解析（file:line:col: severity: message）
 *     包括 Windows 盘符冒号、无 column 行、多 severity 等级
 *   - renderYosysScript：--keep-hierarchy 固化 + --top 可选 + write_json 路径
 *   - RtlElaborationError.toElaborationError 结构化转换
 */

import { describe, it, expect } from 'vitest';
import { parseDiagnostics, renderYosysScript, firstErrorLine, RtlElaborationError } from '../../src/main/rtl/elaborator';

// ─── parseDiagnostics ────────────────────────────────────────

describe('parseDiagnostics', () => {
  it('解析标准 slang 诊断行（file:line:col: severity: message）', () => {
    const log = 'rtl/ip/spike_ip.sv:99:5: error: unknown port `nope`';
    const diags = parseDiagnostics(log);
    expect(diags).toHaveLength(1);
    expect(diags[0]).toMatchObject({
      file: 'rtl/ip/spike_ip.sv',
      line: 99,
      column: 5,
      severity: 'error',
      message: 'unknown port `nope`',
    });
  });

  it('解析 Windows 盘符路径（D:\\path\\a.sv:line:col: severity: message）', () => {
    const log = 'D:\\proj\\rtl\\top.sv:10:3: error: syntax error';
    const diags = parseDiagnostics(log);
    expect(diags).toHaveLength(1);
    expect(diags[0]).toMatchObject({
      file: 'D:\\proj\\rtl\\top.sv',
      line: 10,
      column: 3,
      severity: 'error',
    });
  });

  it('无 column 的诊断行（file:line:severity: message，severity 前无空格）', () => {
    // regex 允许 file:line:severity:（col 省略时 severity 紧跟第二个冒号后）
    const log = 'rtl/top.sv:42:warning: unused signal';
    const diags = parseDiagnostics(log);
    expect(diags).toHaveLength(1);
    expect(diags[0]).toMatchObject({
      file: 'rtl/top.sv',
      line: 42,
      column: null,
      severity: 'warning',
    });
  });

  it('多行混合 severity 等级', () => {
    const log = [
      'rtl/a.sv:1:1: error: first error',
      'rtl/b.sv:2:3: warning: second warning',
      'rtl/c.sv:4:5: info: info message',
      'rtl/d.sv:6:7: note: note message',
      'rtl/e.sv:8:9: fatal: fatal error',
    ].join('\n');
    const diags = parseDiagnostics(log);
    expect(diags).toHaveLength(5);
    expect(diags.map((d) => d.severity)).toEqual(['error', 'warning', 'info', 'note', 'fatal']);
  });

  it('非诊断行被跳过（yosys 命令输出行）', () => {
    const log = [
      '1. Executing Verilog-2005 frontend: read_slang -f design_flat.f --top spike_top --keep-hierarchy',
      'rtl/top.sv:3:1: error: some error',
      'ERROR: read_slang failed in design.ys',
      'End of script.',
    ].join('\n');
    const diags = parseDiagnostics(log);
    expect(diags).toHaveLength(1);
    expect(diags[0]?.file).toBe('rtl/top.sv');
  });

  it('空日志返回空数组', () => {
    expect(parseDiagnostics('')).toEqual([]);
    expect(parseDiagnostics('\n\n')).toEqual([]);
  });

  it('severity 大小写不敏感（ERROR → error）', () => {
    const log = 'rtl/top.sv:1:1: ERROR: something';
    const diags = parseDiagnostics(log);
    expect(diags[0]?.severity).toBe('error');
  });

  it('message 含冒号时正确解析（惰性匹配到 severity 关键字）', () => {
    const log = 'rtl/top.sv:1:1: error: expected `;` at `endmodule` line 5: missing semicolon';
    const diags = parseDiagnostics(log);
    expect(diags[0]?.message).toBe('expected `;` at `endmodule` line 5: missing semicolon');
  });
});

// ─── renderYosysScript ───────────────────────────────────────

describe('renderYosysScript', () => {
  it('固化 --keep-hierarchy + --top + write_json', () => {
    const script = renderYosysScript('/path/to/design_flat.f', 'spike_top', '/work/design.json');
    expect(script).toContain('read_slang -f /path/to/design_flat.f --top spike_top --keep-hierarchy');
    expect(script).toContain('write_json /work/design.json');
  });

  it('固化 --ignore-timing（忽略 intra-assignment 延迟，如 wujian100 dmac.v 的 `<= #1`）', () => {
    const script = renderYosysScript('/path/to/design_flat.f', 'spike_top', '/work/design.json');
    expect(script).toContain('--keep-hierarchy --ignore-timing');
  });

  it('top 为 null 时不带 --top（detectTops 模式）', () => {
    const script = renderYosysScript('/path/to/design_flat.f', null, '/work/design.json');
    expect(script).toContain('read_slang -f /path/to/design_flat.f --keep-hierarchy');
    expect(script).not.toContain('--top');
    expect(script).toContain('write_json');
  });

  it('脚本以换行结尾（yosys 逐行解析）', () => {
    const script = renderYosysScript('/path.f', 'top', '/out.json');
    expect(script.endsWith('\n')).toBe(true);
  });
});

// ─── firstErrorLine ──────────────────────────────────────────

describe('firstErrorLine', () => {
  it('提取 slang 无位置错误行（error: ... 开头）', () => {
    const log = ['warning: include directory not found', "error: 'D:proja.sv': No such file or directory"].join('\n');
    expect(firstErrorLine(log)).toBe("error: 'D:proja.sv': No such file or directory");
  });

  it('提取 yosys 大写 ERROR: 行', () => {
    const log = ['1. Executing SLANG frontend.', 'ERROR: read_slang failed in design.ys'].join('\n');
    expect(firstErrorLine(log)).toBe('ERROR: read_slang failed in design.ys');
  });

  it('warning 行不匹配（只认 error）', () => {
    const log = 'warning: include directory was not found';
    expect(firstErrorLine(log)).toBeNull();
  });

  it('空日志 / 无错误行返回 null', () => {
    expect(firstErrorLine('')).toBeNull();
    expect(firstErrorLine('End of script.\nAll good.')).toBeNull();
  });
});

// ─── RtlElaborationError.toElaborationError ──────────────────

describe('RtlElaborationError', () => {
  it('toElaborationError 转换为结构化错误', () => {
    const diags = [{ file: 'rtl/top.sv', line: 10, column: 5, severity: 'error' as const, message: 'oops' }];
    const err = new RtlElaborationError('elaboration 失败', diags, 'log tail');
    const structured = err.toElaborationError();
    expect(structured.message).toBe('elaboration 失败');
    expect(structured.diagnostics).toEqual(diags);
    expect(structured.logTail).toBe('log tail');
  });

  it('name 为 RtlElaborationError', () => {
    const err = new RtlElaborationError('msg', [], '');
    expect(err.name).toBe('RtlElaborationError');
  });
});
