import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { resolveDesignSource, scanHdlDirectory, DEFAULT_DIRECTORY_EXCLUDES } from '../../src/main/rtl/design-source';
import type { DesignSourceConfig } from '../../src/main/rtl/types';

let projectDir: string;

beforeEach(() => {
  projectDir = mkdtempSync(join(tmpdir(), 'sv-design-source-'));
  mkdirSync(join(projectDir, 'hw/rtl'), { recursive: true });
  mkdirSync(join(projectDir, 'hw/dv'), { recursive: true });
  mkdirSync(join(projectDir, 'hw/vendor'), { recursive: true });
  writeFileSync(join(projectDir, 'hw/rtl/soc_pkg.sv'), 'package soc_pkg; endpackage\n');
  writeFileSync(join(projectDir, 'hw/rtl/bus_if.sv'), 'interface bus_if; endinterface\n');
  writeFileSync(join(projectDir, 'hw/rtl/top.sv'), 'module top; endmodule\n');
  writeFileSync(join(projectDir, 'hw/rtl/legacy.v'), 'module legacy; endmodule\n');
  writeFileSync(join(projectDir, 'hw/rtl/prim_assert.svh'), '`define ASSERT(a) assert(a)\n');
  writeFileSync(join(projectDir, 'hw/dv/tb.sv'), 'module tb; endmodule\n');
  writeFileSync(join(projectDir, 'hw/vendor/third_party.sv'), 'module third_party; endmodule\n');
  // autogen 目录 — 应被默认排除规则排除
  mkdirSync(join(projectDir, 'hw/autogen'), { recursive: true });
  writeFileSync(join(projectDir, 'hw/autogen/dup_pkg.sv'), 'package dup_pkg; endpackage\n');
  // generic_dv 目录 — 应被默认排除规则排除
  mkdirSync(join(projectDir, 'hw/generic_dv/env'), { recursive: true });
  writeFileSync(join(projectDir, 'hw/generic_dv/env/uvm_pkg.sv'), 'package uvm_pkg; endpackage\n');
  // pre_dv / fpv 目录 — 应被默认排除规则排除（OpenTitan TB 目录）
  mkdirSync(join(projectDir, 'hw/pre_dv'), { recursive: true });
  writeFileSync(join(projectDir, 'hw/pre_dv/ip_tb.sv'), 'module ip_tb; endmodule\n');
  mkdirSync(join(projectDir, 'hw/fpv'), { recursive: true });
  writeFileSync(join(projectDir, 'hw/fpv/ip_tb.sv'), 'module ip_fpv_tb; endmodule\n');
  writeFileSync(join(projectDir, 'top.core'), 'CAPI=2:\nname: vendor:lib:top:1\n');
});

afterEach(() => rmSync(projectDir, { recursive: true, force: true }));

