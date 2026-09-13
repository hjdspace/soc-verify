/**
 * wiki-page 单元测试（issue 04 — 页面 frontmatter 契约与默认模板）。
 *
 * spec §2：每页最小 frontmatter（type/title/summary/keywords/tags/
 * sources/created/updated）；YAML 安全解析，拒绝重复键、非法对象类型
 * 与过深结构；坏 YAML、未知/缺失类型拒绝。八类默认模板齐全，
 * pitfall/interface 保留对应结构。
 */

import { describe, it, expect } from 'vitest';
import {
  parseWikiPage,
  renderWikiPageTemplate,
  WIKI_PAGE_TEMPLATES,
  type WikiPageIssueCode,
} from '../src/main/kb/wiki-page';
import { WIKI_PAGE_TYPES } from '../src/main/kb/wiki-schema';

function codes(res: ReturnType<typeof parseWikiPage>): Set<WikiPageIssueCode> {
  if (res.ok) throw new Error('expected parse failure, got ok');
  return new Set(res.issues.map((i) => i.code));
}

const VALID_FM = [
  '---',
  'type: concept',
  'title: AXI outstanding 限制',
  'summary: 区分协议允许范围与 DUT 当前实现上限。',
  'keywords: [AXI, outstanding]',
  'tags: [协议约束]',
  'sources:',
  '  - sourceId: aabbcc',
  '    sourceRevision: ddeeff',
  '    parsedHash: 112233',
  'created: "2026-09-13T01:00:00Z"',
  'updated: "2026-09-13T01:00:00Z"',
  '---',
  '',
  '# 正文',
  '',
  '内容。',
].join('\n');

describe('parseWikiPage — 合法输入', () => {
  it('完整 frontmatter + 正文解析成功', () => {
    const res = parseWikiPage(VALID_FM);
    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(res.frontmatter.type).toBe('concept');
      expect(res.frontmatter.title).toBe('AXI outstanding 限制');
      expect(res.frontmatter.keywords).toEqual(['AXI', 'outstanding']);
      expect(res.frontmatter.sources).toHaveLength(1);
      expect(res.frontmatter.sources[0].sourceId).toBe('aabbcc');
      expect(res.body).toContain('# 正文');
    }
  });

  it('sources 为空数组允许（页面可暂无来源引用）', () => {
    const res = parseWikiPage(VALID_FM.replace(/sources:[\s\S]*?parsedHash: 112233/, 'sources: []'));
    expect(res.ok).toBe(true);
    if (res.ok) expect(res.frontmatter.sources).toEqual([]);
  });

  it('允许多余字段（最小契约，不封顶）', () => {
    const res = parseWikiPage(VALID_FM.replace('tags: [协议约束]', 'tags: [协议约束]\nextra: ok'));
    expect(res.ok).toBe(true);
  });
});

