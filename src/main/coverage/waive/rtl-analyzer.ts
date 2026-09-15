/**
 * RTL 静态分析引擎 — 识别「结构性不可覆盖」信号（docs/coverage_auto_waive.md §2）。
 *
 * 三类目标信号：
 * - const_assign：`assign Sig = 1'b0;`（信号被固定为常数，toggle 必然漏掉）
 * - input_tie：子例化端口输入被接成常量（`.y(1'b0)`）
 * - output_floating：子例化端口输出悬空（`.c()` 或 named 连接中省略）
 *
 * 跨文件设计：detail.txt 的 File name 指向 module 定义文件，而该 module 例化的
 * 子 module 端口方向声明往往在别的文件里。因此先用 `buildPortIndex` 对全部
 * RTL 文本构建全局「模块名 → 端口方向」索引，`analyzeModuleInstance` 分析
 * 单个 instance 时用该索引解析子例化端口方向。
 *
 * 引擎为纯函数（无 IO），文件读取由 WaiveManager 编排；正则集与
 * docs/coverage_auto_waive.md §2.1 的 python 参考实现逐条对应。
 */

import type { WaiveSignal, WaiveSignalKind } from '@shared/types';

// ─── 正则（python 参考实现的 TS 翻译） ──────────────────────────

/** assign 固定值: `assign [width] <sig>[sel] = <const>;`（前缀/后缀位选均支持，常数含 b/h/d/o 四进制与 x/z 位） */
const RE_ASSIGN_CONST = /assign\s+(?:(\[[^\]]+\])\s*)?(\w+(?:\s*\[[^\]]+\])?)\s*=\s*((?:\d+\s*'?\s*[sS]?\s*[bB]\s*[01xXzZ_]+|\d+\s*'?\s*[sS]?\s*[hH]\s*[0-9a-fA-FxXzZ_]+|\d+\s*'?\s*[sS]?\s*[dD]\s*\d+|\d+\s*'?\s*[sS]?\s*[oO]\s*[0-7xXzZ_]+|1'\s*[bB]\s*[01xX]|'\s*[bB]\s*[01xX]|'\b[01]\b)\s*);/g;

/** 例化端口连接 : .PORT_NAME(EXPR)，EXPR 为空即显式悬空 */
const RE_PORT_CONNECT = /\.\s*(\w+)\s*\(\s*([^)]*)\s*\)/g;

/**
 * 例化点头部 `<mod> <inst>(` 或 `<mod> #(<params>) <inst>(`。
 * 第一个 token 不能命中关键字黑名单（否则误中 always/task/case 等声明形式）。
 * 参数块 `#(...)` 允许一层括号嵌套（如 `#(.W(8))`）。
 */
const RE_INSTANCE_HEAD = /\b([A-Za-z_]\w*)\s*(?:#\s*\((?:[^()]|\([^()]*\))*\))?\s+([A-Za-z_]\w*)\s*\(/g;

const INSTANCE_HEAD_KEYWORD_BLACKLIST = new Set([
  'module', 'endmodule', 'always', 'assign', 'wire', 'reg',
  'input', 'output', 'inout', 'begin', 'if', 'else', 'case',
  'for', 'generate', 'initial', 'task', 'function', 'integer',
  'parameter', 'localparam', 'casez', 'casex', 'endcase',
  'endtask', 'endfunction', 'endgenerate', 'always_ff',
  'always_comb', 'always_latch', 'logic', 'genvar', 'signed',
  'unsigned', 'randcase', 'priority', 'unique', 'int', 'bit',
  'byte', 'longint', 'shortint', 'real', 'time', 'string',
]);

/** module 定义内的端口方向声明: `input/output/inout [width] name` */
const RE_PORT_DIR_DECL = /\b(input|output|inout)\b\s*(?:\[[^\]]+\])?\s*(\w+)/g;

/** 判断一个字符串是否 Verilog 常数（整数匹配） */
const RE_CONST_VAL = /^\s*((?:\d+\s*'?\s*[sS]?\s*[bB]\s*[01XxZz?_]+)|(?:\d+\s*'?\s*[sS]?\s*[hH]\s*[0-9a-fA-FxXzZ?_]+)|(?:\d+\s*'?\s*[sS]?\s*[dD]\s*\d+)|(?:\d+\s*'?\s*[sS]?\s*[oO]\s*[0-7xXzZ?_]+)|(?:1'\s*[bB]\s*[01xX])|(?:'[bB]\s*[01xX])|(?:'[01]))\s*$/;

/** module 定义头（用于切分 module 源码段与构建端口索引） */
const RE_MODULE_HEAD = /\bmodule\s+([A-Za-z_]\w*)/g;

/** module 段结束 */
const RE_MODULE_END = /\bendmodule\b/g;

/**
 * 剥离 Verilog 注释：行注释（// 到行尾）与块注释（斜杠星号到星号斜杠）。
 * 块注释用非贪婪跨行匹配。剥离时保留换行符数量，行号计算不受影响。
 */
export function stripComments(source: string): string {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, ' '))
    .replace(/\/\/[^\n]*/g, (m) => m.replace(/[^\n]/g, ' '));
}

/** Verilog 常数判断（RE_CONST_VAL 的封装，供例化 tie 值复用） */
export function isVerilogConst(value: string): boolean {
  return RE_CONST_VAL.test(value.trim());
}

/** 计算正则匹配在全文中的 1-based 行号（match.index 前的换行数） */
function lineOf(source: string, index: number): number {
  let line = 1;
  for (let i = 0; i < index && i < source.length; i++) {
    if (source.charCodeAt(i) === 10) line++;
  }
  return line;
}

// ─── 全局端口方向索引（跨文件） ───────────────────────────────

/** 模块端口方向表（input/output 名字集合；inout 不参与 tie/floating 判定） */
export type ModulePortDirs = {
  inputs: Set<string>;
  outputs: Set<string>;
};

/** 全局索引：模块名 → 端口方向表（同名多次定义时首个定义生效） */
export type PortIndex = Map<string, ModulePortDirs>;

/**
 * 扫描一份（去注释后的）RTL 文本，提取其中全部 module 定义的端口方向。
 * 返回的 entries 供调用方合并进全局 PortIndex（`mergeIntoPortIndex`）。
 */
export function scanFilePortDirs(stripped: string): Array<[string, ModulePortDirs]> {
  const entries: Array<[string, ModulePortDirs]> = [];
  RE_MODULE_HEAD.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = RE_MODULE_HEAD.exec(stripped)) !== null) {
    const body = moduleBodyOf(stripped, m.index);
    if (!body) continue;
    const dirs: ModulePortDirs = { inputs: new Set(), outputs: new Set() };
    collectPortDirs(body, dirs);
    entries.push([m[1], dirs]);
  }
  return entries;
}

