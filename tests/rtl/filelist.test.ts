/**
 * filelist.ts — VCS 风格 .f 展开器测试。
 *
 * 覆盖：+incdir+ 多目录、+define+ 多宏、-f/-F 嵌套、注释与续行、
 * 透传旗标、相对路径解析（先 .f 同目录后 baseDir）、循环引用保护。
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { flattenFilelists, renderFlatFilelist, toSlashPath, type ParsedFilelist } from '../../src/main/rtl/filelist';

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'sv-filelist-'));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe('flattenFilelists 基础形态', () => {
  it('+incdir+ 多目录与 +define+ 多宏按 + 拆分', () => {
    const f = join(dir, 'a.f');
    writeFileSync(f, '+incdir+rtl/ip+rtl/common\n+define+SPIKE_MACRO+WIDTH=2\nrtl/top.sv\n');
    const parsed = flattenFilelists([f], dir);
    expect(parsed.incdirs).toEqual([join(dir, 'rtl/ip'), join(dir, 'rtl/common')]);
    expect(parsed.defines).toEqual(['SPIKE_MACRO', 'WIDTH=2']);
    expect(parsed.sources).toEqual([join(dir, 'rtl/top.sv')]);
  });

  it('剥离 // 与 # 注释和空行', () => {
    const f = join(dir, 'a.f');
    writeFileSync(f, [
      '// 顶层注释',
      '+define+FOO // 行尾注释',
      '# shell 风格注释',
      '',
      'rtl/top.sv',
    ].join('\n'));
    const parsed = flattenFilelists([f], dir);
    expect(parsed.defines).toEqual(['FOO']);
    expect(parsed.sources).toEqual([join(dir, 'rtl/top.sv')]);
  });

  it('源文件相对路径优先解析到 .f 同目录，回退 baseDir', () => {
    mkdirSync(join(dir, 'sub'), { recursive: true });
    const f = join(dir, 'sub', 'a.f');
    writeFileSync(join(dir, 'sub', 'local.sv'), 'module x; endmodule\n');
    writeFileSync(f, 'local.sv\nshared.sv\n');
    writeFileSync(join(dir, 'shared.sv'), 'module y; endmodule\n');
    const parsed = flattenFilelists([f], dir);
    expect(parsed.sources).toEqual([join(dir, 'sub', 'local.sv'), join(dir, 'shared.sv')]);
  });

  it('Windows 伪 symlink 源重定向到真实目标并去重', () => {
    // OpenTitan 形态：top_b/rtl/top_pkg.sv 为指向 top_a 的伪 symlink 文本，
    // .f 同时列出两者 —— 重定向后只保留一份真实目标
    mkdirSync(join(dir, 'top_a/rtl'), { recursive: true });
    mkdirSync(join(dir, 'top_b/rtl'), { recursive: true });
    writeFileSync(join(dir, 'top_a/rtl/top_pkg.sv'), 'package top_pkg; endpackage\n');
    writeFileSync(join(dir, 'top_b/rtl/top_pkg.sv'), '../../top_a/rtl/top_pkg.sv');
    const f = join(dir, 'a.f');
    writeFileSync(f, 'top_b/rtl/top_pkg.sv\ntop_a/rtl/top_pkg.sv\n');
    const parsed = flattenFilelists([f], dir);
    expect(parsed.sources).toEqual([join(dir, 'top_a/rtl/top_pkg.sv')]);
  });

  it('伪 symlink 目标缺失时跳过该源', () => {
    mkdirSync(join(dir, 'top_c'), { recursive: true });
    writeFileSync(join(dir, 'top_c/gone.sv'), '../missing/gone.sv');
    const f = join(dir, 'a.f');
    writeFileSync(f, 'top_c/gone.sv\n');
    const parsed = flattenFilelists([f], dir);
    expect(parsed.sources).toEqual([]);
  });

  it('其他 - / + 旗标原样透传', () => {
    const f = join(dir, 'a.f');
    writeFileSync(f, '-y libs\n+libext+.sv+.v\nrtl/top.sv\n');
    const parsed = flattenFilelists([f], dir);
    expect(parsed.passthrough).toEqual(['-y libs', '+libext+.sv+.v']);
  });

  it('行尾反斜杠续行拼接下一行', () => {
    const f = join(dir, 'a.f');
    writeFileSync(f, '+incdir+rtl/a\\\n+rtl/b\n');
    const parsed = flattenFilelists([f], dir);
    expect(parsed.incdirs).toEqual([join(dir, 'rtl/a'), join(dir, 'rtl/b')]);
  });
});

describe('flattenFilelists 嵌套', () => {
  it('-f 递归展开（嵌套文件相对自身目录解析），-F 相对当前 .f 目录', () => {
    mkdirSync(join(dir, 'ip'), { recursive: true });
    mkdirSync(join(dir, 'rtl'), { recursive: true });
    const main = join(dir, 'main.f');
    const nested = join(dir, 'ip', 'nested.f');
    writeFileSync(main, '-f ip/nested.f\nrtl/top.sv\n');
    writeFileSync(nested, 'ip_cell.sv\n');
    writeFileSync(join(dir, 'ip', 'ip_cell.sv'), 'module c; endmodule\n');
    writeFileSync(join(dir, 'rtl', 'top.sv'), 'module t; endmodule\n');

    const parsed = flattenFilelists([main], dir);
    expect(parsed.sources).toEqual([join(dir, 'ip', 'ip_cell.sv'), join(dir, 'rtl', 'top.sv')]);
    expect(parsed.files).toContain(join(dir, 'main.f'));
    expect(parsed.files).toContain(join(dir, 'ip', 'nested.f'));
  });

  it('-f 循环引用不死循环（visited 保护）', () => {
    const a = join(dir, 'a.f');
    const b = join(dir, 'b.f');
    writeFileSync(a, '-f b.f\nrtl/top.sv\n');
    writeFileSync(b, '-f a.f\n');
    const parsed = flattenFilelists([a], dir);
    expect(parsed.sources).toEqual([join(dir, 'rtl/top.sv')]);
  });
});

describe('renderFlatFilelist', () => {
  it('产出与 yosys cwd 无关的全绝对路径清单（incdir → define → 透传 → 源文件）', () => {
    const f = join(dir, 'a.f');
    writeFileSync(f, '+define+FOO\n-y libs\nrtl/top.sv\n+incdir+rtl/ip\n');
    const parsed = flattenFilelists([f], dir);
    const flat = renderFlatFilelist(parsed);
    const lines = flat.trim().split('\n');
    expect(lines).toEqual([
      `+incdir+${toSlashPath(join(dir, 'rtl/ip'))}`,
      '+define+FOO',
      '-y libs',
      toSlashPath(join(dir, 'rtl/top.sv')),
    ]);
  });

  it('Windows 反斜杠路径转正斜杠（slang -f 解析器吞反斜杠转义，回归）', () => {
    // 回归场景：Windows 下 join 产出反斜杠绝对路径，直接写入 flat .f 时
    // slang 把 \ 当转义符吞掉（D:\proj\a.sv → D:proja.sv → No such file or directory
    // → yosys 退出码 1 → detectTops 报「未检测到顶层」）
    const parsed: ParsedFilelist = {
      sources: ['D:\\proj\\rtl\\top.sv'],
      incdirs: ['D:\\proj\\rtl\\ip'],
      defines: [],
      passthrough: [],
      files: [],
    };
    const flat = renderFlatFilelist(parsed);
    expect(flat).toContain('+incdir+D:/proj/rtl/ip');
    expect(flat).toContain('D:/proj/rtl/top.sv');
    expect(flat).not.toContain('\\');
  });
});
