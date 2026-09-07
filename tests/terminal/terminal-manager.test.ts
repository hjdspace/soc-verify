import { describe, it, expect, afterEach } from 'vitest';
import {
  createLogModeChunkNormalizer,
  getInteractiveShellArgs,
  getLogModeShellArgs,
  mergeTerminalEnvs,
  resolveInteractiveShell,
  sanitizeModuleEnvForChild,
  TerminalManager,
} from '../../src/main/terminal/terminal-manager';

describe('mergeTerminalEnvs', () => {
  it('preserves project variables and prepends configured tool paths', () => {
    const separator = process.platform === 'win32' ? ';' : ':';
    const env = mergeTerminalEnvs(
      { PROJ_RTL: '/shell/rtl', PATH: ['/proj/python/bin', '/usr/bin'].join(separator) },
      { PROJ_RTL: '/config/rtl', PATH: ['/config/tools', '/proj/python/bin'].join(separator) },
    );

    expect(env.PROJ_RTL).toBe('/config/rtl');
    expect(env.PATH).toBe(['/config/tools', '/proj/python/bin', '/usr/bin'].join(separator));
  });
});

describe('createLogModeChunkNormalizer', () => {
  it('rewrites bare LF to CRLF so xterm.js renders each line left-aligned', () => {
    const normalize = createLogModeChunkNormalizer();
    expect(normalize(Buffer.from('ai_config\nall_sys_cov_cmd\n'))).toBe(
      'ai_config\r\nall_sys_cov_cmd\r\n',
    );
  });

  it('keeps existing CRLF pairs unchanged', () => {
    const normalize = createLogModeChunkNormalizer();
    expect(normalize(Buffer.from('first\r\nsecond\r\n'))).toBe('first\r\nsecond\r\n');
  });

  it('preserves lone CR (progress-bar overwrites)', () => {
    const normalize = createLogModeChunkNormalizer();
    expect(normalize(Buffer.from('10%\r50%\r100%\n'))).toBe('10%\r50%\r100%\r\n');
  });

  it('does not double the CR when a CRLF pair splits across chunks', () => {
    const normalize = createLogModeChunkNormalizer();
    const first = normalize(Buffer.from('line\r'));
    const second = normalize(Buffer.from('\nnext\n'));
    expect(first + second).toBe('line\r\nnext\r\n');
  });

  it('prepends CR for a bare LF arriving right after a chunk boundary', () => {
    const normalize = createLogModeChunkNormalizer();
    const first = normalize(Buffer.from('no newline at end'));
    const second = normalize(Buffer.from('\nnext line\n'));
    expect(first + second).toBe('no newline at end\r\nnext line\r\n');
  });

  it('decodes multi-byte UTF-8 sequences split across chunks', () => {
    const normalize = createLogModeChunkNormalizer();
    const text = '设置\n';
    const bytes = Buffer.from(text, 'utf8');
    // Split mid-way through the 3-byte sequence of 设 (E8 AE BE).
    const first = normalize(bytes.subarray(0, 5));
    const second = normalize(bytes.subarray(5));
    expect(first + second).toBe('设置\r\n');
  });

  it('returns empty string for empty chunks without corrupting state', () => {
    const normalize = createLogModeChunkNormalizer();
    expect(normalize(Buffer.alloc(0))).toBe('');
    expect(normalize(Buffer.from('a\n'))).toBe('a\r\n');
  });
});

