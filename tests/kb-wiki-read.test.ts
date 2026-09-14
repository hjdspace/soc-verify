/**
 * KB 分页证据读取服务测试 — readWikiEvidence（issue 15，spec §2/§8）。
 *
 * 测试缝：kb/wiki-read.ts 的 readWikiEvidence(kbPath, query)。
 * 直接在临时目录构造 wiki 布局库（initWikiLayout + manifest + 页面 +
 * parsed 全文 + revisions 历史快照 + pdf 资产），不 mock 文件系统。
 *
 * 覆盖场景（验收映射 A02/A13/A20；User Stories 51/52）：
 *  - kind=wiki：按 pageId 读已发布页，返回 hash/行号/next；聚合页拒绝
 *  - kind=parsed：当前全文与历史快照（revision/parsedHash 决定定位）
 *  - kind=asset：按 sourceId/revision/assetId 解析原图字节
 *  - 分页：按 next 顺序以 '\n' 拼接 = 原文零丢失零重复（超长行独占一页如实返回）
 *  - 越界：startLine 超过总行数 → outOfRange，不编造空页
 *  - 非法输入：未知 kind、空 id、wiki 带 revision、负 startLine
 *  - 失效/未知引用：未知 pageId、未知 sourceId、未知 revision/assetId
 *    → 结构化错误码，不抛裸异常
 *  - 读取门禁：prepared 事务存在时 readGateBlocked
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { join } from 'node:path';
import { mkdirSync, writeFileSync, rmSync } from 'node:fs';

import { readWikiEvidence } from '../src/main/kb/wiki-read';
import { initWikiLayout, writeWikiManifest, wikiLayout } from '../src/main/kb/wiki-layout';
import type { WikiKbManifest } from '../src/main/kb/wiki-layout';
import { sha256Hex } from '../src/main/kb/hash';

// ─── fixture 工具 ───────────────────────────────────────────

let kbPath: string;

const sourceRecord = (over: Record<string, unknown>): Record<string, unknown> => ({
  sourcePath: 'spec/dds.pdf',
  sourceId: 'src-1',
  ext: '.pdf',
  size: 100,
  currentRevision: 'a'.repeat(64),
  parsedRevision: 'a'.repeat(64),
  parsedHash: 'p1'.padEnd(64, '0'),
  engine: 'anydoc',
  engineFingerprint: 'fp',
  status: 'ready',
  assetCount: 0,
  importedAt: '2026-09-13T00:00:00Z',
  updatedAt: '2026-09-13T00:00:00Z',
  ...over,
});

const writeManifest = async (sources: Record<string, unknown>): Promise<void> => {
  await writeWikiManifest(kbPath, {
    manifestVersion: 1,
    format: 'wiki',
    kbId: 'kb-read-test',
    name: 'Read Test',
    createdAt: '2026-09-13T00:00:00Z',
    updatedAt: '2026-09-13T00:00:00Z',
    sources: sources as unknown as WikiKbManifest['sources'],
  } as unknown as WikiKbManifest);
};

const page = (type: string, title: string, body: string): string => [
  '---',
  `type: ${type}`,
  `title: "${title}"`,
  `summary: ${title}的摘要。`,
  'keywords: [测试]',
  'tags: [单测]',
  'sources: []',
  'created: "2026-09-13T00:00:00Z"',
  'updated: "2026-09-13T00:00:00Z"',
  '---',
  '',
  `# ${title}`,
  '',
  body,
].join('\n');

const writePage = (rel: string, content: string): void => {
  const abs = join(kbPath, 'wiki', rel);
  mkdirSync(abs.replace(/[\\/][^\\/]*$/, ''), { recursive: true });
  writeFileSync(abs, content, 'utf-8');
};

const writeParsed = (rel: string, content: string): void => {
  const abs = join(wikiLayout(kbPath).rawParsedDir, rel);
  mkdirSync(abs.replace(/[\\/][^\\/]*$/, ''), { recursive: true });
  writeFileSync(abs, content, 'utf-8');
};

/** 写历史快照：raw/revisions/<sid>/<rev>/parsed/<hash>.md + 旧原件 */
const writeRevisionSnapshot = (sourceId: string, rev: string, parsedHash: string, content: string): void => {
  const dir = join(wikiLayout(kbPath).rawRevisionsDir, sourceId, rev, 'parsed');
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, `${parsedHash}.md`), content, 'utf-8');
  const revDir = join(wikiLayout(kbPath).rawRevisionsDir, sourceId, rev);
  writeFileSync(join(revDir, 'dds.pdf'), 'old-bytes', 'utf-8');
};

