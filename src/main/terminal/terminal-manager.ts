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

// ── Data batching constants ─────────────────────────────────
/**
 * Max batch size in bytes before flushing (64KB).
 * Prevents unbounded buffer growth during massive output bursts.
 */
const BATCH_MAX_BYTES = 64 * 1024;
/**
 * Flush interval in ms (~60fps). Batches high-frequency PTY data
 * into fewer IPC messages to avoid overwhelming the renderer.
 */
const BATCH_FLUSH_MS = 16;
/**
 * Max number of output buffer chunks retained for session restore.
 */
const OUTPUT_BUFFER_MAX = 5000;

interface SessionEntry {
  pty: NodePty.IPty | ChildProcess | null;
  session: TerminalSession;
  outputBuffer: string[];
  /** Pending data chunks waiting to be flushed via IPC */
  pendingChunks: string[];
  /** Combined size of pending chunks (bytes) */
  pendingSize: number;
  /** Flush timer handle */
  flushTimer: NodeJS.Timeout | null;
}

/**
 * Manages PTY sessions for terminal integration.
 *
 * Uses node-pty when available for a real PTY experience.
 * Falls back to child_process.spawn when node-pty is not compiled.
 *
 * Performance: data events are batched (every 16ms or 64KB) to reduce
 * IPC message count during high-volume simulation output (百万行日志).
 */
export class TerminalManager extends EventEmitter {
  private sessions = new Map<string, SessionEntry>();
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
    const entry: SessionEntry = {
      pty: null,
      session,
      outputBuffer,
      pendingChunks: [],
      pendingSize: 0,
      flushTimer: null,
    };

    const ptyModule = await loadNodePty();

    // Helper: enqueue data for batched flush
    const enqueueData = (data: string): void => {
      // Store in output buffer for session restore
      outputBuffer.push(data);
      if (outputBuffer.length > OUTPUT_BUFFER_MAX) outputBuffer.shift();

      // Enqueue for batched IPC flush
      entry.pendingChunks.push(data);
      entry.pendingSize += data.length;

      // Flush immediately if batch exceeds size limit
      if (entry.pendingSize >= BATCH_MAX_BYTES) {
        this.flushPending(id);
      } else if (entry.flushTimer === null) {
        // Schedule a flush on next tick
        entry.flushTimer = setTimeout(() => {
          this.flushPending(id);
        }, BATCH_FLUSH_MS);
        entry.flushTimer.unref();
      }
    };

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
      entry.pty = pty;

      pty.onData((data: string) => {
        enqueueData(data);
      });

      pty.onExit(({ exitCode }: { exitCode: number }) => {
        this.flushPending(id);
        this.emit('exit', { id, exitCode });
        this.sessions.delete(id);
      });

      this.sessions.set(id, entry);
    } else {
      // Fallback: use child_process.spawn
      const shell = process.platform === 'win32' ? 'powershell.exe' : 'bash';
      const child = spawn(shell, [], {
        cwd,
        env,
        stdio: ['pipe', 'pipe', 'pipe'],
      });

      session.pid = child.pid ?? 0;
      entry.pty = child;

      child.stdout?.on('data', (data: Buffer) => {
        enqueueData(data.toString());
      });

      child.stderr?.on('data', (data: Buffer) => {
        enqueueData(data.toString());
      });

      child.on('exit', (exitCode: number | null) => {
        this.flushPending(id);
        this.emit('exit', { id, exitCode: exitCode ?? 0 });
        this.sessions.delete(id);
      });

      this.sessions.set(id, entry);
    }

    return session;
  }

  /**
   * Flush pending data chunks for a terminal session.
   * Combines all pending chunks into a single 'data' event.
   */
  private flushPending(id: string): void {
    const entry = this.sessions.get(id);
    if (!entry || entry.pendingChunks.length === 0) return;

    // Cancel pending timer
    if (entry.flushTimer !== null) {
      clearTimeout(entry.flushTimer);
      entry.flushTimer = null;
    }

    // Combine chunks and emit
    const combined = entry.pendingChunks.join('');
    entry.pendingChunks = [];
    entry.pendingSize = 0;

    if (combined.length > 0) {
      this.emit('data', { id, data: combined });
    }
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

    // Flush any remaining data
    this.flushPending(id);

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
