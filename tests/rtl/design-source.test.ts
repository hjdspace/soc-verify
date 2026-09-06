import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { resolveDesignSource, scanHdlDirectory } from '../../src/main/rtl/design-source';
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
  writeFileSync(join(projectDir, 'hw/rtl/ignored.svh'), '`define IGNORED\n');
  writeFileSync(join(projectDir, 'hw/dv/tb.sv'), 'module tb; endmodule\n');
  writeFileSync(join(projectDir, 'hw/vendor/third_party.sv'), 'module third_party; endmodule\n');
  writeFileSync(join(projectDir, 'top.core'), 'CAPI=2:\nname: vendor:lib:top:1\n');
});

afterEach(() => rmSync(projectDir, { recursive: true, force: true }));

describe('scanHdlDirectory', () => {
  it('扫描 .v/.sv，应用 glob 排除，并将 package/interface 排在 module 前', () => {
    const parsed = scanHdlDirectory(
      join(projectDir, 'hw'),
      ['**/dv/**', '**/vendor/**'],
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
      excludes: ['**/dv/**', '**/vendor/**'],
      incdirs: ['hw/rtl'],
      defines: ['SYNTHESIS=1'],
    },
    top: 'top',
  });

  it('相对扫描路径按项目根解析', () => {
    expect(resolveDesignSource(directoryConfig(), projectDir).sources).toHaveLength(4);
  });

});