describe('sanitizeModuleEnvForChild', () => {
  it('strips inherited Environment Modules runtime state', () => {
    const env = sanitizeModuleEnvForChild({
      LOADEDMODULES: 'tool/python/3.11.10:synopsys/verdi/U-2023.03-SP2-4',
      _LMFILES_: '/pub/modulefiles/tool/python/3.11.10',
      MODULE_VERSION: '4.5.3',
      MODULE_VERSION_STACK: '4.5.3',
      PATH: '/usr/bin:/bin',
      PROJ_DIR: '/proj/KunlunN02/gitview/user/view',
    });

    expect(env.LOADEDMODULES).toBeUndefined();
    expect(env._LMFILES_).toBeUndefined();
    expect(env.MODULE_VERSION).toBeUndefined();
    expect(env.MODULE_VERSION_STACK).toBeUndefined();
    expect(env.PATH).toBe('/usr/bin:/bin');
    expect(env.PROJ_DIR).toBe('/proj/KunlunN02/gitview/user/view');
  });

  it('strips chunked _ModuleTable state variables by prefix', () => {
    const env = sanitizeModuleEnvForChild({
      _ModuleTable00_: 'MTVUUkVWSVNX',
      _ModuleTable001_: 'more-chunks',
      PATH: '/usr/bin',
    });

    expect(env._ModuleTable00_).toBeUndefined();
    expect(env._ModuleTable001_).toBeUndefined();
    expect(env.PATH).toBe('/usr/bin');
  });

  it('keeps MODULEPATH and MODULESHOME so modulecmd still works', () => {
    const env = sanitizeModuleEnvForChild({
      MODULEPATH: '/pub/modulefiles',
      MODULESHOME: '/usr/share/Modules',
      LOADEDMODULES: 'tool/python/3.9.7',
    });

    expect(env.MODULEPATH).toBe('/pub/modulefiles');
    expect(env.MODULESHOME).toBe('/usr/share/Modules');
    expect(env.LOADEDMODULES).toBeUndefined();
  });
});

describe('resolveInteractiveShell', () => {
  const available = new Set(['/bin/bash', '/bin/zsh', '/bin/sh']);
  const exists = (path: string): boolean => available.has(path);

  it('uses the account login shell when the AppImage environment has no SHELL', () => {
    expect(resolveInteractiveShell('linux', undefined, '/bin/zsh', exists)).toBe('/bin/zsh');
  });

  it('prefers the account login shell over a stale inherited SHELL', () => {
    expect(resolveInteractiveShell('linux', '/bin/bash', '/bin/zsh', exists)).toBe('/bin/zsh');
  });

  it('falls back to an inherited SHELL when the account shell is unavailable', () => {
    expect(resolveInteractiveShell('linux', '/bin/zsh', null, exists)).toBe('/bin/zsh');
  });

  it('does not treat an installed zsh as the account default', () => {
    expect(resolveInteractiveShell('linux', undefined, null, exists)).toBe('/bin/bash');
  });
});

describe('getInteractiveShellArgs', () => {
  it('loads the project-path prompt configuration for Linux Bash', () => {
    expect(getInteractiveShellArgs('/bin/bash', 'linux', '/app/terminal/bashrc')).toEqual([
      '--rcfile',
      '/app/terminal/bashrc',
      '-i',
    ]);
  });

  it('starts zsh as a login + interactive shell to source .zshrc', () => {
    expect(getInteractiveShellArgs('/bin/zsh', 'linux', '/app/terminal/bashrc')).toEqual(['-l', '-i']);
  });

  it('starts csh as a login + interactive shell to source .cshrc', () => {
    expect(getInteractiveShellArgs('/bin/csh', 'linux', '/app/terminal/bashrc')).toEqual(['-l']);
    expect(getInteractiveShellArgs('/bin/tcsh', 'linux', '/app/terminal/bashrc')).toEqual(['-l']);
  });

  it('does not change Windows terminals', () => {
    expect(getInteractiveShellArgs('powershell.exe', 'win32', 'unused')).toEqual([]);
  });
});

describe('getLogModeShellArgs', () => {
  // csh/tcsh reject `csh -l -c` with `Unknown option -l`; the Python reference
  // GUI runs log-mode simulations as plain `csh -c <command>`.
  it('runs csh/tcsh commands without the -l login flag', () => {
    expect(getLogModeShellArgs('/bin/csh', 'runsim -case foo', 'linux')).toEqual([
      '-c',
      'runsim -case foo',
    ]);
    expect(getLogModeShellArgs('/bin/tcsh', 'runsim -case foo', 'linux')).toEqual([
      '-c',
      'runsim -case foo',
    ]);
  });

  it('keeps the login flag for bash/zsh so startup files are sourced', () => {
    expect(getLogModeShellArgs('/bin/bash', 'echo hi', 'linux')).toEqual(['-l', '-c', 'echo hi']);
    expect(getLogModeShellArgs('/bin/zsh', 'echo hi', 'linux')).toEqual(['-l', '-c', 'echo hi']);
  });

  it('uses NoProfile PowerShell on Windows', () => {
    expect(getLogModeShellArgs('powershell.exe', 'echo hi', 'win32')).toEqual([
      '-NoProfile',
      '-Command',
      'echo hi',
    ]);
  });
});

