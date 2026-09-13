/**
 * wiki-catalog 单元测试（issue 04 — 页面目录）。
 *
 * spec §2：页面目录按 pageId（类型路径 + 文件名）标识，标题与
 * basename 不作为唯一主键；坏 YAML、未知/缺失类型按页报错不崩；
 * 聚合页（index/overview/log）单独归类；路由外的文件标 orphan。
 *
 * 用小型合法库 fixture（真实临时目录）演示阅读。
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { rmSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { scanWikiCatalog, wikiCatalogLookup, readWikiPage } from '../src/main/kb/wiki-catalog';
import { initWikiLayout, SCHEMA_MD_SKELETON } from '../src/main/kb/wiki-layout';

let kbPath: string;

const PAGE_FM = (type: string, title: string): string => [
  '---',
  `type: ${type}`,
  `title: "${title}"`,
  'summary: 测试页摘要。',
  'keywords: [测试]',
  'tags: [单测]',
  'sources: []',
  'created: "2026-09-13T00:00:00Z"',
  'updated: "2026-09-13T00:00:00Z"',
  '---',
  '',
  `# ${title}`,
  '',
  '正文含 [[concepts/axi-outstanding|AXI]] 链接。',
].join('\n');

beforeEach(() => {
  kbPath = join(__dirname, `tmp-kb-catalog-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`);
  mkdirSync(kbPath, { recursive: true });
});

afterEach(() => {
  rmSync(kbPath, { recursive: true, force: true });
});

/** 在 wiki/ 下写页面（自动建目录）。rel 形如 `concepts/axi.md` 或 `index.md` */
function writeWikiPage(rel: string, content: string): void {
  const abs = join(kbPath, 'wiki', rel);
  mkdirSync(abs.replace(/[\\/][^\\/]*$/, ''), { recursive: true });
  writeFileSync(abs, content, 'utf-8');
}

