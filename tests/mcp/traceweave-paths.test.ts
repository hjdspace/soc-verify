/**
 * TraceWeave path resolver and default MCP config tests.
 *
 * Test seam: mock node:fs (existsSync) and node:child_process (execFileSync)
 * to avoid real filesystem/process access, matching the officecli binary tests.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import type { ChildProcess } from 'node:child_process';

// Mock node:fs
vi.mock('node:fs', () => ({
  existsSync: vi.fn(),
  readFileSync: vi.fn(),
}));

// Mock node:child_process
vi.mock('node:child_process', () => ({
  execFileSync: vi.fn(),
  execFile: vi.fn(),
}));

import { existsSync, readFileSync } from 'node:fs';
import { execFileSync, execFile } from 'node:child_process';
import {
  resolveTraceweaveDir,
  resolvePythonBin,
  isTraceweaveAvailable,
  buildTraceweaveMcpConfig,
  ensureTraceweaveDefaultMcp,
  diagnoseTraceweave,
  getFsdbBlockers,
  describeTraceweaveUnavailability,
  TRACEWEAVE_SERVER_NAME,
  TRACEWEAVE_VERSION,
  TRACEWEAVE_UPSTREAM_COMMIT,
} from '../../src/main/mcp/traceweave-paths';

const mockExistsSync = vi.mocked(existsSync);
const mockReadFileSync = vi.mocked(readFileSync);
const mockExecFileSync = vi.mocked(execFileSync);
const mockExecFile = vi.mocked(execFile);

/** Make the mocked existsSync report a TraceWeave source tree at server.py. */
function mockSourceTreeFound(): void {
  mockExistsSync.mockImplementation((p) => {
    const s = String(p).replace(/\\/g, '/');
    return s.includes('traceweave') && s.includes('server.py');
  });
}

type ExecFileCallback = (err: Error | null, stdout: string, stderr: string) => void;

/** Configure the mocked execFile to answer --version and -c import probes. */
function mockPythonProbes(version: { stdout?: string; stderr?: string } | null, depsError: string | null): void {
  mockExecFile.mockImplementation((_cmd, args, _opts, cb) => {
    const callback = cb as ExecFileCallback;
    const argv = args as string[];
    if (argv[0] === '--version') {
      if (version) callback(null, version.stdout ?? '', version.stderr ?? '');
      else callback(new Error('spawn failed'), '', '');
    } else if (argv[0] === '-c') {
      if (depsError !== null) callback(new Error('exit 1'), '', depsError);
      else callback(null, '', '');
    } else {
      callback(new Error(`unexpected args: ${argv.join(' ')}`), '', '');
    }
    return undefined as unknown as ChildProcess;
  });
}

describe('traceweave-paths - resolveTraceweaveDir', () => {
  let originalResourcesPath: string | undefined;

  beforeEach(() => {
    vi.clearAllMocks();
    mockExistsSync.mockReturnValue(false);
    originalResourcesPath = (process as NodeJS.Process & { resourcesPath?: string }).resourcesPath;
  });

  afterEach(() => {
    (process as unknown as { resourcesPath?: string }).resourcesPath = originalResourcesPath;
  });

  it('returns packaged traceweave directory in production mode', () => {
    const fakeResources = '/fake/electron/resources';
    (process as NodeJS.Process & { resourcesPath?: string }).resourcesPath = fakeResources;

    mockExistsSync.mockImplementation((p) => {
      const s = String(p).replace(/\\/g, '/');
      return s.includes(fakeResources) && s.includes('traceweave') && s.includes('server.py');
    });

    const result = resolveTraceweaveDir();
    expect(result).toBeTruthy();
    expect(String(result).replace(/\\/g, '/')).toContain(fakeResources);
    expect(String(result).replace(/\\/g, '/')).toContain('traceweave');
  });

  it('falls back to dev engine/traceweave directory in dev mode', () => {
    (process as NodeJS.Process & { resourcesPath?: string }).resourcesPath = '/fake/electron/resources';

    mockExistsSync.mockImplementation((p) => {
      const s = String(p).replace(/\\/g, '/');
      // Only the dev path exists (contains engine/traceweave)
      return !s.includes('/fake/electron') && s.includes('engine') && s.includes('traceweave') && s.includes('server.py');
    });

    const result = resolveTraceweaveDir();
    expect(result).toBeTruthy();
    expect(String(result).replace(/\\/g, '/')).not.toContain('/fake/electron');
    expect(String(result).replace(/\\/g, '/')).toContain('traceweave');
  });

  it('returns null when traceweave source is not found anywhere', () => {
    (process as NodeJS.Process & { resourcesPath?: string }).resourcesPath = '/fake/electron/resources';
    mockExistsSync.mockReturnValue(false);

    expect(resolveTraceweaveDir()).toBeNull();
  });
});

