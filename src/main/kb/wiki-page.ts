/**
 * Wiki Page — 知识页 frontmatter 契约解析与八类默认模板。
 *
 * spec §2：每页最小 frontmatter 为 `type/title/summary/keywords/tags/
 * sources/created/updated`；YAML 使用安全解析/序列化，拒绝重复键、
 * 非法对象类型与过深结构，不用正则模拟完整 YAML。
 * 来源引用格式（SourceRef）与应用统一 ISO 日期在此校验。
 *
 * 本模块是页面文件内容唯一解析入口：阅读目录（wiki-catalog）、
 * 规则保存（wiki-rules）、后继编译/发布共用同一实现。
 *
 * @see docs/prd/knowledge-base-llm-wiki-spec.md §2
 */

import { parse as parseYaml } from 'yaml';
import { WIKI_PAGE_TYPES, DEFAULT_TYPE_DIRS } from './wiki-schema';
import type {
  WikiPageFrontmatter,
  WikiPageIssue,
  WikiPageIssueCode,
  WikiPageParseResult,
  WikiPageType,
  WikiSourceRef,
  WikiTemplateInfo,
} from '@shared/kb-types';

// 类型契约单一源在 @shared/kb-types；此处 re-export 供既有引用方使用
export type {
  WikiPageFrontmatter,
  WikiPageIssue,
  WikiPageIssueCode,
  WikiPageParseResult,
  WikiSourceRef,
  WikiTemplateInfo,
};

/** frontmatter 允许的最大嵌套深度（spec：拒绝过深结构） */
const MAX_FRONTMATTER_DEPTH = 4;

const REQUIRED_FIELDS = ['type', 'title', 'summary', 'keywords', 'tags', 'sources', 'created', 'updated'] as const;

// ── 解析 ────────────────────────────────────────────────────────

/**
 * 解析知识页内容：提取 `---` 围栏 frontmatter → YAML 安全解析 →
 * 最小契约校验。收集所有问题而非首错即停。
 */
export function parseWikiPage(content: string): WikiPageParseResult {
  const issues: WikiPageIssue[] = [];

  const block = extractFrontmatter(content);
  if (!block) {
    return { ok: false, issues: [{ code: 'missingFrontmatter', message: '缺少 `---` 围栏的 frontmatter' }] };
  }

  // YAML 安全解析。yaml v2 对重复键抛 YAMLParseError（消息含 Map keys must be unique）。
  let data: unknown;
  try {
    data = parseYaml(block.yaml);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    const code: WikiPageIssueCode = /unique/i.test(msg) ? 'duplicateKey' : 'badYaml';
    return { ok: false, issues: [{ code, message: `frontmatter YAML 解析失败: ${msg}` }] };
  }

  if (data === null || typeof data !== 'object' || Array.isArray(data)) {
    return { ok: false, issues: [{ code: 'notAnObject', message: 'frontmatter 顶层必须是键值映射' }] };
  }
  const fm = data as Record<string, unknown>;

  const depth = measureDepth(fm);
  if (depth > MAX_FRONTMATTER_DEPTH) {
    issues.push({ code: 'tooDeep', message: `frontmatter 嵌套过深（${depth} 层，上限 ${MAX_FRONTMATTER_DEPTH} 层）` });
  }

  for (const field of REQUIRED_FIELDS) {
    if (fm[field] === undefined) {
      issues.push({ code: 'missingField', message: `缺少必填字段「${field}」` });
    }
  }

  let type: WikiPageType | undefined;
  if (fm.type !== undefined) {
    if (typeof fm.type !== 'string' || !(WIKI_PAGE_TYPES as readonly string[]).includes(fm.type)) {
      issues.push({ code: 'unknownType', message: `type「${String(fm.type)}」不是固定八类之一` });
    } else {
      type = fm.type as WikiPageType;
    }
  }

  if (fm.title !== undefined && !isNonEmptyString(fm.title)) {
    issues.push({ code: 'badFieldType', message: 'title 必须是非空字符串' });
  }
  if (fm.summary !== undefined && typeof fm.summary !== 'string') {
    issues.push({ code: 'badFieldType', message: 'summary 必须是字符串' });
  }
  if (fm.keywords !== undefined && !isStringArray(fm.keywords)) {
    issues.push({ code: 'badFieldType', message: 'keywords 必须是字符串数组' });
  }
  if (fm.tags !== undefined && !isStringArray(fm.tags)) {
    issues.push({ code: 'badFieldType', message: 'tags 必须是字符串数组' });
  }

  let sources: WikiSourceRef[] = [];
  if (fm.sources !== undefined) {
    const check = parseSources(fm.sources);
    if (typeof check === 'string') {
      issues.push({ code: 'badSources', message: check });
    } else {
      sources = check;
    }
  }

  let created: string | undefined;
  let updated: string | undefined;
  if (fm.created !== undefined) {
    if (!isIsoDate(fm.created)) {
      issues.push({ code: 'badDate', message: `created「${String(fm.created)}」不是 ISO 8601 时间` });
    } else {
      created = fm.created as string;
    }
  }
  if (fm.updated !== undefined) {
    if (!isIsoDate(fm.updated)) {
      issues.push({ code: 'badDate', message: `updated「${String(fm.updated)}」不是 ISO 8601 时间` });
    } else {
      updated = fm.updated as string;
    }
  }

  if (issues.length > 0) {
    return { ok: false, issues };
  }

  return {
    ok: true,
    frontmatter: {
      type: type as WikiPageType,
      title: fm.title as string,
      summary: fm.summary as string,
      keywords: fm.keywords as string[],
      tags: fm.tags as string[],
      sources,
      created: created as string,
      updated: updated as string,
    },
    body: block.body,
  };
}

