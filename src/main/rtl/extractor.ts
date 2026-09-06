/**
 * write_json 提炼器（ADR 0032 决策 8-10 / spec「write_json 提炼模型」）。
 *
 * 输入：yosys `write_json` 产物（`--keep-hierarchy` 硬性要求下的 uniquified 命名模式）。
 * 输出：自有提炼模型（Module Definition 聚合 / Module Instance 树 / per-def 连线表）。
 *
 * uniquified 命名：每实例是独立模块 `<defName>$<完整实例路径>`（如
 * `spike_ip$spike_top.u_subsys1.gen_ip[3].u_ip`）——模块名自带实例树，
 * generate 展开正确；按 defName 聚合 Definition、按 cells 遍历重建 Instance 树。
 *
 * 流式解析（超大设计不整体 JSON.parse）在 issue 08（tests-performance）落实；
 * 本实现保证 raw doc 只在主进程内存中出现、不持久化（渲染端零解析）。
 */

import { isAbsolute, resolve } from 'node:path';
import type {
  ExtractedDef,
  ExtractedDesign,
  ExtractedEdge,
  ExtractedEdgeCell,
  ExtractedInst,
  ExtractedPort,
} from './types';

// ─── write_json 文档结构（只声明我们消费的字段） ──────────────

type WJPort = {
  direction: 'input' | 'output' | 'inout';
  bits: (number | string)[];
};

type WJCell = {
  type: string;
  parameters?: Record<string, unknown>;
  connections?: Record<string, (number | string)[]>;
};

type WJModule = {
  attributes?: Record<string, unknown>;
  ports?: Record<string, WJPort>;
  cells?: Record<string, WJCell>;
  netnames?: Record<string, { bits?: (number | string)[] }>;
  parameter_default_values?: Record<string, unknown>;
};

export type WriteJsonDoc = {
  modules: Record<string, WJModule>;
};

/** `soc_subsys$spike_top.u_subsys0` → ['soc_subsys', 'spike_top.u_subsys0']；无 `$` → 自身（顶层） */
export function splitUniquified(name: string): [string, string | null] {
  const i = name.indexOf('$');
  return i === -1 ? [name, null] : [name.slice(0, i), name.slice(i + 1)];
}

/**
 * write_json `src` 属性归一化为绝对路径（保留 `:行.列` 后缀）。
 *
 * yosys 把 src 记录为相对其进程 cwd（elaboration work 目录）的路径
 * （如 `..\..\rtl-spike\rtl\a.sv:3.8`），渲染端按项目根拼接会在路径深度
 * 不足时越过盘符根被钳位，得到错误绝对路径。相对路径必须按 yosys cwd
 * （= workDir）解析；绝对路径原样返回。
 */
export function normalizeSrc(src: string | null, yosysCwd: string): string | null {
  if (src === null) return null;
  // 惰性匹配兼容 Windows 盘符冒号；后缀形态 `:行.列[-行.列]`
  const m = /^(.*?)(:\d+(?:\.\d+)?(?:-\d+(?:\.\d+)?)?)$/.exec(src);
  const pathPart = m?.[1] ?? src;
  const suffix = m?.[2] ?? '';
  if (isAbsolute(pathPart)) return src;
  return `${resolve(yosysCwd, pathPart)}${suffix}`;
}

function srcOf(m: WJModule, yosysCwd: string): string | null {
  const src = m.attributes?.['src'];
  return typeof src === 'string' ? normalizeSrc(src, yosysCwd) : null;
}

/** 提炼 Module Definitions（按 defName 聚合；yosys 内部 `$` 模块跳过；顶层同名模块亦为 def） */
export function extractDefs(doc: WriteJsonDoc, yosysCwd: string): ExtractedDef[] {
  const defs = new Map<string, ExtractedDef>();
  for (const [name, m] of Object.entries(doc.modules ?? {})) {
    if (name.startsWith('$')) continue; // yosys 内部模块
    const [defName] = splitUniquified(name);
    if (defs.has(defName)) continue; // uniquified 同定义只取首个代表
    const ports: ExtractedPort[] = Object.entries(m.ports ?? {}).map(([pname, p]) => ({
      name: pname,
      direction: p.direction,
      width: Array.isArray(p.bits) ? p.bits.length : 0,
    }));
    defs.set(defName, {
      name: defName,
      src: srcOf(m, yosysCwd),
      paramDefaults: (m.parameter_default_values ?? {}) as Record<string, unknown>,
      ports,
    });
  }
  return [...defs.values()];
}