/** 写资产：raw/assets/<sid>/<rev>/<assetId>.png + pdf-assets.json 清单 */
const writeAsset = (sourceId: string, rev: string, assetId: string, page: number): void => {
  const dir = join(wikiLayout(kbPath).rawAssetsDir, sourceId, rev);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, `${assetId}.png`), Buffer.from([0x89, 0x50, 0x4e, 0x47, page & 0xff]));
  const manifest = {
    manifestVersion: 1,
    sourceId,
    revision: rev,
    parsedHash: null,
    extractor: { runtime: 'pdfjs', version: '1' },
    assets: [{
      assetId,
      ext: 'png',
      page,
      method: 'object',
      width: 10,
      height: 10,
    }],
    pages: [],
    stats: { bitmapAssets: 1, renderAssets: 0, textPages: 0, renderCandidates: 0, renderRendered: 0, renderRemaining: 0, totalPages: 1, skipped: 0, failures: [], batchLimitReached: false, cancelled: false },
    extractions: [],
    textLayer: true,
    createdAt: '2026-09-13T00:00:00Z',
    updatedAt: '2026-09-13T00:00:00Z',
  };
  writeFileSync(join(dir, 'pdf-assets.json'), JSON.stringify(manifest), 'utf-8');
};

// ─── 测试 ────────────────────────────────────────────────────

beforeEach(async () => {
  kbPath = join(__dirname, '..', '.tmp-kb-wiki-read', `kb-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`);
  await initWikiLayout(kbPath, { kbId: 'kb-read-test', name: 'Read Test' });
});

afterEach(() => {
  rmSync(join(__dirname, '..', '.tmp-kb-wiki-read'), { recursive: true, force: true });
});

describe('readWikiEvidence — kind=wiki', () => {
  it('按 pageId 读已发布页：hash/行号/next/relativePath', async () => {
    const content = page('concept', 'DDS 原理', 'AWLEN 位宽 [7:0]。');
    writePage('concepts/dds.md', content);
    await writeManifest({});

    const out = await readWikiEvidence(kbPath, { kind: 'wiki', id: 'concepts/dds' });
    expect(out.ok).toBe(true);
    if (!out.ok) return;
    const p = out.page as Extract<typeof out.page, { kind: 'wiki' }>;
    expect(p.kind).toBe('wiki');
    expect(p.id).toBe('concepts/dds');
    expect(p.kbId).toBe('kb-read-test');
    expect(p.relativePath).toBe('wiki/concepts/dds.md');
    expect(p.hash).toBe(sha256Hex(new TextEncoder().encode(content)));
    expect(p.startLine).toBe(1);
    expect(p.endLine).toBe(p.totalLines);
    expect(p.next).toBeNull();
    expect(p.content).toBe(content);
    expect(p.title).toBe('DDS 原理');
    expect(p.pageType).toBe('concept');
  });

  it('聚合页（index/overview/log）拒绝读取：invalidTarget', async () => {
    writePage('index.md', '# 索引\n\n- [[concepts/dds]]\n');
    await writeManifest({});

    const out = await readWikiEvidence(kbPath, { kind: 'wiki', id: 'index' });
    expect(out.ok).toBe(false);
    if (out.ok) return;
    expect(out.error.code).toBe('invalidTarget');
  });

  it('未知 pageId：unknownPage（不猜路径）', async () => {
    await writeManifest({});
    const out = await readWikiEvidence(kbPath, { kind: 'wiki', id: 'concepts/不存在' });
    expect(out.ok).toBe(false);
    if (out.ok) return;
    expect(out.error.code).toBe('unknownPage');
  });

  it('wiki 带 revision 参数：invalidInput（页面历史读取不在本票范围）', async () => {
    writePage('concepts/dds.md', page('concept', 'DDS 原理', '正文。'));
    await writeManifest({});
    const out = await readWikiEvidence(kbPath, { kind: 'wiki', id: 'concepts/dds', revision: 'a'.repeat(64) });
    expect(out.ok).toBe(false);
    if (out.ok) return;
    expect(out.error.code).toBe('invalidInput');
  });
});

