/**
 * wiki-search 统一关键词检索测试（issue 14，spec §8）。
 *
 * 覆盖验收映射 A14：
 *  - 分词：中文相邻双字 bigram、单字兜底；AWLEN / [7:0] / 0x10 / tRCD
 *    等工程符号原样精确匹配（分词不拆 [ ] : . _ -）
 *  - 元数据（标题/summary/keywords/tags）与正文合为一份排名，
 *    标题命中排在正文-only 命中之前
 *  - 只检索已发布 wiki 页与当前可用 parsed；聚合页 / orphan /
 *    staging / 坏元数据页不参与；无嵌入也能搜（mode 恒 'keyword'）
 *  - stale：frontmatter sources 与 manifest 当前修订动态核对
 *  - parsed 修订标注用 parsedRevision（旧全文不得伪装为当前）
 *  - 去重、topK（默认 20，范围 1–50）、同分按规范身份稳定排序
 *  - kind / pageType / tag 筛选
 *  - 失败态：emptyQuery、readGateBlocked（prepared 事务）、
 *    catalogFailed（manifest 缺失）
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  searchWiki,
  tokenizeQuery,
} from '../src/main/kb/wiki-search';
import { initWikiLayout, writeWikiManifest, wikiLayout } from '../src/main/kb/wiki-layout';
import type { WikiKbManifest } from '../src/main/kb/wiki-layout';
import type { WikiSourceRecord } from '@shared/kb-types';

let kbPath: string;

beforeEach(async () => {
  kbPath = mkdtempSync(join(tmpdir(), 'sv-kb-search-'));
  await initWikiLayout(kbPath, { kbId: 'kb-search', name: '检索测试库' });
});

afterEach(() => {
  rmSync(kbPath, { recursive: true, force: true });
});

const PAGE_FM = (type: string, title: string, extra: Record<string, string> = {}): string => {
  const base: Array<[string, string]> = [
    ['type', type],
    ['title', `"${title}"`],
    ['summary', '测试页摘要。'],
    ['keywords', '[测试]'],
    ['tags', '[单测]'],
    ['sources', '[]'],
    ['created', '"2026-09-13T00:00:00Z"'],
    ['updated', '"2026-09-13T00:00:00Z"'],
    ...Object.entries(extra).map(([k, v]) => [k, v] as [string, string]),
  ];
  // 同名 key 后者覆盖前者（避免重复 YAML key 解析报错）
  const merged = new Map(base);
  const lines = Array.from(merged, ([k, v]) => `${k}: ${v}`);
  return [
    '---',
    ...lines,
    '---',
    '',
    `# ${title}`,
    '',
  ].join('\n');
};

/** 在 wiki/ 下写页面。rel 形如 `concepts/axi.md` 或 `index.md` */
function writeWikiPage(rel: string, content: string): void {
  const abs = join(kbPath, 'wiki', rel);
  mkdirSync(abs.replace(/[\\/][^\\/]*$/, ''), { recursive: true });
  writeFileSync(abs, content, 'utf-8');
}

/** 覆写 manifest（在 initWikiLayout 基础上附加 sources） */
async function writeSources(sources: Record<string, WikiSourceRecord>): Promise<void> {
  const manifest: WikiKbManifest = {
    manifestVersion: 1,
    format: 'wiki',
    kbId: 'kb-search',
    name: '检索测试库',
    createdAt: '2026-09-13T00:00:00Z',
    updatedAt: '2026-09-13T00:00:00Z',
    sources,
  };
  await writeWikiManifest(kbPath, manifest);
}

const sourceRecord = (overrides: Partial<WikiSourceRecord>): WikiSourceRecord => ({
  sourcePath: 'spec/dds.pdf',
  sourceId: 'src-1',
  ext: '.pdf',
  size: 100,
  currentRevision: 'rev-a',
  parsedRevision: 'rev-a',
  parsedHash: 'ph',
  engine: 'anydoc',
  engineFingerprint: 'fp',
  status: 'ready',
  assetCount: 0,
  importedAt: '2026-09-13T00:00:00Z',
  updatedAt: '2026-09-13T00:00:00Z',
  ...overrides,
});

