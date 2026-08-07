import type { BrowserWindow } from 'electron';
import { EventEmitter } from 'node:events';
import { projectManager } from '../project/project-manager';
import { sessionManager } from '../agent/session-manager';
import { simulationRegistry } from '../simulation/simulation-registry';
import { simTerminalLinker } from '../simulation/sim-terminal-linker';
import { terminalManager } from '../terminal/terminal-manager';
import { errorAnalysisCoordinator } from '../simulation/error-analysis-coordinator';

// ──────────────────────────────────────────────────────────────────────────
// EventRelay — declarative event forwarding from Node EventEmitter sources
// to the Electron renderer via webContents.send().
//
// Deep module: small interface (register / registerMany / destroy),
// rich implementation (isDestroyed guard, payload transform, listener
// lifecycle management).
//
// Replaces the 110-line imperative registerEventForwarding() function.
// Adding a new event = one line in the mappings table below.
// ──────────────────────────────────────────────────────────────────────────

/** A single event forwarding rule: source event → IPC channel. */
export type EventMapping = {
  /** The EventEmitter to listen on. */
  source: EventEmitter;
  /** The event name on the source. */
  event: string;
  /** The IPC channel to forward to the renderer. */
  channel: string;
  /** Optional transform applied to the event payload before forwarding. */
  transform?: (payload: unknown) => unknown;
};

/**
 * Declarative event relay.
 *
 * Forwards events from Node EventEmitter sources to the renderer via
 * `win.webContents.send()`. Each mapping is a declarative
 * `{ source, event, channel, transform? }` rule — no imperative wiring.
 *
 * Guards against destroyed windows and cleans up all listeners on `destroy()`.
 */
export class EventRelay {
  private readonly listeners: Array<{
    source: EventEmitter;
    event: string;
    handler: (...args: unknown[]) => void;
  }> = [];

  constructor(private readonly win: BrowserWindow) {}

  /** Register a single event mapping. */
  register(mapping: EventMapping): this {
    const handler = (...args: unknown[]) => {
      if (this.win.isDestroyed()) return;
      const payload = args.length <= 1 ? args[0] : args;
      const ipcPayload = mapping.transform ? mapping.transform(payload) : payload;
      this.win.webContents.send(mapping.channel, ipcPayload);
    };
    mapping.source.on(mapping.event, handler);
    this.listeners.push({ source: mapping.source, event: mapping.event, handler });
    return this;
  }

  /** Register multiple event mappings at once. */
  registerMany(mappings: readonly EventMapping[]): this {
    for (const m of mappings) this.register(m);
    return this;
  }

  /** Remove all registered listeners from their sources. */
  destroy(): void {
    for (const { source, event, handler } of this.listeners) {
      source.removeListener(event, handler);
    }
    this.listeners.length = 0;
  }
}

// ── Helper factories for common transform patterns ──────────────────────

/** Wrap a record with a type tag: `(record) => { type, record }` */
function withTypeTag(type: string): (record: unknown) => { type: string; record: unknown } {
  return (record: unknown) => ({ type, record });
}

/** Spread event data with a type tag: `(data) => { type, ...data }` */
function withSpreadType(type: string): (data: unknown) => Record<string, unknown> {
  return (data: unknown) => ({ type, ...(data as Record<string, unknown>) });
}

// ── Declarative event mapping table ─────────────────────────────────────
//
// Every event forwarded to the renderer is declared here as one line.
// To add a new event: add one entry to this array. No other file needs
// to change (except the preload/renderer if a new IPC channel is needed).

const eventMappings: EventMapping[] = [
  // projectManager → direct forward (same channel name)
  { source: projectManager, event: 'filetree:update', channel: 'filetree:update' },
  { source: projectManager, event: 'project:opened', channel: 'project:opened' },
  { source: projectManager, event: 'project:closed', channel: 'project:closed' },

  // sessionManager → channel rename (sessionEvent → session:event)
  { source: sessionManager, event: 'sessionEvent', channel: 'session:event' },

  // simulationRegistry → wrap with type tag
  { source: simulationRegistry, event: 'run:started', channel: 'simulation:event', transform: withTypeTag('started') },
  { source: simulationRegistry, event: 'run:statusChanged', channel: 'simulation:event', transform: withTypeTag('statusChanged') },
  { source: simulationRegistry, event: 'run:completed', channel: 'simulation:event', transform: withTypeTag('completed') },
  { source: simulationRegistry, event: 'run:aborted', channel: 'simulation:event', transform: withTypeTag('aborted') },

  // simTerminalLinker → same simulation:event channel
  { source: simTerminalLinker, event: 'run:started', channel: 'simulation:event', transform: withTypeTag('started') },
  { source: simTerminalLinker, event: 'run:completed', channel: 'simulation:event', transform: withTypeTag('completed') },
  { source: simTerminalLinker, event: 'run:aborted', channel: 'simulation:event', transform: withTypeTag('aborted') },

  // terminalManager → direct forward
  { source: terminalManager, event: 'data', channel: 'terminal:data' },
  { source: terminalManager, event: 'exit', channel: 'terminal:exit' },

  // errorAnalysisCoordinator → spread data with type tag
  { source: errorAnalysisCoordinator, event: 'errorAnalysis:started', channel: 'errorAnalysis:event', transform: withSpreadType('started') },
  { source: errorAnalysisCoordinator, event: 'errorAnalysis:retrying', channel: 'errorAnalysis:event', transform: withSpreadType('retrying') },
  { source: errorAnalysisCoordinator, event: 'errorAnalysis:stopped', channel: 'errorAnalysis:event', transform: withSpreadType('stopped') },
  { source: errorAnalysisCoordinator, event: 'errorAnalysis:failed', channel: 'errorAnalysis:event', transform: withSpreadType('failed') },
  { source: errorAnalysisCoordinator, event: 'errorAnalysis:statusChanged', channel: 'errorAnalysis:event', transform: withSpreadType('statusChanged') },
];

/**
 * Create an EventRelay pre-wired with all standard event mappings.
 *
 * The relay forwards events from 6 subsystem EventEmitters to the renderer.
 * Call `relay.destroy()` when the window is closed or recreated to clean
 * up all listeners.
 */
export function createEventRelay(win: BrowserWindow): EventRelay {
  return new EventRelay(win).registerMany(eventMappings);
}
