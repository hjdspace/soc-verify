import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const plugin = require('../../plugins/unisoc-subsys-discoverer/index.js');

describe('unisoc-subsys-discoverer', () => {
  let tempDir: string;
  let projRtlDir: string;
  let originalProjRtl: string | undefined;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'socverify-test-'));
    projRtlDir = join(tempDir, 'rtl');
    mkdirSync(projRtlDir, { recursive: true });
    originalProjRtl = process.env.PROJ_RTL;
  });

  afterEach(() => {
    if (originalProjRtl !== undefined) {
      process.env.PROJ_RTL = originalProjRtl;
    } else {
      delete process.env.PROJ_RTL;
    }
    rmSync(tempDir, { recursive: true, force: true });
  });

  it('should have correct manifest', () => {
    expect(plugin.manifest.id).toBe('unisoc-subsys-discoverer');
    expect(plugin.manifest.kind).toBe('subsys-discoverer');
    expect(plugin.manifest.name).toBe('Unisoc Subsys Discoverer');
    expect(typeof plugin.discover).toBe('function');
  });

  it('should discover _sys directories as subsystems', async () => {
    process.env.PROJ_RTL = projRtlDir;
    mkdirSync(join(projRtlDir, 'cpu_sub_sys'));
    mkdirSync(join(projRtlDir, 'ddr_sub_sys'));

    const result = await plugin.discover(tempDir);

    expect(result).toHaveLength(2);
    expect(result.map((r: { name: string }) => r.name).sort()).toEqual(['cpu_sub_sys', 'ddr_sub_sys']);
    expect(result.every((r: { kind: string }) => r.kind === 'subsys')).toBe(true);
  });

  it('should discover top directory as top kind', async () => {
    process.env.PROJ_RTL = projRtlDir;
    mkdirSync(join(projRtlDir, 'top'));

    const result = await plugin.discover(tempDir);

    expect(result).toHaveLength(1);
    expect(result[0].name).toBe('top');
    expect(result[0].kind).toBe('top');
  });

  it('should discover both _sys and top directories', async () => {
    process.env.PROJ_RTL = projRtlDir;
    mkdirSync(join(projRtlDir, 'cpu_sub_sys'));
    mkdirSync(join(projRtlDir, 'gpu_sub_sys'));
    mkdirSync(join(projRtlDir, 'top'));
    // Non-matching directories should be ignored
    mkdirSync(join(projRtlDir, 'docs'));
    mkdirSync(join(projRtlDir, 'scripts'));
    // Files should be ignored
    writeFileSync(join(projRtlDir, 'README.md'), 'hello');

    const result = await plugin.discover(tempDir);

    expect(result).toHaveLength(3);
    // top should be last
    expect(result[2].name).toBe('top');
    expect(result[2].kind).toBe('top');
    // subsys should be sorted alphabetically
    expect(result[0].name).toBe('cpu_sub_sys');
    expect(result[1].name).toBe('gpu_sub_sys');
  });

  it('should return empty array when $PROJ_RTL points to non-existent path', async () => {
    process.env.PROJ_RTL = join(tempDir, 'nonexistent');

    const result = await plugin.discover(tempDir);

    expect(result).toEqual([]);
  });

  it('should ignore files (not directories) matching _sys', async () => {
    process.env.PROJ_RTL = projRtlDir;
    writeFileSync(join(projRtlDir, 'fake_sub_sys'), 'not a directory');

    const result = await plugin.discover(tempDir);

    expect(result).toEqual([]);
  });

  it('should fall back to manual config when $PROJ_RTL is not set', async () => {
    delete process.env.PROJ_RTL;

    const socverifyDir = join(tempDir, '.socverify');
    mkdirSync(socverifyDir, { recursive: true });
    writeFileSync(
      join(socverifyDir, 'subsys-config.json'),
      JSON.stringify({
        subsystems: [
          { name: 'manual_sub_sys', path: 'rtl/manual_sub_sys', kind: 'subsys' },
          { name: 'top', path: 'rtl/top', kind: 'top' },
        ],
      }),
    );

    const result = await plugin.discover(tempDir);

    expect(result).toHaveLength(2);
    expect(result[0].name).toBe('manual_sub_sys');
    expect(result[0].kind).toBe('subsys');
    expect(result[0].path).toBe(join(tempDir, 'rtl', 'manual_sub_sys'));
    expect(result[1].name).toBe('top');
    expect(result[1].kind).toBe('top');
  });

  it('should discover subsystems from the project environment config', async () => {
    delete process.env.PROJ_RTL;
    mkdirSync(join(projRtlDir, 'display_sub_sys'));

    const socverifyDir = join(tempDir, '.socverify');
    mkdirSync(socverifyDir, { recursive: true });
    writeFileSync(
      join(socverifyDir, 'env.json'),
      JSON.stringify({
        tools: [],
        envVars: { PROJ_RTL: projRtlDir },
      }),
    );

    const result = await plugin.discover(tempDir);

    expect(result.map((subsys: { name: string }) => subsys.name)).toEqual([
      'display_sub_sys',
    ]);
  });

  it('should return empty array when no $PROJ_RTL and no manual config', async () => {
    delete process.env.PROJ_RTL;

    const result = await plugin.discover(tempDir);

    expect(result).toEqual([]);
  });

  it('should return empty array when manual config is invalid JSON', async () => {
    delete process.env.PROJ_RTL;

    const socverifyDir = join(tempDir, '.socverify');
    mkdirSync(socverifyDir, { recursive: true });
    writeFileSync(join(socverifyDir, 'subsys-config.json'), 'invalid json {{{');

    const result = await plugin.discover(tempDir);

    expect(result).toEqual([]);
  });

  it('should fall back to manual config when $PROJ_RTL scan returns empty', async () => {
    process.env.PROJ_RTL = projRtlDir;
    // $PROJ_RTL exists but has no matching directories

    const socverifyDir = join(tempDir, '.socverify');
    mkdirSync(socverifyDir, { recursive: true });
    writeFileSync(
      join(socverifyDir, 'subsys-config.json'),
      JSON.stringify({
        subsystems: [
          { name: 'fallback_sub_sys', path: 'rtl/fallback', kind: 'subsys' },
        ],
      }),
    );

    const result = await plugin.discover(tempDir);

    expect(result).toHaveLength(1);
    expect(result[0].name).toBe('fallback_sub_sys');
  });
});
