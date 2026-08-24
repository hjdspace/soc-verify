import { describe, it, expect, vi, beforeEach } from 'vitest';
import { mkdtempSync, writeFileSync, rmSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

// ─── Hoisted mock state ─────────────────────────────────────
// vi.mock factories are hoisted to the top of the file, so any variables
// they reference must also be hoisted via vi.hoisted().
const { execFileMock, mockLoginShellEnv } = vi.hoisted(() => ({
  execFileMock: vi.fn(),
  mockLoginShellEnv: {} as Record<string, string>,
}));

// ─── Mock child_process ─────────────────────────────────────
// The mock must handle both 'where' (Windows) and 'which' (Linux/macOS)
// commands for tool path lookup, plus tool version commands.
vi.mock('node:child_process', () => ({
  execFile: execFileMock,
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

// ─── Mock login-shell-env ───────────────────────────────────
// Mock the login shell env module so tests don't actually spawn shells.
// The mock returns a controlled environment that simulates what a login
// shell would produce.
vi.mock('../../src/main/env/login-shell-env', () => ({
  getLoginShellEnv: vi.fn(async () => ({ ...process.env, ...mockLoginShellEnv })),
  refreshLoginShellEnv: vi.fn(),
  findInPathAsync: vi.fn(async (executable: string, _env?: Record<string, string>) => {
    // Simulate 'which'/'where' behavior using the execFileMock.
    // This is called by detectEdaTools instead of the raw execFile('where', ...).
    const cmd = process.platform === 'win32' ? 'where' : 'which';
    return new Promise<string[]>((resolve) => {
      execFileMock(cmd, [executable], { timeout: 5000 }, (err: unknown, result: { stdout: string }) => {
        if (err) return resolve([]);
        resolve(result.stdout.trim().split(/\r?\n/).filter(Boolean));
      });
    });
  }),
}));

// Import after mocks are set up
import {
  detectEdaTools,
  loadEnvConfig,
  saveEnvConfig,
  buildEnvFromConfig,
  getKnownEnvVarNames,
  getEnvVarCatalog,
  detectSystemEnvVars,
  mergeSystemEnvVars,
  resolveProjectEnvVar,
  resolveProjectEnvVarSync,
  resolveProjEnv,
  resolveProjRtl,
  syncEnvFromSystem,
} from '../../src/main/env/env-manager';

// ─── Helper: configure execFileMock for a set of tools ──────
/**
 * Set up the execFileMock to simulate finding specific tools.
 *
 * @param foundTools - Map of tool command → path (e.g. { vcs: '/usr/bin/vcs' })
 * @param versionOutputs - Map of tool command → version string
 */
function setupToolMocks(
  foundTools: Record<string, string>,
  versionOutputs: Record<string, string> = {},
): void {
  execFileMock.mockImplementation((cmd: string, args: string[], _opts: unknown, cb: (err: unknown, result: { stdout: string; stderr: string }) => void) => {
    if (cmd === 'where' || cmd === 'which') {
      const toolName = args[0];
      if (foundTools[toolName]) {
        cb(null, { stdout: foundTools[toolName] + '\n', stderr: '' });
      } else {
        cb(new Error('not found'), { stdout: '', stderr: '' });
      }
    } else {
      // Version detection: cmd is the resolved absolute path (e.g. '/usr/bin/vcs').
      // Match by the basename of the path, or by the full path, or by the
      // command name in versionOutputs.
      const basename = cmd.split(/[/\\]/).pop() ?? cmd;
      const versionKey = Object.keys(versionOutputs).find(
        (key) => key === cmd || key === basename || foundTools[key] === cmd,
      );
      if (versionKey) {
        cb(null, { stdout: versionOutputs[versionKey], stderr: '' });
      } else {
        cb(new Error('error'), { stdout: '', stderr: '' });
      }
    }
  });
}

// ─── Reset mocks before each test ───────────────────────────
beforeEach(() => {
  execFileMock.mockReset();
  // Clear mock login shell env
  for (const key of Object.keys(mockLoginShellEnv)) {
    delete mockLoginShellEnv[key];
  }
});

// ─── Tests ──────────────────────────────────────────────────
describe('env-manager', () => {
  describe('detectEdaTools', () => {
    it('returns a list of all known EDA tools with detection status', async () => {
      setupToolMocks(
        { vcs: '/usr/bin/vcs', verilator: '/usr/bin/verilator' },
        { vcs: 'VCS version Q-2020.03', verilator: 'Verilator 5.0' },
      );

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

    it('works with both "where" and "which" commands (platform adaptive)', async () => {
      // This test verifies that the mock handles whichever command
      // the platform uses. The findInPathAsync mock dispatches to
      // execFileMock with the correct command name.
      setupToolMocks(
        { vcs: '/usr/bin/vcs' },
        { vcs: 'VCS version Q-2020.03' },
      );

      const tools = await detectEdaTools();
      const vcs = tools.find((t) => t.name.includes('VCS'));
      expect(vcs!.detected).toBe(true);

      // Verify that either 'where' or 'which' was called (not both)
      const whichCalls = execFileMock.mock.calls.filter(
        (c: unknown[]) => c[0] === 'where' || c[0] === 'which',
      );
      expect(whichCalls.length).toBeGreaterThan(0);
    });

    it('reports version as undefined when version command fails but tool is detected', async () => {
      setupToolMocks({ vcs: '/usr/bin/vcs' }, {});

      const tools = await detectEdaTools();
      const vcs = tools.find((t) => t.name.includes('VCS'));
      expect(vcs).toBeDefined();
      expect(vcs!.detected).toBe(true);
      expect(vcs!.version).toBeUndefined();
    });

    it('reports detected=false when tool is not found in PATH', async () => {
      setupToolMocks({}, {});

      const tools = await detectEdaTools();
      // All tools should be undetected
      for (const tool of tools) {
        expect(tool.detected).toBe(false);
        expect(tool.path).toBe('');
      }
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
      expect(vars).toContain('XCELIUM_HOME');
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

    it('cadence group contains XCELIUM_HOME, XLM_ROOT, CDS_INST_DIR, CDS_LICENSE_FILE', () => {
      const catalog = getEnvVarCatalog();
      const cadenceGroup = catalog.find((g) => g.category === 'cadence');
      expect(cadenceGroup).toBeDefined();
      const names = cadenceGroup!.vars.map((v) => v.name);
      expect(names).toContain('XCELIUM_HOME');
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
    it('returns known env vars from the login shell environment', async () => {
      // Simulate login shell env having EDA variables set
      mockLoginShellEnv['PROJ_RTL'] = '/home/user/proj/rtl';
      mockLoginShellEnv['VCS_HOME'] = '/tools/synopsys/vcs';
      mockLoginShellEnv['LM_LICENSE_FILE'] = '27000@license-server';

      const detected = await detectSystemEnvVars();
      expect(detected['PROJ_RTL']).toBe('/home/user/proj/rtl');
      expect(detected['VCS_HOME']).toBe('/tools/synopsys/vcs');
      expect(detected['LM_LICENSE_FILE']).toBe('27000@license-server');
    });

    it('does not include empty string values', async () => {
      mockLoginShellEnv['PROJ_ENV'] = '';

      const detected = await detectSystemEnvVars();
      expect(detected['PROJ_ENV']).toBeUndefined();
    });

    it('does not include unknown env var names', async () => {
      mockLoginShellEnv['UNKNOWN_VAR_XYZ'] = 'some-value';

      const detected = await detectSystemEnvVars();
      expect(detected['UNKNOWN_VAR_XYZ']).toBeUndefined();
    });

    it('detects env vars that are only in login shell env (not process.env)', async () => {
      // This simulates the AppImage desktop launch scenario where VCS_HOME
      // is set in .bashrc but not in the desktop environment.
      const originalVcsHome = process.env['VCS_HOME'];
      delete process.env['VCS_HOME'];
      mockLoginShellEnv['VCS_HOME'] = '/tools/synopsys/vcs/M-2023.06';

      try {
        const detected = await detectSystemEnvVars();
        expect(detected['VCS_HOME']).toBe('/tools/synopsys/vcs/M-2023.06');
      } finally {
        if (originalVcsHome !== undefined) {
          process.env['VCS_HOME'] = originalVcsHome;
        }
      }
    });
  });

  describe('mergeSystemEnvVars', () => {
    it('fills in system values for vars not yet set', async () => {
      mockLoginShellEnv['PROJ_RTL'] = '/home/user/proj/rtl';
      mockLoginShellEnv['VCS_HOME'] = '/tools/synopsys/vcs';

      const current = { PROJ_ENV: '/home/user/proj/dv' };
      const merged = await mergeSystemEnvVars(current);
      expect(merged['PROJ_ENV']).toBe('/home/user/proj/dv');
      expect(merged['PROJ_RTL']).toBe('/home/user/proj/rtl');
      expect(merged['VCS_HOME']).toBe('/tools/synopsys/vcs');
    });

    it('does not overwrite existing user-set values', async () => {
      mockLoginShellEnv['PROJ_RTL'] = '/system/path';

      const current = { PROJ_RTL: '/user/custom/path' };
      const merged = await mergeSystemEnvVars(current);
      expect(merged['PROJ_RTL']).toBe('/user/custom/path');
    });

    it('overwrites empty string values with system values', async () => {
      mockLoginShellEnv['PROJ_RTL'] = '/system/path';

      const current = { PROJ_RTL: '' };
      const merged = await mergeSystemEnvVars(current);
      expect(merged['PROJ_RTL']).toBe('/system/path');
    });

    it('preserves custom (non-catalog) env vars', async () => {
      const current = { MY_CUSTOM_VAR: 'custom-value' };
      const merged = await mergeSystemEnvVars(current);
      expect(merged['MY_CUSTOM_VAR']).toBe('custom-value');
    });
  });

  describe('resolveProjectEnvVar / resolveProjEnv / resolveProjRtl', () => {
    it('resolves from process.env first', async () => {
      const tmpDir = mkdtempSync(join(tmpdir(), 'env-resolve-'));
      try {
        process.env.PROJ_ENV = '/from/process/env';
        try {
          const result = await resolveProjEnv(tmpDir);
          expect(result).toBe('/from/process/env');
        } finally {
          delete process.env.PROJ_ENV;
        }
      } finally {
        rmSync(tmpDir, { recursive: true });
      }
    });

    it('falls back to login shell env when process.env is unset', async () => {
      const tmpDir = mkdtempSync(join(tmpdir(), 'env-resolve-'));
      try {
        const original = process.env.PROJ_ENV;
        delete process.env.PROJ_ENV;
        mockLoginShellEnv['PROJ_ENV'] = '/from/login/shell';
        try {
          const result = await resolveProjEnv(tmpDir);
          expect(result).toBe('/from/login/shell');
        } finally {
          if (original !== undefined) process.env.PROJ_ENV = original;
          delete mockLoginShellEnv['PROJ_ENV'];
        }
      } finally {
        rmSync(tmpDir, { recursive: true });
      }
    });

    it('falls back to .socverify/env.json when process.env and login shell are unset', async () => {
      const tmpDir = mkdtempSync(join(tmpdir(), 'env-resolve-'));
      const socverifyDir = join(tmpDir, '.socverify');
      mkdirSync(socverifyDir, { recursive: true });
      writeFileSync(
        join(socverifyDir, 'env.json'),
        JSON.stringify({ tools: [], envVars: { PROJ_ENV: '/from/env.json' } }),
      );
      try {
        const original = process.env.PROJ_ENV;
        delete process.env.PROJ_ENV;
        try {
          const result = await resolveProjEnv(tmpDir);
          expect(result).toBe('/from/env.json');
        } finally {
          if (original !== undefined) process.env.PROJ_ENV = original;
        }
      } finally {
        rmSync(tmpDir, { recursive: true });
      }
    });

    it('returns null when var is unset everywhere', async () => {
      const tmpDir = mkdtempSync(join(tmpdir(), 'env-resolve-'));
      try {
        const original = process.env.PROJ_ENV;
        delete process.env.PROJ_ENV;
        try {
          const result = await resolveProjEnv(tmpDir);
          expect(result).toBeNull();
        } finally {
          if (original !== undefined) process.env.PROJ_ENV = original;
        }
      } finally {
        rmSync(tmpDir, { recursive: true });
      }
    });

    it('resolveProjRtl resolves PROJ_RTL from process.env', async () => {
      const tmpDir = mkdtempSync(join(tmpdir(), 'env-resolve-'));
      try {
        process.env.PROJ_RTL = '/rtl/from/process';
        try {
          const result = await resolveProjRtl(tmpDir);
          expect(result).toBe('/rtl/from/process');
        } finally {
          delete process.env.PROJ_RTL;
        }
      } finally {
        rmSync(tmpDir, { recursive: true });
      }
    });

    it('resolveProjectEnvVar works for arbitrary var names', async () => {
      const tmpDir = mkdtempSync(join(tmpdir(), 'env-resolve-'));
      try {
        process.env.VCS_HOME = '/tools/vcs';
        try {
          const result = await resolveProjectEnvVar('VCS_HOME', tmpDir);
          expect(result).toBe('/tools/vcs');
        } finally {
          delete process.env.VCS_HOME;
        }
      } finally {
        rmSync(tmpDir, { recursive: true });
      }
    });

    it('resolveProjectEnvVarSync reads process.env without login shell fallback', async () => {
      const tmpDir = mkdtempSync(join(tmpdir(), 'env-sync-resolve-'));
      try {
        process.env.PROJ_ENV = '/sync/from/process';
        try {
          const result = resolveProjectEnvVarSync('PROJ_ENV', tmpDir);
          expect(result).toBe('/sync/from/process');
        } finally {
          delete process.env.PROJ_ENV;
        }
      } finally {
        rmSync(tmpDir, { recursive: true });
      }
    });

    it('resolveProjectEnvVarSync falls back to .socverify/env.json', () => {
      const tmpDir = mkdtempSync(join(tmpdir(), 'env-sync-resolve-'));
      const socverifyDir = join(tmpDir, '.socverify');
      mkdirSync(socverifyDir, { recursive: true });
      writeFileSync(
        join(socverifyDir, 'env.json'),
        JSON.stringify({ tools: [], envVars: { PROJ_RTL: '/rtl/from/env.json' } }),
      );
      try {
        const original = process.env.PROJ_RTL;
        delete process.env.PROJ_RTL;
        try {
          const result = resolveProjectEnvVarSync('PROJ_RTL', tmpDir);
          expect(result).toBe('/rtl/from/env.json');
        } finally {
          if (original !== undefined) process.env.PROJ_RTL = original;
        }
      } finally {
        rmSync(tmpDir, { recursive: true });
      }
    });
  });

  describe('syncEnvFromSystem', () => {
    it('merges system env vars into env.json without overwriting user-set values', async () => {
      const tmpDir = mkdtempSync(join(tmpdir(), 'env-sync-'));
      const socverifyDir = join(tmpDir, '.socverify');
      mkdirSync(socverifyDir, { recursive: true });
      writeFileSync(
        join(socverifyDir, 'env.json'),
        JSON.stringify({
          tools: [{ name: 'VCS', path: '/usr/bin/vcs', detected: true }],
          envVars: { PROJ_ENV: '/user/set/proj-env' },
        }),
      );
      try {
        mockLoginShellEnv['PROJ_RTL'] = '/system/proj/rtl';
        mockLoginShellEnv['VCS_HOME'] = '/tools/synopsys/vcs';

        const { config, detectedCount } = await syncEnvFromSystem(tmpDir);
        expect(config.envVars['PROJ_ENV']).toBe('/user/set/proj-env');
        expect(config.envVars['PROJ_RTL']).toBe('/system/proj/rtl');
        expect(config.envVars['VCS_HOME']).toBe('/tools/synopsys/vcs');
        expect(config.tools).toHaveLength(1);
        // At least the two vars we set in mockLoginShellEnv were detected
        // (PATH may also be detected from process.env, so use >=).
        expect(detectedCount).toBeGreaterThanOrEqual(2);

        // Verify persistence
        const reloaded = await loadEnvConfig(tmpDir);
        expect(reloaded?.envVars['PROJ_RTL']).toBe('/system/proj/rtl');
        expect(reloaded?.envVars['PROJ_ENV']).toBe('/user/set/proj-env');
      } finally {
        rmSync(tmpDir, { recursive: true });
      }
    });

    it('preserves existing tools array when syncing env vars', async () => {
      const tmpDir = mkdtempSync(join(tmpdir(), 'env-sync-'));
      const socverifyDir = join(tmpDir, '.socverify');
      mkdirSync(socverifyDir, { recursive: true });
      const originalTools = [{ name: 'VCS', path: '/usr/bin/vcs', detected: true }];
      writeFileSync(
        join(socverifyDir, 'env.json'),
        JSON.stringify({ tools: originalTools, envVars: {} }),
      );
      try {
        const { config } = await syncEnvFromSystem(tmpDir);
        expect(config.tools).toEqual(originalTools);
      } finally {
        rmSync(tmpDir, { recursive: true });
      }
    });

    it('returns detectedCount=0 when no new system vars are found', async () => {
      const tmpDir = mkdtempSync(join(tmpdir(), 'env-sync-'));
      const socverifyDir = join(tmpDir, '.socverify');
      mkdirSync(socverifyDir, { recursive: true });
      // Pre-populate with all known system vars so nothing new can be detected.
      const allKnown: Record<string, string> = {};
      for (const name of getKnownEnvVarNames()) {
        allKnown[name] = '/preset';
      }
      writeFileSync(
        join(socverifyDir, 'env.json'),
        JSON.stringify({ tools: [], envVars: allKnown }),
      );
      try {
        const { detectedCount } = await syncEnvFromSystem(tmpDir);
        expect(detectedCount).toBe(0);
      } finally {
        rmSync(tmpDir, { recursive: true });
      }
    });

    it('creates env.json if it does not exist', async () => {
      const tmpDir = mkdtempSync(join(tmpdir(), 'env-sync-'));
      try {
        mockLoginShellEnv['PROJ_ENV'] = '/system/proj-env';

        const { config, detectedCount } = await syncEnvFromSystem(tmpDir);
        expect(config.envVars['PROJ_ENV']).toBe('/system/proj-env');
        expect(detectedCount).toBeGreaterThanOrEqual(1);

        // File should now exist on disk
        const reloaded = await loadEnvConfig(tmpDir);
        expect(reloaded).not.toBeNull();
        expect(reloaded?.envVars['PROJ_ENV']).toBe('/system/proj-env');
      } finally {
        rmSync(tmpDir, { recursive: true });
      }
    });
  });
});
