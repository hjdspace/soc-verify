import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

// Mock node:fs to control existsSync for path resolution tests
vi.mock('node:fs', () => ({
  existsSync: vi.fn(),
}));

import { existsSync } from 'node:fs';
import {
  resolveZdotdirPath,
  resolveStarshipConfigPath,
  resolveOsc133Ps1Path,
  findEnhancedShell,
  getEnhancedShellArgs,
  buildEnhancedEnv,
} from '../../src/main/terminal/terminal-manager';

const mockExistsSync = vi.mocked(existsSync);

describe('Enhanced Terminal — resolveZdotdirPath', () => {
  let originalResourcesPath: string | undefined;

  beforeEach(() => {
    vi.clearAllMocks();
    mockExistsSync.mockReturnValue(false);
    originalResourcesPath = (process as NodeJS.Process & { resourcesPath?: string }).resourcesPath;
  });

  afterEach(() => {
    (process as unknown as { resourcesPath?: string }).resourcesPath = originalResourcesPath;
  });

  it('returns packaged path when resourcesPath/terminal/zsh exists', () => {
    const fakeResources = '/fake/electron/resources';
    (process as NodeJS.Process & { resourcesPath?: string }).resourcesPath = fakeResources;
    mockExistsSync.mockImplementation((p) => {
      const normalized = String(p).replace(/\\/g, '/');
      return normalized.includes('/fake/electron/resources/terminal/zsh');
    });

    const result = resolveZdotdirPath();
    expect(result).toContain('terminal');
    expect(result).toContain('zsh');
    expect(String(result).replace(/\\/g, '/')).toContain('/fake/electron/resources/terminal/zsh');
  });

  it('falls back to dev path when packaged path does not exist', () => {
    (process as NodeJS.Process & { resourcesPath?: string }).resourcesPath = '/fake/electron/resources';
    mockExistsSync.mockReturnValue(false);

    const result = resolveZdotdirPath();
    expect(result).toContain('terminal');
    expect(result).toContain('zsh');
    // Dev path should NOT contain the fake resources path
    expect(String(result).replace(/\\/g, '/')).not.toContain('/fake/electron');
  });
});

describe('Enhanced Terminal — resolveStarshipConfigPath', () => {
  it('returns starship.toml path inside ZDOTDIR', () => {
    const result = resolveStarshipConfigPath();
    expect(result).toContain('starship.toml');
    expect(result).toContain('zsh');
  });
});

describe('Enhanced Terminal — resolveOsc133Ps1Path', () => {
  it('returns osc133.ps1 path inside ZDOTDIR', () => {
    const result = resolveOsc133Ps1Path();
    expect(result).toContain('osc133.ps1');
    expect(result).toContain('zsh');
  });
});

describe('Enhanced Terminal — findEnhancedShell', () => {
  let originalResourcesPath: string | undefined;

  beforeEach(() => {
    vi.clearAllMocks();
    mockExistsSync.mockReturnValue(false);
    originalResourcesPath = (process as NodeJS.Process & { resourcesPath?: string }).resourcesPath;
  });

  afterEach(() => {
    (process as unknown as { resourcesPath?: string }).resourcesPath = originalResourcesPath;
  });

  it.skipIf(process.platform === 'win32')(
    'prefers zsh over bash when zsh is available',
    () => {
      mockExistsSync.mockImplementation((p) => String(p) === '/bin/zsh');
      const result = findEnhancedShell();
      expect(result).toBe('/bin/zsh');
    },
  );

  it.skipIf(process.platform === 'win32')(
    'falls back to bash when zsh is not available',
    () => {
      mockExistsSync.mockImplementation((p) => String(p) === '/bin/bash');
      const result = findEnhancedShell();
      // Should NOT be a csh/tcsh shell
      expect(result).not.toContain('csh');
      expect(result).not.toContain('tcsh');
    },
  );

  it.skipIf(process.platform !== 'win32')(
    'returns powershell.exe on Windows',
    () => {
      const result = findEnhancedShell();
      expect(result).toBe('powershell.exe');
    },
  );
});

describe('Enhanced Terminal — getEnhancedShellArgs', () => {
  let originalResourcesPath: string | undefined;

  beforeEach(() => {
    vi.clearAllMocks();
    mockExistsSync.mockReturnValue(false);
    originalResourcesPath = (process as NodeJS.Process & { resourcesPath?: string }).resourcesPath;
  });

  afterEach(() => {
    (process as unknown as { resourcesPath?: string }).resourcesPath = originalResourcesPath;
  });

  it('returns zsh login + interactive args for zsh on Linux', () => {
    expect(getEnhancedShellArgs('/bin/zsh', 'linux')).toEqual(['-l', '-i']);
  });

  it('returns zsh login + interactive args for /usr/bin/zsh on Linux', () => {
    expect(getEnhancedShellArgs('/usr/bin/zsh', 'linux')).toEqual(['-l', '-i']);
  });

  it('returns bash --rcfile args for bash on Linux (fallback)', () => {
    // Bash should fall through to getInteractiveShellArgs which returns ['--rcfile', <path>, '-i']
    const args = getEnhancedShellArgs('/bin/bash', 'linux');
    expect(args).toContain('-i');
    expect(args).toContain('--rcfile');
  });

  it('returns PowerShell -File args on Windows when osc133.ps1 exists', () => {
    mockExistsSync.mockReturnValue(true);
    const args = getEnhancedShellArgs('powershell.exe', 'win32');
    expect(args).toContain('-NoProfile');
    // -NoExit keeps the session alive after the -File script finishes
    expect(args).toContain('-NoExit');
    expect(args).toContain('-ExecutionPolicy');
    expect(args).toContain('Bypass');
    expect(args).toContain('-File');
    // The -File argument should point to osc133.ps1
    const fileArgIndex = args.indexOf('-File');
    expect(args[fileArgIndex + 1]).toContain('osc133.ps1');
  });

  it('returns -NoProfile only on Windows when osc133.ps1 does not exist', () => {
    mockExistsSync.mockReturnValue(false);
    const args = getEnhancedShellArgs('powershell.exe', 'win32');
    expect(args).toEqual(['-NoProfile']);
  });

  it('returns -NoProfile for non-powershell shell on Windows (enhanced mode always uses -NoProfile)', () => {
    // On Windows, enhanced mode always returns -NoProfile (with -File osc133.ps1 if exists)
    mockExistsSync.mockReturnValue(false);
    const args = getEnhancedShellArgs('cmd.exe', 'win32');
    expect(args).toEqual(['-NoProfile']);
  });
});