// ── 分词 ────────────────────────────────────────────────────────

describe('tokenizeQuery', () => {
  it('中文按相邻双字 bigram 拆分并保留单字兜底', () => {
    const tokens = tokenizeQuery('异步复位');
    expect(tokens).toContain('异步');
    expect(tokens).toContain('步复');
    expect(tokens).toContain('复位');
    expect(tokens).toContain('异');
    expect(tokens).toContain('位');
  });

  it('工程符号原样保留：[7:0]、0x10、AWLEN、tRCD 不被拆碎', () => {
    const tokens = tokenizeQuery('AWLEN [7:0] 0x10 tRCD');
    expect(tokens).toContain('awlen');
    expect(tokens).toContain('[7:0]');
    expect(tokens).toContain('0x10');
    expect(tokens).toContain('trcd');
    expect(tokens).not.toContain('7:0]'); // [ 未参与分词
  });

  it('空白与常见标点分词；空查询返回空数组', () => {
    expect(tokenizeQuery('axi,协议;ace|lite')).toContain('axi');
    expect(tokenizeQuery('axi,协议;ace|lite')).toContain('ace');
    expect(tokenizeQuery('  ')).toEqual([]);
  });
});

// ── 排名与命中 ──────────────────────────────────────────────────

describe('searchWiki — 排名与匹配', () => {
  it('标题命中排在正文-only 命中之前（元数据与正文合为一份排名）', async () => {
    // 标题命中页：正文（含标题行）不含查询词，只有 frontmatter title 命中
    writeWikiPage('concepts/dds.md', [
      '---',
      'type: concept',
      'title: "ZetaQ 标志页"',
      'summary: 测试页摘要。',
      'keywords: [测试]',
      'tags: [单测]',
      'sources: []',
      'created: "2026-09-13T00:00:00Z"',
      'updated: "2026-09-13T00:00:00Z"',
      '---',
      '',
      '# 其他标题',
      '',
      '正文没有查询词。',
    ].join('\n'));
    writeWikiPage('concepts/other.md', PAGE_FM('concept', '无关页') + '\n这里提到了 ZetaQ 的边注。\n');

    const res = await searchWiki(kbPath, { query: 'ZetaQ' });
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.result.hits.length).toBe(2);
    expect(res.result.hits[0].id).toBe('concepts/dds');
    expect(res.result.hits[0].score).toBeGreaterThan(res.result.hits[1].score);
    // 元数据命中无正文片段
    expect(res.result.hits[0].snippet).toBeNull();
    expect(res.result.hits[1].snippet).not.toBeNull();
  });

  it('中文 bigram 命中正文，snippet 取命中行附近内容', async () => {
    writeWikiPage('concepts/fsm.md', PAGE_FM('concept', '状态机') + '\n本页描述异步复位的行为。\n');

    const res = await searchWiki(kbPath, { query: '异步复位' });
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.result.hits).toHaveLength(1);
    expect(res.result.hits[0].id).toBe('concepts/fsm');
    expect(res.result.hits[0].snippet).toContain('异步复位');
  });

  it('工程符号 [7:0] / 0x10 / AWLEN / tRCD 按原样精确匹配', async () => {
    writeWikiPage('concepts/axi-burst.md', PAGE_FM('concept', 'AXI 突发')
      + '\nAWLEN 的位宽是 [7:0]，起始地址按 0x10 对齐，tRCD 为时序参数。\n');

    for (const q of ['[7:0]', '0x10', 'awlen', 'tRCD']) {
      const res = await searchWiki(kbPath, { query: q });
      expect(res.ok).toBe(true);
      if (!res.ok) return;
      expect(res.result.hits.map((h) => h.id), `query=${q}`).toContain('concepts/axi-burst');
    }
  });

  it('keywords / tags / summary 命中参与排名', async () => {
    writeWikiPage('concepts/kw.md', [
      '---',
      'type: concept',
      'title: 关键词页',
      'summary: 摘要里提到流控',
      'keywords: [backpressure]',
      'tags: [可靠性]',
      'sources: []',
      'created: "2026-09-13T00:00:00Z"',
      'updated: "2026-09-13T00:00:00Z"',
      '---',
      '',
      '# 关键词页',
    ].join('\n'));

    const res = await searchWiki(kbPath, { query: 'backpressure' });
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.result.hits).toHaveLength(1);
    expect(res.result.hits[0].score).toBeGreaterThan(0);
  });

  it('无命中返回空 hits 且 ok（无嵌入也能搜，mode=keyword）', async () => {
    writeWikiPage('concepts/a.md', PAGE_FM('concept', 'A'));
    const res = await searchWiki(kbPath, { query: '不存在的词' });
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.result.hits).toEqual([]);
    expect(res.result.mode).toBe('keyword');
  });
});

