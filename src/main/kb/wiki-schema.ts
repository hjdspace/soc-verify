/**
 * Wiki Schema — schema.md `## Page Types` 受约束表的解析与校验。
 *
 * spec §2：固定八种 type，默认路由到固定目录。`## Page Types` 是
 * 受约束表：类型完整且唯一、目录唯一且位于 wiki 内、无保留聚合路径。
 * 无法解析、缺类型、未知类型或冲突路由一律报错——**不回退到无约束**
 * （区别于参考 R06 的宽松行为）。
 *
 * 本模块是 schema.md 唯一解析入口：阅读目录扫描（wiki-catalog）、
 * 规则保存校验（wiki-rules）、后继编译内核共用同一实现。
 *
 * @see docs/prd/knowledge-base-llm-wiki-spec.md §2
 */

import { validateManagedRelPath } from './path-guard';
import type {
  WikiPageType,
  WikiSchemaIssue,
  WikiSchemaIssueCode,
  WikiSchemaParseResult,
  WikiSchemaRouting,
} from '@shared/kb-types';

// 类型契约单一源在 @shared/kb-types；此处 re-export 供既有引用方（tests、后继模块）使用
export type {
  WikiPageType,
  WikiSchemaIssue,
  WikiSchemaIssueCode,
  WikiSchemaParseResult,
  WikiSchemaRouting,
};

// ── 固定类型集合 ────────────────────────────────────────────────

export const WIKI_PAGE_TYPES = [
  'source', 'entity', 'concept', 'comparison',
  'synthesis', 'query', 'pitfall', 'interface',
] as const satisfies readonly WikiPageType[];

/** 默认路由（与 wiki-layout 的 SCHEMA_MD_SKELETON 一致） */
export const DEFAULT_TYPE_DIRS: Record<WikiPageType, string> = {
  source: 'sources',
  entity: 'entities',
  concept: 'concepts',
  comparison: 'comparisons',
  synthesis: 'synthesis',
  query: 'queries',
  pitfall: 'pitfalls',
  interface: 'interfaces',
};

/**
 * 保留聚合页名（wiki 根目录下的 index.md / overview.md / log.md）。
 * 类型目录不得占用这些名字。
 */
export const RESERVED_AGGREGATE_NAMES = ['index', 'overview', 'log'] as const;

// ── 解析结果（类型定义见 @shared/kb-types）──────────────────────

/** 类型 → wiki 内相对目录（`concepts`、`entities/nested`） */