describe('scanWikiCatalog', () => {
  it('合法八类库：按 pageId（类型路径+文件名）编目，标题不是主键', async () => {
    await initWikiLayout(kbPath, { kbId: 'kb-1', name: 'KB' });
    writeWikiPage('concepts/axi-outstanding.md', PAGE_FM('concept', '同名标题'));
    writeWikiPage('entities/同名标题.md', PAGE_FM('entity', '同名标题')); // 标题相同，pageId 不同
    writeWikiPage('pitfalls/p1.md', PAGE_FM('pitfall', 'P1'));
    writeWikiPage('sources/s1.md', PAGE_FM('source', 'S1'));
    writeWikiPage('comparisons/c1.md', PAGE_FM('comparison', 'C1'));
    writeWikiPage('synthesis/sy1.md', PAGE_FM('synthesis', 'SY'));
    writeWikiPage('queries/q1.md', PAGE_FM('query', 'Q1'));
    writeWikiPage('interfaces/i1.md', PAGE_FM('interface', 'I1'));

    const res = await scanWikiCatalog(kbPath);
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    const ids = res.catalog.pages.map((p) => p.pageId);
    expect(ids).toContain('concepts/axi-outstanding');
    expect(ids).toContain('entities/同名标题');
    expect(new Set(ids).size).toBe(ids.length); // pageId 唯一
    expect(res.catalog.pages).toHaveLength(8);

    const axi = res.catalog.pages.find((p) => p.pageId === 'concepts/axi-outstanding');
    expect(axi).toMatchObject({ type: 'concept', kind: 'page' });
    if (axi?.parse.ok) expect(axi.parse.frontmatter.title).toBe('同名标题');
  });

  it('聚合页（index/overview/log）单独归类，不进 pages', async () => {
    await initWikiLayout(kbPath, { kbId: 'kb-2', name: 'KB' });
    writeWikiPage('index.md', '# 索引\n');
    writeWikiPage('overview.md', '# 概览\n');
    writeWikiPage('log.md', '# 日志\n');

    const res = await scanWikiCatalog(kbPath);
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.catalog.pages).toHaveLength(0);
    expect(res.catalog.aggregates.map((a) => a.pageId).sort()).toEqual(['index', 'log', 'overview']);
  });

  it('坏 YAML 页面报 issue 不崩，好页面照常编目', async () => {
    await initWikiLayout(kbPath, { kbId: 'kb-3', name: 'KB' });
    writeWikiPage('concepts/broken.md', [
      '---', 'type: concept', 'title: [未闭合', 'summary: ok', 'keywords: []', 'tags: []',
      'sources: []', 'created: "2026-09-13T00:00:00Z"', 'updated: "2026-09-13T00:00:00Z"',
      '---', '', '# 坏页',
    ].join('\n'));
    writeWikiPage('concepts/good.md', PAGE_FM('concept', 'Good'));

    const res = await scanWikiCatalog(kbPath);
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    const broken = res.catalog.pages.find((p) => p.pageId === 'concepts/broken');
    expect(broken).toBeDefined();
    expect(broken?.parse.ok).toBe(false);
    const good = res.catalog.pages.find((p) => p.pageId === 'concepts/good');
    expect(good?.parse.ok).toBe(true);
  });

  it('未知/缺失类型页面报 unknownType/missingField', async () => {
    await initWikiLayout(kbPath, { kbId: 'kb-4', name: 'KB' });
    const fm = (typeLine: string): string => [
      '---',
      typeLine,
      'title: T', 'summary: S', 'keywords: []', 'tags: []', 'sources: []',
      'created: "2026-09-13T00:00:00Z"', 'updated: "2026-09-13T00:00:00Z"',
      '---',
    ].join('\n');
    writeWikiPage('concepts/unknown.md', fm('type: foobar'));
    writeWikiPage('concepts/notype.md', fm('note: this page has no type field'));

    const res = await scanWikiCatalog(kbPath);
    if (!res.ok) throw new Error('catalog should scan');
    const unknown = res.catalog.pages.find((p) => p.pageId === 'concepts/unknown');
    const notype = res.catalog.pages.find((p) => p.pageId === 'concepts/notype');
    const unknownParse = unknown?.parse;
    const notypeParse = notype?.parse;
    expect(unknownParse && !unknownParse.ok).toBe(true);
    expect(notypeParse && !notypeParse.ok).toBe(true);
    if (unknownParse && !unknownParse.ok) {
      expect(unknownParse.issues.some((i) => i.code === 'unknownType')).toBe(true);
    }
    if (notypeParse && !notypeParse.ok) {
      expect(notypeParse.issues.some((i) => i.code === 'missingField')).toBe(true);
    }
  });

  it('目录与类型不匹配（正文 type 与所在路由目录不符）→ routeMismatch 标记', async () => {
    await initWikiLayout(kbPath, { kbId: 'kb-5', name: 'KB' });
    writeWikiPage('concepts/wrong-dir.md', PAGE_FM('entity', '放错目录'));

    const res = await scanWikiCatalog(kbPath);
    if (!res.ok) throw new Error('catalog should scan');
    const page = res.catalog.pages.find((p) => p.pageId === 'concepts/wrong-dir');
    expect(page?.routeMismatch).toBe(true);
  });

  it('路由外的 wiki 根文件 → orphan', async () => {
    await initWikiLayout(kbPath, { kbId: 'kb-6', name: 'KB' });
    writeWikiPage('misc/stray.md', PAGE_FM('concept', '走丢'));

    const res = await scanWikiCatalog(kbPath);
    if (!res.ok) throw new Error('catalog should scan');
    expect(res.catalog.orphans.map((o) => o.relPath)).toContain('wiki/misc/stray.md');
  });

  it('目录查找索引（供链接解析）：byId/byBasename/byTitle', async () => {
    await initWikiLayout(kbPath, { kbId: 'kb-7', name: 'KB' });
    writeWikiPage('concepts/axi-outstanding.md', PAGE_FM('concept', 'AXI 限制'));

    const res = await scanWikiCatalog(kbPath);
    if (!res.ok) throw new Error('catalog should scan');
    const lookup = wikiCatalogLookup(res.catalog);
    expect(lookup.byId.get('concepts/axi-outstanding')).toBeDefined();
    expect(lookup.byBasename.get('axi-outstanding')).toEqual(['concepts/axi-outstanding']);
    expect(lookup.byTitle.get('AXI 限制')).toEqual(['concepts/axi-outstanding']);
  });

  it('嵌套路由目录（schema 允许子目录）的页面可编目与读取', async () => {
    await initWikiLayout(kbPath, { kbId: 'kb-9', name: 'KB' });
    // 把 entity 目录改为嵌套子目录
    writeFileSync(
      join(kbPath, 'schema.md'),
      SCHEMA_MD_SKELETON.replace('| entity | entities | 实体页：IP、模块、信号组 |', '| entity | entities/nested | 实体页 |'),
      'utf-8',
    );
    writeWikiPage('entities/nested/foo.md', PAGE_FM('entity', '嵌套页'));

    const res = await scanWikiCatalog(kbPath);
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.catalog.pages.map((p) => p.pageId)).toContain('entities/nested/foo');
    expect(res.catalog.orphans).toHaveLength(0);

    // readWikiPage 同样可达
    const page = await readWikiPage(kbPath, 'entities/nested/foo');
    expect(page.ok).toBe(true);
    if (page.ok) expect(page.page.content).toContain('# 嵌套页');
  });

  it('schema 损坏 → ok: false + schemaIssues（不回退无约束）', async () => {
    await initWikiLayout(kbPath, { kbId: 'kb-8', name: 'KB' });
    writeFileSync(join(kbPath, 'schema.md'), '# 被破坏的 schema\n\n没有 Page Types 表。\n', 'utf-8');

    const res = await scanWikiCatalog(kbPath);
    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.schemaIssues.length).toBeGreaterThan(0);
    }
  });
});