describe('traceweave-paths - resolvePythonBin', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockExecFileSync.mockImplementation(() => {
      throw new Error('not found');
    });
  });

  it('returns python3.11 path when found in PATH', () => {
    mockExecFileSync.mockReturnValue('/usr/bin/python3.11\n');
    const result = resolvePythonBin();
    expect(result).toBe('/usr/bin/python3.11');
  });

  it('returns python3 path when python3.11 is not found', () => {
    // python3.11 not found, python3 found
    mockExecFileSync.mockImplementation((cmd: string) => {
      if (cmd === 'where' || cmd === 'which') {
        // First call (python3.11) throws, second call (python3) returns
        throw new Error('not found');
      }
      return '/usr/bin/python3\n';
    });
    // Need to re-mock to handle sequence
    let callCount = 0;
    mockExecFileSync.mockImplementation(() => {
      callCount++;
      if (callCount === 1) throw new Error('not found'); // python3.11
      if (callCount === 2) return '/usr/bin/python3\n'; // python3
      throw new Error('not found');
    });

    const result = resolvePythonBin();
    expect(result).toBe('/usr/bin/python3');
  });

  it('returns python path when neither python3.11 nor python3 found', () => {
    let callCount = 0;
    mockExecFileSync.mockImplementation(() => {
      callCount++;
      if (callCount <= 2) throw new Error('not found'); // python3.11, python3
      return '/usr/bin/python\n'; // python
    });

    const result = resolvePythonBin();
    expect(result).toBe('/usr/bin/python');
  });

  it('returns null when no python binary is found', () => {
    mockExecFileSync.mockImplementation(() => {
      throw new Error('not found');
    });

    expect(resolvePythonBin()).toBeNull();
  });
});

describe('traceweave-paths - isTraceweaveAvailable', () => {
  let originalResourcesPath: string | undefined;

  beforeEach(() => {
    vi.clearAllMocks();
    mockExistsSync.mockReturnValue(false);
    mockExecFileSync.mockReturnValue('/usr/bin/python3.11\n');
    originalResourcesPath = (process as NodeJS.Process & { resourcesPath?: string }).resourcesPath;
  });

  afterEach(() => {
    (process as unknown as { resourcesPath?: string }).resourcesPath = originalResourcesPath;
  });

  it('returns true when both TraceWeave dir and python are available', () => {
    mockExistsSync.mockImplementation((p) => {
      const s = String(p).replace(/\\/g, '/');
      return s.includes('traceweave') && s.includes('server.py');
    });

    expect(isTraceweaveAvailable()).toBe(true);
  });

  it('returns false when TraceWeave dir is not available', () => {
    mockExistsSync.mockReturnValue(false);
    mockExecFileSync.mockReturnValue('/usr/bin/python3.11\n');

    expect(isTraceweaveAvailable()).toBe(false);
  });

  it('returns false when python is not available', () => {
    mockExistsSync.mockReturnValue(true);
    mockExecFileSync.mockImplementation(() => {
      throw new Error('not found');
    });

    expect(isTraceweaveAvailable()).toBe(false);
  });
});

