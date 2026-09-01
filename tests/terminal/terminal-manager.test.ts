import { describe, it, expect, afterEach } from 'vitest';
import {
  getInteractiveShellArgs,
  mergeTerminalEnvs,
  resolveInteractiveShell,
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
