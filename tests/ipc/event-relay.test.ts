import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { EventEmitter } from 'node:events';
import { EventRelay, type EventMapping } from '../../src/main/ipc/event-relay';

// ── Mock BrowserWindow ──────────────────────────────────────────────────
// The relay only uses win.isDestroyed() and win.webContents.send().
// We mock just those to keep the test focused on relay behavior.

type MockWin = {
  isDestroyed: () => boolean;
  webContents: { send: ReturnType<typeof vi.fn> };
};

function createMockWin(): MockWin {
  return {
    isDestroyed: () => false,
    webContents: { send: vi.fn() },
  };
}

describe('EventRelay', () => {
  let source: EventEmitter;
  let win: MockWin;

  beforeEach(() => {
    source = new EventEmitter();
    win = createMockWin();
  });

  afterEach(() => {
    source.removeAllListeners();
  });

  // ── Core forwarding ───────────────────────────────────────────────────

  it('forwards events from source to renderer via webContents.send', () => {
    const relay = new EventRelay(win as never);
    relay.register({ source, event: 'test:event', channel: 'test:event' });

    source.emit('test:event', { hello: 'world' });

    expect(win.webContents.send).toHaveBeenCalledWith('test:event', { hello: 'world' });
  });

  it('forwards to a different channel name than the source event', () => {
    const relay = new EventRelay(win as never);
    relay.register({ source, event: 'sessionEvent', channel: 'session:event' });

    source.emit('sessionEvent', { sessionId: 's1', event: { type: 'msg' } });

    expect(win.webContents.send).toHaveBeenCalledWith('session:event', {
      sessionId: 's1',
      event: { type: 'msg' },
    });
  });

  // ── Transform ─────────────────────────────────────────────────────────

  it('applies transform to payload before forwarding', () => {
    const relay = new EventRelay(win as never);
    relay.register({
      source,
      event: 'run:started',
      channel: 'simulation:event',
      transform: (record) => ({ type: 'started', record }),
    });

    source.emit('run:started', { id: 'run1', status: 'running' });

    expect(win.webContents.send).toHaveBeenCalledWith('simulation:event', {
      type: 'started',
      record: { id: 'run1', status: 'running' },
    });
  });

  it('supports spread-style transform (errorAnalysis pattern)', () => {
    const relay = new EventRelay(win as never);
    relay.register({
      source,
      event: 'errorAnalysis:started',
      channel: 'errorAnalysis:event',
      transform: (data) => ({ type: 'started', ...(data as Record<string, unknown>) }),
    });

    source.emit('errorAnalysis:started', { sessionId: 's1', count: 3 });

    expect(win.webContents.send).toHaveBeenCalledWith('errorAnalysis:event', {
      type: 'started',
      sessionId: 's1',
      count: 3,
    });
  });

  it('forwards payload as-is when no transform is specified', () => {
    const relay = new EventRelay(win as never);
    relay.register({ source, event: 'filetree:update', channel: 'filetree:update' });

    const payload = { path: '/src', action: 'added' };
    source.emit('filetree:update', payload);

    expect(win.webContents.send).toHaveBeenCalledWith('filetree:update', payload);
  });

  // ── isDestroyed guard ─────────────────────────────────────────────────

  it('does not send when window is destroyed', () => {
    win.isDestroyed = () => true;
    const relay = new EventRelay(win as never);
    relay.register({ source, event: 'test', channel: 'test' });

    source.emit('test', 'data');

    expect(win.webContents.send).not.toHaveBeenCalled();
  });

  // ── registerMany ──────────────────────────────────────────────────────

  it('registers multiple mappings at once', () => {
    const relay = new EventRelay(win as never);
    const mappings: EventMapping[] = [
      { source, event: 'event:a', channel: 'channel:a' },
      { source, event: 'event:b', channel: 'channel:b', transform: (d) => ({ wrapped: d }) },
    ];
    relay.registerMany(mappings);

    source.emit('event:a', 1);
    source.emit('event:b', 2);

    expect(win.webContents.send).toHaveBeenCalledWith('channel:a', 1);
    expect(win.webContents.send).toHaveBeenCalledWith('channel:b', { wrapped: 2 });
  });

  // ── Multiple sources ──────────────────────────────────────────────────

  it('handles multiple event sources independently', () => {
    const source2 = new EventEmitter();
    const relay = new EventRelay(win as never);
    relay.register({ source, event: 'a', channel: 'ch-a' });
    relay.register({ source: source2, event: 'b', channel: 'ch-b' });

    source.emit('a', 'from-a');
    source2.emit('b', 'from-b');

    expect(win.webContents.send).toHaveBeenCalledWith('ch-a', 'from-a');
    expect(win.webContents.send).toHaveBeenCalledWith('ch-b', 'from-b');

    source2.removeAllListeners();
  });

  // ── destroy ───────────────────────────────────────────────────────────

  it('removes all listeners from sources on destroy', () => {
    const relay = new EventRelay(win as never);
    relay.register({ source, event: 'a', channel: 'ch-a' });
    relay.register({ source, event: 'b', channel: 'ch-b' });

    expect(source.listenerCount('a')).toBe(1);
    expect(source.listenerCount('b')).toBe(1);

    relay.destroy();

    expect(source.listenerCount('a')).toBe(0);
    expect(source.listenerCount('b')).toBe(0);
  });

  it('stops forwarding after destroy', () => {
    const relay = new EventRelay(win as never);
    relay.register({ source, event: 'test', channel: 'test' });

    relay.destroy();
    source.emit('test', 'data');

    expect(win.webContents.send).not.toHaveBeenCalled();
  });

  it('destroy is idempotent', () => {
    const relay = new EventRelay(win as never);
    relay.register({ source, event: 'test', channel: 'test' });

    relay.destroy();
    relay.destroy(); // should not throw

    expect(source.listenerCount('test')).toBe(0);
  });

  // ── Chaining ──────────────────────────────────────────────────────────

  it('register returns this for chaining', () => {
    const relay = new EventRelay(win as never);
    const result = relay.register({ source, event: 'a', channel: 'a' });

    expect(result).toBe(relay);
  });

  it('registerMany returns this for chaining', () => {
    const relay = new EventRelay(win as never);
    const result = relay.registerMany([{ source, event: 'a', channel: 'a' }]);

    expect(result).toBe(relay);
  });
});
