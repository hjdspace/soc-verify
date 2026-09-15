/**
 * .vRefine XML 生成器（docs/coverage_auto_waive.md §3）。
 *
 * 输出 Cadence Verisium Manager 兼容的 refinement 排除文件，可被
 * `imc -load <cov_dir> -refinement <file>` 加载，把结构性不可覆盖信号
 * 从 toggle 覆盖率统计中排除。
 *
 * 骨架与属性顺序严格遵循文档 §3.2 的真实样本（tool-version 24.09）：
 * - rule 顺序：先 const_assign，再 input_tie，再 output_floating
 * - entityName 的层级分隔符是 `/` 而非 `.`
 * - cache-map：key 0 → 用户名、key 1 → "unknown"、再全量 file_map
 */

import type { WaiveSignal } from '@shared/types';

/** 单条 toggle rule 的定位信息（file_id/line 由 file_map 分配） */
export type ToggleRuleSpec = {
  hier: string;
  signal: string;
  fileId: number;
  line: number;
};

/** file_map：file_id → 绝对路径（cache-entry 用） */
export type VrefineFileMap = Map<number, string>;

export type VrefineOptions = {
  /** 顶层 scope（如 tb_top）；空串表示不过滤 */
  topScope: string;
  /** XML attribute 转义与骨架所需的环境值 */
  creator: string;
  /** excTime / creation-time 的基准时间（Date.now()） */
  now: Date;
  toolVersion: string;
};

/** XML attribute 转义：& < > " '（文档 §3.1） */
export function escapeXmlAttr(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

/** creation-time 格式：`%a %d %b %Y %H:%M:%S CST`（如 Mon 08 Sep 2026 19:30:00 CST） */
function formatCreationTime(date: Date): string {
  const DAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
  const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  const pad = (n: number): string => (n < 10 ? `0${n}` : String(n));
  return (
    `${DAYS[date.getUTCDay()]} ${pad(date.getUTCDate())} ${MONTHS[date.getUTCMonth()]} ` +
    `${date.getUTCFullYear()} ${pad(date.getUTCHours())}:${pad(date.getUTCMinutes())}:${pad(date.getUTCSeconds())} CST`
  );
}

/**
 * 构建单条 toggle rule 的 XML 片段（文档 §3.1 伪代码的 TS 实现）。
 *
 * top_scope 越界过滤规则：
 * - top_scope 非空且 hier 不以 top_scope 开头：hier 不含 "." 时视为 module 名
 *   补 top_scope 前缀；否则越界返回 null（丢弃，不计入 rule 数）
 * - full_dotted（hier.signal）不以 top_scope 开头时同样返回 null
 *
 * @returns 有效 rule 的 XML 行；越界/无效信号返回 null
 */
export function buildToggleRule(
  spec: { hier: string; signal: string; fileId: number; line: number },
  opts: VrefineOptions,
): string | null {
  const hier = spec.hier.trim();
  const signal = spec.signal.trim();
  if (signal === '') return null;

  // top_scope 越界过滤（文档 §3.1）
  let hierPath = hier;
  if (opts.topScope !== '' && hierPath !== '' && !hierPath.startsWith(opts.topScope)) {
    if (!hierPath.includes('.')) {
      hierPath = `${opts.topScope}.${hierPath}`;
    } else {
      return null;
    }
  }
  const fullDotted = hierPath === '' ? signal : `${hierPath}.${signal}`;
  if (opts.topScope !== '' && !fullDotted.startsWith(opts.topScope)) return null;

  // ★ entityName 分隔符是 / 不是 .
  const entityName = fullDotted.split('.').join('/');

  const attrs: Array<[string, string]> = [
    ['ccType', 'inst'],
    ['domain', 'icc'],
    ['entityName', entityName],
    ['entityType', 'toggle'],
    ['excTime', String(Math.floor(opts.now.getTime() / 1000))],
    ['name', 'exclude_covered'],
    ['reviewer', '1'],
    ['user', '0'],
    ['vscope', 'default'],
  ];
  if (spec.fileId !== 0) attrs.push(['file', String(spec.fileId)]);
  if (spec.line > 0) attrs.push(['line', String(spec.line)]);

  const attrText = attrs
    .map(([k, v]) => `${k}="${escapeXmlAttr(v)}"`)
    .join(' ');
  return `        <rule ${attrText}></rule>`;
}

/**
 * 渲染完整 .vRefine XML。
 *
 * @param signals 按 kind 分组后的有序信号（const_assign → input_tie → output_floating）
 * @param fileMap file_id → 绝对路径（cache-entry 全量写出）
 */
export function renderVrefineXml(
  signals: WaiveSignal[],
  fileMap: VrefineFileMap,
  opts: VrefineOptions,
): { xml: string; ruleCount: number; droppedOutOfRange: number } {
  const order: Record<string, number> = { const_assign: 0, input_tie: 1, output_floating: 2 };
  const sorted = [...signals].sort(
    (a, b) => (order[a.kind] ?? 3) - (order[b.kind] ?? 3),
  );

  const ruleLines: string[] = [];
  let dropped = 0;
  for (const sig of sorted) {
    const line = buildToggleRule(
      { hier: sig.hier, signal: sig.signal, fileId: fileIdOf(fileMap, sig.file), line: sig.line },
      opts,
    );
    if (line === null) {
      dropped++;
      continue;
    }
    ruleLines.push(line);
  }

  const xml =
    `<?xml version="1.0" encoding="UTF-8" standalone="no"?>\n` +
    `<refinement-file-root>\n` +
    `    <information comment-version="2" creation-time="${escapeXmlAttr(formatCreationTime(opts.now))}" creator="${escapeXmlAttr(opts.creator)}" csCheck="true" save-ref-method="seq" tool-version="${escapeXmlAttr(opts.toolVersion)}">\n` +
    `        <ucm-files/>\n` +
    `        <ccf-files>\n` +
    `        </ccf-files>\n` +
    `    </information>\n` +
    `    <rules>\n` +
    `${ruleLines.join('\n')}\n` +
    `    </rules>\n` +
    `    <cache-map>\n` +
    `        <cache-entry key="0" value="${escapeXmlAttr(opts.creator)}"></cache-entry>\n` +
    `        <cache-entry key="1" value="unknown"></cache-entry>\n` +
    [...fileMap.entries()]
      .map(([id, path]) => `        <cache-entry key="${id}" value="${escapeXmlAttr(path)}"></cache-entry>`)
      .join('\n') +
    (fileMap.size > 0 ? '\n' : '') +
    `    </cache-map>\n` +
    `</refinement-file-root>\n`;

  return { xml, ruleCount: ruleLines.length, droppedOutOfRange: dropped };
}

/** 信号 → file_id（fileMap 中无记录时 0 = 不写 file 属性） */
function fileIdOf(fileMap: VrefineFileMap, file: string): number {
  for (const [id, path] of fileMap) {
    if (path === file) return id;
  }
  return 0;
}