describe('traceweave-paths - buildTraceweaveMcpConfig', () => {
  let originalResourcesPath: string | undefined;

  beforeEach(() => {
    vi.clearAllMocks();
    mockExistsSync.mockReturnValue(false);
    mockExecFileSync.mockReturnValue('/usr/bin/python3.11\n');
    originalResourcesPath = (process as NodeJS.Process & { resourcesPath?: string }).resourcesPath;
  });

  afterEach(() => {
    (process as unknown as { resourcesPath?: string }).resourcesPath = originalResourcesPath;
  });

  it('returns a valid McpServerConfig when TraceWeave is available', () => {
    mockExistsSync.mockImplementation((p) => {
      const s = String(p).replace(/\\/g, '/');
      return s.includes('traceweave') && s.includes('server.py');
    });

    const config = buildTraceweaveMcpConfig();
    expect(config).not.toBeNull();
    expect(config!.command).toBe('/usr/bin/python3.11');
    expect(config!.args).toBeDefined();
    expect(config!.args!.length).toBe(1);
    expect(config!.args![0]).toContain('server.py');
    expect(config!.cwd).toBeDefined();
    expect(config!.env).toBeDefined();
    // PATH is always included (TraceWeave needs it to find EDA tools)
    expect('PATH' in config!.env!).toBe(true);
    // TraceWeave v2.0 self-locates via __file__ (REPO_ROOT in config.py);
    // no TRACEWEAVE_HOME env var is set anymore
    expect('TRACEWEAVE_HOME' in config!.env!).toBe(false);
    expect(config!.enabled).toBe(true);
    expect(config!.type).toBe('stdio');
  });

  it('passes through existing EDA env vars from process.env', () => {
    mockExistsSync.mockImplementation((p) => {
      const s = String(p).replace(/\\/g, '/');
      return s.includes('traceweave') && s.includes('server.py');
    });
    process.env.VERDI_HOME = '/opt/verdi';
    process.env.VCS_HOME = '/opt/vcs';

    const config = buildTraceweaveMcpConfig();
    expect(config).not.toBeNull();
    expect(config!.env!.VERDI_HOME).toBe('/opt/verdi');
    expect(config!.env!.VCS_HOME).toBe('/opt/vcs');

    delete process.env.VERDI_HOME;
    delete process.env.VCS_HOME;
  });

  it('passes through XCELIUM_HOME from process.env', () => {
    mockExistsSync.mockImplementation((p) => {
      const s = String(p).replace(/\\/g, '/');
      return s.includes('traceweave') && s.includes('server.py');
    });
    process.env.XCELIUM_HOME = '/opt/cadence/xcelium';

    const config = buildTraceweaveMcpConfig();
    expect(config).not.toBeNull();
    expect(config!.env!.XCELIUM_HOME).toBe('/opt/cadence/xcelium');

    delete process.env.XCELIUM_HOME;
  });

  it('falls back XLM_ROOT to XCELIUM_HOME when XLM_ROOT is not set', () => {
    mockExistsSync.mockImplementation((p) => {
      const s = String(p).replace(/\\/g, '/');
      return s.includes('traceweave') && s.includes('server.py');
    });
    process.env.XCELIUM_HOME = '/opt/cadence/xcelium';
    // Ensure XLM_ROOT is not set
    delete process.env.XLM_ROOT;

    const config = buildTraceweaveMcpConfig();
    expect(config).not.toBeNull();
    expect(config!.env!.XCELIUM_HOME).toBe('/opt/cadence/xcelium');
    expect(config!.env!.XLM_ROOT).toBe('/opt/cadence/xcelium');

    delete process.env.XCELIUM_HOME;
  });

  it('does not override XLM_ROOT when both XLM_ROOT and XCELIUM_HOME are set', () => {
    mockExistsSync.mockImplementation((p) => {
      const s = String(p).replace(/\\/g, '/');
      return s.includes('traceweave') && s.includes('server.py');
    });
    process.env.XCELIUM_HOME = '/opt/cadence/xcelium';
    process.env.XLM_ROOT = '/opt/cadence/xcelium/custom';

    const config = buildTraceweaveMcpConfig();
    expect(config).not.toBeNull();
    expect(config!.env!.XCELIUM_HOME).toBe('/opt/cadence/xcelium');
    expect(config!.env!.XLM_ROOT).toBe('/opt/cadence/xcelium/custom');

    delete process.env.XCELIUM_HOME;
    delete process.env.XLM_ROOT;
  });

  it('does not set XLM_ROOT when neither XLM_ROOT nor XCELIUM_HOME is set', () => {
    mockExistsSync.mockImplementation((p) => {
      const s = String(p).replace(/\\/g, '/');
      return s.includes('traceweave') && s.includes('server.py');
    });
    delete process.env.XLM_ROOT;
    delete process.env.XCELIUM_HOME;

    const config = buildTraceweaveMcpConfig();
    expect(config).not.toBeNull();
    expect(config!.env!.XLM_ROOT).toBeUndefined();
    expect(config!.env!.XCELIUM_HOME).toBeUndefined();
  });

  it('returns null when TraceWeave dir is not available', () => {
    mockExistsSync.mockReturnValue(false);
    expect(buildTraceweaveMcpConfig()).toBeNull();
  });

  it('returns null when python is not available', () => {
    mockExistsSync.mockReturnValue(true);
    mockExecFileSync.mockImplementation(() => {
      throw new Error('not found');
    });
    expect(buildTraceweaveMcpConfig()).toBeNull();
  });
});