/** 用户模块实例判定：type 是文档内模块（含 uniquified）或非 `$` 前缀（黑盒）；`$` 前缀为 yosys 原语 */
function isModuleInstance(doc: WriteJsonDoc, cellType: string): boolean {
  return doc.modules[cellType] !== undefined || !cellType.startsWith('$');
}

/** 递归重建 Module Instance 树（S0 extractor.mjs 原型的 TS 化） */
function buildTree(
  doc: WriteJsonDoc,
  uniquifiedName: string,
  instName: string,
  parentPath: string | null,
  depth: number,
  cellParams: Record<string, unknown>,
  yosysCwd: string,
  out: ExtractedInst[],
): void {
  const m = doc.modules[uniquifiedName];
  const [defName] = splitUniquified(uniquifiedName);
  const path = parentPath === null ? instName : `${parentPath}.${instName}`;
  out.push({
    path,
    name: instName,
    module: defName,
    parent: parentPath,
    depth,
    src: m ? srcOf(m, yosysCwd) : null,
    // 参数覆盖值在父模块 cell.parameters 上（write_json 已知缺口：uniquified 模块的
    // parameter_default_values 为空，spec 遗留问题的展示方案在后续切片解决）
    params: cellParams,
    // extractDesign 末尾 assignInstCounts 统一填写
    instCount: 0,
  });
  if (!m) return; // 黑盒：无可遍历 body
  for (const [cname, cell] of Object.entries(m.cells ?? {})) {
    if (!isModuleInstance(doc, cell.type)) continue;
    buildTree(doc, cell.type, cname, path, depth + 1, (cell.parameters ?? {}) as Record<string, unknown>, yosysCwd, out);
  }
}

/**
 * elaborated top units：未被任何模块实例化的非 yosys 内部模块。
 *
 * `--keep-hierarchy` 下 write_json 同时产出 uniquified 实例模块
 * （`soc_subsys$spike_top.u_subsys0` 等）——它们是其他模块的 cell type，
 * 不是顶层候选；「被实例化」的模块集合可通过全模块 cells 扫描重建。
 * detectTops 模式（无 --top，slang 编译全部 root units）据此得到真实顶层列表。
 */
export function extractTopUnits(doc: WriteJsonDoc): string[] {
  const instantiated = new Set<string>();
  for (const m of Object.values(doc.modules ?? {})) {
    for (const cell of Object.values(m.cells ?? {})) {
      instantiated.add(cell.type);
    }
  }
  return Object.keys(doc.modules ?? {})
    .filter((name) => !name.startsWith('$') && !instantiated.has(name))
    .sort();
}

/**
 * 提炼全设计。top 必须在文档中（elaborated top units 之一），否则抛错。
 * 注意 cell.parameters 在父模块的 cells 上 —— buildTree 需要读取它。
 * yosysCwd = yosys 进程 cwd（work 目录）：write_json src 是相对它的路径，
 * 必须在此归一化为绝对路径（见 normalizeSrc）。
 */
export function extractDesign(doc: WriteJsonDoc, topName: string, yosysCwd: string): ExtractedDesign {
  const topModule = doc.modules?.[topName];
  if (!topModule) {
    throw new Error(`顶层模块 ${topName} 不在 elaborated 设计中（write_json 无此模块）`);
  }
  const insts: ExtractedInst[] = [];
  buildTree(doc, topName, topName, null, 0, {}, yosysCwd, insts);
  assignInstCounts(insts);
  return {
    top: topName,
    defs: extractDefs(doc, yosysCwd),
    insts,
    edges: extractEdges(doc),
  };
}

/**
 * 子树实例数（含自身）：buildTree 为 DFS 先序，倒序遍历时每个实例的全部后代
 * 已先处理完 —— 把累加值上抛给父节点即可，O(n) 无需重建树。
 */
function assignInstCounts(insts: ExtractedInst[]): void {
  const size = new Map<string, number>();
  for (let i = insts.length - 1; i >= 0; i--) {
    const inst = insts[i]!;
    const total = (size.get(inst.path) ?? 0) + 1;
    size.set(inst.path, total);
    inst.instCount = total;
    if (inst.parent !== null) {
      size.set(inst.parent, (size.get(inst.parent) ?? 0) + total);
    }
  }
}

