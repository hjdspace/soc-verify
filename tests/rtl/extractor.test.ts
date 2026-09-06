/**
 * extractor.ts — write_json 提炼器测试（golden fixture = S0 真实 yosys 产物）。
 *
 * fixture：tests/rtl/fixtures/spike_netlist_keep.json（read_slang --keep-hierarchy，
 * uniquified 命名 / generate 展开 / 实例互连齐全的合成 SoC spike 设计）。
 * 断言基线：9 实例、3 定义、soc_subsys 内 IP 互连 i2i、spike_top top2i 边。
 * issue 03：instCount 子树实例数统计（spec story 5 树节点模块统计）。
 */

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { extractDesign, extractEdges, extractTopUnits, normalizeSrc, splitUniquified } from '../../src/main/rtl/extractor';
import type { WriteJsonDoc } from '../../src/main/rtl/extractor';

const here = dirname(fileURLToPath(import.meta.url));
const doc = JSON.parse(readFileSync(join(here, 'fixtures/spike_netlist_keep.json'), 'utf-8')) as WriteJsonDoc;

describe('splitUniquified', () => {
  it('首个 $ 为分隔符：defName 与完整实例路径', () => {
    expect(splitUniquified('spike_ip$spike_top.u_subsys1.gen_ip[3].u_ip')).toEqual([
      'spike_ip',
      'spike_top.u_subsys1.gen_ip[3].u_ip',
    ]);
  });

  it('无 $ 为顶层 plain 模块', () => {
    expect(splitUniquified('spike_top')).toEqual(['spike_top', null]);
  });
});

describe('normalizeSrc（write_json src 按 yosys cwd 归一化）', () => {
  it('优先匹配 filelist 中的真实源文件，修复被错误上溯到盘符根的 Windows 路径', () => {
    const cwd = 'D:\\AI\\rtl-spike\\.socverify\\design\\work';
    const source = 'D:\\AI\\rtl-spike\\rtl\\spike_top.sv';
    expect(normalizeSrc('..\\..\\..\\..\\rtl-spike\\rtl\\spike_top.sv:3.8', cwd, [source])).toBe(
      `${source}:3.8`,
    );
    expect(normalizeSrc('D:\\rtl-spike\\rtl\\spike_top.sv:3.8', cwd, [source])).toBe(`${source}:3.8`);
  });

  it('相对路径（含 .. 上溯与行列后缀）按 yosys cwd 解析为绝对路径，后缀保留', () => {
    // 用户实测场景：yosys cwd = work 目录，src 上溯 4 级越过项目根
    const cwd = 'D:\\proj\\.socverify\\design\\work';
    expect(normalizeSrc('..\\..\\..\\..\\rtl-spike\\rtl\\a.sv:3.8', cwd)).toBe(
      `${resolve(cwd, '..\\..\\..\\..\\rtl-spike\\rtl\\a.sv')}:3.8`,
    );
  });

  it('正斜杠相对路径同样解析', () => {
    expect(normalizeSrc('rtl/sub.sv:10.8', '/work/dir')).toBe(`${resolve('/work/dir', 'rtl/sub.sv')}:10.8`);
  });

  it('绝对路径原样返回（Windows 盘符 / POSIX 根）', () => {
    expect(normalizeSrc('D:\\x\\a.sv:12.3-12.9', 'D:\\work')).toBe('D:\\x\\a.sv:12.3-12.9');
    expect(normalizeSrc('/abs/a.sv', '/work')).toBe('/abs/a.sv');
  });

  it('无行列后缀的相对路径只解析路径部分；null 透传', () => {
    expect(normalizeSrc('rtl/a.sv', '/work')).toBe(resolve('/work', 'rtl/a.sv'));
    expect(normalizeSrc(null, '/work')).toBeNull();
  });
});