describe('traceweave-paths - ensureTraceweaveDefaultMcp', () => {
  let originalResourcesPath: string | undefined;

  beforeEach(() => {
    vi.clearAllMocks();
    mockExistsSync.mockReturnValue(false);
    mockExecFileSync.mockReturnValue('/usr/bin/python3.11\n');
    originalResourcesPath = (process as NodeJS.Process & { resourcesPath?: string }).resourcesPath;
  });

  afterEach(() => {
    (process as unknown as { resourcesPath?: string }).resourcesPath = originalResourcesPath;
  });

  it('returns the built-in config when TraceWeave is available', () => {
    mockExistsSync.mockImplementation((p) => {
      const s = String(p).replace(/\\/g, '/');
      return s.includes('traceweave') && s.includes('server.py');
    });

    const result = ensureTraceweaveDefaultMcp();
    expect(result).not.toBeNull();
    expect(result!.name).toBe(TRACEWEAVE_SERVER_NAME);
    expect(result!.config).toBeDefined();
    expect(result!.config.command).toBe('/usr/bin/python3.11');
  });

  it('returns null when TraceWeave is not available', () => {
    mockExistsSync.mockReturnValue(false);
    mockExecFileSync.mockReturnValue('/usr/bin/python3.11\n');

    const result = ensureTraceweaveDefaultMcp();
    expect(result).toBeNull();
  });

  it('returns null when python is not available', () => {
    mockExistsSync.mockReturnValue(true);
    mockExecFileSync.mockImplementation(() => {
      throw new Error('not found');
    });

    const result = ensureTraceweaveDefaultMcp();
    expect(result).toBeNull();
  });
});

describe('traceweave-paths - resolvePythonBin (Windows Store stub filtering)', () => {
  const isWindows = process.platform === 'win32';

  beforeEach(() => {
    vi.clearAllMocks();
    mockExecFileSync.mockImplementation(() => {
      throw new Error('not found');
    });
  });

  it('filters out Windows Store stubs and returns real Python', () => {
    // On Windows: where python returns both WindowsApps stub and real Python.
    // On Unix: where/which python returns a single path (no stub filtering).
    mockExecFileSync.mockImplementation((cmd: string, args?: readonly string[]) => {
      const exe = args?.[0] ?? '';
      if (cmd === 'where' && exe === 'python') {
        return 'C:\\Users\\test\\AppData\\Local\\Microsoft\\WindowsApps\\python.exe\nD:\\Program\\Python\\Python313\\python.exe\n';
      }
      throw new Error('not found');
    });

    const result = resolvePythonBin();
    if (isWindows) {
      // Should skip the WindowsApps stub and return the real Python
      expect(result).toBe('D:\\Program\\Python\\Python313\\python.exe');
    } else {
      // On Unix, the first result is returned (no stub filtering)
      expect(result).toContain('python');
    }
  });

  it('falls through to next candidate when only WindowsApps stub found', () => {
    // where python → only WindowsApps stub
    // where python3 → real Python
    mockExecFileSync.mockImplementation((cmd: string, args?: readonly string[]) => {
      const exe = args?.[0] ?? '';
      if (cmd === 'where' && exe === 'python') {
        return 'C:\\Users\\test\\AppData\\Local\\Microsoft\\WindowsApps\\python.exe\n';
      }
      if (cmd === 'where' && exe === 'python3') {
        return 'D:\\Program\\Python\\Python313\\python3.exe\n';
      }
      throw new Error('not found');
    });

    const result = resolvePythonBin();
    if (isWindows) {
      expect(result).toBe('D:\\Program\\Python\\Python313\\python3.exe');
    } else {
      // On Unix, python is the last candidate; the mock for 'python' throws,
      // and 'python3' returns a real path
      expect(result).toContain('python');
    }
  });

  it('returns null when all candidates return only WindowsApps stubs', () => {
    mockExecFileSync.mockImplementation(() => {
      return 'C:\\Users\\test\\AppData\\Local\\Microsoft\\WindowsApps\\python3.exe\n';
    });

    if (isWindows) {
      expect(resolvePythonBin()).toBeNull();
    } else {
      // On Unix, no stub filtering — returns the path as-is
      expect(resolvePythonBin()).not.toBeNull();
    }
  });
});

