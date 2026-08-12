/**
 * TraceWeave path resolver and default MCP config tests.
 *
 * Test seam: mock node:fs (existsSync) and node:child_process (execFileSync)
 * to avoid real filesystem/process access, matching the officecli binary tests.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

// Mock node:fs
vi.mock('node:fs', () => ({
  existsSync: vi.fn(),
}));

// Mock node:child_process
vi.mock('node:child_process', () => ({
  execFileSync: vi.fn(),
}));

import { existsSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import {
  resolveTraceweaveDir,
  resolvePythonBin,
  isTraceweaveAvailable,
  buildTraceweaveMcpConfig,
  ensureTraceweaveDefaultMcp,
  TRACEWEAVE_SERVER_NAME,
} from '../../src/main/mcp/traceweave-paths';

const mockExistsSync = vi.mocked(existsSync);
const mockExecFileSync = vi.mocked(execFileSync);

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
    // TRACEWEAVE_HOME is always set to the source directory
    expect('TRACEWEAVE_HOME' in config!.env!).toBe(true);
    expect(config!.env!.TRACEWEAVE_HOME).toContain('traceweave');
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