// ─── 连线表（spec 决策 9：bit id → endpoints 聚合 → i2i / top2i 边） ──────

type NetAccumulator = {
  net: string | null;
  kind: 'i2i' | 'top2i';
  cells: Map<string, ExtractedEdgeCell>;
  topPorts: Set<string>;
  width: number;
};

/**
 * per-Definition 连线表：对每个 defName 的代表模块，把 bit id 按端点聚合
 * （≥2 实例 → i2i；1 实例 + 本定义端口 → top2i），再按 netname 归并为网级边。
 */
export function extractEdges(doc: WriteJsonDoc): ExtractedEdge[] {
  const representative = new Map<string, string>(); // defName → 首个 uniquified 模块名
  for (const name of Object.keys(doc.modules ?? {})) {
    if (name.startsWith('$')) continue;
    const [defName] = splitUniquified(name);
    if (!representative.has(defName)) representative.set(defName, name);
  }

  const edges: ExtractedEdge[] = [];
  for (const [defName, moduleName] of representative) {
    edges.push(...extractEdgesOfModule(doc, moduleName, defName));
  }
  return edges;
}

function extractEdgesOfModule(doc: WriteJsonDoc, moduleName: string, defName: string): ExtractedEdge[] {
  const m = doc.modules[moduleName];
  if (!m) return [];

  // bit id → 端点（常量位 'x'/'z' 字符串跳过）
  const bitEndpoints = new Map<number, { cells: { cell: string; port: string }[]; topPorts: Set<string> }>();
  const endpointsFor = (bit: number) => {
    let eps = bitEndpoints.get(bit);
    if (!eps) {
      eps = { cells: [], topPorts: new Set<string>() };
      bitEndpoints.set(bit, eps);
    }
    return eps;
  };

  for (const [pname, p] of Object.entries(m.ports ?? {})) {
    (p.bits ?? []).forEach((bit) => {
      if (typeof bit !== 'number') return;
      endpointsFor(bit).topPorts.add(pname);
    });
  }
  for (const [cname, cell] of Object.entries(m.cells ?? {})) {
    if (!isModuleInstance(doc, cell.type)) continue;
    for (const [pname, bits] of Object.entries(cell.connections ?? {})) {
      (bits ?? []).forEach((bit) => {
        if (typeof bit !== 'number') return;
        endpointsFor(bit).cells.push({ cell: cname, port: pname });
      });
    }
  }

  // netname 映射：bit → RTL 网名
  const netOf = new Map<number, string>();
  for (const [nname, n] of Object.entries(m.netnames ?? {})) {
    (n.bits ?? []).forEach((b) => {
      if (typeof b === 'number') netOf.set(b, nname);
    });
  }

  // bit 级边按网归并（无名位段独立成边）
  const byNet = new Map<string, NetAccumulator>();
  for (const [bit, eps] of bitEndpoints) {
    const cells = new Map<string, ExtractedEdgeCell>();
    for (const ep of eps.cells) {
      if (!cells.has(ep.cell)) cells.set(ep.cell, { inst: ep.cell, port: ep.port });
    }
    const topPorts = eps.topPorts;
    if (cells.size < 1) continue;
    const kind: 'i2i' | 'top2i' = cells.size >= 2 ? 'i2i' : topPorts.size >= 1 ? 'top2i' : 'i2i';
    if (cells.size === 1 && topPorts.size === 0) continue; // 单端点悬空位
    const net = netOf.get(bit) ?? null;
    const key = net ?? `__bit_${bit}`;
    let acc = byNet.get(key);
    if (!acc) {
      acc = { net, kind, cells, topPorts, width: 0 };
      byNet.set(key, acc);
    } else {
      for (const [cell, ep] of cells) acc.cells.set(cell, ep);
      for (const tp of topPorts) acc.topPorts.add(tp);
    }
    acc.width += 1;
    // 一个网内只要有一条位边是 i2i，整体即 i2i（优先级高于 top2i）
    if (kind === 'i2i') acc.kind = 'i2i';
  }

  return [...byNet.values()].map((acc) => ({
    module: defName,
    net: acc.net,
    kind: acc.kind,
    width: acc.width,
    cells: [...acc.cells.values()],
    topPorts: [...acc.topPorts],
  }));
}
