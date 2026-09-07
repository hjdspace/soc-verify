import { describe, it, expect } from 'vitest';
import { selectKeepAliveTerminalTabIds } from '@renderer/components/terminal/TerminalKeepAliveLayer';

type Tab = { id: string; terminalId: string | null; lastActivatedAt: number };

const tab = (id: string, at: number, terminalId: string | null = `pty-${id}`): Tab => ({
  id,
  terminalId,
  lastActivatedAt: at,
});

describe('selectKeepAliveTerminalTabIds', () => {
  it('keeps every terminal when under the cap, newest first', () => {
    const kept = selectKeepAliveTerminalTabIds([tab('a', 1), tab('b', 3), tab('c', 2)], 'b');
    expect(kept.length).toBe(3);
    // 活动终端排最前（可见），其余按最近使用排序
    expect(kept[0]).toBe('b');
  });

  it('evicts the least recently used terminal beyond the cap', () => {
    // 8 个终端（cap=6）：最久未用的 a、b 被淘汰，a 因 terminalId=null 本就不参选
    const tabs = [
      tab('a', 1),
      tab('b', 2),
      tab('c', 3),
      tab('d', 4),
      tab('e', 5),
      tab('f', 6),
      tab('g', 7),
      tab('h', 8),
    ];
    const kept = selectKeepAliveTerminalTabIds(tabs, 'h');
    expect(kept.length).toBe(6);
    const keptSet = new Set(kept);
    expect(keptSet.has('b')).toBe(false);
    expect(keptSet.has('c')).toBe(true);
    expect(keptSet.has('h')).toBe(true);
  });

  it('always keeps the active terminal even when it is the least recently used', () => {
    const tabs = [
      tab('a', 10),
      tab('b', 9),
      tab('c', 8),
      tab('d', 7),
      tab('e', 6),
      tab('f', 5),
      tab('stale', 1),
    ];
    const kept = selectKeepAliveTerminalTabIds(tabs, 'stale');
    expect(kept.length).toBe(6);
    // 'stale' 虽是 LRU 但正在查看，必须保留；挤掉的是次旧的 'f'
    expect(new Set(kept).has('stale')).toBe(true);
    expect(new Set(kept).has('f')).toBe(false);
  });

  it('ignores tabs still creating a session (terminalId null)', () => {
    const kept = selectKeepAliveTerminalTabIds(
      [tab('creating', 99, null), tab('ready', 1)],
      null,
    );
    expect(kept).toEqual(['ready']);
  });
});
