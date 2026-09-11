import { describe, it, expect } from 'vitest';
import { selectKeepAliveTerminalTabIds } from '@renderer/components/terminal/TerminalKeepAliveLayer';
import type { TerminalLocation } from '@renderer/stores/terminal';

type Tab = {
  id: string;
  terminalId: string | null;
  lastActivatedAt: number;
  location: TerminalLocation;
};

const tab = (
  id: string,
  at: number,
  terminalId: string | null = `pty-${id}`,
  location: TerminalLocation = 'center',
): Tab => ({ id, terminalId, lastActivatedAt: at, location });

describe('selectKeepAliveTerminalTabIds', () => {
  it('keeps every terminal when under the cap, newest first', () => {
    const kept = selectKeepAliveTerminalTabIds(
      [tab('a', 1), tab('b', 3), tab('c', 2)],
      'b',
      'center',
    );
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
    const kept = selectKeepAliveTerminalTabIds(tabs, 'h', 'center');
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
    const kept = selectKeepAliveTerminalTabIds(tabs, 'stale', 'center');
    expect(kept.length).toBe(6);
    // 'stale' 虽是 LRU 但正在查看，必须保留；挤掉的是次旧的 'f'
    expect(new Set(kept).has('stale')).toBe(true);
    expect(new Set(kept).has('f')).toBe(false);
  });

  it('ignores tabs still creating a session (terminalId null)', () => {
    const kept = selectKeepAliveTerminalTabIds(
      [tab('creating', 99, null), tab('ready', 1)],
      null,
      'center',
    );
    expect(kept).toEqual(['ready']);
  });

  it('only selects terminals of the given location (center layer excludes bottom tabs)', () => {
    const tabs = [
      tab('c1', 5),
      tab('c2', 4),
      tab('b1', 9, 'pty-b1', 'bottom'),
      tab('b2', 8, 'pty-b2', 'bottom'),
    ];
    expect(selectKeepAliveTerminalTabIds(tabs, null, 'center')).toEqual(['c1', 'c2']);
    expect(selectKeepAliveTerminalTabIds(tabs, null, 'bottom')).toEqual(['b1', 'b2']);
  });

  it('keeps the active bottom terminal in the bottom layer even if a center tab is newer', () => {
    const tabs = [
      tab('c-new', 10),
      tab('b-stale', 1, 'pty-b-stale', 'bottom'),
    ];
    // 底部层激活 b-stale：中栏层不得因为 lastActivatedAt 较新把 bottom 终端挤掉
    expect(selectKeepAliveTerminalTabIds(tabs, 'b-stale', 'bottom')).toEqual(['b-stale']);
    // 中栏层只看自己的终端，bottom 终端不参选
    expect(selectKeepAliveTerminalTabIds(tabs, null, 'center')).toEqual(['c-new']);
  });

  it('returns empty when the layer has no terminals of its location', () => {
    expect(selectKeepAliveTerminalTabIds(
      [tab('b1', 5, 'pty-b1', 'bottom')],
      null,
      'center',
    )).toEqual([]);
  });
});
