/**
 * sysbase-gen-router tests — Issue 2 + Issue 3 + Issue 4 + Issue 5 procedures.
 *
 * Test seam: tRPC server-side caller (router.createCaller).
 * Mock: temp directory + simulated file tree for listRtlFiles / extractModuleName.
 * Mock: node:child_process spawn for generateModIo.
 *
 * Procedures under test:
 *   - inferInstanceName: pure string transform (subsys → instance name)
 *   - listRtlFiles: scan $PROJ_RTL/<subsys>/design/rtl/top/ for .v files
 *   - extractModuleName: regex extract `module <name>` from .v file content
 *   - getTemplatePath / getTemplatePreview (Issue 3)
 *   - inferRalDirs / inferClkDirs (Issue 4)
 *   - generateModIo (Issue 5): spawn perl script, stream output, return result
 */

import { describe, it, expect, beforeEach, afterEach, afterAll, vi } from 'vitest';
import { mkdirSync, rmSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { EventEmitter } from 'node:events';

// ─── Hoisted tmp dir ───────────────────────────────────────

const { tmpDir, projRtlDir, mockSpawn } = vi.hoisted(() => {
  const os = require('node:os');
  const fs = require('node:fs');
  const path = require('node:path');
  const dir = os.tmpdir() + `/sv-sysbase-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
  fs.mkdirSync(dir, { recursive: true });
  const rtlDir = path.join(dir, 'proj_rtl');
  fs.mkdirSync(rtlDir, { recursive: true });
  return { tmpDir: dir, projRtlDir: rtlDir, mockSpawn: vi.fn() };
});

// ─── Mocks ─────────────────────────────────────────────────

// Mock process.env.PROJ_RTL to point at our temp dir
vi.stubEnv('PROJ_RTL', projRtlDir);

// Mock electron (BrowserWindow used by generateModIo for IPC event broadcasting)
vi.mock('electron', () => ({
  BrowserWindow: {
    getAllWindows: () => [],
  },
}));

// Mock node:child_process spawn (used by generateModIo to execute perl script)
vi.mock('node:child_process', () => ({
  spawn: mockSpawn,
}));

// Mock VERDI_HOME for generateModIo tests
vi.stubEnv('VERDI_HOME', '/fake/verdi/home');

// ─── Imports (after mocks) ─────────────────────────────────

import { sysbaseGenRouter } from '../src/main/tools/routers/sysbase-gen-router';

const caller = sysbaseGenRouter.createCaller({});

// ─── Test helpers ──────────────────────────────────────────

/** Create a mock .v file with a module declaration. */
function createMockRtlFile(dir: string, filename: string, moduleName: string): string {
  const fullPath = join(dir, filename);
  writeFileSync(fullPath, `// Some comment\nmodule ${moduleName} (\n  clk,\n  rst_n\n);\nendmodule\n`, 'utf-8');
  return fullPath;
}

/** Create a mock .v file without a module declaration. */
function createMockRtlFileNoModule(dir: string, filename: string): string {
  const fullPath = join(dir, filename);
  writeFileSync(fullPath, `// Just comments\n// No module here\n`, 'utf-8');
  return fullPath;
}

// ─── Test Suite ────────────────────────────────────────────

describe('sysbase-gen-router', () => {

  beforeEach(() => {
    // Ensure clean state: remove any leftover dirs from previous test
    const subsysRtlBase = join(projRtlDir, 'apcpu_sys', 'design');
    if (existsSync(subsysRtlBase)) {
      rmSync(subsysRtlBase, { recursive: true, force: true });
    }
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  afterAll(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  // ─── inferInstanceName ───────────────────────────────────

  describe('inferInstanceName', () => {
    it('derives u_sys_<prefix> from <prefix>_sys', async () => {
      const result = await caller.inferInstanceName({ subsys: 'apcpu_sys' });
      expect(result.instanceName).toBe('u_sys_apcpu');
    });

    it('derives instance name for aon_sys', async () => {
      const result = await caller.inferInstanceName({ subsys: 'aon_sys' });
      expect(result.instanceName).toBe('u_sys_aon');
    });

    it('derives instance name for camera_sys', async () => {
      const result = await caller.inferInstanceName({ subsys: 'camera_sys' });
      expect(result.instanceName).toBe('u_sys_camera');
    });

    it('returns original name wrapped in u_sys_ when no _sys suffix', async () => {
      const result = await caller.inferInstanceName({ subsys: 'custom' });
      expect(result.instanceName).toBe('u_sys_custom');
    });

    it('handles subsys with multiple underscores before _sys', async () => {
      const result = await caller.inferInstanceName({ subsys: 'my_complex_sys' });
      expect(result.instanceName).toBe('u_sys_my_complex');
    });

    it('throws BAD_REQUEST for empty subsys', async () => {
      await expect(caller.inferInstanceName({ subsys: '' })).rejects.toThrow();
    });

    it('throws BAD_REQUEST for missing subsys field', async () => {
      await expect(caller.inferInstanceName({} as { subsys: string })).rejects.toThrow();
    });
  });

  // ─── listRtlFiles ────────────────────────────────────────

  describe('listRtlFiles', () => {
    it('lists all .v files in $PROJ_RTL/<subsys>/design/rtl/top/', async () => {
      const topDir = join(projRtlDir, 'apcpu_sys', 'design', 'rtl', 'top');
      mkdirSync(topDir, { recursive: true });
      createMockRtlFile(topDir, 'apcpu_top.v', 'apcpu_top');
      createMockRtlFile(topDir, 'apcpu_wrap.v', 'apcpu_wrap');

      const result = await caller.listRtlFiles({ subsys: 'apcpu_sys' });

      expect(result.files).toHaveLength(2);
      expect(result.files.map((f) => f.name)).toContain('apcpu_top.v');
      expect(result.files.map((f) => f.name)).toContain('apcpu_wrap.v');
      // Each file should have a full path
      for (const f of result.files) {
        expect(f.path).toContain('apcpu_sys');
        expect(f.path).toContain('design');
        expect(f.path).toContain('rtl');
        expect(f.path).toContain('top');
      }
    });

    it('returns only .v files (not .sv or other extensions)', async () => {
      const topDir = join(projRtlDir, 'apcpu_sys', 'design', 'rtl', 'top');
      mkdirSync(topDir, { recursive: true });
      createMockRtlFile(topDir, 'real.v', 'real');
      writeFileSync(join(topDir, 'system.sv'), 'module system();\nendmodule\n', 'utf-8');
      writeFileSync(join(topDir, 'readme.txt'), 'not rtl\n', 'utf-8');

      const result = await caller.listRtlFiles({ subsys: 'apcpu_sys' });

      expect(result.files).toHaveLength(1);
      expect(result.files[0].name).toBe('real.v');
    });

    it('returns empty list when directory does not exist', async () => {
      const result = await caller.listRtlFiles({ subsys: 'nonexistent_sys' });
      expect(result.files).toEqual([]);
    });

    it('returns empty list when directory has no .v files', async () => {
      const topDir = join(projRtlDir, 'apcpu_sys', 'design', 'rtl', 'top');
      mkdirSync(topDir, { recursive: true });
      writeFileSync(join(topDir, 'readme.txt'), 'not rtl\n', 'utf-8');

      const result = await caller.listRtlFiles({ subsys: 'apcpu_sys' });
      expect(result.files).toEqual([]);
    });

    it('throws error when $PROJ_RTL is not set', async () => {
      // Temporarily unset PROJ_RTL
      const original = process.env.PROJ_RTL;
      delete process.env.PROJ_RTL;

      await expect(caller.listRtlFiles({ subsys: 'apcpu_sys' })).rejects.toThrow();

      // Restore
      if (original) process.env.PROJ_RTL = original;
    });

    it('throws BAD_REQUEST for empty subsys', async () => {
      await expect(caller.listRtlFiles({ subsys: '' })).rejects.toThrow();
    });
  });

  // ─── extractModuleName ───────────────────────────────────

  describe('extractModuleName', () => {
    it('extracts module name from .v file content', async () => {
      const topDir = join(projRtlDir, 'apcpu_sys', 'design', 'rtl', 'top');
      mkdirSync(topDir, { recursive: true });
      const filePath = createMockRtlFile(topDir, 'test_top.v', 'apcpu_top_pwr_wrap');

      const result = await caller.extractModuleName({ filePath });
      expect(result.moduleName).toBe('apcpu_top_pwr_wrap');
    });

    it('extracts module name with underscores and numbers', async () => {
      const topDir = join(projRtlDir, 'apcpu_sys', 'design', 'rtl', 'top');
      mkdirSync(topDir, { recursive: true });
      const filePath = createMockRtlFile(topDir, 'complex.v', 'my_module_42');

      const result = await caller.extractModuleName({ filePath });
      expect(result.moduleName).toBe('my_module_42');
    });

    it('extracts module name when module keyword has leading whitespace', async () => {
      const topDir = join(projRtlDir, 'apcpu_sys', 'design', 'rtl', 'top');
      mkdirSync(topDir, { recursive: true });
      const filePath = join(topDir, 'indented.v');
      writeFileSync(filePath, `   module indented_top (\n  clk\n);\nendmodule\n`, 'utf-8');

      const result = await caller.extractModuleName({ filePath });
      expect(result.moduleName).toBe('indented_top');
    });

    it('returns null moduleName when no module declaration found', async () => {
      const topDir = join(projRtlDir, 'apcpu_sys', 'design', 'rtl', 'top');
      mkdirSync(topDir, { recursive: true });
      const filePath = createMockRtlFileNoModule(topDir, 'nomodule.v');

      const result = await caller.extractModuleName({ filePath });
      expect(result.moduleName).toBeNull();
    });

    it('extracts first module name when file has multiple modules', async () => {
      const topDir = join(projRtlDir, 'apcpu_sys', 'design', 'rtl', 'top');
      mkdirSync(topDir, { recursive: true });
      const filePath = join(topDir, 'multi.v');
      writeFileSync(filePath, `module first_mod();\nendmodule\nmodule second_mod();\nendmodule\n`, 'utf-8');

      const result = await caller.extractModuleName({ filePath });
      expect(result.moduleName).toBe('first_mod');
    });

    it('throws NOT_FOUND when file does not exist', async () => {
      await expect(caller.extractModuleName({ filePath: '/nonexistent/path/file.v' })).rejects.toThrow();
    });

    it('throws BAD_REQUEST for missing filePath', async () => {
      await expect(caller.extractModuleName({} as { filePath: string })).rejects.toThrow();
    });
  });

  // ─── getTemplatePath (Issue 3) ───────────────────────────

  describe('getTemplatePath', () => {
    it('returns absolute path for dut_spec template', async () => {
      const result = await caller.getTemplatePath({ template: 'dut_spec' });
      expect(result.path).toContain('docs');
      expect(result.path).toContain('dut_spec_template.xlsx');
    });

    it('returns absolute path for mini template', async () => {
      const result = await caller.getTemplatePath({ template: 'mini' });
      expect(result.path).toContain('docs');
      expect(result.path).toContain('sysbase_mini_case_template.xlsx');
    });

    it('throws BAD_REQUEST for invalid template name', async () => {
      await expect(
        caller.getTemplatePath({ template: 'invalid' as 'dut_spec' }),
      ).rejects.toThrow();
    });

    it('throws BAD_REQUEST for missing template field', async () => {
      await expect(
        caller.getTemplatePath({} as { template: 'dut_spec' }),
      ).rejects.toThrow();
    });
  });

  // ─── inferRalDirs (Issue 4) ──────────────────────────────

  describe('inferRalDirs', () => {
    it('finds directories containing both for_de and for_dv under spec/', async () => {
      // Create: spec/ral_block/with for_de + for_dv
      const ralBlockDir = join(projRtlDir, 'apcpu_sys', 'design', 'spec', 'ral_block');
      mkdirSync(join(ralBlockDir, 'for_de'), { recursive: true });
      mkdirSync(join(ralBlockDir, 'for_dv'), { recursive: true });

      const result = await caller.inferRalDirs({ subsys: 'apcpu_sys' });

      expect(result.dirs).toContain(ralBlockDir);
    });

    it('finds directories containing both for_de and for_dv under rtl/', async () => {
      const ralInRtl = join(projRtlDir, 'apcpu_sys', 'design', 'rtl', 'sub_ral');
      mkdirSync(join(ralInRtl, 'for_de'), { recursive: true });
      mkdirSync(join(ralInRtl, 'for_dv'), { recursive: true });

      const result = await caller.inferRalDirs({ subsys: 'apcpu_sys' });

      expect(result.dirs).toContain(ralInRtl);
    });

    it('finds nested directories up to max depth 5', async () => {
      // spec/a/b/c/ral_deep/with for_de + for_dv (depth 4 from spec)
      const deepDir = join(projRtlDir, 'apcpu_sys', 'design', 'spec', 'a', 'b', 'c', 'ral_deep');
      mkdirSync(join(deepDir, 'for_de'), { recursive: true });
      mkdirSync(join(deepDir, 'for_dv'), { recursive: true });

      const result = await caller.inferRalDirs({ subsys: 'apcpu_sys' });

      expect(result.dirs).toContain(deepDir);
    });

    it('does not include directories with only for_de', async () => {
      const onlyDe = join(projRtlDir, 'apcpu_sys', 'design', 'spec', 'only_de');
      mkdirSync(join(onlyDe, 'for_de'), { recursive: true });

      const result = await caller.inferRalDirs({ subsys: 'apcpu_sys' });

      expect(result.dirs).not.toContain(onlyDe);
    });

    it('does not include directories with only for_dv', async () => {
      const onlyDv = join(projRtlDir, 'apcpu_sys', 'design', 'spec', 'only_dv');
      mkdirSync(join(onlyDv, 'for_dv'), { recursive: true });

      const result = await caller.inferRalDirs({ subsys: 'apcpu_sys' });

      expect(result.dirs).not.toContain(onlyDv);
    });

    it('returns empty array when no matching directories exist', async () => {
      mkdirSync(join(projRtlDir, 'apcpu_sys', 'design', 'spec'), { recursive: true });
      mkdirSync(join(projRtlDir, 'apcpu_sys', 'design', 'rtl'), { recursive: true });

      const result = await caller.inferRalDirs({ subsys: 'apcpu_sys' });

      expect(result.dirs).toEqual([]);
    });

    it('returns empty array when subsys directory does not exist', async () => {
      const result = await caller.inferRalDirs({ subsys: 'nonexistent_sys' });
      expect(result.dirs).toEqual([]);
    });

    it('throws error when $PROJ_RTL is not set', async () => {
      const original = process.env.PROJ_RTL;
      delete process.env.PROJ_RTL;

      await expect(caller.inferRalDirs({ subsys: 'apcpu_sys' })).rejects.toThrow();

      if (original) process.env.PROJ_RTL = original;
    });

    it('throws BAD_REQUEST for empty subsys', async () => {
      await expect(caller.inferRalDirs({ subsys: '' })).rejects.toThrow();
    });
  });

  // ─── inferClkDirs (Issue 4) ──────────────────────────────

  describe('inferClkDirs', () => {
    it('finds directory containing file with clk_max_cfg in name', async () => {
      const clkDir = join(projRtlDir, 'apcpu_sys', 'design', 'rtl', 'clk_gen');
      mkdirSync(clkDir, { recursive: true });
      writeFileSync(join(clkDir, 'clk_max_cfg_apcpu.v'), '// clk config\n', 'utf-8');

      const result = await caller.inferClkDirs({ subsys: 'apcpu_sys' });

      expect(result.dirs).toContain(clkDir);
    });

    it('finds directories in nested subdirectories', async () => {
      const nestedClkDir = join(projRtlDir, 'apcpu_sys', 'design', 'rtl', 'top', 'clk_sub');
      mkdirSync(nestedClkDir, { recursive: true });
      writeFileSync(join(nestedClkDir, 'sub_clk_max_cfg.v'), '// nested clk\n', 'utf-8');

      const result = await caller.inferClkDirs({ subsys: 'apcpu_sys' });

      expect(result.dirs).toContain(nestedClkDir);
    });

    it('does not include directories without clk_max_cfg files', async () => {
      const noClkDir = join(projRtlDir, 'apcpu_sys', 'design', 'rtl', 'no_clk');
      mkdirSync(noClkDir, { recursive: true });
      writeFileSync(join(noClkDir, 'regular_file.v'), '// not a clk file\n', 'utf-8');

      const result = await caller.inferClkDirs({ subsys: 'apcpu_sys' });

      expect(result.dirs).not.toContain(noClkDir);
    });

    it('returns empty array when no matching files exist', async () => {
      mkdirSync(join(projRtlDir, 'apcpu_sys', 'design', 'rtl', 'top'), { recursive: true });

      const result = await caller.inferClkDirs({ subsys: 'apcpu_sys' });

      expect(result.dirs).toEqual([]);
    });

    it('returns empty array when subsys directory does not exist', async () => {
      const result = await caller.inferClkDirs({ subsys: 'nonexistent_sys' });
      expect(result.dirs).toEqual([]);
    });

    it('throws error when $PROJ_RTL is not set', async () => {
      const original = process.env.PROJ_RTL;
      delete process.env.PROJ_RTL;

      await expect(caller.inferClkDirs({ subsys: 'apcpu_sys' })).rejects.toThrow();

      if (original) process.env.PROJ_RTL = original;
    });

    it('throws BAD_REQUEST for empty subsys', async () => {
      await expect(caller.inferClkDirs({ subsys: '' })).rejects.toThrow();
    });
  });

  // ─── generateModIo (Issue 5) ─────────────────────────────

  describe('generateModIo', () => {
    /** Create a mock ChildProcess using EventEmitter for stdout/stderr/proc events. */
    function createMockProc(): EventEmitter & {
      stdout: EventEmitter;
      stderr: EventEmitter;
      pid: number;
    } {
      const proc = new EventEmitter() as EventEmitter & {
        stdout: EventEmitter;
        stderr: EventEmitter;
        pid: number;
      };
      proc.stdout = new EventEmitter();
      proc.stderr = new EventEmitter();
      proc.pid = 12345;
      return proc;
    }

    beforeEach(() => {
      mockSpawn.mockReset();
    });

    it('spawns perl script with correct arguments and returns success on exit code 0', async () => {
      const filelistPath = join(tmpDir, 'modio_filelist.f');
      writeFileSync(filelistPath, '// filelist content\n', 'utf-8');

      const proc = createMockProc();
      mockSpawn.mockReturnValue(proc);

      const promise = caller.generateModIo({
        filelist: filelistPath,
        moduleName: 'apcpu_top',
      });

      // Wait for spawn to be called before emitting events
      await vi.waitFor(() => expect(mockSpawn).toHaveBeenCalled());
      const spawnedProc = mockSpawn.mock.results[0].value as ReturnType<typeof createMockProc>;

      // Simulate process output
      spawnedProc.stdout.emit('data', Buffer.from('Generating Module IO...\n'));
      spawnedProc.stderr.emit('data', Buffer.from('Warning: deprecated feature\n'));
      spawnedProc.emit('exit', 0);

      const result = await promise;

      expect(result.success).toBe(true);
      expect(result.logs).toContain('Generating Module IO...');
      expect(result.logs).toContain('Warning: deprecated feature');
      expect(result.outputFilePath).toContain('getModIO.log');

      // Verify spawn was called with perl and correct arguments
      expect(mockSpawn).toHaveBeenCalledTimes(1);
      const [cmd, args] = mockSpawn.mock.calls[0];
      expect(cmd).toBe('perl');
      expect(args[0]).toContain('getModIO_batch.p');
      expect(args).toContain('-f');
      expect(args).toContain(filelistPath);
      expect(args).toContain('-modules');
      expect(args).toContain('apcpu_top');
      expect(args).toContain('-o');
    });

    it('returns failure on non-zero exit code', async () => {
      const filelistPath = join(tmpDir, 'modio_fail.f');
      writeFileSync(filelistPath, '// filelist content\n', 'utf-8');

      const proc = createMockProc();
      mockSpawn.mockReturnValue(proc);

      const promise = caller.generateModIo({
        filelist: filelistPath,
        moduleName: 'my_module',
      });

      await vi.waitFor(() => expect(mockSpawn).toHaveBeenCalled());
      const spawnedProc = mockSpawn.mock.results[0].value as ReturnType<typeof createMockProc>;

      spawnedProc.stderr.emit('data', Buffer.from('Error: module not found\n'));
      spawnedProc.emit('exit', 1);

      const result = await promise;

      expect(result.success).toBe(false);
      expect(result.logs).toContain('Error: module not found');
      expect(result.errorMessage).toBeDefined();
    });

    it('handles spawn error event', async () => {
      const filelistPath = join(tmpDir, 'modio_error.f');
      writeFileSync(filelistPath, '// filelist content\n', 'utf-8');

      const proc = createMockProc();
      mockSpawn.mockReturnValue(proc);

      const promise = caller.generateModIo({
        filelist: filelistPath,
        moduleName: 'my_module',
      });

      await vi.waitFor(() => expect(mockSpawn).toHaveBeenCalled());
      const spawnedProc = mockSpawn.mock.results[0].value as ReturnType<typeof createMockProc>;

      spawnedProc.emit('error', new Error('perl not found'));

      const result = await promise;

      expect(result.success).toBe(false);
      expect(result.logs.some((l) => l.includes('perl not found'))).toBe(true);
    });

    it('throws when VERDI_HOME is not set', async () => {
      const filelistPath = join(tmpDir, 'modio_no_verdi.f');
      writeFileSync(filelistPath, '// filelist content\n', 'utf-8');

      const original = process.env.VERDI_HOME;
      delete process.env.VERDI_HOME;

      await expect(
        caller.generateModIo({ filelist: filelistPath, moduleName: 'my_module' }),
      ).rejects.toThrow();

      if (original) process.env.VERDI_HOME = original;
    });

    it('throws when filelist file does not exist', async () => {
      await expect(
        caller.generateModIo({
          filelist: '/nonexistent/path/to/filelist.f',
          moduleName: 'my_module',
        }),
      ).rejects.toThrow();
    });

    it('throws BAD_REQUEST for empty filelist', async () => {
      await expect(
        caller.generateModIo({ filelist: '', moduleName: 'my_module' }),
      ).rejects.toThrow();
    });

    it('throws BAD_REQUEST for empty moduleName', async () => {
      const filelistPath = join(tmpDir, 'modio_empty_module.f');
      writeFileSync(filelistPath, '// filelist content\n', 'utf-8');

      await expect(
        caller.generateModIo({ filelist: filelistPath, moduleName: '' }),
      ).rejects.toThrow();
    });

    it('uses custom output file name', async () => {
      const filelistPath = join(tmpDir, 'modio_custom_output.f');
      writeFileSync(filelistPath, '// filelist content\n', 'utf-8');

      const proc = createMockProc();
      mockSpawn.mockReturnValue(proc);

      const promise = caller.generateModIo({
        filelist: filelistPath,
        moduleName: 'my_module',
        outputFile: 'custom_mod_io.log',
      });

      await vi.waitFor(() => expect(mockSpawn).toHaveBeenCalled());
      const spawnedProc = mockSpawn.mock.results[0].value as ReturnType<typeof createMockProc>;

      spawnedProc.emit('exit', 0);

      const result = await promise;

      expect(result.outputFilePath).toContain('custom_mod_io.log');

      // Verify -o argument uses custom output file
      const [, args] = mockSpawn.mock.calls[0];
      expect(args).toContain('custom_mod_io.log');
    });
  });

  // ─── getTemplatePreview (Issue 3) ────────────────────────

  describe('getTemplatePreview', () => {
    it('returns sheet names for dut_spec template (Architecture + MemoryMap)', async () => {
      const result = await caller.getTemplatePreview({ template: 'dut_spec' });
      expect(result.sheets.length).toBeGreaterThanOrEqual(2);
      const sheetNames = result.sheets.map((s) => s.name);
      expect(sheetNames).toContain('Architecture');
      expect(sheetNames).toContain('MemoryMap');
    });

    it('returns headers for each sheet in dut_spec template', async () => {
      const result = await caller.getTemplatePreview({ template: 'dut_spec' });
      for (const sheet of result.sheets) {
        expect(Array.isArray(sheet.headers)).toBe(true);
      }
    });

    it('returns at least one sheet for mini template', async () => {
      const result = await caller.getTemplatePreview({ template: 'mini' });
      expect(result.sheets.length).toBeGreaterThanOrEqual(1);
    });

    it('throws BAD_REQUEST for invalid template name', async () => {
      await expect(
        caller.getTemplatePreview({ template: 'invalid' as 'dut_spec' }),
      ).rejects.toThrow();
    });
  });

  // ─── saveConfig / loadConfig / listSavedConfigs (Issue 6) ─

  describe('saveConfig', () => {
    it('saves config to .socverify/sysbase-gen/<subsys>.json and returns success', async () => {
      const config: Record<string, unknown> = {
        subsys: 'apcpu_sys',
        instanceName: 'u_sys_apcpu',
        rtlFile: '/path/to/rtl.v',
        moduleName: 'apcpu_top',
        dutSpecPath: '/path/to/dut_spec.xlsx',
        miniExcelPath: '/path/to/mini.xlsx',
        ralDirs: ['/ral/dir1', '/ral/dir2'],
        clkDir: '/clk/dir',
        clk2Dir: '',
        modIoPath: '/path/to/modio.log',
        filelistPath: '/path/to/filelist.f',
        pinlistPath: '',
        dmalistPath: '',
        outputDir: './output',
      };

      const result = await caller.saveConfig({
        config: config as never,
        scriptPath: '/custom/script/path.py',
        projectDir: tmpDir,
      });

      expect(result.success).toBe(true);

      // Verify file was created on disk
      const configFilePath = join(tmpDir, '.socverify', 'sysbase-gen', 'apcpu_sys.json');
      expect(existsSync(configFilePath)).toBe(true);

      // Verify content
      const saved = JSON.parse(readFileSync(configFilePath, 'utf-8')) as Record<string, unknown>;
      expect(saved.subsys).toBe('apcpu_sys');
      expect(saved.instanceName).toBe('u_sys_apcpu');
      expect(saved.rtlFile).toBe('/path/to/rtl.v');
    });

    it('also persists scriptPath to .socverify/sysbase-gen/config.json', async () => {
      const config: Record<string, unknown> = {
        subsys: 'aon_sys',
        instanceName: 'u_sys_aon',
        rtlFile: '',
        moduleName: '',
        dutSpecPath: '',
        miniExcelPath: '',
        ralDirs: [],
        clkDir: '',
        clk2Dir: '',
        modIoPath: '',
        filelistPath: '',
        pinlistPath: '',
        dmalistPath: '',
        outputDir: './',
      };

      await caller.saveConfig({
        config: config as never,
        scriptPath: '/custom/path/sysbase_gen.py',
        projectDir: tmpDir,
      });

      const scriptConfigPath = join(tmpDir, '.socverify', 'sysbase-gen', 'config.json');
      expect(existsSync(scriptConfigPath)).toBe(true);

      const scriptConfig = JSON.parse(readFileSync(scriptConfigPath, 'utf-8')) as Record<string, unknown>;
      expect(scriptConfig.scriptPath).toBe('/custom/path/sysbase_gen.py');
    });

    it('throws BAD_REQUEST when subsys is empty', async () => {
      const config: Record<string, unknown> = {
        subsys: '',
        instanceName: '',
        rtlFile: '',
        moduleName: '',
        dutSpecPath: '',
        miniExcelPath: '',
        ralDirs: [],
        clkDir: '',
        clk2Dir: '',
        modIoPath: '',
        filelistPath: '',
        pinlistPath: '',
        dmalistPath: '',
        outputDir: './',
      };

      await expect(
        caller.saveConfig({ config: config as never, scriptPath: '/script.py', projectDir: tmpDir }),
      ).rejects.toThrow();
    });
  });

  describe('loadConfig', () => {
    it('loads a previously saved config and scriptPath', async () => {
      // First save
      const config: Record<string, unknown> = {
        subsys: 'apcpu_sys',
        instanceName: 'u_sys_apcpu',
        rtlFile: '/path/to/top.v',
        moduleName: 'apcpu_top',
        dutSpecPath: '/path/to/dut_spec.xlsx',
        miniExcelPath: '/path/to/mini.xlsx',
        ralDirs: ['/ral/dir1', '/ral/dir2'],
        clkDir: '/clk/dir',
        clk2Dir: '/de/path,clk_prefix',
        modIoPath: '/path/to/modio.log',
        filelistPath: '/path/to/filelist.f',
        pinlistPath: '/path/to/pinlist.txt',
        dmalistPath: '/path/to/dmalist.txt',
        outputDir: './output',
      };

      await caller.saveConfig({
        config: config as never,
        scriptPath: '/script/sysbase_gen.py',
        projectDir: tmpDir,
      });

      // Then load
      const result = await caller.loadConfig({ subsys: 'apcpu_sys', projectDir: tmpDir });

      expect(result.config).not.toBeNull();
      expect(result.config!.subsys).toBe('apcpu_sys');
      expect(result.config!.instanceName).toBe('u_sys_apcpu');
      expect(result.config!.rtlFile).toBe('/path/to/top.v');
      expect(result.config!.ralDirs).toEqual(['/ral/dir1', '/ral/dir2']);
      expect(result.config!.clk2Dir).toBe('/de/path,clk_prefix');
      expect(result.scriptPath).toBe('/script/sysbase_gen.py');
    });

    it('returns null config when no saved config exists for subsys', async () => {
      const result = await caller.loadConfig({ subsys: 'nonexistent_sys', projectDir: tmpDir });
      expect(result.config).toBeNull();
    });

    it('returns default scriptPath when config.json does not exist', async () => {
      // Use a fresh project dir with no saved configs
      const freshDir = join(tmpDir, 'fresh_project');
      mkdirSync(freshDir, { recursive: true });

      const result = await caller.loadConfig({ subsys: 'apcpu_sys', projectDir: freshDir });
      expect(result.config).toBeNull();
      // scriptPath should be the default
      expect(result.scriptPath).toContain('sysbase_gen.py');
    });

    it('throws BAD_REQUEST for empty subsys', async () => {
      await expect(
        caller.loadConfig({ subsys: '', projectDir: tmpDir }),
      ).rejects.toThrow();
    });
  });

  describe('listSavedConfigs', () => {
    it('lists all saved configs grouped by subsys name', async () => {
      // Save two configs
      const config1: Record<string, unknown> = {
        subsys: 'apcpu_sys', instanceName: 'u_sys_apcpu', rtlFile: '/a.v',
        moduleName: '', dutSpecPath: '', miniExcelPath: '', ralDirs: [],
        clkDir: '', clk2Dir: '', modIoPath: '', filelistPath: '',
        pinlistPath: '', dmalistPath: '', outputDir: './',
      };
      const config2: Record<string, unknown> = {
        subsys: 'aon_sys', instanceName: 'u_sys_aon', rtlFile: '/b.v',
        moduleName: '', dutSpecPath: '', miniExcelPath: '', ralDirs: [],
        clkDir: '', clk2Dir: '', modIoPath: '', filelistPath: '',
        pinlistPath: '', dmalistPath: '', outputDir: './',
      };

      await caller.saveConfig({ config: config1 as never, scriptPath: '/s.py', projectDir: tmpDir });
      await caller.saveConfig({ config: config2 as never, scriptPath: '/s.py', projectDir: tmpDir });

      const result = await caller.listSavedConfigs({ projectDir: tmpDir });

      expect(result.configs.length).toBeGreaterThanOrEqual(2);
      const subsysNames = result.configs.map((c) => c.subsys);
      expect(subsysNames).toContain('apcpu_sys');
      expect(subsysNames).toContain('aon_sys');
    });

    it('returns empty list when no configs saved', async () => {
      const freshDir = join(tmpDir, 'empty_project');
      mkdirSync(freshDir, { recursive: true });

      const result = await caller.listSavedConfigs({ projectDir: freshDir });
      expect(result.configs).toEqual([]);
    });

    it('does not include config.json in the list', async () => {
      // Save a config (which also creates config.json)
      const config: Record<string, unknown> = {
        subsys: 'apcpu_sys', instanceName: 'u_sys_apcpu', rtlFile: '/a.v',
        moduleName: '', dutSpecPath: '', miniExcelPath: '', ralDirs: [],
        clkDir: '', clk2Dir: '', modIoPath: '', filelistPath: '',
        pinlistPath: '', dmalistPath: '', outputDir: './',
      };
      await caller.saveConfig({ config: config as never, scriptPath: '/s.py', projectDir: tmpDir });

      const result = await caller.listSavedConfigs({ projectDir: tmpDir });

      // config.json should not appear as a subsys entry
      for (const c of result.configs) {
        expect(c.subsys).not.toBe('config');
      }
    });
  });

  // ─── runGen (Issue 6) ─────────────────────────────────────

  describe('runGen', () => {
    /** Create a mock ChildProcess for spawn. */
    function createMockProc(): EventEmitter & {
      stdout: EventEmitter;
      stderr: EventEmitter;
      pid: number;
    } {
      const proc = new EventEmitter() as EventEmitter & {
        stdout: EventEmitter;
        stderr: EventEmitter;
        pid: number;
      };
      proc.stdout = new EventEmitter();
      proc.stderr = new EventEmitter();
      proc.pid = 99999;
      return proc;
    }

    beforeEach(() => {
      mockSpawn.mockReset();
    });

    it('spawns sysbase_gen.py command and returns success on exit code 0', async () => {
      const command = 'python3 /path/to/sysbase_gen.py gen -rtl top.v -n apcpu_sys';
      const proc = createMockProc();
      mockSpawn.mockReturnValue(proc);

      const promise = caller.runGen({ command, cwd: tmpDir });

      await vi.waitFor(() => expect(mockSpawn).toHaveBeenCalled());
      const spawnedProc = mockSpawn.mock.results[0].value as ReturnType<typeof createMockProc>;

      spawnedProc.stdout.emit('data', Buffer.from('Generating environment...\n'));
      spawnedProc.stderr.emit('data', Buffer.from('Warning: deprecated\n'));
      spawnedProc.emit('exit', 0);

      const result = await promise;

      expect(result.success).toBe(true);
      expect(result.logs).toContain('Generating environment...');
      expect(result.logs).toContain('Warning: deprecated');
    });

    it('returns failure on non-zero exit code', async () => {
      const command = 'python3 /path/to/sysbase_gen.py gen -rtl top.v -n apcpu_sys';
      const proc = createMockProc();
      mockSpawn.mockReturnValue(proc);

      const promise = caller.runGen({ command, cwd: tmpDir });

      await vi.waitFor(() => expect(mockSpawn).toHaveBeenCalled());
      const spawnedProc = mockSpawn.mock.results[0].value as ReturnType<typeof createMockProc>;

      spawnedProc.stderr.emit('data', Buffer.from('Error: file not found\n'));
      spawnedProc.emit('exit', 1);

      const result = await promise;

      expect(result.success).toBe(false);
      expect(result.logs).toContain('Error: file not found');
    });

    it('handles spawn error event', async () => {
      const command = 'python3 /path/to/sysbase_gen.py gen';
      const proc = createMockProc();
      mockSpawn.mockReturnValue(proc);

      const promise = caller.runGen({ command, cwd: tmpDir });

      await vi.waitFor(() => expect(mockSpawn).toHaveBeenCalled());
      const spawnedProc = mockSpawn.mock.results[0].value as ReturnType<typeof createMockProc>;

      spawnedProc.emit('error', new Error('python3 not found'));

      const result = await promise;

      expect(result.success).toBe(false);
      expect(result.logs.some((l) => l.includes('python3 not found'))).toBe(true);
    });

    it('throws BAD_REQUEST for empty command', async () => {
      await expect(caller.runGen({ command: '', cwd: tmpDir })).rejects.toThrow();
    });
  });
});