describe('readWikiEvidence — kind=parsed', () => {
  it('当前全文：hash = manifest parsedHash，revision = parsedRevision', async () => {
    const content = '来源全文：DDS 直接频率合成。\n第二行。\n';
    writeParsed('spec/dds.pdf.md', content);
    await writeManifest({ 'src-1': sourceRecord({}) });

    const out = await readWikiEvidence(kbPath, { kind: 'parsed', id: 'src-1' });
    expect(out.ok).toBe(true);
    if (!out.ok) return;
    const p = out.page as Extract<typeof out.page, { kind: 'parsed' }>;
    expect(p.hash).toBe('p1'.padEnd(64, '0'));
    expect(p.revision).toBe('a'.repeat(64));
    expect(p.isHistorical).toBe(false);
    expect(p.relativePath).toBe('raw/parsed/spec/dds.pdf.md');
    expect(p.content).toBe(content);
  });

  it('历史快照：revision/parsedHash 决定定位（isHistorical）', async () => {
    const oldContent = '旧版全文（被引用的历史证据）。\n';
    const oldHash = 'b'.repeat(64);
    const oldRev = 'c'.repeat(64);
    writeRevisionSnapshot('src-1', oldRev, oldHash, oldContent);
    writeParsed('spec/dds.pdf.md', '新版全文。\n');
    await writeManifest({ 'src-1': sourceRecord({}) });

    const out = await readWikiEvidence(kbPath, { kind: 'parsed', id: 'src-1', revision: oldRev, parsedHash: oldHash });
    expect(out.ok).toBe(true);
    if (!out.ok) return;
    const p = out.page as Extract<typeof out.page, { kind: 'parsed' }>;
    expect(p.isHistorical).toBe(true);
    expect(p.revision).toBe(oldRev);
    expect(p.hash).toBe(oldHash);
    expect(p.content).toBe(oldContent);
    expect(p.relativePath).toBe(`raw/revisions/src-1/${oldRev}/parsed/${oldHash}.md`);
  });

  it('未知 sourceId：sourceNotFound', async () => {
    await writeManifest({});
    const out = await readWikiEvidence(kbPath, { kind: 'parsed', id: 'ghost' });
    expect(out.ok).toBe(false);
    if (out.ok) return;
    expect(out.error.code).toBe('sourceNotFound');
  });

  it('从未成功转换：noParsed（不把旧全文伪装成新版）', async () => {
    await writeManifest({ 'src-1': sourceRecord({ parsedRevision: null, parsedHash: null, status: 'failed' }) });
    const out = await readWikiEvidence(kbPath, { kind: 'parsed', id: 'src-1' });
    expect(out.ok).toBe(false);
    if (out.ok) return;
    expect(out.error.code).toBe('noParsed');
  });

  it('历史修订无对应快照：snapshotNotFound', async () => {
    await writeManifest({ 'src-1': sourceRecord({}) });
    const out = await readWikiEvidence(kbPath, {
      kind: 'parsed', id: 'src-1', revision: 'e'.repeat(64), parsedHash: 'f'.repeat(64),
    });
    expect(out.ok).toBe(false);
    if (out.ok) return;
    expect(out.error.code).toBe('snapshotNotFound');
  });
});