// ── 检索范围排除 ────────────────────────────────────────────────

describe('searchWiki — 检索范围', () => {
  it('聚合页（index/overview/log）与 orphan 不参与检索', async () => {
    writeWikiPage('index.md', '# 索引\n\nDDS 汇总。\n');
    writeWikiPage('overview.md', '# 概览\n\nDDS 汇总。\n');
    writeWikiPage('log.md', '# 日志\n\nDDS 变更。\n');
    writeWikiPage('stray/dds.md', '# 路由外页面\n\nDDS。\n'); // 非八类目录 → orphan
    writeWikiPage('concepts/real.md', PAGE_FM('concept', '真实页') + '\nDDS 正文。\n');

    const res = await searchWiki(kbPath, { query: 'DDS' });
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    const ids = res.result.hits.map((h) => h.id);
    expect(ids).toEqual(['concepts/real']);
  });

  it('staging 页面与坏元数据页不参与检索', async () => {
    // staging 在 .kb/staging/ 下，不在 wiki/ 编目范围
    mkdirSync(join(kbPath, '.kb', 'staging', 'tx-1'), { recursive: true });
    writeFileSync(join(kbPath, '.kb', 'staging', 'tx-1', 'staged.md'), '# staging\n\nDDS 草稿。\n', 'utf-8');
    // 坏元数据页：title YAML 未闭合
    writeWikiPage('concepts/broken.md', [
      '---', 'type: concept', 'title: [未闭合', 'summary: ok', 'keywords: []', 'tags: []',
      'sources: []', 'created: "2026-09-13T00:00:00Z"', 'updated: "2026-09-13T00:00:00Z"',
      '---', '', '# 坏页\n\nDDS 正文。\n',
    ].join('\n'));

    const res = await searchWiki(kbPath, { query: 'DDS' });
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.result.hits).toEqual([]);
  });

  it('kind 筛选：wiki / parsed 分别限定检索对象', async () => {
    writeWikiPage('concepts/dds.md', PAGE_FM('concept', 'DDS'));
    await writeSources({
      'src-1': sourceRecord({ sourcePath: 'spec/dds.pdf', currentRevision: 'rev-a', parsedRevision: 'rev-a' }),
    });
    const parsedPath = join(wikiLayout(kbPath).rawParsedDir, 'spec', 'dds.pdf.md');
    mkdirSync(parsedPath.replace(/[\\/][^\\/]*$/, ''), { recursive: true });
    writeFileSync(parsedPath, '来源全文：DDS 直接数字频率合成。\n', 'utf-8');

    const wikiOnly = await searchWiki(kbPath, { query: 'DDS', kind: 'wiki' });
    expect(wikiOnly.ok).toBe(true);
    if (wikiOnly.ok) expect(wikiOnly.result.hits.map((h) => h.kind)).toEqual(['wiki']);

    const parsedOnly = await searchWiki(kbPath, { query: 'DDS', kind: 'parsed' });
    expect(parsedOnly.ok).toBe(true);
    if (parsedOnly.ok) expect(parsedOnly.result.hits.map((h) => h.kind)).toEqual(['parsed']);

    const both = await searchWiki(kbPath, { query: 'DDS' });
    expect(both.ok).toBe(true);
    if (both.ok) expect(both.result.hits).toHaveLength(2);
  });

  it('pageType 与 tag 筛选（仅作用于 wiki 命中）', async () => {
    writeWikiPage('concepts/dds.md', PAGE_FM('concept', 'DDS'));
    writeWikiPage('pitfalls/dds-p.md', PAGE_FM('pitfall', 'DDS 踩坑'));

    const byType = await searchWiki(kbPath, { query: 'DDS', pageType: 'pitfall' });
    expect(byType.ok).toBe(true);
    if (byType.ok) expect(byType.result.hits.map((h) => h.id)).toEqual(['pitfalls/dds-p']);

    // tag 不匹配 → 无 wiki 命中
    const byTag = await searchWiki(kbPath, { query: 'DDS', tag: '不存在的标签' });
    expect(byTag.ok).toBe(true);
    if (byTag.ok) expect(byTag.result.hits).toEqual([]);
  });
});

