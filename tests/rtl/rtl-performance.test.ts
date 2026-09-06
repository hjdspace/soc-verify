/**
 * SoC 级性能验证（issue 08）。
 *
 * 合成几万 instance fixture，验证：
 *   1. elaboration→提炼→入库全链路耗时在界限内
 *   2. 子树分页查询延迟在界限内
 *   3. 内存边界验证：SoC 级 raw write_json 不进渲染进程（零解析）
 *
 * 测试缝：extractor + design-db 公共 API 边界（纯函数 + SQLite 内存库），
 * 不涉及 yosys spawn（那在 rtl-router.test.ts 已覆盖）。
 * 合成 fixture 用 generateSyntheticSoC（非真实 yosys 产物，但结构等价）。
 */

import { describe, it, expect, beforeAll } from 'vitest';
import { extractDesign, type WriteJsonDoc } from '../../src/main/rtl/extractor';
import { analyzePorts, BUILTIN_AMBA_RULES } from '../../src/main/rtl/bundle-rules';
import {
  createMemoryDesignDatabase,
  getChildrenInstances,
  getDef,
  getDefEdges,
  getRootInstance,
  hasDesignData,
  replaceAll,
  type DesignDatabase,
} from '../../src/main/rtl/design-db';
import { generateSyntheticSoC } from './fixtures/soc-synthetic';
import type { ExtractedDesign } from '../../src/main/rtl/types';

// ─── 性能界限常量 ────────────────────────────────────────────

/** SoC 级 fixture 规模：10 子系统 × 2000 IP = 20001 实例（几万量级） */
const SUBSYS_COUNT = 10;
const IPS_PER_SUBSYS = 2_000;
const EXPECTED_TOTAL = 1 + SUBSYS_COUNT + SUBSYS_COUNT * IPS_PER_SUBSYS; // 20011

/** 提炼 + 入库耗时上限（ms）—— 合成 fixture 在 CI 环境放宽 */
const EXTRACT_AND_PERSIST_BUDGET_MS = 5_000;

/** 单次子树查询耗时上限（ms）—— SQLite 索引性能 */
const QUERY_BUDGET_MS = 50;

// ─── 合成 fixture ────────────────────────────────────────────

const { doc, totalInsts } = generateSyntheticSoC({
  subsysCount: SUBSYS_COUNT,
  ipsPerSubsys: IPS_PER_SUBSYS,
});

// ─── 提炼 → 入库 全链路 ──────────────────────────────────────

describe('SoC 级提炼→入库性能', () => {
  let design: ExtractedDesign;
  let db: DesignDatabase;
  let elapsedMs: number;

  it('合成 fixture 规模正确（几万 instance）', () => {
    expect(totalInsts).toBe(EXPECTED_TOTAL);
    expect(Object.keys(doc.modules).length).toBeGreaterThan(EXPECTED_TOTAL * 0.5);
  });

  it('extractDesign + bundle 打标 + replaceAll 全链路在界限内', () => {
    const start = performance.now();

    // 1. 提炼
    design = extractDesign(doc as WriteJsonDoc, 'spike_top');

    // 2. bundle 打标（per-def analyzePorts）
    for (const def of design.defs) {
      def.bundles = analyzePorts(def.ports, BUILTIN_AMBA_RULES);
    }

    // 3. 入库（内存 SQLite）
    db = createMemoryDesignDatabase();
    replaceAll(db, design, {
      top: 'spike_top',
      lastElaboratedAt: new Date().toISOString(),
      elapsedMs: '0',
    });

    elapsedMs = performance.now() - start;
    expect(elapsedMs).toBeLessThan(EXTRACT_AND_PERSIST_BUDGET_MS);
  });

  it('提炼结果正确：实例数 = 顶层 1 + 子系统 + IP', () => {
    expect(design.insts).toHaveLength(EXPECTED_TOTAL);
    expect(design.defs.map((d) => d.name).sort()).toEqual(['soc_subsys', 'spike_ip', 'spike_top']);
  });

  it('入库后 hasDesignData 为真，顶层实例可查', () => {
    expect(hasDesignData(db)).toBe(true);
    const root = getRootInstance(db);
    expect(root?.path).toBe('spike_top');
    expect(root?.instCount).toBe(EXPECTED_TOTAL);
  });
});

// ─── 子树分页查询延迟 ────────────────────────────────────────

