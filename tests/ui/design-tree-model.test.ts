/**
 * design-tree-model.ts — DesignTree 虚拟滚动的纯函数层（issue 03）。
 *
 * 覆盖：展开状态 → 扁平可见行（含加载占位）；yosys write_json src 属性解析
 * （文件 + 模块声明行号，story 32 源码跳转）；相对 src 路径按项目根解析。
 */

import { describe, it, expect } from 'vitest';
import { flattenVisibleTree, parseSrcLocation, resolveSrcPath } from '../../src/renderer/src/components/design/design-tree-model';
import type { DesignInstRow } from '../../src/main/rtl/types';

function inst(path: string, instCount = 1): DesignInstRow {
  const name = path.split('.').pop() ?? path;
  return {
    path,
    name,
    module: `mod_${name}`,
    parent: path.includes('.') ? path.slice(0, path.lastIndexOf('.')) : null,
    depth: path.split('.').length - 1,
    src: null,
    params: {},
    instCount,
  };
}

describe('flattenVisibleTree', () => {
  const root = inst('soc_top', 6);
  const ua = inst('soc_top.u_a', 3);
  const ub = inst('soc_top.u_b', 2);
  const leaf = inst('soc_top.u_a.g0', 1);
  const childrenMap = new Map([
    ['soc_top', [ua, ub]],
    ['soc_top.u_a', [leaf]],
    ['soc_top.u_b', []],
  ]);

  it('全部折叠：仅根节点一行', () => {
    const rows = flattenVisibleTree(root, new Set(), childrenMap);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ kind: 'node', level: 0, key: 'soc_top' });
  });

  it('展开链：先序扁平化 + 层级缩进', () => {
    const rows = flattenVisibleTree(root, new Set(['soc_top', 'soc_top.u_a']), childrenMap);
    expect(rows.map((r) => (r.kind === 'node' ? r.node.path : r.kind))).toEqual([
      'soc_top',
      'soc_top.u_a',
      'soc_top.u_a.g0',
      'soc_top.u_b',
    ]);
    expect(rows.map((r) => r.level)).toEqual([0, 1, 2, 1]);
  });

  it('展开但子实例未加载：节点后跟加载占位行', () => {
    const rows = flattenVisibleTree(root, new Set(['soc_top']), new Map());
    expect(rows).toHaveLength(2);
    expect(rows[1]).toMatchObject({ kind: 'loading', key: 'loading:soc_top', level: 1 });
  });

  it('空 children 数组（leaf 展开）不产生占位行', () => {
    const rows = flattenVisibleTree(ub, new Set(['soc_top.u_b']), childrenMap);
    expect(rows).toHaveLength(1);
  });
});

describe('parseSrcLocation（yosys write_json src 属性）', () => {
  it('相对路径 + 行.列 后缀', () => {
    expect(parseSrcLocation('rtl\\soc_subsys.sv:2.8')).toEqual({ path: 'rtl\\soc_subsys.sv', line: 2 });
  });

  it('行.列-行.列 区间后缀取起始行', () => {
    expect(parseSrcLocation('rtl/a.sv:62.25-62.55')).toEqual({ path: 'rtl/a.sv', line: 62 });
  });

  it('Windows 盘符绝对路径不被盘符冒号截断', () => {
    expect(parseSrcLocation('D:\\proj\\rtl\\a.sv:12.3')).toEqual({ path: 'D:\\proj\\rtl\\a.sv', line: 12 });
  });

  it('无行号后缀：line 为 null，路径原样', () => {
    expect(parseSrcLocation('rtl/a.sv')).toEqual({ path: 'rtl/a.sv', line: null });
  });
});

describe('resolveSrcPath（相对 src 按项目根解析）', () => {
  it('相对路径 + Windows 项目根：归一为反斜杠拼接', () => {
    expect(resolveSrcPath('rtl/soc_top.sv', 'D:\\proj')).toBe('D:\\proj\\rtl\\soc_top.sv');
  });

  it('相对路径 + POSIX 项目根', () => {
    expect(resolveSrcPath('rtl/soc_top.sv', '/home/u/proj')).toBe('/home/u/proj/rtl/soc_top.sv');
  });

  it('已是绝对路径：原样返回', () => {
    expect(resolveSrcPath('D:\\other\\a.sv', 'D:\\proj')).toBe('D:\\other\\a.sv');
    expect(resolveSrcPath('/abs/a.sv', '/proj')).toBe('/abs/a.sv');
  });

  it('无项目根：原样返回', () => {
    expect(resolveSrcPath('rtl/a.sv', null)).toBe('rtl/a.sv');
  });

  it('项目根尾部分隔符去重', () => {
    expect(resolveSrcPath('rtl/a.sv', 'D:\\proj\\')).toBe('D:\\proj\\rtl\\a.sv');
  });
});
