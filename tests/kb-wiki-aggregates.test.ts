/**
 * 确定性聚合与日志生成器测试（issue 06）。
 *
 * 验收（spec §6、§8）：
 *  - 正式页与 index/overview/log 属同一次提交 → 聚合内容必须确定性
 *    （同一目录两次生成逐字节相同，否则提交会被误判为「有变动」）；
 *  - 所有页都登记，坏元数据单独报错，不静默漏项；
 *  - 日志追加幂等：同一 commitId 重放不重复写日志。
 */

import { describe, it, expect } from 'vitest';
import {
  buildWikiIndex,
  buildWikiOverview,
  buildWikiLogEntry,
  appendLogEntryIdempotent,
  LOG_HEADER,
} from '../src/main/kb/wiki-aggregates';
import { DEFAULT_TYPE_DIRS } from '../src/main/kb/wiki-schema';
import type { WikiCatalog, WikiCatalogPage, WikiPageParseResult } from '@shared/kb-types';

function page(
  pageId: string,
  type: WikiCatalogPage['type'],
  title: string,
  summary: string,
  keywords: string[] = [],
): WikiCatalogPage {
  const parse: WikiPageParseResult = {
    ok: true,
    frontmatter: {
      type,
      title,
      summary,
      keywords,
      tags: [],
      sources: [],
      created: '2026-09-13T00:00:00Z',
      updated: '2026-09-13T00:00:00Z',
    },
    body: '',
  };
  return {
    pageId,
    relPath: `wiki/${pageId}.md`,
    type,
    kind: 'page',
    parse,
    routeMismatch: false,
  };
}

function broken(pageId: string): WikiCatalogPage {
  return {
    pageId,
    relPath: `wiki/${pageId}.md`,
    type: 'concept',
    kind: 'page',
    parse: { ok: false, issues: [{ code: 'missingFrontmatter', message: '缺少 frontmatter' }] },
    routeMismatch: false,
  };
}

function catalog(pages: WikiCatalogPage[]): WikiCatalog {
  return {
    typeDirs: DEFAULT_TYPE_DIRS,
    pages,
    aggregates: [],
    orphans: [],
  };
}

describe('buildWikiIndex', () => {
  it('按类型（固定八类顺序）与 pageId 确定性排序', () => {
    const c = catalog([
      page('concepts/zeta', 'concept', 'Zeta', '末位。'),
      page('sources/b-spec', 'source', 'B 手册', 'B。'),
      page('concepts/alpha', 'concept', 'Alpha', '首位。'),
    ]);
    const out = buildWikiIndex(c);
    expect(out.indexOf('sources/b-spec')).toBeLessThan(out.indexOf('concepts/alpha'));
    expect(out.indexOf('concepts/alpha')).toBeLessThan(out.indexOf('concepts/zeta'));
  });

  it('同一目录两次生成逐字节相同（确定性）', () => {
    const c = catalog([
      page('concepts/b', 'concept', 'B', 'b。'),
      page('entities/a', 'entity', 'A', 'a。'),
    ]);
    expect(buildWikiIndex(c)).toBe(buildWikiIndex(c));
  });

  it('输入顺序不同不改变输出（排序而非稳定遍历）', () => {
    const a = page('concepts/a', 'concept', 'A', 'a。');
    const b = page('concepts/b', 'concept', 'B', 'b。');
    expect(buildWikiIndex(catalog([a, b]))).toBe(buildWikiIndex(catalog([b, a])));
  });

  it('用 wikilink + 标题 + 摘要登记每一页', () => {
    const out = buildWikiIndex(catalog([page('concepts/axi', 'concept', 'AXI 限制', '区分协议与实现上限。')]));
    expect(out).toContain('[[concepts/axi|AXI 限制]]');
    expect(out).toContain('区分协议与实现上限。');
  });

  it('坏元数据单独报错，不静默漏项', () => {
    const out = buildWikiIndex(catalog([page('concepts/ok', 'concept', 'OK', 'ok。'), broken('concepts/bad')]));
    expect(out).toContain('[[concepts/ok|OK]]');
    expect(out).toContain('concepts/bad');
    expect(out).toContain('缺少 frontmatter');
  });

  it('摘要中的换行被压平成单行（聚合页本身保持行结构）', () => {
    const out = buildWikiIndex(catalog([page('concepts/multi', 'concept', 'Multi', '第一行。\n第二行。')]));
    expect(out).toContain('第一行。 第二行。');
    expect(out.split('\n').filter((l) => l.startsWith('- '))).toHaveLength(1);
  });
});

