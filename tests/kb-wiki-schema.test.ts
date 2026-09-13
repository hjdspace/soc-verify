/**
 * wiki-schema 单元测试（issue 04 — 页面、链接和证据契约）。
 *
 * schema.md 的 `## Page Types` 是受约束表：类型完整且唯一、目录唯一
 * 且位于 wiki/ 内、无保留聚合路径。解析失败返回结构化 issues，
 * 不回退到无约束路由（spec §2，区别于参考 R06 的宽松行为）。
 */

import { describe, it, expect } from 'vitest';
import {
  parseWikiSchema,
  WIKI_PAGE_TYPES,
  DEFAULT_TYPE_DIRS,
  RESERVED_AGGREGATE_NAMES,
  type WikiSchemaIssueCode,
} from '../src/main/kb/wiki-schema';
import { SCHEMA_MD_SKELETON } from '../src/main/kb/wiki-layout';

/** 从结果提取 issues 的 code 集合（便于断言） */
function issueCodes(res: ReturnType<typeof parseWikiSchema>): Set<WikiSchemaIssueCode> {
  if (res.ok) throw new Error('expected parse failure, got ok');
  return new Set(res.issues.map((i) => i.code));
}

/** 把骨架表的数据行替换为给定行集（骨架原有表头/分隔行保留） */
function withTableRows(rows: string[]): string {
  const marker = '| source | sources | 单一来源的结构化摘要 |';
  const idx = SCHEMA_MD_SKELETON.indexOf(marker);
  const end = SCHEMA_MD_SKELETON.indexOf('| interface | interfaces | 接口：信号表、位段、时序 |');
  const endLineEnd = SCHEMA_MD_SKELETON.indexOf('\n', end) + 1;
  return SCHEMA_MD_SKELETON.slice(0, idx) + rows.join('\n') + '\n' + SCHEMA_MD_SKELETON.slice(endLineEnd);
}

describe('parseWikiSchema — 合法输入', () => {
  it('默认骨架可完整解析为默认路由', () => {
    const res = parseWikiSchema(SCHEMA_MD_SKELETON);
    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(res.routing.typeDirs).toEqual(DEFAULT_TYPE_DIRS);
    }
  });

  it('固定八类类型齐全', () => {
    expect([...WIKI_PAGE_TYPES]).toEqual([
      'source', 'entity', 'concept', 'comparison',
      'synthesis', 'query', 'pitfall', 'interface',
    ]);
  });

  it('行顺序无关、容忍额外说明列与表格前后散文', () => {
    const md = withTableRows([
      '| interface | interfaces | 接口 |',
      '| concept | concepts | 概念 |',
      '| source | sources | 来源 |',
      '| entity | entities | 实体 |',
      '| comparison | comparisons | 对照 |',
      '| synthesis | synthesis | 综合 |',
      '| query | queries | 问答 |',
      '| pitfall | pitfalls | 踩坑 |',
    ]);
    const res = parseWikiSchema(md);
    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(res.routing.typeDirs.concept).toBe('concepts');
      expect(res.routing.typeDirs.pitfall).toBe('pitfalls');
    }
  });

  it('目录允许带尾随空格与嵌套子目录', () => {
    const md = withTableRows([
      '| source | sources | 来源 |',
      '| entity | entities/nested | 实体 |',
      '| concept | concepts | 概念 |',
      '| comparison | comparisons | 对照 |',
      '| synthesis | synthesis | 综合 |',
      '| query | queries | 问答 |',
      '| pitfall | pitfalls | 踩坑 |',
      '| interface | interfaces | 接口 |',
    ]);
    const res = parseWikiSchema(md);
    expect(res.ok).toBe(true);
    if (res.ok) expect(res.routing.typeDirs.entity).toBe('entities/nested');
  });
});

