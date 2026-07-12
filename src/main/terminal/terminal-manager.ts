import { EventEmitter } from 'node:events';
import { spawn, ChildProcess } from 'node:child_process';
import type * as NodePty from 'node-pty';

export interface TerminalSession {
  id: string;
  pid: number;
  cwd: string;
  cols: number;
  rows: number;
  createdAt: number;
}

export interface TerminalCreateOptions {
  cwd?: string;
  cols?: number;
  rows?: number;
  env?: Record<string, string>;
}

let nodePtyModule: typeof NodePty | null = null;
let ptyLoadAttempted = false;

/**
 * Dynamically load node-pty. Falls back to null if not available
 * (e.g., native module not compiled for current platform).
 */
async function loadNodePty(): Promise<typeof NodePty | null> {
  if (ptyLoadAttempted) return nodePtyModule;
  ptyLoadAttempted = true;
  try {
    nodePtyModule = await import('node-pty');
    return nodePtyModule;
  } catch {
    console.warn('[terminal] node-pty not available, falling back to child_process.spawn');
    return null;
  }
}

/**
 * Manages PTY sessions for terminal integration.
 *
 * Uses node-pty when available for a real PTY experience.
 * Falls back to child_process.spawn when node-pty is not compiled.
 */
export class TerminalManager extends EventEmitter {
  private sessions = new Map<string, {
    pty: NodePty.IPty | ChildProcess | null;
    session: TerminalSession;
    outputBuffer: string[];
  }>();
  private idCounter = 0;

  /**
   * Create a new terminal session.
   */
  async create(opts: TerminalCreateOptions = {}): Promise<TerminalSession> {
    const id = `term_${++this.idCounter}_${Date.now()}`;
    const cwd = opts.cwd ?? process.cwd();
    const cols = opts.cols ?? 80;
    const rows = opts.rows ?? 24;
    const env = { ...process.env, ...opts.env } as Record<string, string>;

    const session: TerminalSession = {
      id,
      pid: 0,
      cwd,
      cols,
      rows,
      createdAt: Date.now(),
    };

    const outputBuffer: string[] = [];
    const ptyModule = await loadNodePty();

    if (ptyModule) {
      // Use real node-pty
      const shell = process.platform === 'win32' ? 'powershell.exe' : 'bash';
      const pty = ptyModule.spawn(shell, [], {
        name: 'xterm-color',
        cols,
        rows,
        cwd,
        env,
      });

      session.pid = pty.pid;

      pty.onData((data: string) => {
        outputBuffer.push(data);
        if (outputBuffer.length > 1000) outputBuffer.shift();
        this.emit('data', { id, data });
      });

      pty.onExit(({ exitCode }: { exitCode: number }) => {
        this.emit('exit', { id, exitCode });
        this.sessions.delete(id);
      });

      this.sessions.set(id, { pty, session, outputBuffer });
    } else {
      // Fallback: use child_process.spawn
      const shell = process.platform === 'win32' ? 'powershell.exe' : 'bash';
      const child = spawn(shell, [], {
        cwd,
        env,
        stdio: ['pipe', 'pipe', 'pipe'],
      });

      session.pid = child.pid ?? 0;

      child.stdout?.on('data', (data: Buffer) => {
        const str = data.toString();
        outputBuffer.push(str);
        if (outputBuffer.length > 1000) outputBuffer.shift();
        this.emit('data', { id, data: str });
      });

      child.stderr?.on('data', (data: Buffer) => {
        const str = data.toString();
        outputBuffer.push(str);
        if (outputBuffer.length > 1000) outputBuffer.shift();
        this.emit('data', { id, data: str });
      });

      child.on('exit', (exitCode: number | null) => {
        this.emit('exit', { id, exitCode: exitCode ?? 0 });
        this.sessions.delete(id);
      });

      this.sessions.set(id, { pty: child, session, outputBuffer });
    }

    return session;
  }

  /**
   * Write data to a terminal's input.
   */
  write(id: string, data: string): void {
    const entry = this.sessions.get(id);
    if (!entry || !entry.pty) return;

    // node-pty IPty has a write method
    if (typeof (entry.pty as NodePty.IPty).write === 'function') {
      (entry.pty as NodePty.IPty).write(data);
    } else {
      // child_process fallback
      const child = entry.pty as ChildProcess;
      child.stdin?.write(data);
    }
  }

  /**
   * Resize a terminal.
   */
  resize(id: string, cols: number, rows: number): void {
    const entry = this.sessions.get(id);
    if (!entry) return;

    entry.session.cols = cols;
    entry.session.rows = rows;

    if (entry.pty && 'resize' in entry.pty) {
      // node-pty
      (entry.pty as NodePty.IPty).resize(cols, rows);
    }
    // child_process doesn't support resize
  }

  /**
   * Destroy a terminal session.
   */
  destroy(id: string): void {
    const entry = this.sessions.get(id);
    if (!entry) return;

    if (entry.pty) {
      // node-pty IPty has kill(), child_process also has kill()
      if (typeof (entry.pty as NodePty.IPty).kill === 'function') {
        (entry.pty as NodePty.IPty).kill();
      } else {
        (entry.pty as ChildProcess).kill();
      }
    }

    this.sessions.delete(id);
    this.emit('destroyed', { id });
  }

  /**
   * List all active terminal sessions.
   */
  list(): TerminalSession[] {
    return Array.from(this.sessions.values()).map((e) => e.session);
  }

  /**
   * Get a specific terminal session.
   */
  get(id: string): TerminalSession | undefined {
    return this.sessions.get(id)?.session;
  }

  /**
   * Get buffered output for a terminal (for session restore).
   */
  getOutputBuffer(id: string): string[] {
    return this.sessions.get(id)?.outputBuffer ?? [];
  }

  /**
   * Destroy all terminal sessions.
   */
  destroyAll(): void {
    for (const id of Array.from(this.sessions.keys())) {
      this.destroy(id);
    }
  }
}

/**
 * Singleton terminal manager instance.
 */
export const terminalManager = new TerminalManager();