/** 合并到全局索引（首个定义生效，不覆盖） */
export function mergeIntoPortIndex(
  index: PortIndex,
  entries: Array<[string, ModulePortDirs]>,
): void {
  for (const [type, dirs] of entries) {
    if (!index.has(type)) index.set(type, dirs);
  }
}

// ─── 单 instance 分析 ──────────────────────────────────────────

/** 单个 module instance 的分析产出 */
export type ModuleScanResult = {
  /** instance 层级路径（detail.txt 的 Instance name） */
  instancePath: string;
  signals: WaiveSignal[];
  warnings: string[];
};

/**
 * 分析一个 RTL 文本中某个 module 定义（及其内部例化点）的不可覆盖信号。
 *
 * @param stripped 该 instance 对应 module 定义所在的去注释 RTL 全文
 * @param moduleType detail.txt 的 Type name（定位 module 定义）
 * @param instancePath 该实例的层级路径（detail.txt 的 Instance name）
 * @param file 来源文件绝对路径（写入 WaiveSignal.file）
 * @param portIndex 全局模块端口方向索引（解析子例化端口方向）
 */
export function analyzeModuleInstance(
  stripped: string,
  moduleType: string,
  instancePath: string,
  file: string,
  portIndex: PortIndex,
): ModuleScanResult {
  const signals: WaiveSignal[] = [];
  const warnings: string[] = [];

  const body = moduleBodyOf(stripped, findModuleHead(stripped, moduleType));
  if (body === null) {
    return {
      instancePath,
      signals,
      warnings: [`module ${moduleType} definition not found in ${file}`],
    };
  }

  // 1) assign 固定值（module 自身定义内的常数赋值）
  const bodyStart = bodyOffset(stripped, moduleType);
  collectConstAssigns(stripped, body, bodyStart, instancePath, file, signals);

  // 2) 子例化端口 tie / 悬空（例化点在 module 定义内，端口方向查全局索引）
  collectInstancePortIssues(
    stripped,
    body,
    bodyStart,
    instancePath,
    file,
    portIndex,
    signals,
    warnings,
  );

  return { instancePath, signals, warnings };
}

// ─── module 段定位 ─────────────────────────────────────────────

/** 找 module 定义头在全文中的偏移；找不到返回 -1 */
function findModuleHead(stripped: string, moduleType: string): number {
  RE_MODULE_HEAD.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = RE_MODULE_HEAD.exec(stripped)) !== null) {
    if (m[1] === moduleType) return m.index;
  }
  return -1;
}

/** module 源码段（module 头到 endmodule），headIndex<0 或未闭合时返回 null */
function moduleBodyOf(stripped: string, headIndex: number): string | null {
  if (headIndex < 0) return null;
  RE_MODULE_END.lastIndex = headIndex;
  const end = RE_MODULE_END.exec(stripped);
  if (!end) return stripped.slice(headIndex);
  return stripped.slice(headIndex, end.index);
}

function bodyOffset(stripped: string, moduleType: string): number {
  const head = findModuleHead(stripped, moduleType);
  return head < 0 ? 0 : head;
}

// ─── 1) assign 固定值 ──────────────────────────────────────────

