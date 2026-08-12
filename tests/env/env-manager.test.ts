import { describe, it, expect, vi } from 'vitest';
import { detectEdaTools, loadEnvConfig, saveEnvConfig, buildEnvFromConfig, getKnownEnvVarNames, getEnvVarCatalog, detectSystemEnvVars, mergeSystemEnvVars } from '../../src/main/env/env-manager';
import { mkdtempSync, writeFileSync, rmSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

// Mock child_process
vi.mock('node:child_process', () => ({
  execFile: vi.fn((cmd, args, opts, cb) => {
    if (cmd === 'where') {
      // Simulate finding 'vcs' but not others
      if (args[0] === 'vcs') {
        cb(null, { stdout: '/usr/bin/vcs\n', stderr: '' });
      } else if (args[0] === 'verilator') {
        cb(null, { stdout: '/usr/bin/verilator\n', stderr: '' });
      } else {
        cb(new Error('not found'), { stdout: '', stderr: '' });
      }
    } else if (cmd === 'vcs') {
      cb(null, { stdout: 'VCS version Q-2020.03', stderr: '' });
    } else if (cmd === 'verilator') {
      cb(null, { stdout: 'Verilator 5.0', stderr: '' });
    } else {
      cb(new Error('error'), { stdout: '', stderr: '' });
    }
  }),
}));

vi.mock('node:util', async () => {
  const actual = await vi.importActual<typeof import('node:util')>('node:util');
  return {
    ...actual,
    promisify: (fn: (...args: unknown[]) => void) =>
      (...args: unknown[]) =>
        new Promise((resolve, reject) => {
          fn(...args, (err: unknown, result: unknown) => {
            if (err) reject(err);
            else resolve(result);
          });
        }),
  };
});

describe('env-manager', () => {
  describe('detectEdaTools', () => {
    it('returns a list of all known EDA tools with detection status', async () => {
      const tools = await detectEdaTools();
      expect(tools.length).toBeGreaterThan(0);
      const vcs = tools.find((t) => t.name.includes('VCS'));
      expect(vcs).toBeDefined();
      expect(vcs!.detected).toBe(true);
      expect(vcs!.path).toBe('/usr/bin/vcs');
      expect(vcs!.version).toContain('VCS version');

      const xrun = tools.find((t) => t.name.includes('Xcelium'));
      expect(xrun).toBeDefined();
      expect(xrun!.detected).toBe(false);
    });
  });

  describe('loadEnvConfig', () => {
    it('returns null when config file does not exist', async () => {
      const result = await loadEnvConfig('/nonexistent/path');
      expect(result).toBeNull();
    });

    it('loads config from .socverify/env.json', async () => {
      const tmpDir = mkdtempSync(join(tmpdir(), 'env-test-'));
      const socverifyDir = join(tmpDir, '.socverify');
      mkdirSync(socverifyDir, { recursive: true });
      const configPath = join(socverifyDir, 'env.json');
      const config = {
        tools: [{ name: 'VCS', path: '/usr/bin/vcs', detected: true }],
        envVars: { LICENSE_FILE: '27000@localhost' },
      };
      writeFileSync(configPath, JSON.stringify(config));

      const result = await loadEnvConfig(tmpDir);
      expect(result).toEqual(config);

      rmSync(tmpDir, { recursive: true });
    });
  });

  describe('saveEnvConfig', () => {
    it('saves config to .socverify/env.json', async () => {
      const tmpDir = mkdtempSync(join(tmpdir(), 'env-save-test-'));
      const config = {
        tools: [{ name: 'Verilator', path: '/usr/bin/verilator', detected: true }],
        envVars: { LM_LICENSE_FILE: '27000@localhost' },
      };

      await saveEnvConfig(tmpDir, config);

      const loaded = await loadEnvConfig(tmpDir);
      expect(loaded).toEqual(config);

      rmSync(tmpDir, { recursive: true });
    });
  });

  describe('buildEnvFromConfig', () => {
    it('merges tool paths into PATH and includes env vars', () => {
      const config = {
        tools: [
          { name: 'VCS', path: '/usr/bin/vcs', detected: true },
          { name: 'Xcelium', path: '', detected: false },
        ],
        envVars: { LICENSE_FILE: '27000@localhost' },
      };

      const env = buildEnvFromConfig(config);
      expect(env.LICENSE_FILE).toBe('27000@localhost');
      expect(env.PATH).toContain('/usr/bin');
    });
  });

  describe('getKnownEnvVarNames', () => {
    it('returns list of known EDA env var names', () => {
      const vars = getKnownEnvVarNames();
      expect(vars).toContain('PROJ_RTL');
      expect(vars).toContain('LICENSE_FILE');
      expect(vars).toContain('LM_LICENSE_FILE');
      expect(vars.length).toBeGreaterThan(0);
    });

    it('includes all SOC environment variables', () => {
      const vars = getKnownEnvVarNames();
      expect(vars).toContain('PROJ_ENV');
      expect(vars).toContain('PROJ_RTL');
      expect(vars).toContain('PROJ_WORK');
      expect(vars).toContain('SPRD_TOOL_DIR');
    });

    it('includes all Synopsys environment variables', () => {
      const vars = getKnownEnvVarNames();
      expect(vars).toContain('VERDI_HOME');
      expect(vars).toContain('NOVAS_HOME');
      expect(vars).toContain('VCS_HOME');
      expect(vars).toContain('SNPSLMD_LICENSE_FILE');
    });

    it('includes all Cadence environment variables', () => {
      const vars = getKnownEnvVarNames();
      expect(vars).toContain('XLM_ROOT');
      expect(vars).toContain('CDS_INST_DIR');
      expect(vars).toContain('CDS_LICENSE_FILE');
    });

    it('includes system environment variables', () => {
      const vars = getKnownEnvVarNames();
      expect(vars).toContain('LM_LICENSE_FILE');
      expect(vars).toContain('LD_LIBRARY_PATH');
      expect(vars).toContain('PATH');
    });
  });

  describe('getEnvVarCatalog', () => {
    it('returns groups in correct category order', () => {
      const catalog = getEnvVarCatalog();
      expect(catalog.length).toBe(5);
      expect(catalog[0].category).toBe('soc');
      expect(catalog[1].category).toBe('synopsys');
      expect(catalog[2].category).toBe('cadence');
      expect(catalog[3].category).toBe('license');
      expect(catalog[4].category).toBe('system');
    });

    it('soc group contains PROJ_ENV, PROJ_RTL, PROJ_WORK, SPRD_TOOL_DIR', () => {
      const catalog = getEnvVarCatalog();
      const socGroup = catalog.find((g) => g.category === 'soc');
      expect(socGroup).toBeDefined();
      const names = socGroup!.vars.map((v) => v.name);
      expect(names).toContain('PROJ_ENV');
      expect(names).toContain('PROJ_RTL');
      expect(names).toContain('PROJ_WORK');
      expect(names).toContain('SPRD_TOOL_DIR');
    });

    it('synopsys group contains VERDI_HOME, NOVAS_HOME, VCS_HOME, SNPSLMD_LICENSE_FILE', () => {
      const catalog = getEnvVarCatalog();
      const synopsysGroup = catalog.find((g) => g.category === 'synopsys');
      expect(synopsysGroup).toBeDefined();
      const names = synopsysGroup!.vars.map((v) => v.name);
      expect(names).toContain('VERDI_HOME');
      expect(names).toContain('NOVAS_HOME');
      expect(names).toContain('VCS_HOME');
      expect(names).toContain('SNPSLMD_LICENSE_FILE');
    });

    it('cadence group contains XLM_ROOT, CDS_INST_DIR, CDS_LICENSE_FILE', () => {
      const catalog = getEnvVarCatalog();
      const cadenceGroup = catalog.find((g) => g.category === 'cadence');
      expect(cadenceGroup).toBeDefined();
      const names = cadenceGroup!.vars.map((v) => v.name);
      expect(names).toContain('XLM_ROOT');
      expect(names).toContain('CDS_INST_DIR');
      expect(names).toContain('CDS_LICENSE_FILE');
    });

    it('system group contains LD_LIBRARY_PATH and PATH', () => {
      const catalog = getEnvVarCatalog();
      const systemGroup = catalog.find((g) => g.category === 'system');
      expect(systemGroup).toBeDefined();
      const names = systemGroup!.vars.map((v) => v.name);
      expect(names).toContain('LD_LIBRARY_PATH');
      expect(names).toContain('PATH');
    });

    it('each group has label and description', () => {
      const catalog = getEnvVarCatalog();
      for (const group of catalog) {
        expect(group.label.length).toBeGreaterThan(0);
        expect(group.description.length).toBeGreaterThan(0);
      }
    });

    it('path vars are marked with isPath', () => {
      const catalog = getEnvVarCatalog();
      const socGroup = catalog.find((g) => g.category === 'soc');
      const projRtl = socGroup!.vars.find((v) => v.name === 'PROJ_RTL');
      expect(projRtl!.isPath).toBe(true);

      const licenseGroup = catalog.find((g) => g.category === 'license');
      const lmLicense = licenseGroup!.vars.find((v) => v.name === 'LM_LICENSE_FILE');
      expect(lmLicense!.isPath).toBeUndefined();
    });
  });

  describe('detectSystemEnvVars', () => {
    it('returns known env vars from process.env', () => {
      const original = { ...process.env };
      process.env['PROJ_RTL'] = '/home/user/proj/rtl';
      process.env['VCS_HOME'] = '/tools/synopsys/vcs';
      process.env['LM_LICENSE_FILE'] = '27000@license-server';

      const detected = detectSystemEnvVars();
      expect(detected['PROJ_RTL']).toBe('/home/user/proj/rtl');
      expect(detected['VCS_HOME']).toBe('/tools/synopsys/vcs');
      expect(detected['LM_LICENSE_FILE']).toBe('27000@license-server');

      // Restore
      for (const key of ['PROJ_RTL', 'VCS_HOME', 'LM_LICENSE_FILE']) {
        if (original[key] !== undefined) {
          process.env[key] = original[key];
        } else {
          delete process.env[key];
        }
      }
    });

    it('does not include empty string values', () => {
      const original = process.env['PROJ_ENV'];
      process.env['PROJ_ENV'] = '';

      const detected = detectSystemEnvVars();
      expect(detected['PROJ_ENV']).toBeUndefined();

      if (original !== undefined) {
        process.env['PROJ_ENV'] = original;
      } else {
        delete process.env['PROJ_ENV'];
      }
    });

    it('does not include unknown env var names', () => {
      const original = process.env['UNKNOWN_VAR_XYZ'];
      process.env['UNKNOWN_VAR_XYZ'] = 'some-value';

      const detected = detectSystemEnvVars();
      expect(detected['UNKNOWN_VAR_XYZ']).toBeUndefined();

      if (original !== undefined) {
        process.env['UNKNOWN_VAR_XYZ'] = original;
      } else {
        delete process.env['UNKNOWN_VAR_XYZ'];
      }
    });
  });

  describe('mergeSystemEnvVars', () => {
    it('fills in system values for vars not yet set', () => {
      const original = { ...process.env };
      process.env['PROJ_RTL'] = '/home/user/proj/rtl';
      process.env['VCS_HOME'] = '/tools/synopsys/vcs';

      const current = { PROJ_ENV: '/home/user/proj/dv' };
      const merged = mergeSystemEnvVars(current);
      expect(merged['PROJ_ENV']).toBe('/home/user/proj/dv');
      expect(merged['PROJ_RTL']).toBe('/home/user/proj/rtl');
      expect(merged['VCS_HOME']).toBe('/tools/synopsys/vcs');

      for (const key of ['PROJ_RTL', 'VCS_HOME']) {
        if (original[key] !== undefined) {
          process.env[key] = original[key];
        } else {
          delete process.env[key];
        }
      }
    });

    it('does not overwrite existing user-set values', () => {
      const original = process.env['PROJ_RTL'];
      process.env['PROJ_RTL'] = '/system/path';

      const current = { PROJ_RTL: '/user/custom/path' };
      const merged = mergeSystemEnvVars(current);
      expect(merged['PROJ_RTL']).toBe('/user/custom/path');

      if (original !== undefined) {
        process.env['PROJ_RTL'] = original;
      } else {
        delete process.env['PROJ_RTL'];
      }
    });

    it('overwrites empty string values with system values', () => {
      const original = process.env['PROJ_RTL'];
      process.env['PROJ_RTL'] = '/system/path';

      const current = { PROJ_RTL: '' };
      const merged = mergeSystemEnvVars(current);
      expect(merged['PROJ_RTL']).toBe('/system/path');

      if (original !== undefined) {
        process.env['PROJ_RTL'] = original;
      } else {
        delete process.env['PROJ_RTL'];
      }
    });

    it('preserves custom (non-catalog) env vars', () => {
      const current = { MY_CUSTOM_VAR: 'custom-value' };
      const merged = mergeSystemEnvVars(current);
      expect(merged['MY_CUSTOM_VAR']).toBe('custom-value');
    });
  });
});