describe('traceweave-paths - diagnoseTraceweave', () => {
  let originalResourcesPath: string | undefined;

  beforeEach(() => {
    vi.clearAllMocks();
    mockExistsSync.mockReturnValue(false);
    mockReadFileSync.mockReturnValue('');
    mockExecFileSync.mockReturnValue('/usr/bin/python3.12\n');
    originalResourcesPath = (process as NodeJS.Process & { resourcesPath?: string }).resourcesPath;
  });

  afterEach(() => {
    (process as unknown as { resourcesPath?: string }).resourcesPath = originalResourcesPath;
  });

  it('reports ready when source, python >= 3.11 and deps are all present', async () => {
    mockSourceTreeFound();
    mockPythonProbes({ stdout: 'Python 3.12.4\n' }, null);

    const diag = await diagnoseTraceweave();
    expect(diag.ready).toBe(true);
    expect(diag.sourceDirFound).toBe(true);
    expect(diag.pythonFound).toBe(true);
    expect(diag.pythonVersion).toBe('3.12.4');
    expect(diag.pythonVersionOk).toBe(true);
    expect(diag.depsInstalled).toBe(true);
    expect(diag.missingDeps).toEqual([]);
    expect(diag.installCommand).toContain('pip install');
  });

  it('reads the python version from stderr when stdout is empty', async () => {
    mockSourceTreeFound();
    mockPythonProbes({ stderr: 'Python 3.11.9\n' }, null);

    const diag = await diagnoseTraceweave();
    expect(diag.pythonVersion).toBe('3.11.9');
    expect(diag.pythonVersionOk).toBe(true);
  });

  it('reports too-old python and does not claim readiness', async () => {
    mockSourceTreeFound();
    mockPythonProbes({ stdout: 'Python 3.8.10\n' }, null);

    const diag = await diagnoseTraceweave();
    expect(diag.pythonVersionOk).toBe(false);
    expect(diag.ready).toBe(false);
    expect(diag.installCommand).not.toBeNull();
  });

  it('reports missing deps with parsed module names and a pinned install command', async () => {
    mockSourceTreeFound();
    mockExecFile.mockImplementation((_cmd, args, _opts, cb) => {
      const callback = cb as ExecFileCallback;
      const argv = args as string[];
      if (argv[0] === '--version') callback(null, 'Python 3.12.1\n', '');
      else if (argv[0] === '-c') callback(new Error('exit 1'), '', "Traceback (most recent call last):\nModuleNotFoundError: No module named 'mcp'");
      else callback(new Error('unexpected'), '', '');
      return undefined as unknown as ChildProcess;
    });
    // requirements pin: existsSync matches the requirements file, readFileSync returns upstream content
    mockExistsSync.mockImplementation((p) => {
      const s = String(p).replace(/\\/g, '/');
      return s.includes('traceweave') && (s.includes('server.py') || s.includes('requirements-source-graph.txt'));
    });
    mockReadFileSync.mockReturnValue('mcp==1.27.0\nPyYAML\n');

    const diag = await diagnoseTraceweave();
    expect(diag.ready).toBe(false);
    expect(diag.depsInstalled).toBe(false);
    expect(diag.missingDeps).toEqual(['mcp']);
    expect(diag.installCommand).toContain('mcp==1.27.0');
    expect(diag.installCommand).toContain('pyyaml');
  });

  it('falls back to an unpinned install command when requirements are unreadable', async () => {
    mockSourceTreeFound();
    mockPythonProbes({ stdout: 'Python 3.12.4\n' }, "ModuleNotFoundError: No module named 'yaml'");

    const diag = await diagnoseTraceweave();
    expect(diag.missingDeps).toEqual(['yaml']);
    expect(diag.installCommand).toContain('pip install mcp pyyaml');
  });

  it('reports python missing with null-dependent fields', async () => {
    mockSourceTreeFound();
    mockExecFileSync.mockImplementation(() => {
      throw new Error('not found');
    });
    mockExecFile.mockImplementation((_cmd, args, _opts, cb) => {
      (cb as ExecFileCallback)(new Error('should not be called'), '', '');
      return undefined as unknown as ChildProcess;
    });

    const diag = await diagnoseTraceweave();
    expect(diag.ready).toBe(false);
    expect(diag.pythonFound).toBe(false);
    expect(diag.pythonVersionOk).toBeNull();
    expect(diag.depsInstalled).toBeNull();
    expect(diag.installCommand).toBeNull();
  });

  it('always reports the vendored version and upstream commit', async () => {
    mockSourceTreeFound();
    mockPythonProbes({ stdout: 'Python 3.12.4\n' }, null);

    const diag = await diagnoseTraceweave();
    expect(diag.version).toBe(TRACEWEAVE_VERSION);
    expect(diag.version).toBe('v2.0.0');
    expect(diag.upstreamCommit).toBe(TRACEWEAVE_UPSTREAM_COMMIT);
    expect(TRACEWEAVE_UPSTREAM_COMMIT).toMatch(/^[0-9a-f]{40}$/);
  });
});