function collectConstAssigns(
  stripped: string,
  body: string,
  bodyStart: number,
  instancePath: string,
  file: string,
  signals: WaiveSignal[],
): void {
  RE_ASSIGN_CONST.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = RE_ASSIGN_CONST.exec(body)) !== null) {
    // 归一化位选空格：`data [3]` → `data[3]`（m[2] 为信号名，m[1] 为前缀位选不进信号名）
    const signal = m[2].replace(/\s+/g, '');
    signals.push({
      kind: 'const_assign',
      hier: instancePath,
      signal,
      file,
      line: lineOf(stripped, bodyStart + m.index),
    });
  }
}

// ─── 2) 子例化端口 tie / 悬空 ──────────────────────────────────

/**
 * 扫描 module body 内的例化点（`<mod> <inst>( ... )` 或带参数块形式），提取：
 * - `.port(const)` → input_tie（需子 module 端口方向为 input）
 * - `.port()` → 显式悬空（按子 module 端口方向分类；方向不可见按 floating）
 * - named 连接省略的 output → output_floating
 *
 * positional 连接（按顺序裸表达式，无 `.port(` 形式）无法映射端口名，跳过。
 */
function collectInstancePortIssues(
  stripped: string,
  body: string,
  bodyStart: number,
  instancePath: string,
  file: string,
  portIndex: PortIndex,
  signals: WaiveSignal[],
  warnings: string[],
): void {
  RE_INSTANCE_HEAD.lastIndex = 0;
  let head: RegExpExecArray | null;
  while ((head = RE_INSTANCE_HEAD.exec(body)) !== null) {
    if (INSTANCE_HEAD_KEYWORD_BLACKLIST.has(head[1])) continue;
    const subType = head[1];
    const subInst = head[2];

    // 端口连接括号定位：例化头匹配的末字符即端口括号；带参数块
    // `#(...)` 时匹配末字符的括号是端口括号（正则已跳过参数块）。
    // headMatchEnd = head.index + head[0].length - 1 指向该 `(`。
    const parenStart = head.index + head[0].length - 1;
    if (body[parenStart] !== '(') continue;
    const closeParen = findMatchingParen(body, parenStart);
    if (closeParen < 0) continue;
    const openParen = parenStart;
    const connectText = body.slice(openParen + 1, closeParen);
    // 无 `.port(` 形式（positional 连接/函数原型等）不解析
    if (!/\.\s*\w+\s*\(/.test(connectText)) continue;

    // 子 module 端口方向（全局索引；不可见时 warning 并降级为仅识别显式悬空）
    const subDirs = portIndex.get(subType);
    if (!subDirs) {
      warnings.push(
        `submodule ${subType} definition not found in analyzed files; ` +
        `port direction unknown for instance ${subInst} (only explicit floating detected)`,
      );
    }

    const connected = new Set<string>();
    RE_PORT_CONNECT.lastIndex = 0;
    let conn: RegExpExecArray | null;
    while ((conn = RE_PORT_CONNECT.exec(connectText)) !== null) {
      const portName = conn[1];
      const expr = (conn[2] ?? '').trim();
      connected.add(portName);
      const line = lineOf(stripped, bodyStart + openParen + 1 + conn.index);
      if (expr === '') {
        // 显式悬空 `.port()`：按子 module 端口方向分类，方向不可见按 floating（保守）
        const kind: WaiveSignalKind =
          subDirs?.inputs.has(portName) === true ? 'input_tie' : 'output_floating';
        signals.push({
          kind,
          hier: `${instancePath}.${subInst}`,
          signal: portName,
          file,
          line,
          tieValue: '',
        });
        continue;
      }
      if (!isVerilogConst(expr)) continue;
      // 常量连接：output 端口接常量是驱动冲突而非 tie，跳过；方向不可见时报（宁多勿漏）
      if (subDirs && !subDirs.inputs.has(portName)) continue;
      signals.push({
        kind: 'input_tie',
        hier: `${instancePath}.${subInst}`,
        signal: portName,
        file,
        line,
        tieValue: expr,
      });
    }

    // named 连接中省略的 output 端口（用户决策：算悬空）
    if (subDirs) {
      for (const port of subDirs.outputs) {
        if (!connected.has(port)) {
          signals.push({
            kind: 'output_floating',
            hier: `${instancePath}.${subInst}`,
            signal: port,
            file,
            line: lineOf(stripped, bodyStart + head.index),
          });
        }
      }
    }
  }
}

/** 从 module body 文本中提取方向表（input/output 集合） */
function collectPortDirs(bodyText: string, dirs: ModulePortDirs): void {
  RE_PORT_DIR_DECL.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = RE_PORT_DIR_DECL.exec(bodyText)) !== null) {
    if (m[1] === 'input') dirs.inputs.add(m[2]);
    else if (m[1] === 'output') dirs.outputs.add(m[2]);
  }
}

/** 从 openIndex 开始找配对右括号（考虑嵌套），找不到返回 -1 */
function findMatchingParen(text: string, openIndex: number): number {
  let depth = 0;
  for (let i = openIndex; i < text.length; i++) {
    const c = text.charCodeAt(i);
    if (c === 40) depth++; // (
    else if (c === 41) { // )
      depth--;
      if (depth === 0) return i;
    }
  }
  return -1;
}