// ── stale 动态核对 ──────────────────────────────────────────────

describe('searchWiki — stale 与 parsed 修订', () => {
  it('来源引用旧修订 → stale=true；引用当前修订 → false', async () => {
    await writeSources({
      'src-1': sourceRecord({ sourceId: 'src-1', currentRevision: 'rev-b' }),
    });
    writeWikiPage('concepts/stale.md', PAGE_FM('concept', '过期页',
      { sources: "[{ sourceId: 'src-1', sourceRevision: 'rev-a', parsedHash: 'ph' }]" }));
    writeWikiPage('concepts/fresh.md', PAGE_FM('concept', '新鲜页',
      { sources: "[{ sourceId: 'src-1', sourceRevision: 'rev-b', parsedHash: 'ph' }]" }));

    const res = await searchWiki(kbPath, { query: '页' });
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    const byId = new Map(res.result.hits.map((h) => [h.id, h]));
    expect(byId.get('concepts/stale')?.stale).toBe(true);
    expect(byId.get('concepts/fresh')?.stale).toBe(false);
  });

  it('来源已不在 manifest → stale=true', async () => {
    writeWikiPage('concepts/orphan-ref.md', PAGE_FM('concept', '引用被删来源',
      { sources: "[{ sourceId: 'gone', sourceRevision: 'rev-a', parsedHash: 'ph' }]" }));

    const res = await searchWiki(kbPath, { query: '引用' });
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.result.hits.find((h) => h.id === 'concepts/orphan-ref')?.stale).toBe(true);
  });

  it('parsed 命中标注 parsedRevision，旧全文不伪装为当前修订', async () => {
    // currentRevision 已是 rev-b，但转换失败/进行中，磁盘全文仍属 rev-a
    await writeSources({
      'src-1': sourceRecord({ currentRevision: 'rev-b', parsedRevision: 'rev-a' }),
    });
    const parsedPath = join(wikiLayout(kbPath).rawParsedDir, 'spec', 'dds.pdf.md');
    mkdirSync(parsedPath.replace(/[\\/][^\\/]*$/, ''), { recursive: true });
    writeFileSync(parsedPath, '旧版全文：DDS。\n', 'utf-8');

    const res = await searchWiki(kbPath, { query: 'DDS' });
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    const parsed = res.result.hits.find((h) => h.kind === 'parsed');
    expect(parsed).toBeDefined();
    expect(parsed?.sourceRevision).toBe('rev-a');
    expect(parsed?.stale).toBe(false);
  });

  it('parsedRevision 为 null（从未成功转换）→ 不检索其全文；孤儿 parsed 排除', async () => {
    await writeSources({
      'src-2': sourceRecord({ sourceId: 'src-2', sourcePath: 'spec/other.pdf', parsedRevision: null, parsedHash: null, engine: null, engineFingerprint: null, status: 'failed' }),
    });
    const parsedDir = wikiLayout(kbPath).rawParsedDir;
    // src-2 从未转换：不应有文件，但写一个兜底文件确认也被跳过
    const p1 = join(parsedDir, 'spec', 'other.pdf.md');
    mkdirSync(p1.replace(/[\\/][^\\/]*$/, ''), { recursive: true });
    writeFileSync(p1, 'DDS。\n', 'utf-8');
    // 孤儿 parsed：磁盘有文件但 manifest 无对应来源
    const p2 = join(parsedDir, 'spec', 'orphan.pdf.md');
    writeFileSync(p2, 'DDS 孤儿。\n', 'utf-8');

    const res = await searchWiki(kbPath, { query: 'DDS' });
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.result.hits).toEqual([]);
  });
});