describe('scanHdlDirectory', () => {
  it('扫描 .v/.sv，应用 glob 排除，并将 package/interface 排在 module 前', () => {
    const parsed = scanHdlDirectory(
      join(projectDir, 'hw'),
      ['**/dv/**', '**/vendor/**', '**/autogen/**', '**/generic_dv/**', '**/pre_dv/**', '**/fpv/**'],
      [join(projectDir, 'hw/rtl')],
      ['SYNTHESIS=1'],
    );

    expect(parsed.sources.map((path) => path.replace(/\\/g, '/').split('/').at(-1))).toEqual([
      'soc_pkg.sv',
      'bus_if.sv',
      'legacy.v',
      'top.sv',
    ]);
    expect(parsed.defines).toEqual(['SYNTHESIS=1']);
    expect(parsed.files).toContain(join(projectDir, 'hw/rtl'));
  });

  it('.svh 文件不作为独立编译单元，但其所在目录自动加入 incdir', () => {
    const parsed = scanHdlDirectory(
      join(projectDir, 'hw'),
      ['**/dv/**', '**/vendor/**', '**/autogen/**', '**/generic_dv/**'],
      [],
      [],
    );

    // .svh 不在 sources 中
    expect(parsed.sources.some((s) => s.endsWith('.svh'))).toBe(false);
    // 但 hw/rtl 目录自动出现在 incdirs 中（因为 prim_assert.svh 在该目录）
    expect(parsed.incdirs).toContain(join(projectDir, 'hw/rtl'));
  });

  it('默认排除规则包含 autogen 和 generic_dv', () => {
    const parsed = scanHdlDirectory(
      join(projectDir, 'hw'),
      DEFAULT_DIRECTORY_EXCLUDES,
      [],
      [],
    );

    // autogen/dup_pkg.sv 被排除
    expect(parsed.sources.some((s) => s.endsWith('dup_pkg.sv'))).toBe(false);
    // generic_dv/env/uvm_pkg.sv 被排除
    expect(parsed.sources.some((s) => s.endsWith('uvm_pkg.sv'))).toBe(false);
  });

  it('默认排除规则包含 pre_dv 和 fpv（OpenTitan TB 目录）', () => {
    const parsed = scanHdlDirectory(join(projectDir, 'hw'), DEFAULT_DIRECTORY_EXCLUDES, [], []);

    expect(parsed.sources.some((s) => s.endsWith('ip_tb.sv'))).toBe(false);
    expect(parsed.sources.some((s) => s.endsWith('ip_fpv_tb.sv'))).toBe(false);
  });

  describe('Windows 伪 symlink（git symlink 退化文本）', () => {
    beforeEach(() => {
      // top_b/top_pkg.sv 内容为指向 top_a/top_pkg.sv 的相对路径 —— Windows
      // 上 git clone（未启用 core.symlinks）产生的伪 symlink 形态
      mkdirSync(join(projectDir, 'hw/top_a/rtl'), { recursive: true });
      mkdirSync(join(projectDir, 'hw/top_b/rtl'), { recursive: true });
      writeFileSync(join(projectDir, 'hw/top_a/rtl/top_pkg.sv'), 'package top_pkg; endpackage\n');
      writeFileSync(join(projectDir, 'hw/top_b/rtl/top_pkg.sv'), '../../top_a/rtl/top_pkg.sv');
    });

    it('伪 symlink 重定向到真实目标且不产生重复源', () => {
      const parsed = scanHdlDirectory(join(projectDir, 'hw'), [], [], []);
      const targets = parsed.sources.filter((s) => s.endsWith('top_pkg.sv'));
      expect(targets).toHaveLength(1);
      expect(targets[0]).toBe(join(projectDir, 'hw/top_a/rtl/top_pkg.sv'));
    });

    it('伪 symlink 目标缺失时跳过该文件', () => {
      mkdirSync(join(projectDir, 'hw/top_c/rtl'), { recursive: true });
      writeFileSync(join(projectDir, 'hw/top_c/rtl/gone.sv'), '../../top_missing/rtl/gone.sv');
      const parsed = scanHdlDirectory(join(projectDir, 'hw'), [], [], []);
      expect(parsed.sources.some((s) => s.endsWith('gone.sv'))).toBe(false);
    });

    it('正常源文件不受伪 symlink 检测影响', () => {
      // 单行正常 SV 内容（含分号/空格）不应被误判为伪 symlink
      const parsed = scanHdlDirectory(join(projectDir, 'hw'), [], [], []);
      expect(parsed.sources).toContain(join(projectDir, 'hw/rtl/top.sv'));
    });

    it('伪 symlink .svh 的目标目录加入 incdir', () => {
      mkdirSync(join(projectDir, 'hw/inc_a'), { recursive: true });
      mkdirSync(join(projectDir, 'hw/top_b/inc'), { recursive: true });
      writeFileSync(join(projectDir, 'hw/inc_a/common.svh'), '`define COMMON 1\n');
      writeFileSync(join(projectDir, 'hw/top_b/inc/common.svh'), '../../inc_a/common.svh');
      const parsed = scanHdlDirectory(join(projectDir, 'hw'), [], [], []);
      // 伪 .svh 所在目录（top_b/inc）不进 incdir；目标目录 inc_a 在 incdir 中
      expect(parsed.sources.some((s) => s.endsWith('.svh'))).toBe(false);
      expect(parsed.incdirs).toContain(join(projectDir, 'hw/inc_a'));
    });
  });

  it('目录不存在时给出明确错误', () => {
    expect(() => scanHdlDirectory(join(projectDir, 'missing'), [], [], [])).toThrow('RTL 扫描目录不存在');
  });
});

describe('resolveDesignSource / previewDesignSource', () => {
  const directoryConfig = (): DesignSourceConfig => ({
    source: 'directory',
    filelists: [],
    directory: {
      root: 'hw',
      excludes: ['**/dv/**', '**/vendor/**', '**/autogen/**', '**/generic_dv/**', '**/pre_dv/**', '**/fpv/**'],
      incdirs: ['hw/rtl'],
      defines: ['SYNTHESIS=1'],
    },
    top: 'top',
  });

  it('相对扫描路径按项目根解析', () => {
    expect(resolveDesignSource(directoryConfig(), projectDir).sources).toHaveLength(4);
  });

});