describe('readWikiEvidence — kind=asset', () => {
  // 资产身份是内容 hash：sourceId/assetId 必须是 64 位 hex（真实系统由
  // 路径 SHA256 / 字节 SHA256 生成）；hex 校验同时防路径穿越
  const SID = 'aa'.repeat(32);

  it('解析原图字节：base64、mimeType、页码与提取方式', async () => {
    const rev = 'a'.repeat(64);
    const assetId = '1'.repeat(64);
    writeAsset(SID, rev, assetId, 3);
    await writeManifest({ [SID]: sourceRecord({ sourceId: SID, assetCount: 1 }) });

    const out = await readWikiEvidence(kbPath, { kind: 'asset', id: SID, assetId });
    expect(out.ok).toBe(true);
    if (!out.ok) return;
    const p = out.page as Extract<typeof out.page, { kind: 'asset' }>;
    expect(p.kind).toBe('asset');
    expect(p.revision).toBe(rev);
    expect(p.assetId).toBe(assetId);
    expect(p.hash).toBe(assetId);
    expect(p.mimeType).toBe('image/png');
    expect(p.page).toBe(3);
    expect(p.method).toBe('object');
    expect(p.relativePath).toBe(`raw/assets/${SID}/${rev}/${assetId}.png`);
    expect(Buffer.from(p.dataBase64, 'base64').length).toBeGreaterThan(0);
  });

  it('历史修订的原图可以打开（引用旧来源的图）', async () => {
    const oldRev = 'c'.repeat(64);
    const assetId = '2'.repeat(64);
    writeAsset(SID, oldRev, assetId, 1);
    await writeManifest({ [SID]: sourceRecord({ sourceId: SID, assetCount: 1 }) });

    const out = await readWikiEvidence(kbPath, { kind: 'asset', id: SID, revision: oldRev, assetId });
    expect(out.ok).toBe(true);
  });

  it('assetId 缺失：invalidInput；未知 assetId：assetNotFound', async () => {
    await writeManifest({ [SID]: sourceRecord({ sourceId: SID }) });

    const noId = await readWikiEvidence(kbPath, { kind: 'asset', id: SID });
    expect(noId.ok).toBe(false);
    if (!noId.ok) expect(noId.error.code).toBe('invalidInput');

    const ghost = await readWikiEvidence(kbPath, { kind: 'asset', id: SID, assetId: '9'.repeat(64) });
    expect(ghost.ok).toBe(false);
    if (!ghost.ok) expect(ghost.error.code).toBe('assetNotFound');
  });
});

