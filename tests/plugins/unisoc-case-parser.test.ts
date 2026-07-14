import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const plugin = require('../../plugins/unisoc-case-parser/index.js');

describe('unisoc-case-parser', () => {
  let tempDir: string;
  let projEnvDir: string;
  let originalProjEnv: string | undefined;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'socverify-test-'));
    projEnvDir = join(tempDir, 'dv');
    mkdirSync(projEnvDir, { recursive: true });
    originalProjEnv = process.env.PROJ_ENV;
  });

  afterEach(() => {
    if (originalProjEnv !== undefined) {
      process.env.PROJ_ENV = originalProjEnv;
    } else {
      delete process.env.PROJ_ENV;
    }
    rmSync(tempDir, { recursive: true, force: true });
  });

  // ─── Manifest ──────────────────────────────────────────

  it('should have correct manifest', () => {
    expect(plugin.manifest.id).toBe('unisoc-case-parser');
    expect(plugin.manifest.kind).toBe('case-parser');
    expect(plugin.manifest.name).toBe('Unisoc Case Parser');
    expect(typeof plugin.parse).toBe('function');
  });

  // ─── Single file parsing ───────────────────────────────

  it('should parse root cases from .cfg file (no base)', async () => {
    process.env.PROJ_ENV = projEnvDir;
    const subsys = 'cpu_sub_sys';
    const cfgDir = join(projEnvDir, subsys, 'bin', 'case_cfg');
    mkdirSync(cfgDir, { recursive: true });
    writeFileSync(
      join(cfgDir, 'cpu_case.cfg'),
      '[case test_basic]\n[case test_advanced]\n',
    );

    const result = await plugin.parse(tempDir, subsys);

    expect(result).toHaveLength(2);
    expect(result[0].name).toBe('test_basic');
    expect(result[0].baseCase).toBeUndefined();
    expect(result[1].name).toBe('test_advanced');
    expect(result[1].baseCase).toBeUndefined();
  });

  it('should parse child cases with baseCase', async () => {
    process.env.PROJ_ENV = projEnvDir;
    const subsys = 'cpu_sub_sys';
    const cfgDir = join(projEnvDir, subsys, 'bin', 'case_cfg');
    mkdirSync(cfgDir, { recursive: true });
    writeFileSync(
      join(cfgDir, 'cpu_case.cfg'),
      '[case test_basic]\n[case test_variant:test_basic]\n',
    );

    const result = await plugin.parse(tempDir, subsys);

    expect(result).toHaveLength(2);
    const rootCase = result.find((c: { name: string }) => c.name === 'test_basic');
    const childCase = result.find((c: { name: string }) => c.name === 'test_variant');
    expect(rootCase).toBeDefined();
    expect(rootCase.baseCase).toBeUndefined();
    expect(childCase).toBeDefined();
    expect(childCase.baseCase).toBe('test_basic');
  });

  it('should handle multiple child cases with different bases', async () => {
    process.env.PROJ_ENV = projEnvDir;
    const subsys = 'cpu_sub_sys';
    const cfgDir = join(projEnvDir, subsys, 'bin', 'case_cfg');
    mkdirSync(cfgDir, { recursive: true });
    writeFileSync(
      join(cfgDir, 'cpu_case.cfg'),
      [
        '[case base1]',
        '[case base2]',
        '[case child1:base1]',
        '[case child2:base1]',
        '[case child3:base2]',
      ].join('\n'),
    );

    const result = await plugin.parse(tempDir, subsys);

    expect(result).toHaveLength(5);
    const roots = result.filter((c: { baseCase?: string }) => !c.baseCase);
    const children = result.filter((c: { baseCase?: string }) => c.baseCase);
    expect(roots).toHaveLength(2);
    expect(children).toHaveLength(3);

    const child1 = children.find((c: { name: string }) => c.name === 'child1');
    expect(child1.baseCase).toBe('base1');
    const child3 = children.find((c: { name: string }) => c.name === 'child3');
    expect(child3.baseCase).toBe('base2');
  });

  // ─── Base/Block parsing ────────────────────────────────

  it('should parse base/block for direct subsys config (Rule 1)', async () => {
    process.env.PROJ_ENV = projEnvDir;
    const subsys = 'cpu_sub_sys';
    const cfgDir = join(projEnvDir, subsys, 'bin', 'case_cfg');
    mkdirSync(cfgDir, { recursive: true });
    writeFileSync(join(cfgDir, 'cpu_case.cfg'), '[case test1]\n');

    const result = await plugin.parse(tempDir, subsys);

    expect(result).toHaveLength(1);
    expect(result[0].base).toBe('');
    expect(result[0].block).toBe('cpu_sub_sys');
  });

  it('should parse base/block for UDTB sub-environment config (Rule 2)', async () => {
    process.env.PROJ_ENV = projEnvDir;
    const subsys = 'cpu_sub_sys';
    const udtbBinDir = join(projEnvDir, 'udtb', subsys, 'env1', 'bin');
    mkdirSync(udtbBinDir, { recursive: true });
    writeFileSync(join(udtbBinDir, 'test.cfg'), '[case test1]\n');

    const result = await plugin.parse(tempDir, subsys);

    expect(result).toHaveLength(1);
    expect(result[0].base).toBe('cpu_sub_sys');
    expect(result[0].block).toBe('udtb/cpu_sub_sys/env1');
  });

  it('should parse base/block for USVP subsys_case config (Rule 3)', async () => {
    process.env.PROJ_ENV = projEnvDir;
    const subsys = 'apcpu_sys';
    const usvpCfgDir = join(projEnvDir, 'udtb', 'usvp', 'bin', 'case_cfg');
    mkdirSync(usvpCfgDir, { recursive: true });
    writeFileSync(join(usvpCfgDir, 'apcpu_subsys_case.cfg'), '[case test1]\n');

    const result = await plugin.parse(tempDir, subsys);

    expect(result).toHaveLength(1);
    expect(result[0].base).toBe('apcpu_sys');
    expect(result[0].block).toBe('udtb/usvp');
  });

  it('should parse base/block for USVP top_case config (Rule 4)', async () => {
    process.env.PROJ_ENV = projEnvDir;
    const subsys = 'apcpu_sys';
    const usvpCfgDir = join(projEnvDir, 'udtb', 'usvp', 'bin', 'case_cfg');
    mkdirSync(usvpCfgDir, { recursive: true });
    writeFileSync(join(usvpCfgDir, 'apcpu_top_case.cfg'), '[case test1]\n');

    const result = await plugin.parse(tempDir, subsys);

    expect(result).toHaveLength(1);
    expect(result[0].base).toBe('top');
    expect(result[0].block).toBe('udtb/usvp');
  });

  it('should parse base/block for USVP default config (Rule 5)', () => {
    process.env.PROJ_ENV = projEnvDir;
    const usvpCfgDir = join(projEnvDir, 'udtb', 'usvp', 'bin', 'case_cfg');
    mkdirSync(usvpCfgDir, { recursive: true });
    const cfgPath = join(usvpCfgDir, 'random_case.cfg');

    // 直接测试 parseBaseBlockFromPath 函数
    const result = plugin.parseBaseBlockFromPath(cfgPath, projEnvDir);

    expect(result).not.toBeNull();
    expect(result.base).toBe('top');
    expect(result.block).toBe('udtb/usvp');
  });

  it('should parse base/block for USVP known system config (general match)', () => {
    process.env.PROJ_ENV = projEnvDir;
    const usvpCfgDir = join(projEnvDir, 'udtb', 'usvp', 'bin', 'case_cfg');
    mkdirSync(usvpCfgDir, { recursive: true });
    // apcpu.cfg: no underscores, so sys_name="apcpu" which is a known system
    const cfgPath = join(usvpCfgDir, 'apcpu.cfg');

    const result = plugin.parseBaseBlockFromPath(cfgPath, projEnvDir);

    expect(result).not.toBeNull();
    expect(result.base).toBe('apcpu_sys');
    expect(result.block).toBe('udtb/usvp');
  });

  it('should return null for unparseable path', () => {
    process.env.PROJ_ENV = projEnvDir;

    const result = plugin.parseBaseBlockFromPath('/random/path/file.cfg', projEnvDir);

    expect(result).toBeNull();
  });

  // ─── File discovery ────────────────────────────────────

  it('should find .cfg files from subsys bin/case_cfg directory', async () => {
    process.env.PROJ_ENV = projEnvDir;
    const subsys = 'cpu_sub_sys';
    const cfgDir = join(projEnvDir, subsys, 'bin', 'case_cfg');
    mkdirSync(cfgDir, { recursive: true });
    writeFileSync(join(cfgDir, 'case1.cfg'), '[case test1]\n');
    writeFileSync(join(cfgDir, 'case2.cfg'), '[case test2]\n');
    writeFileSync(join(cfgDir, 'not_cfg.txt'), '[case test3]\n');

    const result = await plugin.parse(tempDir, subsys);

    expect(result).toHaveLength(2);
    expect(result.map((r: { name: string }) => r.name).sort()).toEqual(['test1', 'test2']);
  });

  it('should find .cfg files from UDTB sub-environment directories', async () => {
    process.env.PROJ_ENV = projEnvDir;
    const subsys = 'cpu_sub_sys';
    const udtbBin1 = join(projEnvDir, 'udtb', subsys, 'env1', 'bin');
    const udtbBin2 = join(projEnvDir, 'udtb', subsys, 'env2', 'bin');
    mkdirSync(udtbBin1, { recursive: true });
    mkdirSync(udtbBin2, { recursive: true });
    writeFileSync(join(udtbBin1, 'env1.cfg'), '[case env1_test]\n');
    writeFileSync(join(udtbBin2, 'env2.cfg'), '[case env2_test]\n');

    const result = await plugin.parse(tempDir, subsys);

    expect(result).toHaveLength(2);
    expect(result.map((r: { name: string }) => r.name).sort()).toEqual(['env1_test', 'env2_test']);
  });

  it('should find specific .cfg files from USVP for apcpu_sys', async () => {
    process.env.PROJ_ENV = projEnvDir;
    const subsys = 'apcpu_sys';
    const usvpCfgDir = join(projEnvDir, 'udtb', 'usvp', 'bin', 'case_cfg');
    mkdirSync(usvpCfgDir, { recursive: true });
    writeFileSync(join(usvpCfgDir, 'apcpu_subsys_case.cfg'), '[case subsys_test]\n');
    writeFileSync(join(usvpCfgDir, 'apcpu_top_case.cfg'), '[case top_test]\n');
    writeFileSync(join(usvpCfgDir, 'other_case.cfg'), '[case other_test]\n');

    const result = await plugin.parse(tempDir, subsys);

    // Should only find apcpu_subsys_case.cfg and apcpu_top_case.cfg, not other_case.cfg
    expect(result).toHaveLength(2);
    expect(result.map((r: { name: string }) => r.name).sort()).toEqual(['subsys_test', 'top_test']);
  });

  it('should combine cases from multiple config sources', async () => {
    process.env.PROJ_ENV = projEnvDir;
    const subsys = 'apcpu_sys';

    // Direct subsys config
    const cfgDir = join(projEnvDir, subsys, 'bin', 'case_cfg');
    mkdirSync(cfgDir, { recursive: true });
    writeFileSync(join(cfgDir, 'direct.cfg'), '[case direct_test]\n');

    // USVP config
    const usvpCfgDir = join(projEnvDir, 'udtb', 'usvp', 'bin', 'case_cfg');
    mkdirSync(usvpCfgDir, { recursive: true });
    writeFileSync(join(usvpCfgDir, 'apcpu_subsys_case.cfg'), '[case usvp_test]\n');

    const result = await plugin.parse(tempDir, subsys);

    expect(result).toHaveLength(2);
    expect(result.map((r: { name: string }) => r.name).sort()).toEqual(['direct_test', 'usvp_test']);
  });

  // ─── Edge cases ────────────────────────────────────────

  it('should return empty array when $PROJ_ENV is not set', async () => {
    delete process.env.PROJ_ENV;

    const result = await plugin.parse(tempDir, 'cpu_sub_sys');

    expect(result).toEqual([]);
  });

  it('should return empty array when subsys is empty', async () => {
    process.env.PROJ_ENV = projEnvDir;

    const result = await plugin.parse(tempDir, '');

    expect(result).toEqual([]);
  });

  it('should return empty array when no .cfg files found', async () => {
    process.env.PROJ_ENV = projEnvDir;

    const result = await plugin.parse(tempDir, 'nonexistent_sys');

    expect(result).toEqual([]);
  });

  it('should return empty array when .cfg file has no case entries', async () => {
    process.env.PROJ_ENV = projEnvDir;
    const subsys = 'cpu_sub_sys';
    const cfgDir = join(projEnvDir, subsys, 'bin', 'case_cfg');
    mkdirSync(cfgDir, { recursive: true });
    writeFileSync(join(cfgDir, 'empty.cfg'), '# just a comment\n[other_section]\nsome_key=value\n');

    const result = await plugin.parse(tempDir, subsys);

    expect(result).toEqual([]);
  });

  it('should handle .cfg files with mixed content', async () => {
    process.env.PROJ_ENV = projEnvDir;
    const subsys = 'cpu_sub_sys';
    const cfgDir = join(projEnvDir, subsys, 'bin', 'case_cfg');
    mkdirSync(cfgDir, { recursive: true });
    writeFileSync(
      join(cfgDir, 'mixed.cfg'),
      [
        '# Comment line',
        '[other_section]',
        'key=value',
        '[case root_case]',
        'some_option=1',
        '[case child_case:root_case]',
        'other_option=2',
        '[case another_root]',
        '',
      ].join('\n'),
    );

    const result = await plugin.parse(tempDir, subsys);

    expect(result).toHaveLength(3);
    const roots = result.filter((c: { baseCase?: string }) => !c.baseCase);
    const children = result.filter((c: { baseCase?: string }) => c.baseCase);
    expect(roots).toHaveLength(2);
    expect(children).toHaveLength(1);
    expect(children[0].baseCase).toBe('root_case');
  });

  it('should set filePath for all cases', async () => {
    process.env.PROJ_ENV = projEnvDir;
    const subsys = 'cpu_sub_sys';
    const cfgDir = join(projEnvDir, subsys, 'bin', 'case_cfg');
    mkdirSync(cfgDir, { recursive: true });
    const cfgPath = join(cfgDir, 'test.cfg');
    writeFileSync(cfgPath, '[case test1]\n[case test2:test1]\n');

    const result = await plugin.parse(tempDir, subsys);

    expect(result).toHaveLength(2);
    expect(result.every((c: { filePath?: string }) => c.filePath === cfgPath)).toBe(true);
  });

  it('should set unique id per case', async () => {
    process.env.PROJ_ENV = projEnvDir;
    const subsys = 'cpu_sub_sys';
    const cfgDir = join(projEnvDir, subsys, 'bin', 'case_cfg');
    mkdirSync(cfgDir, { recursive: true });
    writeFileSync(join(cfgDir, 'a.cfg'), '[case test1]\n');
    writeFileSync(join(cfgDir, 'b.cfg'), '[case test1]\n');

    const result = await plugin.parse(tempDir, subsys);

    expect(result).toHaveLength(2);
    const ids = result.map((c: { id: string }) => c.id);
    expect(new Set(ids).size).toBe(2);
  });

  // ─── PROJ_ENV from project env config ──────────────────

  it('should resolve PROJ_ENV from project env config when not in process env', async () => {
    delete process.env.PROJ_ENV;

    const subsys = 'cpu_sub_sys';
    mkdirSync(join(projEnvDir, subsys, 'bin', 'case_cfg'), { recursive: true });
    writeFileSync(join(projEnvDir, subsys, 'bin', 'case_cfg', 'test.cfg'), '[case test1]\n');

    const socverifyDir = join(tempDir, '.socverify');
    mkdirSync(socverifyDir, { recursive: true });
    writeFileSync(
      join(socverifyDir, 'env.json'),
      JSON.stringify({ tools: [], envVars: { PROJ_ENV: projEnvDir } }),
    );

    const result = await plugin.parse(tempDir, subsys);

    expect(result).toHaveLength(1);
    expect(result[0].name).toBe('test1');
  });
});
