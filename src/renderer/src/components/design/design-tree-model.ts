/**
 * DesignTree 虚拟滚动的纯函数层（issue 03）。
 *
 * - flattenVisibleTree：展开状态 + 子实例缓存 → 扁平可见行
 *   （虚拟滚动的行源；子实例未加载时产出加载占位行）。
 * - parseSrcLocation：yosys write_json `src` 属性（`rtl\sub.sv:10.8` /
 *   `D:\x\a.sv:12.3-12.9`）→ 文件 + 模块声明行号（story 32 源码跳转）。
 * - resolveSrcPath：相对 src 路径按项目根解析为绝对路径（FileEditor 消费）。
 */

import type { DesignInstRow } from '@main/rtl/types';

/** 虚拟滚动扁平行：树节点行 / 子实例加载中占位行 */
export type FlatTreeRow =
  | { kind: 'node'; key: string; node: DesignInstRow; level: number }
  | { kind: 'loading'; key: string; level: number };

/** 展开状态 + 子实例缓存 → 先序扁平可见行（SoC 级几万节点下虚拟滚动的行源） */
export function flattenVisibleTree(
  root: DesignInstRow,
  expandedPaths: ReadonlySet<string>,
  childrenMap: ReadonlyMap<string, DesignInstRow[]>,
): FlatTreeRow[] {
  const rows: FlatTreeRow[] = [];
  const walk = (node: DesignInstRow, level: number): void => {
    rows.push({ kind: 'node', key: node.path, node, level });
    if (!expandedPaths.has(node.path)) return;
    const kids = childrenMap.get(node.path);
    if (!kids) {
      rows.push({ kind: 'loading', key: `loading:${node.path}`, level: level + 1 });
      return;
    }
    for (const kid of kids) walk(kid, level + 1);
  };
  walk(root, 0);
  return rows;
}

/**
 * 解析 write_json src 属性为文件路径 + 声明行号。
 * 后缀形态：`:行.列` / `:行.列-行.列`；无后缀时 line 为 null。
 * 惰性匹配兼容 Windows 盘符冒号（`D:\x\a.sv:12.3` 不被截断）。
 */
export function parseSrcLocation(src: string): { path: string; line: number | null } {
  const m = /^(.*?):(\d+)(?:\.\d+)?(?:-\d+(?:\.\d+)?)?$/.exec(src);
  if (!m) return { path: src, line: null };
  return { path: m[1]!, line: Number(m[2]) };
}

/** 相对 src 路径按项目根解析为绝对路径；绝对路径原样返回（FileEditor 消费） */
export function resolveSrcPath(srcPath: string, projectRoot: string | null): string {
  if (/^([A-Za-z]:[\\/]|\/)/.test(srcPath)) return srcPath;
  if (!projectRoot) return srcPath;
  const windows = /[\\]/.test(projectRoot) || /^[A-Za-z]:/.test(projectRoot);
  const sep = windows ? '\\' : '/';
  const normalized = srcPath.replace(/[\\/]+/g, sep);
  const base = projectRoot.replace(/[\\/]+$/, '');
  return `${base}${sep}${normalized}`;
}