describe('parseWikiSchema — 拒绝非法输入', () => {
  it('缺少 ## Page Types 段', () => {
    const md = SCHEMA_MD_SKELETON.replace(/## Page Types[\s\S]*?## Writing Rules/, '## Writing Rules');
    const res = parseWikiSchema(md);
    expect(res.ok).toBe(false);
    expect(issueCodes(res)).toContain('missingPageTypes');
  });

  it('表头第一列不是 type', () => {
    const md = SCHEMA_MD_SKELETON.replace('| type | 目录 | 说明 |', '| 类型 | 目录 | 说明 |');
    const res = parseWikiSchema(md);
    expect(res.ok).toBe(false);
    expect(issueCodes(res)).toContain('missingHeader');
  });

  it('缺少一个类型 → missingType 且指出缺谁', () => {
    const md = withTableRows([
      '| source | sources | 来源 |',
      '| entity | entities | 实体 |',
      '| comparison | comparisons | 对照 |',
      '| synthesis | synthesis | 综合 |',
      '| query | queries | 问答 |',
      '| pitfall | pitfalls | 踩坑 |',
      '| interface | interfaces | 接口 |',
    ]);
    const res = parseWikiSchema(md);
    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(issueCodes(res)).toContain('missingType');
      const missing = res.issues.find((i) => i.code === 'missingType');
      expect(missing?.message).toContain('concept');
    }
  });

  it('未知类型被拒绝（本期不支持新增类型）', () => {
    const md = withTableRows([
      '| source | sources | 来源 |',
      '| entity | entities | 实体 |',
      '| concept | concepts | 概念 |',
      '| comparison | comparisons | 对照 |',
      '| synthesis | synthesis | 综合 |',
      '| query | queries | 问答 |',
      '| pitfall | pitfalls | 踩坑 |',
      '| interface | interfaces | 接口 |',
      '| foobar | foobars | 自创 |',
    ]);
    const res = parseWikiSchema(md);
    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(issueCodes(res)).toContain('unknownType');
      const unknown = res.issues.find((i) => i.code === 'unknownType');
      expect(unknown?.message).toContain('foobar');
    }
  });

  it('重复类型 → duplicateType', () => {
    const md = withTableRows([
      '| source | sources | 来源 |',
      '| entity | entities | 实体 |',
      '| concept | concepts | 概念 |',
      '| comparison | comparisons | 对照 |',
      '| synthesis | synthesis | 综合 |',
      '| query | queries | 问答 |',
      '| pitfall | pitfalls | 踩坑 |',
      '| interface | interfaces | 接口 |',
      '| concept | more-concepts | 又一个概念 |',
    ]);
    const res = parseWikiSchema(md);
    expect(res.ok).toBe(false);
    expect(issueCodes(res)).toContain('duplicateType');
  });

  it('重复目录 → duplicateDir', () => {
    const md = withTableRows([
      '| source | sources | 来源 |',
      '| entity | sources | 实体 |',
      '| concept | concepts | 概念 |',
      '| comparison | comparisons | 对照 |',
      '| synthesis | synthesis | 综合 |',
      '| query | queries | 问答 |',
      '| pitfall | pitfalls | 踩坑 |',
      '| interface | interfaces | 接口 |',
    ]);
    const res = parseWikiSchema(md);
    expect(res.ok).toBe(false);
    expect(issueCodes(res)).toContain('duplicateDir');
  });

  it('保留聚合目录（index/overview/log）被拒绝', () => {
    for (const reserved of RESERVED_AGGREGATE_NAMES) {
      const md = withTableRows([
        '| source | sources | 来源 |',
        '| entity | entities | 实体 |',
        '| concept | concepts | 概念 |',
        '| comparison | comparisons | 对照 |',
        '| synthesis | synthesis | 综合 |',
        '| query | queries | 问答 |',
        '| pitfall | pitfalls | 踩坑 |',
        '| interface | interfaces | 接口 |',
        '| query | ' + reserved + ' | 占用聚合 |',
      ]);
      const res = parseWikiSchema(md);
      expect(res.ok).toBe(false);
      expect(issueCodes(res)).toContain('reservedDir');
    }
  });

  it('目录穿越 / 空段 / 绝对路径 → invalidDir', () => {
    for (const bad of ['../escape', 'a//b', '/abs', 'C:evil']) {
      const md = withTableRows([
        '| source | sources | 来源 |',
        '| entity | entities | 实体 |',
        '| concept | concepts | 概念 |',
        '| comparison | comparisons | 对照 |',
        '| synthesis | synthesis | 综合 |',
        '| query | queries | 问答 |',
        '| pitfall | pitfalls | 踩坑 |',
        '| interface | interfaces | 接口 |',
        '| query | ' + bad + ' | 非法 |',
      ]);
      const res = parseWikiSchema(md);
      expect(res.ok).toBe(false);
      expect(issueCodes(res)).toContain('invalidDir');
    }
  });

  it('目录单元格为空 → missingDir', () => {
    const md = withTableRows([
      '| source | sources | 来源 |',
      '| entity |  | 实体 |',
      '| concept | concepts | 概念 |',
      '| comparison | comparisons | 对照 |',
      '| synthesis | synthesis | 综合 |',
      '| query | queries | 问答 |',
      '| pitfall | pitfalls | 踩坑 |',
      '| interface | interfaces | 接口 |',
    ]);
    const res = parseWikiSchema(md);
    expect(res.ok).toBe(false);
    expect(issueCodes(res)).toContain('missingDir');
  });

  it('issues 都带可读 message（含出错标识）', () => {
    const md = withTableRows([
      '| source | sources | 来源 |',
      '| entity | sources | 实体 |',
      '| concept | concepts | 概念 |',
      '| comparison | comparisons | 对照 |',
      '| synthesis | synthesis | 综合 |',
      '| query | queries | 问答 |',
      '| pitfall | pitfalls | 踩坑 |',
      '| interface | interfaces | 接口 |',
    ]);
    const res = parseWikiSchema(md);
    expect(res.ok).toBe(false);
    if (!res.ok) {
      for (const issue of res.issues) {
        expect(issue.message.length).toBeGreaterThan(0);
      }
    }
  });
});

describe('保留聚合名', () => {
  it('固定为 index/overview/log', () => {
    expect([...RESERVED_AGGREGATE_NAMES]).toEqual(['index', 'overview', 'log']);
  });
});