describe('extractTopUnits（detectTops 顶层候选过滤）', () => {
  it('只留未被实例化的用户模块：uniquified 实例模块与 $ 内部模块被排除', () => {
    // fixture 含 9 个模块：spike_top + 8 个 uniquified 实例模块（soc_subsys$... / spike_ip$...）
    expect(extractTopUnits(doc)).toEqual(['spike_top']);
  });

  it('多个独立 root 时全部返回；被实例化的 uniquified 模块排除', () => {
    // 真实结构：root top_a 实例化 sub（yosys 产出 sub$top_a.u_sub，被 top_a 的 cell 引用）
    const multiRoot: WriteJsonDoc = {
      modules: {
        top_a: { cells: { u_sub: { type: 'sub$top_a.u_sub' } } },
        top_b: { cells: {} },
        'sub$top_a.u_sub': { cells: {} },
      },
    };
    expect(extractTopUnits(multiRoot)).toEqual(['top_a', 'top_b']);
  });

  it('空文档 / modules 缺失返回空列表', () => {
    expect(extractTopUnits({ modules: {} })).toEqual([]);
    expect(extractTopUnits({ modules: undefined } as unknown as WriteJsonDoc)).toEqual([]);
  });
});

describe('extractDesign（golden fixture）', () => {
  const YOSYS_CWD = resolve(here, 'fake-yosys-cwd');
  const design = extractDesign(doc, 'spike_top', YOSYS_CWD);

  it('实例树：9 节点，root = spike_top（parent null / depth 0）', () => {
    expect(design.insts).toHaveLength(9);
    const root = design.insts[0];
    expect(root.path).toBe('spike_top');
    expect(root.parent).toBeNull();
    expect(root.depth).toBe(0);
    expect(root.module).toBe('spike_top');
  });

  it('src 归一化：fixture 相对 src 按 yosys cwd 解析为绝对路径（story 32 源码跳转）', () => {
    const root = design.insts.find((i) => i.path === 'spike_top');
    expect(root?.src).toBe(`${resolve(YOSYS_CWD, 'rtl\\spike_top.sv')}:3.8`);
    const ip = design.insts.find((i) => i.path === 'spike_top.u_subsys1.gen_ip[3].u_ip');
    expect(ip?.src).toBe(`${resolve(YOSYS_CWD, 'rtl\\ip\\spike_ip.sv')}:4.8`);
    const def = design.defs.find((d) => d.name === 'soc_subsys');
    expect(def?.src).toBe(`${resolve(YOSYS_CWD, 'rtl\\soc_subsys.sv')}:2.8`);
  });

  it('generate 展开正确：gen_ip[N].u_ip 实例名与父子路径', () => {
    const ip = design.insts.find((i) => i.path === 'spike_top.u_subsys1.gen_ip[3].u_ip');
    expect(ip).toBeDefined();
    expect(ip?.module).toBe('spike_ip');
    expect(ip?.name).toBe('gen_ip[3].u_ip');
    expect(ip?.parent).toBe('spike_top.u_subsys1');
    expect(ip?.depth).toBe(2);
    // u_subsys1 generate N_IP=4（4 个 IP），u_subsys0 N_IP=2
    const subsys1 = design.insts.filter((i) => i.parent === 'spike_top.u_subsys1');
    const subsys0 = design.insts.filter((i) => i.parent === 'spike_top.u_subsys0');
    expect(subsys1).toHaveLength(4);
    expect(subsys0).toHaveLength(2);
  });

  it('instCount 子树实例数（含自身）：leaf=1、subsys=自身+IP、root=全设计 9（issue 03）', () => {
    const root = design.insts.find((i) => i.path === 'spike_top');
    const subsys0 = design.insts.find((i) => i.path === 'spike_top.u_subsys0');
    const subsys1 = design.insts.find((i) => i.path === 'spike_top.u_subsys1');
    const ip = design.insts.find((i) => i.path === 'spike_top.u_subsys1.gen_ip[3].u_ip');
    expect(root?.instCount).toBe(9);
    expect(subsys0?.instCount).toBe(3);
    expect(subsys1?.instCount).toBe(5);
    expect(ip?.instCount).toBe(1);
  });

  it('定义表：3 个 def（spike_top/soc_subsys/spike_ip），端口含方向与位宽', () => {
    expect(design.defs.map((d) => d.name).sort()).toEqual(['soc_subsys', 'spike_ip', 'spike_top']);
    const soc = design.defs.find((d) => d.name === 'soc_subsys');
    const haddr = soc?.ports.find((p) => p.name === 'h_haddr');
    expect(haddr).toEqual({ name: 'h_haddr', direction: 'input', width: 12 });

    const top = design.defs.find((d) => d.name === 'spike_top');
    const awid = top?.ports.find((p) => p.name === 'axi0_awid');
    expect(awid).toEqual({ name: 'axi0_awid', direction: 'input', width: 4 });

    const ip = design.defs.find((d) => d.name === 'spike_ip');
    const irq = ip?.ports.find((p) => p.name === 'irq_o');
    expect(irq).toEqual({ name: 'irq_o', direction: 'output', width: 4 });
  });

  it('实例互连 i2i 边：soc_subsys 内 h_haddr 网连接两个 IP 的 p_paddr（width 12）', () => {
    const edge = design.edges.find((e) => e.module === 'soc_subsys' && e.net === 'h_haddr');
    expect(edge).toBeDefined();
    expect(edge?.kind).toBe('i2i');
    expect(edge?.width).toBe(12);
    expect(edge?.cells).toContainEqual({ inst: 'gen_ip[0].u_ip', port: 'p_paddr' });
    expect(edge?.cells).toContainEqual({ inst: 'gen_ip[1].u_ip', port: 'p_paddr' });
  });

  it('top2i 边：spike_top 的 apb0_paddr 端口接入唯一实例（width 12）', () => {
    const edge = design.edges.find((e) => e.module === 'spike_top' && e.net === 'apb0_paddr');
    expect(edge).toBeDefined();
    expect(edge?.kind).toBe('top2i');
    expect(edge?.width).toBe(12);
    expect(edge?.topPorts).toEqual(['apb0_paddr']);
    expect(edge?.cells).toEqual([{ inst: 'u_subsys0', port: 'h_haddr' }]);
  });

  it('叶子定义无内部互连边（spike_ip 无实例 cells）', () => {
    expect(design.edges.filter((e) => e.module === 'spike_ip')).toHaveLength(0);
  });
});