describe('TerminalManager', () => {
  let manager: TerminalManager;

  afterEach(() => {
    manager?.destroyAll();
  });

  it('creates a terminal session and returns metadata', async () => {
    manager = new TerminalManager();

    const session = await manager.create({ cwd: process.cwd() });

    expect(session.id).toMatch(/^term_/);
    expect(session.cwd).toBe(process.cwd());
    expect(session.cols).toBe(80);
    expect(session.rows).toBe(24);
    expect(session.pid).toBeGreaterThan(0);
    expect(session.createdAt).toBeGreaterThan(0);
  });

  it('creates terminal with custom dimensions', async () => {
    manager = new TerminalManager();

    const session = await manager.create({
      cwd: process.cwd(),
      cols: 120,
      rows: 40,
    });

    expect(session.cols).toBe(120);
    expect(session.rows).toBe(40);
  });

  it('lists all active terminal sessions', async () => {
    manager = new TerminalManager();

    await manager.create({ cwd: process.cwd() });
    await manager.create({ cwd: process.cwd() });

    const list = manager.list();
    expect(list).toHaveLength(2);
  });

  it('gets a specific terminal session by id', async () => {
    manager = new TerminalManager();

    const session = await manager.create({ cwd: process.cwd() });
    const found = manager.get(session.id);

    expect(found).toBeDefined();
    expect(found?.id).toBe(session.id);
  });

  it('returns undefined for non-existent terminal', () => {
    manager = new TerminalManager();

    const found = manager.get('nonexistent');
    expect(found).toBeUndefined();
  });

  it('emits data event when terminal produces output', async () => {
    manager = new TerminalManager();

    const dataPromise = new Promise<string>((resolve) => {
      manager.on('data', ({ id: _id, data }) => {
        resolve(data);
      });
    });

    const session = await manager.create({ cwd: process.cwd() });

    // Write a command that produces output
    manager.write(session.id, 'echo hello\n');

    // Wait for output (the shell should echo something back)
    const data = await Promise.race([
      dataPromise,
      new Promise<string>((resolve) => setTimeout(() => resolve('timeout'), 5000)),
    ]);

    expect(data).not.toBe('timeout');
  });

  it('retains command output after the process exits for tab restoration', async () => {
    manager = new TerminalManager();

    const exitPromise = new Promise<void>((resolve) => {
      manager.on('exit', () => resolve());
    });

    const session = await manager.runCommand({
      command: 'echo retained-output',
      cwd: process.cwd(),
    });

    await Promise.race([
      exitPromise,
      new Promise((_, reject) => setTimeout(() => reject(new Error('timeout waiting for command exit')), 5000)),
    ]);

    expect(manager.getOutputBuffer(session.id).join('')).toContain('retained-output');
  });

  describe('getOutputBufferTail', () => {
    it('returns the newest chunks in original order when under the budget', () => {
      manager = new TerminalManager();
      const session = manager.createSessionForTest(['a', 'b', 'c']);
      expect(manager.getOutputBufferTail(session.id, 100)).toEqual(['a', 'b', 'c']);
    });

    it('keeps only the tail of the last chunk when the budget is smaller than it', () => {
      manager = new TerminalManager();
      const session = manager.createSessionForTest(['0123456789', 'abcdefghij']);
      expect(manager.getOutputBufferTail(session.id, 4)).toEqual(['ghij']);
    });

    it('drops oldest chunks first once the budget is exhausted', () => {
      manager = new TerminalManager();
      const session = manager.createSessionForTest(['aaa', 'bbb', 'ccc']);
      expect(manager.getOutputBufferTail(session.id, 6)).toEqual(['bbb', 'ccc']);
    });

    it('returns an empty array for a zero budget', () => {
      manager = new TerminalManager();
      const session = manager.createSessionForTest(['aaa', 'bbb']);
      expect(manager.getOutputBufferTail(session.id, 0)).toEqual([]);
    });

    it('returns an empty array for a session with no output', () => {
      manager = new TerminalManager();
      expect(manager.getOutputBufferTail('nonexistent', 100)).toEqual([]);
    });
  });

  // POSIX-only: process groups and process.kill(-pid) do not exist on Windows.
  it.skipIf(process.platform === 'win32')(
    'log-mode abort kills the whole simulation process tree (grandchild dies with the group)',
    { timeout: 15000 },
    async () => {
      const { mkdtempSync } = await import('node:fs');
      const { tmpdir } = await import('node:os');
      const { join } = await import('node:path');
      const { readFile } = await import('node:fs/promises');

      manager = new TerminalManager();

      const dir = mkdtempSync(join(tmpdir(), 'socverify-tree-'));
      const childPidFile = join(dir, 'grandchild.pid');
      // The grandchild records its pid and sleeps — simulating runsim/xrun
      // running as a descendant of the log-mode shell.
      const command = `sh -c 'echo $$ > ${childPidFile}; sleep 30' & wait`;

      const session = await manager.runCommand({
        command,
        cwd: process.cwd(),
        shell: '/bin/sh',
      });

      // Wait for the grandchild to record its pid.
      let grandchildPid = 0;
      for (let i = 0; i < 50 && grandchildPid === 0; i++) {
        await new Promise((r) => setTimeout(r, 100));
        try {
          grandchildPid = Number(await readFile(childPidFile, 'utf-8'));
        } catch {
          // not written yet
        }
      }
      expect(grandchildPid).toBeGreaterThan(0);

      // Abort: destroy() must SIGTERM the whole process group, killing the
      // grandchild too — not just the shell.
      manager.destroy(session.id);

      // Give the signal a moment to take effect, then verify the grandchild is gone.
      await new Promise((r) => setTimeout(r, 500));
      expect(() => process.kill(grandchildPid, 0)).toThrow();
    },
  );

  it('destroys a terminal session', async () => {
    manager = new TerminalManager();

    const session = await manager.create({ cwd: process.cwd() });
    manager.destroy(session.id);

    expect(manager.get(session.id)).toBeUndefined();
    expect(manager.list()).toHaveLength(0);
  });

  it('emits destroyed event when terminal is destroyed', async () => {
    manager = new TerminalManager();

    const destroyedPromise = new Promise<string>((resolve) => {
      manager.on('destroyed', ({ id }) => resolve(id));
    });

    const session = await manager.create({ cwd: process.cwd() });
    manager.destroy(session.id);

    const destroyedId = await Promise.race([
      destroyedPromise,
      new Promise<string>((resolve) => setTimeout(() => resolve('timeout'), 3000)),
    ]);

    expect(destroyedId).toBe(session.id);
  });

  it('handles write to non-existent terminal gracefully', () => {
    manager = new TerminalManager();

    // Should not throw
    expect(() => manager.write('nonexistent', 'test')).not.toThrow();
  });

  it('handles resize to non-existent terminal gracefully', () => {
    manager = new TerminalManager();

    // Should not throw
    expect(() => manager.resize('nonexistent', 100, 50)).not.toThrow();
  });

  it('handles destroy of non-existent terminal gracefully', () => {
    manager = new TerminalManager();

    // Should not throw
    expect(() => manager.destroy('nonexistent')).not.toThrow();
  });

  it('destroys all terminal sessions', async () => {
    manager = new TerminalManager();

    await manager.create({ cwd: process.cwd() });
    await manager.create({ cwd: process.cwd() });
    await manager.create({ cwd: process.cwd() });

    expect(manager.list()).toHaveLength(3);

    manager.destroyAll();

    expect(manager.list()).toHaveLength(0);
  });
});