describe('buildWikiOverview', () => {
  it('登记各类型页数与总数', () => {
    const out = buildWikiOverview(catalog([
      page('concepts/a', 'concept', 'A', 'a。'),
      page('concepts/b', 'concept', 'B', 'b。'),
      page('sources/s', 'source', 'S', 's。'),
    ]));
    expect(out).toContain('| concept | 2 |');
    expect(out).toContain('| source | 1 |');
    expect(out).toContain('共 3 页');
  });

  it('确定性：同目录两次生成一致', () => {
    const c = catalog([page('concepts/a', 'concept', 'A', 'a。')]);
    expect(buildWikiOverview(c)).toBe(buildWikiOverview(c));
  });

  it('坏元数据计入问题行', () => {
    const out = buildWikiOverview(catalog([page('concepts/a', 'concept', 'A', 'a。'), broken('concepts/bad')]));
    expect(out).toContain('| 元数据问题 | 1 |');
  });
});

describe('buildWikiLogEntry / appendLogEntryIdempotent', () => {
  it('日志行以 `## [ISO] <operation> | <subject>` 开头并附 commitId', () => {
    const entry = buildWikiLogEntry({
      at: '2026-09-13T10:00:00Z',
      operation: 'publish',
      subject: 'wiki/concepts/axi.md',
      commitId: 'commit-1',
    });
    expect(entry.split('\n')[0]).toBe('## [2026-09-13T10:00:00Z] publish | wiki/concepts/axi.md');
    expect(entry).toContain('commit-1');
  });

  it('空日志追加时写入表头', () => {
    const entry = buildWikiLogEntry({ at: '2026-09-13T10:00:00Z', operation: 'publish', subject: 's', commitId: 'commit-1' });
    const out = appendLogEntryIdempotent(null, entry, 'commit-1');
    expect(out.startsWith(LOG_HEADER)).toBe(true);
    expect(out).toContain('commit-1');
  });

  it('同一 commitId 重放不重复追加（幂等）', () => {
    const entry = buildWikiLogEntry({ at: '2026-09-13T10:00:00Z', operation: 'publish', subject: 's', commitId: 'commit-1' });
    const once = appendLogEntryIdempotent(null, entry, 'commit-1');
    const twice = appendLogEntryIdempotent(once, entry, 'commit-1');
    expect(twice).toBe(once);
  });

  it('不同 commitId 正常追加', () => {
    const e1 = buildWikiLogEntry({ at: '2026-09-13T10:00:00Z', operation: 'publish', subject: 's1', commitId: 'commit-1' });
    const e2 = buildWikiLogEntry({ at: '2026-09-13T11:00:00Z', operation: 'publish', subject: 's2', commitId: 'commit-2' });
    const out = appendLogEntryIdempotent(appendLogEntryIdempotent(null, e1, 'commit-1'), e2, 'commit-2');
    expect(out).toContain('commit-1');
    expect(out).toContain('commit-2');
    expect(out.match(/^## /gm)).toHaveLength(2);
  });

  it('按整行匹配 commitId：前缀相同的另一个 commitId 不被误判为已存在', () => {
    const e1 = buildWikiLogEntry({ at: '2026-09-13T10:00:00Z', operation: 'publish', subject: 's1', commitId: 'commit-1' });
    const e2 = buildWikiLogEntry({ at: '2026-09-13T11:00:00Z', operation: 'publish', subject: 's2', commitId: 'commit-1-extra' });
    const once = appendLogEntryIdempotent(null, e1, 'commit-1');
    const twice = appendLogEntryIdempotent(once, e2, 'commit-1-extra');
    expect(twice.match(/^## /gm)).toHaveLength(2);
  });
});