/** `## Page Types` 段标题匹配（与参考 R06 一致：1-6 级标题、忽略大小写） */
const PAGE_TYPES_HEADING_RE = /^#{1,6}\s+page\s+types\s*$/i;
const ANY_HEADING_RE = /^(#{1,6})\s+/;
const TABLE_SEPARATOR_CELL_RE = /^:?-{3,}:?$/;

/**
 * 解析 schema.md 的 Page Types 受约束表。
 *
 * 返回 `{ ok: true, routing }` 或 `{ ok: false, issues }`；
 * 收集所有问题而非首错即停（一次编辑看清全部问题）。
 */
export function parseWikiSchema(markdown: string): WikiSchemaParseResult {
  const lines = markdown.split('\n');
  const issues: WikiSchemaIssue[] = [];

  // 定位 ## Page Types 段
  const start = lines.findIndex((line) => PAGE_TYPES_HEADING_RE.test(line.trim()));
  if (start < 0) {
    return {
      ok: false,
      issues: [{ code: 'missingPageTypes', message: 'schema.md 缺少 `## Page Types` 受约束表段落' }],
    };
  }
  const headingLevel = (lines[start].trim().match(ANY_HEADING_RE)?.[1] ?? '#').length;

  // 段边界：下一个同级或更高级标题
  const sectionLines: string[] = [];
  for (let i = start + 1; i < lines.length; i++) {
    const m = lines[i].trim().match(ANY_HEADING_RE);
    if (m && m[1].length <= headingLevel) break;
    sectionLines.push(lines[i]);
  }

  // 收集表格行（跳过分隔行；表头之外的 `|` 行都是数据行）
  const headerCells = sectionLines
    .map((line, idx) => ({ line, lineNo: start + 1 + idx + 1 }))
    .filter(({ line }) => line.trim().startsWith('|'));
  if (headerCells.length === 0) {
    return {
      ok: false,
      issues: [
        { code: 'missingHeader', message: '`## Page Types` 段内没有表格行' },
        { code: 'missingType', message: `缺少类型行: ${WIKI_PAGE_TYPES.join(', ')}` },
      ],
    };
  }

  const first = splitTableRow(headerCells[0].line);
  if (
    first.length < 2
    || first[0].toLowerCase() !== 'type'
    || !(first[1] === '目录' || first[1].toLowerCase() === 'dir')
  ) {
    issues.push({
      code: 'missingHeader',
      message: `Page Types 表头必须是 | type | 目录 | …，实际为「${first.join(' | ')}」`,
      line: headerCells[0].lineNo,
    });
  }

  const typeDirs = new Map<string, string>();
  const dirOwners = new Map<string, string>();
  const seenTypes = new Set<string>();

  for (let i = 1; i < headerCells.length; i++) {
    const { line, lineNo } = headerCells[i];
    const cells = splitTableRow(line);
    if (cells.length >= 1 && cells.every((c) => TABLE_SEPARATOR_CELL_RE.test(c))) {
      continue; // 分隔行（| --- | --- | --- |）
    }
    if (cells.length < 2 || cells.every((c) => c.length === 0)) {
      issues.push({ code: 'unparseableRow', message: `无法解析的表格行: 「${line.trim()}」`, line: lineNo });
      continue;
    }

    const type = cells[0];
    const dir = cells[1];

    // 类型校验
    if (type.length === 0) {
      issues.push({ code: 'unparseableRow', message: `类型单元格为空: 「${line.trim()}」`, line: lineNo });
    } else if (!(WIKI_PAGE_TYPES as readonly string[]).includes(type)) {
      issues.push({
        code: 'unknownType',
        message: `未知类型「${type}」：本期固定八类（${WIKI_PAGE_TYPES.join(', ')}），不支持新增类型`,
        line: lineNo,
      });
    } else if (seenTypes.has(type)) {
      issues.push({ code: 'duplicateType', message: `类型「${type}」重复出现`, line: lineNo });
    } else {
      seenTypes.add(type);
    }

    // 目录校验
    if (dir.length === 0) {
      issues.push({ code: 'missingDir', message: `类型「${type}」的目录为空`, line: lineNo });
    } else if ((RESERVED_AGGREGATE_NAMES as readonly string[]).includes(dir.toLowerCase())) {
      issues.push({
        code: 'reservedDir',
        message: `目录「${dir}」占用保留聚合路径（${RESERVED_AGGREGATE_NAMES.join('/')}）`,
        line: lineNo,
      });
    } else {
      const check = validateManagedRelPath(dir);
      if (!check.ok) {
        issues.push({ code: 'invalidDir', message: `类型「${type}」的目录「${dir}」非法: ${check.reason}`, line: lineNo });
      } else {
        const normalized = check.normalized.replace(/\/+$/, '');
        const owner = dirOwners.get(normalized.toLowerCase());
        if (owner !== undefined) {
          issues.push({
            code: 'duplicateDir',
            message: `目录「${normalized}」同时分配给「${owner}」和「${type}」`,
            line: lineNo,
          });
        } else {
          dirOwners.set(normalized.toLowerCase(), type);
          if (!typeDirs.has(type)) typeDirs.set(type, normalized);
        }
      }
    }
  }

  // 完整性：八类缺一不可
  const missing = WIKI_PAGE_TYPES.filter((t) => !seenTypes.has(t));
  if (missing.length > 0) {
    issues.push({
      code: 'missingType',
      message: `缺少类型行: ${missing.join(', ')}`,
    });
  }

  if (issues.length > 0) {
    return { ok: false, issues };
  }
  return { ok: true, routing: { typeDirs: Object.fromEntries(typeDirs) as Record<WikiPageType, string> } };
}

/** 拆分 markdown 表格行为单元格（去掉首尾 `|`，trim 每格） */
function splitTableRow(line: string): string[] {
  const trimmed = line.trim();
  if (!trimmed.startsWith('|')) return [];
  const inner = trimmed.startsWith('|') && trimmed.endsWith('|') && trimmed.length >= 2
    ? trimmed.slice(1, -1)
    : trimmed.slice(1);
  return inner.split('|').map((c) => c.trim());
}