/** 提取 `---` 围栏 frontmatter（必须位于文件开头） */
function extractFrontmatter(content: string): { yaml: string; body: string } | null {
  if (!content.startsWith('---')) return null;
  const firstNl = content.indexOf('\n');
  if (firstNl < 0) return null;
  const rest = content.slice(firstNl + 1);
  const end = rest.match(/^---\s*$/m);
  if (!end || end.index === undefined) return null;
  return {
    yaml: rest.slice(0, end.index),
    body: rest.slice(end.index + end[0].length).replace(/^\n/, ''),
  };
}

function measureDepth(value: unknown, depth = 1): number {
  if (depth > MAX_FRONTMATTER_DEPTH + 1) return depth;
  if (Array.isArray(value)) {
    return value.reduce<number>((max, item) => Math.max(max, measureDepth(item, depth + 1)), depth);
  }
  if (value !== null && typeof value === 'object') {
    const entries = Object.values(value as Record<string, unknown>);
    return entries.reduce<number>((max, item) => Math.max(max, measureDepth(item, depth + 1)), depth);
  }
  return depth;
}

function isNonEmptyString(v: unknown): v is string {
  return typeof v === 'string' && v.trim().length > 0;
}

function isStringArray(v: unknown): v is string[] {
  return Array.isArray(v) && v.every((item) => typeof item === 'string');
}

/** sources 校验；失败返回错误说明字符串 */
function parseSources(v: unknown): WikiSourceRef[] | string {
  if (!Array.isArray(v)) return 'sources 必须是 SourceRef 数组';
  const out: WikiSourceRef[] = [];
  for (const [idx, item] of v.entries()) {
    if (item === null || typeof item !== 'object' || Array.isArray(item)) {
      return `sources[${idx}] 必须是 { sourceId, sourceRevision, parsedHash } 映射`;
    }
    const rec = item as Record<string, unknown>;
    for (const key of ['sourceId', 'sourceRevision', 'parsedHash'] as const) {
      const v = rec[key];
      // 纯数字 hash（YAML 会把未加引号的 112233 解析成 number）收敛为字符串
      if (!(typeof v === 'string' && v.trim().length > 0) && typeof v !== 'number') {
        return `sources[${idx}].${key} 必须是非空字符串`;
      }
    }
    out.push({
      sourceId: String(rec.sourceId),
      sourceRevision: String(rec.sourceRevision),
      parsedHash: String(rec.parsedHash),
    });
  }
  return out;
}