// ── 去重 / topK / 稳定排序 ──────────────────────────────────────

describe('searchWiki — 去重、topK 与稳定排序', () => {
  it('topK 默认 20、范围钳制 1–50；同分按规范身份稳定排序', async () => {
    // 25 个同分页（标题都含高频词、正文无命中 → 标题分相同）
    for (let i = 0; i < 25; i++) {
      writeWikiPage(`concepts/z${String(i).padStart(2, '0')}.md`, PAGE_FM('concept', `Zeta 页 ${i}`));
    }

    const all = await searchWiki(kbPath, { query: 'zeta' });
    expect(all.ok).toBe(true);
    if (!all.ok) return;
    expect(all.result.hits).toHaveLength(20); // 默认 topK=20
    // 同分 → 按 kind:id 升序，确定且与遍历顺序无关
    const ids = all.result.hits.map((h) => h.id);
    expect(ids).toEqual([...ids].sort((a, b) => a.localeCompare(b)));

    const two = await searchWiki(kbPath, { query: 'zeta', topK: 2 });
    expect(two.ok).toBe(true);
    if (two.ok) expect(two.result.hits).toHaveLength(2);

    const one = await searchWiki(kbPath, { query: 'zeta', topK: -5 });
    expect(one.ok).toBe(true);
    if (one.ok) expect(one.result.hits).toHaveLength(1);
  });
});

// ── 失败态 ──────────────────────────────────────────────────────

describe('searchWiki — 失败态', () => {
  it('空查询 → emptyQuery', async () => {
    const res = await searchWiki(kbPath, { query: '   ' });
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.error.code).toBe('emptyQuery');
  });

  it('prepared 事务未恢复 → readGateBlocked', async () => {
    writeWikiPage('concepts/a.md', PAGE_FM('concept', 'A'));
    const txDir = join(kbPath, '.kb', 'transactions', 'tx-1');
    mkdirSync(txDir, { recursive: true });
    writeFileSync(join(txDir, 'manifest.json'), JSON.stringify({
      txId: 'tx-1',
      state: 'prepared',
      writes: [{ relPath: 'wiki/concepts/a.md', beforeFile: null, afterFile: 'after-0.bin', afterHash: 'h' }],
    }), 'utf-8');

    const res = await searchWiki(kbPath, { query: 'A' });
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.error.code).toBe('readGateBlocked');
    expect(res.error.message).toContain('未恢复的发布事务');
  });

  it('manifest 缺失 → catalogFailed', async () => {
    const bare = mkdtempSync(join(tmpdir(), 'sv-kb-bare-'));
    try {
      const res = await searchWiki(bare, { query: 'x' });
      expect(res.ok).toBe(false);
      if (res.ok) return;
      expect(res.error.code).toBe('catalogFailed');
    } finally {
      rmSync(bare, { recursive: true, force: true });
    }
  });

  it('coverage 返回参与排名的候选数（wiki 页数 + parsed 份数）', async () => {
    writeWikiPage('concepts/a.md', PAGE_FM('concept', 'A'));
    writeWikiPage('entities/b.md', PAGE_FM('entity', 'B'));
    await writeSources({
      'src-1': sourceRecord({ currentRevision: 'rev-a', parsedRevision: 'rev-a' }),
    });
    const parsedPath = join(wikiLayout(kbPath).rawParsedDir, 'spec', 'dds.pdf.md');
    mkdirSync(parsedPath.replace(/[\\/][^\\/]*$/, ''), { recursive: true });
    writeFileSync(parsedPath, '全文。\n', 'utf-8');

    const res = await searchWiki(kbPath, { query: 'A' });
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.result.coverage).toEqual({ wikiPages: 2, parsedSources: 1 });
    expect(res.result.kbId).toBe('kb-search');
  });
});
