import { describe, it, expect, afterEach } from 'vitest';
import { TerminalManager } from '../../src/main/terminal/terminal-manager';

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
      manager.on('data', ({ id, data }) => {
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
