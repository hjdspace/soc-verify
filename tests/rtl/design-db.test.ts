/**
 * design-db.ts — 提炼模型 SQLite 持久化测试（内存库）。
 *
 * 覆盖：replaceAll 事务全量替换、实例树父子查询、定义表、连线表、
 * meta（top/lastError）持久化与清除。
 */

import { describe, it, expect, beforeEach } from 'vitest';
import {
  createMemoryDesignDatabase,
  getAllMeta,
  getChildrenInstances,
  getDef,
  getDefEdges,
  getLastError,
  getRootInstance,
  hasDesignData,
  replaceAll,
  setLastError,
  setMeta,
  getMeta,
  type DesignDatabase,
} from '../../src/main/rtl/design-db';
import type { ExtractedDesign } from '../../src/main/rtl/types';

let db: DesignDatabase;

const SAMPLE: ExtractedDesign = {
  top: 'spike_top',
  defs: [
    {
      name: 'spike_top',
      src: 'rtl/spike_top.sv:3.8',
      paramDefaults: {},
      ports: [
        { name: 'clk_i', direction: 'input', width: 1 },
        { name: 'axi0_awid', direction: 'input', width: 4 },
      ],
    },
    { name: 'spike_ip', src: null, paramDefaults: { N: 2 }, ports: [{ name: 'irq_o', direction: 'output', width: 4 }] },
  ],
  insts: [
    { path: 'spike_top', name: 'spike_top', module: 'spike_top', parent: null, depth: 0, src: 'rtl/spike_top.sv:3.8', params: {} },
    { path: 'spike_top.u0', name: 'u0', module: 'spike_ip', parent: 'spike_top', depth: 1, src: null, params: { N: 4 } },
    { path: 'spike_top.u1', name: 'u1', module: 'spike_ip', parent: 'spike_top', depth: 1, src: null, params: {} },
  ],
  edges: [
    {
      module: 'spike_top',
      net: 'axi0_awid',
      kind: 'top2i',
      width: 4,
      cells: [{ inst: 'u0', port: 's_axil_awaddr' }],
      topPorts: ['axi0_awid'],
    },
    {
      module: 'spike_top',
      net: 'irq_bus',
      kind: 'i2i',
      width: 4,
      cells: [
        { inst: 'u0', port: 'irq_o' },
        { inst: 'u1', port: 'irq_o' },
      ],
      topPorts: [],
    },
  ],
};

beforeEach(() => {
  db = createMemoryDesignDatabase();
});

describe('replaceAll / hasDesignData', () => {
  it('写入后 hasData 为真，meta 全量记录', () => {
    expect(hasDesignData(db)).toBe(false);
    replaceAll(db, SAMPLE, { top: 'spike_top', lastElaboratedAt: '2026-09-04T00:00:00Z' });
    expect(hasDesignData(db)).toBe(true);
    expect(getMeta(db, 'top')).toBe('spike_top');
    expect(getMeta(db, 'lastElaboratedAt')).toBe('2026-09-04T00:00:00Z');
  });

  it('再次 replaceAll 全量替换（无残留旧实例/旧 meta）', () => {
    replaceAll(db, SAMPLE, { top: 'spike_top' });
    const shrunk: ExtractedDesign = { ...SAMPLE, insts: SAMPLE.insts.slice(0, 1), edges: [] };
    replaceAll(db, shrunk, { top: 'spike_top' });
    expect(hasDesignData(db)).toBe(true);
    expect(getChildrenInstances(db, 'spike_top')).toHaveLength(0);
    expect(getDefEdges(db, 'spike_top')).toHaveLength(0);
    expect(getMeta(db, 'lastElaboratedAt')).toBeNull();
  });
});

describe('实例树查询', () => {
  beforeEach(() => {
    replaceAll(db, SAMPLE, { top: 'spike_top' });
  });

  it('getRootInstance：parent 为 null 的顶层实例', () => {
    const root = getRootInstance(db);
    expect(root?.path).toBe('spike_top');
    expect(root?.params).toEqual({});
  });

  it('getChildrenInstances：按名排序的直接子实例，params 反序列化', () => {
    const children = getChildrenInstances(db, 'spike_top');
    expect(children.map((c) => c.path)).toEqual(['spike_top.u0', 'spike_top.u1']);
    expect(children[0].params).toEqual({ N: 4 });
  });
});

describe('定义与连线查询', () => {
  beforeEach(() => {
    replaceAll(db, SAMPLE, { top: 'spike_top' });
  });

  it('getDef：端口与参数默认值', () => {
    const def = getDef(db, 'spike_ip');
    expect(def?.paramDefaults).toEqual({ N: 2 });
    expect(def?.ports).toEqual([{ name: 'irq_o', direction: 'output', width: 4 }]);
    expect(getDef(db, 'nope')).toBeNull();
  });

  it('getDefEdges：i2i / top2i 与端点', () => {
    const edges = getDefEdges(db, 'spike_top');
    expect(edges).toHaveLength(2);
    const top2i = edges.find((e) => e.kind === 'top2i');
    expect(top2i?.net).toBe('axi0_awid');
    expect(top2i?.cells).toEqual([{ inst: 'u0', port: 's_axil_awaddr' }]);
    expect(top2i?.topPorts).toEqual(['axi0_awid']);
    const i2i = edges.find((e) => e.kind === 'i2i');
    expect(i2i?.cells).toHaveLength(2);
  });
});

describe('meta / lastError', () => {
  it('setLastError 持久化结构化错误（诊断含文件+行号），null 清除', () => {
    setLastError(db, {
      message: 'elaboration 失败',
      diagnostics: [{ file: 'rtl/top.sv', line: 10, column: 5, severity: 'error', message: 'unknown port' }],
      logTail: 'ERROR: read_slang failed',
    });
    const err = getLastError(db);
    expect(err?.message).toBe('elaboration 失败');
    expect(err?.diagnostics[0]).toMatchObject({ file: 'rtl/top.sv', line: 10 });
    expect(err?.logTail).toBe('ERROR: read_slang failed');

    setLastError(db, null);
    expect(getLastError(db)).toBeNull();
    expect(getMeta(db, 'lastError')).toBeNull();
    expect(Object.keys(getAllMeta(db))).not.toContain('lastError');
  });

  it('损坏的 lastError JSON 返回 null 而非抛错', () => {
    setMeta(db, 'lastError', '{not-json');
    expect(getLastError(db)).toBeNull();
  });
});
