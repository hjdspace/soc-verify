/**
 * Regression test: flattenFilelists throws a clear error when .f file is missing.
 *
 * Previously, flattenFilelists silently returned zero sources when the .f file
 * didn't exist on disk — causing the confusing error
 * "Design Source 未解析到任何源文件（检查 .f 配置）" downstream in
 * design-service.detectTops() / refresh().
 *
 * Root cause: filelist.ts line 70 used `existsSync(path) ? read(path) : ''`,
 * treating a missing file as empty content instead of throwing.
 *
 * Fix: throw `filelist 文件不存在: <path>` when the .f file is missing.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { flattenFilelists } from '../../src/main/rtl/filelist';

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'sv-filelist-missing-'));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe('flattenFilelists 缺失 .f 文件', () => {
  it('.f 文件不存在时抛出明确错误（不静默返回空 sources）', () => {
    const missingFile = join(dir, 'nonexistent.f');
    expect(() => flattenFilelists([missingFile], dir)).toThrow(/nonexistent\.f/);
  });

  it('.f 文件路径是目录时抛出错误（不当作空内容处理）', () => {
    expect(() => flattenFilelists([dir], dir)).toThrow();
  });

  it('.f 文件仅含指令（无源文件行）时返回空 sources 但不抛异常', () => {
    const f = join(dir, 'only-dirs.f');
    writeFileSync(f, '+incdir+rtl/ip\n+define+FOO\n');
    const parsed = flattenFilelists([f], dir);
    expect(parsed.sources).toEqual([]);
    expect(parsed.incdirs).toEqual([join(dir, 'rtl/ip')]);
    expect(parsed.defines).toEqual(['FOO']);
  });

  it('filelist 路径含首尾引号时去除后解析（不被当相对路径拼到 baseDir 下）', () => {
    const f = join(dir, 'quoted.f');
    writeFileSync(f, 'a.sv\n');
    // Windows「复制文件地址」粘贴形态：`"C:\...\quoted.f"`
    const parsed = flattenFilelists([`"${f}"`, `  '${f}'  `], dir);
    // 两条输入去重后 .f 只记录一次；files = .f 本身 + 源文件 a.sv
    expect(parsed.files).toEqual([f, join(dir, 'a.sv')]);
    expect(parsed.sources).toEqual([join(dir, 'a.sv')]);
  });
});