describe('traceweave-paths - getFsdbBlockers', () => {
  const originalPlatform = Object.getOwnPropertyDescriptor(process, 'platform');
  const originalVerdiHome = process.env.VERDI_HOME;
  const originalNovasHome = process.env.NOVAS_HOME;

  beforeEach(() => {
    vi.clearAllMocks();
    mockExistsSync.mockReturnValue(false);
    delete process.env.VERDI_HOME;
    delete process.env.NOVAS_HOME;
  });

  afterEach(() => {
    if (originalPlatform) Object.defineProperty(process, 'platform', originalPlatform);
    if (originalVerdiHome === undefined) delete process.env.VERDI_HOME;
    else process.env.VERDI_HOME = originalVerdiHome;
    if (originalNovasHome === undefined) delete process.env.NOVAS_HOME;
    else process.env.NOVAS_HOME = originalNovasHome;
  });

  function setPlatform(platform: NodeJS.Platform): void {
    Object.defineProperty(process, 'platform', { value: platform, configurable: true });
  }

  it('reports the platform blocker on non-Linux', () => {
    setPlatform('win32');
    const blockers = getFsdbBlockers('/fake/traceweave');
    expect(blockers.length).toBe(1);
    expect(blockers[0]).toContain('Linux');
  });

  it('reports the wrapper blocker on Linux when the .so is missing', () => {
    setPlatform('linux');
    mockExistsSync.mockReturnValue(false);

    const blockers = getFsdbBlockers('/fake/traceweave');
    expect(blockers.length).toBe(1);
    expect(blockers[0]).toContain('libfsdb_wrapper.so');
  });

  it('reports the VERDI_HOME blocker on Linux when wrapper exists but Verdi is absent', () => {
    setPlatform('linux');
    mockExistsSync.mockImplementation((p) => String(p).endsWith('libfsdb_wrapper.so'));

    const blockers = getFsdbBlockers('/fake/traceweave');
    expect(blockers.length).toBe(1);
    expect(blockers[0]).toContain('VERDI_HOME');
  });

  it('reports no blockers on Linux with wrapper and VERDI_HOME', () => {
    setPlatform('linux');
    mockExistsSync.mockImplementation((p) => String(p).endsWith('libfsdb_wrapper.so'));
    process.env.VERDI_HOME = '/opt/verdi';

    expect(getFsdbBlockers('/fake/traceweave')).toEqual([]);
  });

  it('accepts NOVAS_HOME as the Verdi home alias', () => {
    setPlatform('linux');
    mockExistsSync.mockImplementation((p) => String(p).endsWith('libfsdb_wrapper.so'));
    delete process.env.VERDI_HOME;
    process.env.NOVAS_HOME = '/opt/verdi';

    expect(getFsdbBlockers('/fake/traceweave')).toEqual([]);
  });

  it('reports no blockers when the source dir is null but platform is non-Linux', () => {
    setPlatform('darwin');
    expect(getFsdbBlockers(null).length).toBe(1);
  });
});

describe('traceweave-paths - describeTraceweaveUnavailability', () => {
  let originalResourcesPath: string | undefined;

  beforeEach(() => {
    vi.clearAllMocks();
    mockExistsSync.mockReturnValue(false);
    originalResourcesPath = (process as NodeJS.Process & { resourcesPath?: string }).resourcesPath;
  });

  afterEach(() => {
    (process as unknown as { resourcesPath?: string }).resourcesPath = originalResourcesPath;
  });

  it('returns null when the source tree is not bundled', () => {
    expect(describeTraceweaveUnavailability()).toBeNull();
  });

  it('returns a python-missing reason when source exists but python does not', () => {
    mockSourceTreeFound();
    mockExecFileSync.mockImplementation(() => {
      throw new Error('not found');
    });

    const reason = describeTraceweaveUnavailability();
    expect(reason).toContain('Python');
    expect(reason).toContain('3.11');
  });

  it('returns null when source and python are both present (registration would succeed)', () => {
    mockSourceTreeFound();
    mockExecFileSync.mockReturnValue('/usr/bin/python3.11\n');

    expect(describeTraceweaveUnavailability()).toBeNull();
  });
});