describe('extractDesign 边界', () => {
  it('top 不在文档中时抛错', () => {
    expect(() => extractDesign(doc, 'no_such_top', '/work')).toThrow(/no_such_top/);
  });

  it('黑盒实例：cell type 不在文档中仍入树（module 为类型名），yosys $ 模块跳过', () => {
    const mini: WriteJsonDoc = {
      modules: {
        top: {
          ports: { clk: { direction: 'input', bits: [1] } },
          cells: {
            u_bb: { type: 'unknown_bb', connections: { a: [1] } },
            u_inner: { type: 'inner$top.u_inner', connections: {} },
            u_gate: { type: '$and', connections: {} },
          },
        },
        'inner$top.u_inner': { ports: {}, cells: {} },
        '$LATCH': { ports: {} },
      },
    };
    const design = extractDesign(mini, 'top', '/work');
    // root 实例（top 本身）也在树中，与 golden fixture 语义一致
    expect(design.insts.map((i) => i.path).sort()).toEqual(['top', 'top.u_bb', 'top.u_inner']);
    expect(design.insts.find((i) => i.path === 'top.u_bb')?.module).toBe('unknown_bb');
    // defs 不含 $ 内部模块
    expect(design.defs.map((d) => d.name).sort()).toEqual(['inner', 'top']);
  });

  it('extractEdges 空设计安全', () => {
    expect(extractEdges({ modules: {} })).toEqual([]);
  });

  it('instCount：黑盒 cell instCount=1，黑盒子树不上抛计数（issue 03）', () => {
    const mini: WriteJsonDoc = {
      modules: {
        top: {
          cells: {
            u_bb: { type: 'unknown_bb' },
            u_inner: { type: 'inner$top.u_inner' },
          },
        },
        'inner$top.u_inner': { cells: {} },
      },
    };
    const design = extractDesign(mini, 'top', '/work');
    expect(design.insts.find((i) => i.path === 'top.u_bb')?.instCount).toBe(1);
    expect(design.insts.find((i) => i.path === 'top.u_inner')?.instCount).toBe(1);
    expect(design.insts.find((i) => i.path === 'top')?.instCount).toBe(3);
  });
});
