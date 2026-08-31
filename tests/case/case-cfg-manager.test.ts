/**
 * Case Cfg Manager — 纯函数模块测试。
 *
 * 测试缝：公共函数接口（scanSubsystems / discoverCaseCfgFiles /
 * discoverUdtbDirs / discoverUdtbCfgFiles / parseCaseCfgFile）。
 * 使用 tmpdir 创建临时文件系统结构，不 mock fs。
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  scanSubsystems,
  discoverCaseCfgFiles,
  discoverUdtbDirs,
  discoverUdtbCfgFiles,
  parseCaseCfgFile,
} from '../../src/main/case/case-cfg-manager';

// ─── Test fixtures ─────────────────────────────────────────

let tempDir: string;

beforeEach(async () => {
  tempDir = await mkdtemp(join(tmpdir(), 'socverify-cfg-'));
});

afterEach(async () => {
  await rm(tempDir, { recursive: true, force: true });
});

// ─── scanSubsystems ────────────────────────────────────────

describe('scanSubsystems', () => {
  it('returns directories ending with _sys or named top', async () => {
    // Create a fake PROJ_ENV structure
    await mkdir(join(tempDir, 'apcpu_sys'), { recursive: true });
    await mkdir(join(tempDir, 'aon_sys'), { recursive: true });
    await mkdir(join(tempDir, 'top'), { recursive: true });
    await mkdir(join(tempDir, 'some_random_dir'), { recursive: true });
    await mkdir(join(tempDir, 'bin'), { recursive: true }); // not a subsystem

    const result = await scanSubsystems(tempDir);

    const names = result.map((s) => s.name).sort();
    expect(names).toEqual(['aon_sys', 'apcpu_sys', 'top']);
  });

  it('returns empty array when no subsystem directories found', async () => {
    await mkdir(join(tempDir, 'random_dir'), { recursive: true });

    const result = await scanSubsystems(tempDir);

    expect(result).toEqual([]);
  });

  it('includes path for each subsystem', async () => {
    await mkdir(join(tempDir, 'apcpu_sys'), { recursive: true });

    const result = await scanSubsystems(tempDir);

    expect(result).toHaveLength(1);
    expect(result[0].name).toBe('apcpu_sys');
    expect(result[0].path).toBe(join(tempDir, 'apcpu_sys'));
  });
});

// ─── discoverCaseCfgFiles ──────────────────────────────────

describe('discoverCaseCfgFiles', () => {
  it('discovers .cfg files in {subsys}/bin/case_cfg/', async () => {
    // apcpu_sys/bin/case_cfg/apcpu_subsys_case.cfg
    await mkdir(join(tempDir, 'apcpu_sys', 'bin', 'case_cfg'), { recursive: true });
    await writeFile(
      join(tempDir, 'apcpu_sys', 'bin', 'case_cfg', 'apcpu_subsys_case.cfg'),
      '[case test_case1]\n[case test_case2]\n',
    );

    const result = await discoverCaseCfgFiles(tempDir, ['apcpu_sys']);

    expect(result).toHaveLength(1);
    expect(result[0]).toBe(
      join(tempDir, 'apcpu_sys', 'bin', 'case_cfg', 'apcpu_subsys_case.cfg'),
    );
  });

  it('discovers .cfg files from multiple subsystems', async () => {
    await mkdir(join(tempDir, 'apcpu_sys', 'bin', 'case_cfg'), { recursive: true });
    await writeFile(
      join(tempDir, 'apcpu_sys', 'bin', 'case_cfg', 'a.cfg'),
      '[case a1]\n',
    );

    await mkdir(join(tempDir, 'aon_sys', 'bin', 'case_cfg'), { recursive: true });
    await writeFile(
      join(tempDir, 'aon_sys', 'bin', 'case_cfg', 'b.cfg'),
      '[case b1]\n',
    );

    const result = await discoverCaseCfgFiles(tempDir, ['apcpu_sys', 'aon_sys']);

    expect(result).toHaveLength(2);
  });

  it('skips subsystems without bin/case_cfg directory', async () => {
    await mkdir(join(tempDir, 'apcpu_sys'), { recursive: true });
    // No bin/case_cfg directory

    const result = await discoverCaseCfgFiles(tempDir, ['apcpu_sys']);

    expect(result).toEqual([]);
  });
});

// ─── discoverUdtbDirs ─────────────────────────────────────

describe('discoverUdtbDirs', () => {
  it('returns subdirectories containing bin/ dir under udtb/{subsys}', async () => {
    // Create udtb/apcpu_sys/ip2soc_a/bin/ with a .cfg file
    await mkdir(join(tempDir, 'udtb', 'apcpu_sys', 'ip2soc_a', 'bin'), { recursive: true });
    await writeFile(
      join(tempDir, 'udtb', 'apcpu_sys', 'ip2soc_a', 'bin', 'a.cfg'),
      '[case case_a]\n',
    );
    // Create udtb/apcpu_sys/ip2soc_b/bin/ with a .cfg file
    await mkdir(join(tempDir, 'udtb', 'apcpu_sys', 'ip2soc_b', 'bin'), { recursive: true });
    await writeFile(
      join(tempDir, 'udtb', 'apcpu_sys', 'ip2soc_b', 'bin', 'b.cfg'),
      '[case case_b]\n',
    );
    // Create a subdirectory without bin/ (should be skipped)
    await mkdir(join(tempDir, 'udtb', 'apcpu_sys', 'no_bin_dir'), { recursive: true });

    const result = await discoverUdtbDirs(tempDir, 'apcpu_sys');

    expect(result).toHaveLength(2);
    const relPaths = result.map((d) => d.relPath).sort();
    expect(relPaths).toEqual(['ip2soc_a', 'ip2soc_b']);
  });

  it('returns empty array when udtb/{subsys} does not exist', async () => {
    const result = await discoverUdtbDirs(tempDir, 'nonexistent_sys');
    expect(result).toEqual([]);
  });

  it('excludes the root udtb/{subsys} directory itself', async () => {
    // bin/ directly under udtb/{subsys} should not be listed as a sub-env
    await mkdir(join(tempDir, 'udtb', 'apcpu_sys', 'bin'), { recursive: true });
    await writeFile(
      join(tempDir, 'udtb', 'apcpu_sys', 'bin', 'root.cfg'),
      '[case root_case]\n',
    );

    const result = await discoverUdtbDirs(tempDir, 'apcpu_sys');

    expect(result).toEqual([]);
  });

  it('does not discover nested bin/ dirs (only scans one level deep)', async () => {
    // udtb/apcpu_sys/group_a/sub_env/bin/x.cfg
    // With the optimized single-level scan, nested directories are NOT
    // discovered — only direct children of udtb/{subsys} are checked.
    await mkdir(join(tempDir, 'udtb', 'apcpu_sys', 'group_a', 'sub_env', 'bin'), { recursive: true });
    await writeFile(
      join(tempDir, 'udtb', 'apcpu_sys', 'group_a', 'sub_env', 'bin', 'x.cfg'),
      '[case x_case]\n',
    );

    const result = await discoverUdtbDirs(tempDir, 'apcpu_sys');

    // group_a does NOT have bin/ directly, so it's not discovered.
    // The nested sub_env/bin is two levels deep and is intentionally skipped.
    expect(result).toEqual([]);
  });
});

// ─── discoverUdtbCfgFiles ────────────────────────────────

describe('discoverUdtbCfgFiles', () => {
  it('discovers .cfg files in {udtbDir}/bin/', async () => {
    const udtbDir = join(tempDir, 'udtb', 'apcpu_sys', 'ip2soc_a');
    await mkdir(join(udtbDir, 'bin'), { recursive: true });
    await writeFile(join(udtbDir, 'bin', 'test.cfg'), '[case test_case]\n');
    await writeFile(join(udtbDir, 'bin', 'other.cfg'), '[case other_case]\n');
    await writeFile(join(udtbDir, 'bin', 'not_cfg.txt'), 'not a cfg file\n');

    const result = await discoverUdtbCfgFiles([udtbDir]);

    expect(result).toHaveLength(2);
    expect(result.some((f) => f.endsWith('test.cfg'))).toBe(true);
    expect(result.some((f) => f.endsWith('other.cfg'))).toBe(true);
  });

  it('discovers from multiple udtb directories', async () => {
    const dir1 = join(tempDir, 'udtb', 'apcpu_sys', 'ip2soc_a');
    const dir2 = join(tempDir, 'udtb', 'apcpu_sys', 'ip2soc_b');
    await mkdir(join(dir1, 'bin'), { recursive: true });
    await mkdir(join(dir2, 'bin'), { recursive: true });
    await writeFile(join(dir1, 'bin', 'a.cfg'), '[case a]\n');
    await writeFile(join(dir2, 'bin', 'b.cfg'), '[case b]\n');

    const result = await discoverUdtbCfgFiles([dir1, dir2]);

    expect(result).toHaveLength(2);
  });

  it('skips directories without bin/ subdirectory', async () => {
    const udtbDir = join(tempDir, 'udtb', 'apcpu_sys', 'no_bin');
    await mkdir(udtbDir, { recursive: true });
    // No bin/ directory

    const result = await discoverUdtbCfgFiles([udtbDir]);

    expect(result).toEqual([]);
  });
});

// ─── parseCaseCfgFile ──────────────────────────────────────

describe('parseCaseCfgFile', () => {
  it('parses root cases and child cases with base reference', async () => {
    const cfgPath = join(tempDir, 'test_case.cfg');
    await writeFile(
      cfgPath,
      [
        '[case base_case]',
        '  some config',
        '[case child_case : base_case]',
        '  more config',
        '[case standalone_case]',
        '  config',
      ].join('\n'),
    );

    const result = await parseCaseCfgFile(cfgPath);

    expect(result.name).toBe('test_case.cfg');
    expect(result.fullPath).toBe(cfgPath);
    // Root cases (no :base)
    expect(result.nodes).toContain('base_case');
    expect(result.nodes).toContain('standalone_case');
    // Child cases (has :base)
    expect(result.childCases).toContainEqual({
      case: 'child_case',
      base: 'base_case',
    });
  });

  it('parses file with only root cases', async () => {
    const cfgPath = join(tempDir, 'roots.cfg');
    await writeFile(
      cfgPath,
      '[case case_a]\n[case case_b]\n',
    );

    const result = await parseCaseCfgFile(cfgPath);

    expect(result.nodes).toContain('case_a');
    expect(result.nodes).toContain('case_b');
    expect(result.childCases).toEqual([]);
  });

  it('parses file with only child cases', async () => {
    const cfgPath = join(tempDir, 'children.cfg');
    await writeFile(
      cfgPath,
      '[case child1 : parent1]\n[case child2 : parent2]\n',
    );

    const result = await parseCaseCfgFile(cfgPath);

    expect(result.nodes).toEqual([]);
    expect(result.childCases).toHaveLength(2);
    expect(result.childCases).toContainEqual({
      case: 'child1',
      base: 'parent1',
    });
  });

  it('infers base and block from file path', async () => {
    // Simulate dv/apcpu_sys/bin/case_cfg/xxx.cfg path structure
    const fakePath = join(tempDir, 'dv', 'apcpu_sys', 'bin', 'case_cfg', 'test.cfg');
    await mkdir(join(tempDir, 'dv', 'apcpu_sys', 'bin', 'case_cfg'), { recursive: true });
    await writeFile(fakePath, '[case test_case]\n');

    const result = await parseCaseCfgFile(fakePath);

    expect(result.base).toBe('');
    expect(result.block).toBe('apcpu_sys');
  });
});