describe('parseWikiPage — 拒绝非法输入', () => {
  it('缺少 frontmatter', () => {
    const res = parseWikiPage('# 没有头部\n');
    expect(res.ok).toBe(false);
    expect(codes(res)).toContain('missingFrontmatter');
  });

  it('坏 YAML 语法', () => {
    const bad = VALID_FM.replace('title: AXI outstanding 限制', 'title: [AXI outstanding 限制');
    const res = parseWikiPage(bad);
    expect(res.ok).toBe(false);
    expect(codes(res)).toContain('badYaml');
  });

  it('重复键拒绝', () => {
    const dup = VALID_FM.replace('summary: 区分协议允许范围与 DUT 当前实现上限。', 'summary: 第一版\nsummary: 第二版');
    const res = parseWikiPage(dup);
    expect(res.ok).toBe(false);
    expect(codes(res)).toContain('duplicateKey');
  });

  it('frontmatter 顶层不是对象', () => {
    const res = parseWikiPage('---\n- just\n- a list\n---\nbody\n');
    expect(res.ok).toBe(false);
    expect(codes(res)).toContain('notAnObject');
  });

  it('过深结构拒绝（深度 > 4）', () => {
    const deep = VALID_FM.replace('tags: [协议约束]', 'tags: [协议约束]\nnest:\n  l1:\n    l2:\n      l3:\n        l4: too-deep');
    const res = parseWikiPage(deep);
    expect(res.ok).toBe(false);
    expect(codes(res)).toContain('tooDeep');
  });

  it('缺失必填字段逐个报 missingField', () => {
    const removals: Record<string, string[]> = {
      title: ['^title:.*\\n'],
      summary: ['^summary:.*\\n'],
      keywords: ['^keywords:.*\\n'],
      tags: ['^tags:.*\\n'],
      sources: ['^sources:\\n', '^  - sourceId:.*\\n', '^    sourceRevision:.*\\n', '^    parsedHash:.*\\n'],
      created: ['^created:.*\\n'],
      updated: ['^updated:.*\\n'],
    };
    for (const field of Object.keys(removals)) {
      let removed = VALID_FM;
      for (const pattern of removals[field]) {
        removed = removed.replace(new RegExp(pattern, 'm'), '');
      }
      const res = parseWikiPage(removed);
      expect(res.ok).toBe(false);
      const cs = codes(res);
      expect(cs).toContain('missingField');
      if (!res.ok) {
        expect(res.issues.some((i) => i.code === 'missingField' && i.message.includes(field))).toBe(true);
      }
    }
  });

  it('type 缺失 → missingField + unknownType 语义不混淆', () => {
    const res = parseWikiPage(VALID_FM.replace(/^type:.*\n/m, ''));
    expect(res.ok).toBe(false);
    expect(codes(res)).toContain('missingField');
  });

  it('未知 type 拒绝', () => {
    const res = parseWikiPage(VALID_FM.replace('type: concept', 'type: foobar'));
    expect(res.ok).toBe(false);
    expect(codes(res)).toContain('unknownType');
  });

  it('字段类型错误（keywords 非数组）→ badFieldType', () => {
    const res = parseWikiPage(VALID_FM.replace('keywords: [AXI, outstanding]', 'keywords: AXI'));
    expect(res.ok).toBe(false);
    expect(codes(res)).toContain('badFieldType');
  });

  it('sources 条目缺字段 → badSources', () => {
    const res = parseWikiPage(VALID_FM.replace('    parsedHash: 112233\n', ''));
    expect(res.ok).toBe(false);
    expect(codes(res)).toContain('badSources');
  });

  it('日期不是 ISO → badDate', () => {
    const res = parseWikiPage(VALID_FM.replace('created: "2026-09-13T01:00:00Z"', 'created: "yesterday morning"'));
    expect(res.ok).toBe(false);
    expect(codes(res)).toContain('badDate');
  });

  it('title 为空字符串 → badFieldType（非空要求）', () => {
    const res = parseWikiPage(VALID_FM.replace('title: AXI outstanding 限制', 'title: ""'));
    expect(res.ok).toBe(false);
    expect(codes(res)).toContain('badFieldType');
  });
});

describe('八类默认模板', () => {
  it('八类模板齐全', () => {
    expect(Object.keys(WIKI_PAGE_TEMPLATES).sort()).toEqual([...WIKI_PAGE_TYPES].sort());
  });

  it('pitfall 模板保留 现象/根因/规避/证据 结构', () => {
    const t = WIKI_PAGE_TEMPLATES.pitfall;
    for (const section of ['现象', '根因', '规避', '证据']) {
      expect(t.bodySections.some((s) => s.includes(section))).toBe(true);
    }
  });

  it('interface 模板保留 信号表/位段/时序 结构', () => {
    const t = WIKI_PAGE_TEMPLATES.interface;
    for (const section of ['信号表', '位段', '时序']) {
      expect(t.bodySections.some((s) => s.includes(section))).toBe(true);
    }
  });

  it('渲染产物全部能通过 parseWikiPage（round-trip）', () => {
    const now = '2026-09-13T12:00:00Z';
    for (const type of WIKI_PAGE_TYPES) {
      const md = renderWikiPageTemplate(type, `${WIKI_PAGE_TEMPLATES[type].dir}/example-page`, now);
      const res = parseWikiPage(md);
      expect(res.ok).toBe(true);
      if (res.ok) {
        expect(res.frontmatter.type).toBe(type);
        expect(res.frontmatter.created).toBe(now);
        expect(res.frontmatter.updated).toBe(now);
      }
    }
  });
});