describe('readWikiEvidence — 分页', () => {
  const lines = (n: number, prefix = '行'): string =>
    Array.from({ length: n }, (_, i) => `${prefix}${i + 1}: ${'x'.repeat(20)}`).join('\n');

  it('按 next 顺序分页，以换行符拼接 = 原文零丢失零重复', async () => {
    const content = `${lines(50)}\n`;
    writeParsed('spec/dds.pdf.md', content);
    await writeManifest({ 'src-1': sourceRecord({}) });

    const pages: string[] = [];
    let startLine: number | undefined;
    let last: string | null = null;
    for (let guard = 0; guard < 100; guard++) {
      const out = await readWikiEvidence(kbPath, {
        kind: 'parsed', id: 'src-1', ...(startLine !== undefined ? { startLine } : {}), maxChars: 150,
      });
      expect(out.ok).toBe(true);
      if (!out.ok) return;
      const p = out.page as Extract<typeof out.page, { kind: 'parsed' }>;
      pages.push(p.content);
      last = p.next === null ? null : String(p.next);
      if (last === null) break;
      startLine = Number(last);
    }
    expect(last).toBeNull();
    expect(pages.length).toBeGreaterThan(1);
    expect(pages.join('\n')).toBe(content);
  });

  it('超长行独占一页：如实返回实际长度（不截断、不编造）', async () => {
    const content = `${'超'.repeat(300)}\n尾行\n`;
    writeParsed('spec/dds.pdf.md', content);
    await writeManifest({ 'src-1': sourceRecord({}) });

    const first = await readWikiEvidence(kbPath, { kind: 'parsed', id: 'src-1', maxChars: 100 });
    expect(first.ok).toBe(true);
    if (!first.ok) return;
    const p1 = first.page as Extract<typeof first.page, { kind: 'parsed' }>;
    expect(p1.startLine).toBe(1);
    expect(p1.endLine).toBe(1);
    expect(p1.content).toBe('超'.repeat(300));
    expect(p1.next).toBe(2);

    const second = await readWikiEvidence(kbPath, { kind: 'parsed', id: 'src-1', startLine: 2, maxChars: 100 });
    expect(second.ok).toBe(true);
    if (!second.ok) return;
    const p2 = second.page as Extract<typeof second.page, { kind: 'parsed' }>;
    // 末尾空行属于最后一页 → content 以 '\n' 结束，next = null
    expect(p2.content).toBe('尾行\n');
    expect(p2.next).toBeNull();
  });

  it('startLine 越界：outOfRange 结构化错误，不编造空页', async () => {
    writeParsed('spec/dds.pdf.md', '只有一行\n');
    await writeManifest({ 'src-1': sourceRecord({}) });

    const out = await readWikiEvidence(kbPath, { kind: 'parsed', id: 'src-1', startLine: 99 });
    expect(out.ok).toBe(false);
    if (out.ok) return;
    expect(out.error.code).toBe('outOfRange');
    expect(out.error.message).toContain('99');
  });

  it('非法 startLine/maxChars：invalidInput', async () => {
    writeParsed('spec/dds.pdf.md', '正文\n');
    await writeManifest({ 'src-1': sourceRecord({}) });

    const bad = await readWikiEvidence(kbPath, { kind: 'parsed', id: 'src-1', startLine: 0 });
    expect(bad.ok).toBe(false);
    if (!bad.ok) expect(bad.error.code).toBe('invalidInput');

    const badMax = await readWikiEvidence(kbPath, { kind: 'parsed', id: 'src-1', maxChars: -5 });
    expect(badMax.ok).toBe(false);
    if (!badMax.ok) expect(badMax.error.code).toBe('invalidInput');
  });
});

describe('readWikiEvidence — 输入与门禁', () => {
  it('未知 kind 与空 id：invalidKind / emptyId', async () => {
    await writeManifest({});
    const badKind = await readWikiEvidence(kbPath, { kind: 'log' as 'wiki', id: 'log' });
    expect(badKind.ok).toBe(false);
    if (!badKind.ok) expect(badKind.error.code).toBe('invalidKind');

    const emptyId = await readWikiEvidence(kbPath, { kind: 'wiki', id: '  ' });
    expect(emptyId.ok).toBe(false);
    if (!emptyId.ok) expect(emptyId.error.code).toBe('emptyId');
  });

  it('读取门禁：存在 prepared 事务时 readGateBlocked', async () => {
    writePage('concepts/dds.md', page('concept', 'DDS', '正文。'));
    await writeManifest({});
    const txDir = join(wikiLayout(kbPath).transactionsDir, 'tx-1');
    mkdirSync(txDir, { recursive: true });
    writeFileSync(join(txDir, 'manifest.json'), JSON.stringify({ txId: 'tx-1', state: 'prepared' }), 'utf-8');

    const out = await readWikiEvidence(kbPath, { kind: 'wiki', id: 'concepts/dds' });
    expect(out.ok).toBe(false);
    if (!out.ok) expect(out.error.code).toBe('readGateBlocked');
  });
});