describe('Enhanced Terminal — buildEnhancedEnv', () => {
  let originalResourcesPath: string | undefined;

  beforeEach(() => {
    vi.clearAllMocks();
    mockExistsSync.mockReturnValue(false);
    originalResourcesPath = (process as NodeJS.Process & { resourcesPath?: string }).resourcesPath;
  });

  afterEach(() => {
    (process as unknown as { resourcesPath?: string }).resourcesPath = originalResourcesPath;
  });

  it('sets ZDOTDIR environment variable', () => {
    const env = buildEnhancedEnv({ PATH: '/usr/bin' });
    expect(env.ZDOTDIR).toBeDefined();
    expect(env.ZDOTDIR).toContain('zsh');
  });

  it('sets STARSHIP_CONFIG environment variable', () => {
    const env = buildEnhancedEnv({ PATH: '/usr/bin' });
    expect(env.STARSHIP_CONFIG).toBeDefined();
    expect(env.STARSHIP_CONFIG).toContain('starship.toml');
  });

  it('preserves base env variables', () => {
    const env = buildEnhancedEnv({ PATH: '/usr/bin', HOME: '/home/user', MY_VAR: 'hello' });
    expect(env.HOME).toBe('/home/user');
    expect(env.MY_VAR).toBe('hello');
  });

  it('merges caller-provided overrides on top of enhanced vars', () => {
    const env = buildEnhancedEnv(
      { PATH: '/usr/bin', HOME: '/home/user' },
      { MY_OVERRIDE: 'custom' },
    );
    expect(env.ZDOTDIR).toBeDefined();
    expect(env.STARSHIP_CONFIG).toBeDefined();
    expect(env.MY_OVERRIDE).toBe('custom');
    expect(env.HOME).toBe('/home/user');
  });

  it('does NOT add csh-specific env vars', () => {
    const env = buildEnhancedEnv({ PATH: '/usr/bin' });
    // Enhanced terminal should never set csh-related variables
    expect(env.PROJ_ENV).toBeUndefined();
  });

  // TERM 注入（命令预测灰色的前提）：
  // zsh 的 zle_highlight 依赖 terminfo，TERM 缺失时 zsh-autosuggestions 的
  // fg=N 上色完全失效，预测文本与用户输入同色。桌面启动的 GUI 进程没有 TERM。
  describe('TERM injection', () => {
    const realPlatform = process.platform;

    function withPlatform(platform: NodeJS.Platform, fn: () => void): void {
      Object.defineProperty(process, 'platform', { value: platform, configurable: true });
      try {
        fn();
      } finally {
        Object.defineProperty(process, 'platform', { value: realPlatform, configurable: true });
      }
    }

    afterEach(() => {
      Object.defineProperty(process, 'platform', { value: realPlatform, configurable: true });
    });

    it('injects TERM=xterm-256color on Linux when base env has no TERM', () => {
      withPlatform('linux', () => {
        const env = buildEnhancedEnv({ PATH: '/usr/bin' });
        expect(env.TERM).toBe('xterm-256color');
      });
    });

    it('injects TERM=xterm-256color on Linux when TERM is dumb', () => {
      withPlatform('linux', () => {
        const env = buildEnhancedEnv({ PATH: '/usr/bin', TERM: 'dumb' });
        expect(env.TERM).toBe('xterm-256color');
      });
    });

    it('preserves an existing meaningful TERM on Linux', () => {
      withPlatform('linux', () => {
        const env = buildEnhancedEnv({ PATH: '/usr/bin', TERM: 'screen-256color' });
        expect(env.TERM).toBe('screen-256color');
      });
    });

    it('injects TERM on macOS too', () => {
      withPlatform('darwin', () => {
        const env = buildEnhancedEnv({ PATH: '/usr/bin' });
        expect(env.TERM).toBe('xterm-256color');
      });
    });

    it('does NOT inject TERM on Windows', () => {
      withPlatform('win32', () => {
        const env = buildEnhancedEnv({ PATH: 'C:\\Windows' });
        expect(env.TERM).toBeUndefined();
      });
    });

    it('caller-provided overrides win over injected TERM', () => {
      withPlatform('linux', () => {
        const env = buildEnhancedEnv({ PATH: '/usr/bin' }, { TERM: 'xterm-kitty' });
        expect(env.TERM).toBe('xterm-kitty');
      });
    });
  });
});