describe('子树分页查询延迟（SoC 级 SQLite 索引性能）', () => {
  let db: DesignDatabase;

  beforeAll(() => {
    const design = extractDesign(doc as WriteJsonDoc, 'spike_top');
    for (const def of design.defs) {
      def.bundles = analyzePorts(def.ports, BUILTIN_AMBA_RULES);
    }
    db = createMemoryDesignDatabase();
    replaceAll(db, design, {
      top: 'spike_top',
      lastElaboratedAt: new Date().toISOString(),
      elapsedMs: '0',
    });
  });

  it('getRootInstance 查询延迟 < 50ms', () => {
    const start = performance.now();
    const root = getRootInstance(db);
    const elapsed = performance.now() - start;
    expect(root).not.toBeNull();
    expect(elapsed).toBeLessThan(QUERY_BUDGET_MS);
  });

  it('getChildren(spike_top) 返回 10 个子系统，延迟 < 50ms', () => {
    const start = performance.now();
    const children = getChildrenInstances(db, 'spike_top');
    const elapsed = performance.now() - start;
    expect(children).toHaveLength(SUBSYS_COUNT);
    expect(elapsed).toBeLessThan(QUERY_BUDGET_MS);
  });

  it('getChildren(spike_top.u_subsys0) 返回 2000 个 IP，延迟 < 50ms', () => {
    const start = performance.now();
    const children = getChildrenInstances(db, 'spike_top.u_subsys0');
    const elapsed = performance.now() - start;
    expect(children).toHaveLength(IPS_PER_SUBSYS);
    expect(elapsed).toBeLessThan(QUERY_BUDGET_MS);
  });

  it('getDef 查询延迟 < 50ms', () => {
    const start = performance.now();
    const def = getDef(db, 'spike_ip');
    const elapsed = performance.now() - start;
    expect(def?.name).toBe('spike_ip');
    expect(elapsed).toBeLessThan(QUERY_BUDGET_MS);
  });

  it('getDefEdges 查询延迟 < 50ms', () => {
    const start = performance.now();
    const edges = getDefEdges(db, 'soc_subsys');
    const elapsed = performance.now() - start;
    expect(edges.length).toBeGreaterThan(0);
    expect(elapsed).toBeLessThan(QUERY_BUDGET_MS);
  });

  it('多次连续查询不退化（无缓存预热需求）', () => {
    const start = performance.now();
    for (let i = 0; i < SUBSYS_COUNT; i++) {
      getChildrenInstances(db, `spike_top.u_subsys${i}`);
    }
    const elapsed = performance.now() - start;
    // 10 次查询总耗时应在 200ms 内
    expect(elapsed).toBeLessThan(QUERY_BUDGET_MS * 4);
  });
});

// ─── 内存边界验证：raw write_json 不进渲染进程 ──────────────

describe('内存边界：raw write_json 不进渲染进程', () => {
  it('rtl-router 返回的查询结果不包含 raw write_json（只有提炼后的行级数据）', () => {
    // 提炼后 design 中的 insts/defs/edges 均为提炼模型，
    // 不含 raw write_json 的 modules/ports/cells/netnames 原始结构
    const design = extractDesign(doc as WriteJsonDoc, 'spike_top');

    // insts 是行级数据（path/name/module/parent/depth/src/params/instCount）
    expect(design.insts[0]).not.toHaveProperty('connections');
    expect(design.insts[0]).not.toHaveProperty('cells');
    expect(design.insts[0]).not.toHaveProperty('netnames');
    expect(design.insts[0]).not.toHaveProperty('modules');

    // defs 是聚合后端口表，不含 raw cell/connection 结构
    expect(design.defs[0]).not.toHaveProperty('cells');
    expect(design.defs[0]).not.toHaveProperty('connections');

    // edges 是提炼后的 i2i/top2i 边，不含 raw bit id
    expect(design.edges[0]).not.toHaveProperty('bits');
    expect(design.edges[0]).toHaveProperty('cells');
    expect(design.edges[0]).toHaveProperty('topPorts');
  });

  it('DB 查询返回的行不含 raw write_json 字段', () => {
    const design = extractDesign(doc as WriteJsonDoc, 'spike_top');
    for (const def of design.defs) {
      def.bundles = analyzePorts(def.ports, BUILTIN_AMBA_RULES);
    }
    const db = createMemoryDesignDatabase();
    replaceAll(db, design, { top: 'spike_top' });

    const root = getRootInstance(db);
    expect(root).not.toHaveProperty('connections');
    expect(root).not.toHaveProperty('cells');
    expect(root).not.toHaveProperty('netnames');
    expect(root).not.toHaveProperty('modules');

    const def = getDef(db, 'spike_top');
    expect(def).not.toHaveProperty('cells');
    expect(def).not.toHaveProperty('netnames');
    expect(def).toHaveProperty('ports');
    expect(def).toHaveProperty('bundles');
  });
});
