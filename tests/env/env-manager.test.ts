import { describe, it, expect, vi, beforeEach } from 'vitest';
import { detectEdaTools, loadEnvConfig, saveEnvConfig, buildEnvFromConfig, getKnownEnvVarNames } from '../../src/main/env/env-manager';
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
  });
});