function isIsoDate(v: unknown): v is string {
  if (typeof v !== 'string') return false;
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/.test(v)) return false;
  return !Number.isNaN(Date.parse(v));
}

// ── 八类默认模板 ────────────────────────────────────────────────

export const WIKI_PAGE_TEMPLATES: Record<WikiPageType, WikiTemplateInfo> = {
  source: {
    type: 'source', dir: DEFAULT_TYPE_DIRS.source,
    bodySections: ['来源概述', '关键内容', '处置范围'],
    defaultSummary: '单一来源的结构化摘要。',
    defaultKeywords: [], defaultTags: ['来源'],
  },
  entity: {
    type: 'entity', dir: DEFAULT_TYPE_DIRS.entity,
    bodySections: ['概述', '组成', '关联页面'],
    defaultSummary: '实体页：IP、模块、信号组。',
    defaultKeywords: [], defaultTags: ['实体'],
  },
  concept: {
    type: 'concept', dir: DEFAULT_TYPE_DIRS.concept,
    bodySections: ['定义', '规则', '适用条件'],
    defaultSummary: '概念与协议规则。',
    defaultKeywords: [], defaultTags: ['概念'],
  },
  comparison: {
    type: 'comparison', dir: DEFAULT_TYPE_DIRS.comparison,
    bodySections: ['对照维度', '逐项对照', '结论'],
    defaultSummary: '跨来源对照。',
    defaultKeywords: [], defaultTags: ['对照'],
  },
  synthesis: {
    type: 'synthesis', dir: DEFAULT_TYPE_DIRS.synthesis,
    bodySections: ['结论', '依据', '适用范围'],
    defaultSummary: '综合结论。',
    defaultKeywords: [], defaultTags: ['综合'],
  },
  query: {
    type: 'query', dir: DEFAULT_TYPE_DIRS.query,
    bodySections: ['问题', '回答', '适用条件'],
    defaultSummary: '保存的问答。',
    defaultKeywords: [], defaultTags: ['问答'],
  },
  pitfall: {
    type: 'pitfall', dir: DEFAULT_TYPE_DIRS.pitfall,
    bodySections: ['现象', '根因', '规避', '证据'],
    defaultSummary: '已知问题：现象 → 根因 → 规避 → 证据。',
    defaultKeywords: [], defaultTags: ['踩坑'],
  },
  interface: {
    type: 'interface', dir: DEFAULT_TYPE_DIRS.interface,
    bodySections: ['接口概述', '信号表', '位段说明', '时序条件'],
    defaultSummary: '接口：信号表、位段、时序。',
    defaultKeywords: [], defaultTags: ['接口'],
  },
};

/**
 * 渲染某类型的默认页面模板（完整 markdown，含 frontmatter）。
 * `now` 由调用方提供 ISO 时间（应用统一时钟，不信任模型/本地随机值）。
 */
export function renderWikiPageTemplate(type: WikiPageType, pageId: string, now: string): string {
  const t = WIKI_PAGE_TEMPLATES[type];
  const title = pageId.includes('/') ? pageId.slice(pageId.lastIndexOf('/') + 1) : pageId;
  const body = t.bodySections.map((s) => `## ${s}\n\n（待补充）\n`).join('\n');
  return [
    '---',
    `type: ${type}`,
    `title: "${title}"`,
    `summary: "${t.defaultSummary}"`,
    `keywords: []`,
    `tags: [${t.defaultTags.map((x) => `"${x}"`).join(', ')}]`,
    `sources: []`,
    `created: "${now}"`,
    `updated: "${now}"`,
    '---',
    '',
    `# ${title}`,
    '',
    body,
  ].join('\n');
}
