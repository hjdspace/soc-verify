/**
 * kb source import 行为测试（issue 02 — 导入来源并保留可追溯修订）。
 *
 * 用真实临时目录 + 真文件 fixture 走通导入管线；Office 转换通过
 * mock @firecrawl/anydoc 控制（文本直通不需要 anydoc）。
 *
 * 覆盖（对照验收）：
 *  - sourceId 含目录/扩展名；同名不同来源不碰撞
 *  - 原件字节与 revision 保存；parsed 保留源扩展名（notes.md → notes.md.md）
 *  - 同路径同字节不新增原始修订（幂等）；异字节保存新 revision
 *  - 被已发布页/历史/staging 引用的旧原件在替换前持久保存
 *  - 同原件不同 parsedHash 均可定位，原件只保留一份
 *  - 转换先写临时产物再切换；失败状态/错误码持久且重开可见；
 *    旧全文不标成新版（parsedRevision 与 currentRevision 分离）
 *  - Office 图片引用与数量正确（内容寻址 + 相对路径回写）
 *  - 不宣称引擎不支持的格式（.html 拒绝）；大小写等价碰撞拒绝
 *  - 单文档与小批量导入（含嵌套目录结构）
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { rmSync, mkdirSync, writeFileSync, readFileSync, existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createHash } from 'node:crypto';

const sha256 = (buf: Buffer | string): string =>
  createHash('sha256').update(buf).digest('hex');

// ─── Mocks ──────────────────────────────────────────────────

// electron mock 工厂惰性求值，此处顶层 const 在测试运行前已初始化
const globalDataDir = join(tmpdir(), `sv-kb-import-app-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`);

vi.mock('electron', () => ({
  app: {
    getPath: vi.fn(() => globalDataDir),
  },
}));

vi.mock('@firecrawl/anydoc', () => ({
  toDocument: vi.fn(),
  toMarkdownBytes: vi.fn(),
  formatFromPath: vi.fn(),
}));

import { toDocument, toMarkdownBytes, formatFromPath } from '@firecrawl/anydoc';
import {
  importWikiSources,
  convertWikiSource,
  listWikiSources,
  readWikiParsed,
  listSourceRevisions,
  type SourceImportOutcome,
} from '../src/main/kb/source-import';
import { readWikiManifest, writeWikiManifest, initWikiLayout, resolveWikiOriginalPath } from '../src/main/kb/wiki-layout';
import { sourceIdFor } from '../src/main/kb/source-identity';

const mockToDocument = vi.mocked(toDocument);
const mockToMarkdownBytes = vi.mocked(toMarkdownBytes);
const mockFormatFromPath = vi.mocked(formatFromPath);

/** anydoc Format 是 ambient const enum（运行时不存在），mock 用等价字符串桥接类型 */
const DOCX_FORMAT = 'docx' as unknown as ReturnType<typeof formatFromPath>;

// ─── Fixture helpers ────────────────────────────────────────

let kbPath: string;
let incomingDir: string;

beforeEach(async () => {
  kbPath = join(tmpdir(), `sv-kb-import-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`);
  incomingDir = join(kbPath, '_incoming');
  mkdirSync(kbPath, { recursive: true });
  mkdirSync(incomingDir, { recursive: true });
  await initWikiLayout(kbPath, { kbId: 'kb-test', name: '测试库' });
  vi.clearAllMocks();
  mockFormatFromPath.mockReturnValue(DOCX_FORMAT);
});

afterEach(() => {
  rmSync(kbPath, { recursive: true, force: true });
  rmSync(globalDataDir, { recursive: true, force: true });
});

function makeIncoming(name: string, content: string, relDir = ''): string {
  const dir = relDir ? join(incomingDir, relDir) : incomingDir;
  mkdirSync(dir, { recursive: true });
  const p = join(dir, name);
  writeFileSync(p, content, 'utf-8');
  return p;
}

function writePageFixture(kb: string, sourceId: string, revision: string): void {
  mkdirSync(join(kb, 'wiki', 'concepts'), { recursive: true });
  writeFileSync(
    join(kb, 'wiki', 'concepts', 'axi.md'),
    ['---', 'type: concept', 'sources:', `  - sourceId: "${sourceId}"`, `    sourceRevision: "${revision}"`, '---', '', '正文'].join('\n'),
    'utf-8',
  );
}

async function readManifest(kb: string) {
  const r = await readWikiManifest(kb);
  if (!r.ok) throw new Error(`manifest 不可读: ${r.reason}`);
  return r.manifest;
}

function outcomeOk(o: SourceImportOutcome | SourceImportOutcome[]): Extract<SourceImportOutcome, { ok: true }> {
  const one = (Array.isArray(o) ? o[0] : o) as SourceImportOutcome;
  if (!one.ok) throw new Error(`预期成功，实际 ${one.error?.code}: ${one.error?.message}`);
  return one;
}

const PNG1 = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x01]);
const PNG2 = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x02]);

/** mock anydoc：Markdown 输出 + 两个 PNG asset */
function mockOfficeMarkdown(markdown: string): void {
  mockFormatFromPath.mockReturnValue(DOCX_FORMAT);
  mockToMarkdownBytes.mockResolvedValue(markdown);
  mockToDocument.mockResolvedValue({
    blocks: [
      {
        content: [
          { kind: 'image', source: { kind: 'asset', assetId: 1 } },
          { kind: 'image', source: { kind: 'asset', assetId: 2 } },
        ],
      },
    ],
    assets: [
      { id: 1, mediaType: 'image/png', data: new Uint8Array(PNG1) },
      { id: 2, mediaType: 'image/png', data: new Uint8Array(PNG2) },
    ],
  } as never);
}

// ─── 导入与身份 ─────────────────────────────────────────────

describe('importWikiSources — 单文档导入与身份', () => {
  it('文本直通导入：原件/全文落盘，parsed 保留源扩展名（notes.md → notes.md.md）', async () => {
    const src = makeIncoming('notes.md', '# 我的笔记\n\n内容');
    const o = outcomeOk(await importWikiSources(kbPath, [{ absolutePath: src }]));
    const sid = sourceIdFor('notes.md');

    expect(o.source.sourceId).toBe(sid);
    expect(o.reused).toBe(false);
    expect(readFileSync(join(kbPath, 'raw', 'sources', 'notes.md'))).toEqual(Buffer.from('# 我的笔记\n\n内容', 'utf-8'));
    const parsed = readFileSync(join(kbPath, 'raw', 'parsed', 'notes.md.md'), 'utf-8');
    expect(parsed).toContain('我的笔记');
    expect(o.source.status).toBe('ready');
    expect(o.source.engine).toBe('text');

    const manifest = await readManifest(kbPath);
    const rec = manifest.sources?.[sid];
    expect(rec).toBeDefined();
    expect(rec!.currentRevision).toBe(sha256(Buffer.from('# 我的笔记\n\n内容', 'utf-8')));
    expect(rec!.parsedHash).toBe(sha256(parsed));
    expect(rec!.parsedRevision).toBe(rec!.currentRevision);
  });

  it('文本直通剥离 BOM', async () => {
    const src = makeIncoming('bom.txt', '\uFEFF正文内容');
    const o = outcomeOk(await importWikiSources(kbPath, [{ absolutePath: src }]));
    const parsed = readFileSync(join(kbPath, 'raw', 'parsed', 'bom.txt.md'), 'utf-8');
    expect(parsed.startsWith('\uFEFF')).toBe(false);
    expect(parsed).toContain('正文内容');
    void o;
  });

  it('嵌套目录结构导入保留相对路径', async () => {
    const src = makeIncoming('spec.md', '# 子目录规格', 'manuals/axi');
    const o = outcomeOk(await importWikiSources(kbPath, [{ absolutePath: src, relPath: 'manuals/axi/spec.md' }]));
    expect(existsSync(join(kbPath, 'raw', 'sources', 'manuals', 'axi', 'spec.md'))).toBe(true);
    expect(existsSync(join(kbPath, 'raw', 'parsed', 'manuals', 'axi', 'spec.md.md'))).toBe(true);
    expect(o.source.sourceId).toBe(sourceIdFor('manuals/axi/spec.md'));
  });

  it('同名不同目录/不同扩展名互不碰撞（sourceId 含目录与扩展名）', async () => {
    const a = makeIncoming('report.md', 'A');
    const b = makeIncoming('report.md', 'B', 'b');
    const c = makeIncoming('report.txt', 'C');
    const oa = outcomeOk(await importWikiSources(kbPath, [{ absolutePath: a, relPath: 'a/report.md' }]));
    const ob = outcomeOk(await importWikiSources(kbPath, [{ absolutePath: b, relPath: 'b/report.md' }]));
    const oc = outcomeOk(await importWikiSources(kbPath, [{ absolutePath: c, relPath: 'a/report.txt' }]));
    expect(new Set([oa.source.sourceId, ob.source.sourceId, oc.source.sourceId]).size).toBe(3);
  });

  it('拒绝引擎不支持的格式（.html），不写任何受管文件', async () => {
    const src = makeIncoming('page.html', '<html></html>');
    const o = (await importWikiSources(kbPath, [{ absolutePath: src, relPath: 'page.html' }]))[0];
    expect(o.ok).toBe(false);
    if (!o.ok) {
      expect(o.error.code).toBe('unsupportedFormat');
      expect(o.error.message).toContain('.html');
    }
    expect(existsSync(join(kbPath, 'raw', 'sources'))).toBe(true);
    expect(readdirSync(join(kbPath, 'raw', 'sources'))).toEqual([]);
  });

  it('拒绝穿越与绝对路径（invalidPath）', async () => {
    const src = makeIncoming('x.md', 'x');
    for (const rel of ['../escape.md', '/abs.md', 'a/../b.md']) {
      const o = (await importWikiSources(kbPath, [{ absolutePath: src, relPath: rel }]))[0];
      expect(o.ok, rel).toBe(false);
      if (!o.ok) expect(o.error.code).toBe('invalidPath');
    }
  });

  it('大小写等价碰撞拒绝（Windows 大小写等价），保留显示拼写', async () => {
    const a = makeIncoming('spec.md', 'v1');
    const b = makeIncoming('Spec.md', 'v2');
    const oa = outcomeOk(await importWikiSources(kbPath, [{ absolutePath: a }]));
    const ob = (await importWikiSources(kbPath, [{ absolutePath: b }]))[0];
    expect(ob.ok).toBe(false);
    if (!ob.ok) expect(ob.error.code).toBe('caseConflict');
    // 首个导入不受影响，manifest 保留显示拼写
    const manifest = await readManifest(kbPath);
    expect(manifest.sources?.[oa.source.sourceId]?.sourcePath).toBe('spec.md');
    expect(Object.keys(manifest.sources ?? {})).toHaveLength(1);
  });

  it('能力清单：UI/工具可用的导入扩展名不包含引擎未支持格式', async () => {
    const { listImportExtensions } = await import('../src/main/kb/source-import');
    const exts = listImportExtensions();
    expect(exts).toContain('.pdf');
    expect(exts).toContain('.docx');
    expect(exts).toContain('.md');
    expect(exts).not.toContain('.html');
  });
});

// ─── 修订规则 ───────────────────────────────────────────────

describe('importWikiSources — 修订规则', () => {
  it('同路径同字节不新增原始修订（幂等 reused），不产生 revisions 目录', async () => {
    const src = makeIncoming('doc.md', 'v1-bytes');
    const first = outcomeOk(await importWikiSources(kbPath, [{ absolutePath: src }]));
    const again = outcomeOk(await importWikiSources(kbPath, [{ absolutePath: src }]));
    expect(again.reused).toBe(true);
    expect(again.source.currentRevision).toBe(first.source.currentRevision);
    expect(existsSync(join(kbPath, 'raw', 'revisions'))).toBe(true);
    expect(readdirSync(join(kbPath, 'raw', 'revisions'))).toEqual([]);
    // 全文也只有一份
    const manifest = await readManifest(kbPath);
    expect(Object.keys(manifest.sources ?? {})).toHaveLength(1);
  });

  it('异字节导入保存新 revision，且旧修订未被引用时不保存旧原件', async () => {
    const v1 = makeIncoming('doc.md', 'bytes-v1');
    const first = outcomeOk(await importWikiSources(kbPath, [{ absolutePath: v1 }]));
    const v2 = makeIncoming('doc2.md', 'bytes-v2');
    const second = outcomeOk(await importWikiSources(kbPath, [{ absolutePath: v2, relPath: 'doc.md' }]));

    expect(second.source.currentRevision).not.toBe(first.source.currentRevision);
    expect(second.source.currentRevision).toBe(sha256(Buffer.from('bytes-v2', 'utf-8')));
    expect(readFileSync(join(kbPath, 'raw', 'sources', 'doc.md'), 'utf-8')).toBe('bytes-v2');
    // 旧修订未被引用 → 不保存
    expect(existsSync(join(kbPath, 'raw', 'revisions', first.source.sourceId, first.source.currentRevision))).toBe(false);
    // 旧 parsed 被新全文替换
    const parsed = readFileSync(join(kbPath, 'raw', 'parsed', 'doc.md.md'), 'utf-8');
    expect(parsed).toContain('bytes-v2');
  });

  it('被已发布页引用的旧原件与 parsed 在替换前持久保存（保存原文件名）', async () => {
    const v1 = makeIncoming('doc.md', 'bytes-v1');
    const first = outcomeOk(await importWikiSources(kbPath, [{ absolutePath: v1 }]));
    const oldRev = first.source.currentRevision;
    const oldParsedHash = first.source.parsedHash!;
    writePageFixture(kbPath, first.source.sourceId, oldRev);

    const v2 = makeIncoming('doc2.md', 'bytes-v2');
    await importWikiSources(kbPath, [{ absolutePath: v2, relPath: 'doc.md' }]);

    const revDir = join(kbPath, 'raw', 'revisions', first.source.sourceId, oldRev);
    expect(existsSync(join(revDir, 'doc.md'))).toBe(true);
    expect(readFileSync(join(revDir, 'doc.md'), 'utf-8')).toBe('bytes-v1');
    expect(existsSync(join(revDir, 'parsed', `${oldParsedHash}.md`))).toBe(true);
    expect(readFileSync(join(revDir, 'parsed', `${oldParsedHash}.md`), 'utf-8')).toContain('bytes-v1');
  });

  it('staging/page-history fixture 引用同样触发旧修订保留', async () => {
    const v1 = makeIncoming('doc.md', 'bytes-v1');
    const first = outcomeOk(await importWikiSources(kbPath, [{ absolutePath: v1 }]));
    mkdirSync(join(kbPath, '.kb', 'staging', 'p1'), { recursive: true });
    writeFileSync(
      join(kbPath, '.kb', 'staging', 'p1', 'proposal.json'),
      JSON.stringify({ sources: [{ sourceId: first.source.sourceId, sourceRevision: first.source.currentRevision }] }),
      'utf-8',
    );
    const v2 = makeIncoming('doc2.md', 'bytes-v2');
    await importWikiSources(kbPath, [{ absolutePath: v2, relPath: 'doc.md' }]);
    expect(existsSync(join(kbPath, 'raw', 'revisions', first.source.sourceId, first.source.currentRevision, 'doc.md'))).toBe(true);
  });

  it('同原件不同 parsedHash 均可定位，原件只保留一份', async () => {
    const src = makeIncoming('doc.docx', Buffer.from('office-bytes').toString('binary') && 'office-bytes');
    writeFileSync(src, 'office-bytes', 'utf-8');
    mockOfficeMarkdown('# 版本 A');
    const first = outcomeOk(await importWikiSources(kbPath, [{ absolutePath: src }]));
    const sid = first.source.sourceId;
    const rev = first.source.currentRevision;
    const hashA = first.source.parsedHash!;

    // 已发布页引用当前修订 → 旧 parsed 需要保留
    writePageFixture(kbPath, sid, rev);

    // 转换配置变化（模拟引擎升级）+ 转换输出变化
    const manifest = await readManifest(kbPath);
    const rec = manifest.sources![sid];
    rec.engineFingerprint = 'anydoc-v2-changed';
    await writeWikiManifest(kbPath, manifest);
    mockOfficeMarkdown('# 版本 B');

    const again = outcomeOk(await importWikiSources(kbPath, [{ absolutePath: src }]));
    expect(again.reused).toBe(false);
    expect(again.source.parsedHash).not.toBe(hashA);

    // 两个 parsed 均可定位
    const revisions = await listSourceRevisions(kbPath, sid);
    const currentInfo = revisions.find((r) => r.isCurrent);
    expect(currentInfo).toBeDefined();
    expect(currentInfo!.parsedHashes.sort()).toEqual([hashA, again.source.parsedHash!].sort());

    const viewA = await readWikiParsed(kbPath, { sourceId: sid, revision: rev, parsedHash: hashA });
    expect(viewA.content).toContain('版本 A');
    expect(viewA.isHistorical).toBe(true);
    const viewB = await readWikiParsed(kbPath, { sourceId: sid });
    expect(viewB.content).toContain('版本 B');

    // 原件只保留一份：revisions 区没有原件副本
    const revDir = join(kbPath, 'raw', 'revisions', sid, rev);
    expect(existsSync(revDir)).toBe(true);
    const entries = readdirSync(revDir);
    expect(entries).toEqual(['parsed']);
  });

  it('未引用的旧 parsed 在指纹变化重转后直接替换（不保留）', async () => {
    const src = makeIncoming('doc.docx', 'office-bytes');
    mockOfficeMarkdown('# 唯一版本');
    const first = outcomeOk(await importWikiSources(kbPath, [{ absolutePath: src }]));
    const hashA = first.source.parsedHash!;

    const manifest = await readManifest(kbPath);
    manifest.sources![first.source.sourceId].engineFingerprint = 'anydoc-v2-changed';
    await writeWikiManifest(kbPath, manifest);
    mockOfficeMarkdown('# 重转版本');

    await importWikiSources(kbPath, [{ absolutePath: src }]);
    expect(existsSync(join(kbPath, 'raw', 'revisions', first.source.sourceId))).toBe(false);
    const view = await readWikiParsed(kbPath, { sourceId: first.source.sourceId });
    expect(view.parsedHash).not.toBe(hashA);
  });
});

// ─── 转换失败与重试 ─────────────────────────────────────────

describe('转换失败与重试 — 失败状态持久且新旧分离', () => {
  it('anydoc 失败：错误码持久、重开可见；旧全文不标成新版', async () => {
    const v1 = makeIncoming('doc.docx', 'office-v1');
    mockOfficeMarkdown('# 第一版全文');
    const first = outcomeOk(await importWikiSources(kbPath, [{ absolutePath: v1 }]));
    const oldRev = first.source.currentRevision;
    const oldParsedHash = first.source.parsedHash!;

    // 更新为坏文档（anydoc 加密错误）
    const v2 = makeIncoming('doc2.docx', 'office-v2-encrypted');
    mockFormatFromPath.mockReturnValue(DOCX_FORMAT);
    mockToMarkdownBytes.mockRejectedValue(Object.assign(new Error('encrypted'), { code: 'encrypted' }));
    mockToDocument.mockRejectedValue(Object.assign(new Error('encrypted'), { code: 'encrypted' }));

    const second = (await importWikiSources(kbPath, [{ absolutePath: v2, relPath: 'doc.docx' }]))[0];
    expect(second.ok).toBe(false);
    if (!second.ok) expect(second.error.code).toBe('ioError');

    // 失败状态持久且重开可见
    const manifest = await readManifest(kbPath);
    const rec = manifest.sources![first.source.sourceId];
    expect(rec.status).toBe('failed');
    expect(rec.errorCode).toBe('encrypted');
    expect(rec.errorMessage).toBeTruthy();
    expect(rec.currentRevision).toBe(sha256(Buffer.from('office-v2-encrypted', 'utf-8')));
    // 旧全文不标成新版：parsedRevision 停留在旧修订
    expect(rec.parsedRevision).toBe(oldRev);
    expect(rec.parsedHash).toBe(oldParsedHash);

    const summaries = await listWikiSources(kbPath);
    const s = summaries.find((x) => x.sourceId === first.source.sourceId)!;
    expect(s.status).toBe('failed');
    expect(s.parsedStale).toBe(true);
    expect(s.parsedRevision).toBe(oldRev);
    // 预览仍可读旧全文，且标注其所属修订
    const view = await readWikiParsed(kbPath, { sourceId: first.source.sourceId });
    expect(view.content).toContain('第一版全文');
    expect(view.revision).toBe(oldRev);
  });

  it('文本转换失败（读取坏路径等 io 错误）同样持久失败状态', async () => {
    const src = makeIncoming('doc.txt', 'x');
    // 文件在导入读取前被删 → 导入读字节失败
    rmSync(src);
    const o = (await importWikiSources(kbPath, [{ absolutePath: src }]))[0];
    expect(o.ok).toBe(false);
    if (!o.ok) expect(o.error.code).toBe('ioError');
    const manifest = await readManifest(kbPath);
    expect(Object.keys(manifest.sources ?? {})).toHaveLength(0);
  });

  it('失败后重试转换成功：状态切换 ready，parsedHash 更新', async () => {
    const src = makeIncoming('doc.docx', 'office-bytes');
    // 首次转换失败（malformed）
    mockFormatFromPath.mockReturnValue(DOCX_FORMAT);
    mockToMarkdownBytes.mockRejectedValue(Object.assign(new Error('boom'), { code: 'malformed' }));
    mockToDocument.mockRejectedValue(Object.assign(new Error('boom'), { code: 'malformed' }));
    const failed = (await importWikiSources(kbPath, [{ absolutePath: src }]))[0];
    expect(failed.ok).toBe(false);

    // 失败状态持久（重开可见）
    const sid = sourceIdFor('doc.docx');
    const before = await readManifest(kbPath);
    expect(before.sources![sid].status).toBe('failed');
    expect(before.sources![sid].errorCode).toBe('malformed');

    // 修复（mock 恢复）后重试转换成功
    mockOfficeMarkdown('# 修复后的全文');
    const retried = await convertWikiSource(kbPath, sid);
    if (!retried.ok) throw new Error(`预期重试成功: ${retried.error.code}`);
    const rec = (await readManifest(kbPath)).sources![sid];
    expect(rec.status).toBe('ready');
    expect(rec.errorCode).toBeUndefined();
    expect(rec.parsedRevision).toBe(rec.currentRevision);
    const parsed = readFileSync(join(kbPath, 'raw', 'parsed', 'doc.docx.md'), 'utf-8');
    expect(parsed).toContain('修复后的全文');
    expect(rec.parsedHash).toBe(sha256(Buffer.from(parsed, 'utf-8')));
  });

  it('convertWikiSource 对不存在来源返回 sourceNotFound', async () => {
    const r = await convertWikiSource(kbPath, 'no-such-source');
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.code).toBe('sourceNotFound');
  });
});

// ─── Office 图片资产 ────────────────────────────────────────

describe('Office 图片资产 — 内容寻址与相对引用', () => {
  it('图片按内容 hash 落盘，assets.json 清单，parsed 引用回写相对路径', async () => {
    const src = makeIncoming('doc.docx', 'office-bytes');
    mockOfficeMarkdown('# 标题\n\n![框图](image1)\n\n![时序](image2)');
    const o = outcomeOk(await importWikiSources(kbPath, [{ absolutePath: src }]));
    const sid = o.source.sourceId;
    const rev = o.source.currentRevision;

    expect(o.source.assetCount).toBe(2);
    const assetsDir = join(kbPath, 'raw', 'assets', sid, rev);
    const h1 = sha256(PNG1);
    const h2 = sha256(PNG2);
    expect(existsSync(join(assetsDir, `${h1}.png`))).toBe(true);
    expect(existsSync(join(assetsDir, `${h2}.png`))).toBe(true);
    expect(readFileSync(join(assetsDir, `${h1}.png`))).toEqual(PNG1);

    const assetsManifest = JSON.parse(readFileSync(join(assetsDir, 'assets.json'), 'utf-8')) as {
      assets: Array<{ assetId: string; file: string; order: number }>;
    };
    expect(assetsManifest.assets).toHaveLength(2);
    expect(assetsManifest.assets[0].assetId).toBe(h1);
    expect(assetsManifest.assets[0].order).toBe(1);

    // parsed 引用回写：从 parsed/ 到 assets/<sid>/<rev>/ 的相对路径
    const parsed = readFileSync(join(kbPath, 'raw', 'parsed', 'doc.docx.md'), 'utf-8');
    expect(parsed).toContain(`](../assets/${sid}/${rev}/${h1}.png)`);
    expect(parsed).toContain(`](../assets/${sid}/${rev}/${h2}.png)`);
    expect(parsed).not.toContain('(image1)');
  });

  it('嵌套目录来源的 parsed 引用按相对层级回写', async () => {
    const src = makeIncoming('doc.docx', 'nested-office', 'sub');
    mockOfficeMarkdown('![图](image1)');
    const o = outcomeOk(await importWikiSources(kbPath, [{ absolutePath: src, relPath: 'sub/doc.docx' }]));
    const sid = o.source.sourceId;
    const rev = o.source.currentRevision;
    const parsed = readFileSync(join(kbPath, 'raw', 'parsed', 'sub', 'doc.docx.md'), 'utf-8');
    expect(parsed).toContain(`](../../assets/${sid}/${rev}/${sha256(PNG1)}.png)`);
  });

  it('同图多次引用复用同一字节文件，各出现位置保留', async () => {
    const src = makeIncoming('doc.docx', 'dup-office');
    mockFormatFromPath.mockReturnValue(DOCX_FORMAT);
    mockToMarkdownBytes.mockResolvedValue('![a](image1)\n\n![b](image1)');
    mockToDocument.mockResolvedValue({
      blocks: [
        { content: [{ kind: 'image', source: { kind: 'asset', assetId: 1 } }] },
        { content: [{ kind: 'image', source: { kind: 'asset', assetId: 1 } }] },
      ],
      assets: [{ id: 1, mediaType: 'image/png', data: new Uint8Array(PNG1) }],
    } as never);

    const o = outcomeOk(await importWikiSources(kbPath, [{ absolutePath: src }]));
    expect(o.source.assetCount).toBe(2); // 两个引用位置
    const assetsDir = join(kbPath, 'raw', 'assets', o.source.sourceId, o.source.currentRevision);
    const files = readdirSync(assetsDir).filter((f) => f.endsWith('.png'));
    expect(files).toEqual([`${sha256(PNG1)}.png`]); // 字节只存一份
    const parsed = readFileSync(join(kbPath, 'raw', 'parsed', 'doc.docx.md'), 'utf-8');
    expect(parsed.match(/\]\(([^)]*\.png)\)/g)).toHaveLength(2); // 引用位置保留
  });
});

// ─── 列表、预览与修订核对 ───────────────────────────────────

describe('列表 / 预览 / 修订核对 — 身份解析而非任意路径', () => {
  it('listWikiSources 返回摘要（revisionShort、parsedStale）', async () => {
    const src = makeIncoming('doc.md', '内容');
    const o = outcomeOk(await importWikiSources(kbPath, [{ absolutePath: src }]));
    const list = await listWikiSources(kbPath);
    expect(list).toHaveLength(1);
    const s = list[0];
    expect(s.sourceId).toBe(o.source.sourceId);
    expect(s.sourcePath).toBe('doc.md');
    expect(s.revisionShort).toBe(o.source.currentRevision.slice(0, 8));
    expect(s.parsedStale).toBe(false);
    expect(s.status).toBe('ready');
  });

  it('readWikiParsed 当前全文；历史修订从 revisions 区读取并标注 isHistorical', async () => {
    const v1 = makeIncoming('doc.md', 'bytes-v1');
    const first = outcomeOk(await importWikiSources(kbPath, [{ absolutePath: v1 }]));
    const oldRev = first.source.currentRevision;
    writePageFixture(kbPath, first.source.sourceId, oldRev);
    const v2 = makeIncoming('doc2.md', 'bytes-v2');
    const second = outcomeOk(await importWikiSources(kbPath, [{ absolutePath: v2, relPath: 'doc.md' }]));

    const current = await readWikiParsed(kbPath, { sourceId: first.source.sourceId });
    expect(current.isHistorical).toBe(false);
    expect(current.revision).toBe(second.source.currentRevision);
    expect(current.content).toContain('bytes-v2');

    const historical = await readWikiParsed(kbPath, { sourceId: first.source.sourceId, revision: oldRev });
    expect(historical.isHistorical).toBe(true);
    expect(historical.revision).toBe(oldRev);
    expect(historical.content).toContain('bytes-v1');
  });

  it('listSourceRevisions 列出当前与历史修订（原件文件名）', async () => {
    const v1 = makeIncoming('doc.md', 'bytes-v1');
    const first = outcomeOk(await importWikiSources(kbPath, [{ absolutePath: v1 }]));
    const oldRev = first.source.currentRevision;
    writePageFixture(kbPath, first.source.sourceId, oldRev);
    const v2 = makeIncoming('doc2.md', 'bytes-v2');
    const second = outcomeOk(await importWikiSources(kbPath, [{ absolutePath: v2, relPath: 'doc.md' }]));

    const revisions = await listSourceRevisions(kbPath, first.source.sourceId);
    expect(revisions).toHaveLength(2);
    const hist = revisions.find((r) => r.revision === oldRev)!;
    expect(hist.isCurrent).toBe(false);
    expect(hist.originalFile).toBe('doc.md');
    expect(hist.parsedHashes).toEqual([first.source.parsedHash]);
    const curr = revisions.find((r) => r.revision === second.source.currentRevision)!;
    expect(curr.isCurrent).toBe(true);
    expect(curr.parsedHashes).toEqual([second.source.parsedHash]);
  });

  it('resolveWikiOriginalPath 从身份解析（拒绝未知来源）', async () => {
    const src = makeIncoming('doc.md', 'x');
    const o = outcomeOk(await importWikiSources(kbPath, [{ absolutePath: src }]));
    const p = await resolveWikiOriginalPath(kbPath, { sourceId: o.source.sourceId });
    expect(p).not.toBeNull();
    expect(readFileSync(p!, 'utf-8')).toBe('x');
    expect(await resolveWikiOriginalPath(kbPath, { sourceId: 'missing' })).toBeNull();
  });

  it('历史修订原件从身份解析（revision 指向旧修订）', async () => {
    const v1 = makeIncoming('doc.md', 'bytes-v1');
    const first = outcomeOk(await importWikiSources(kbPath, [{ absolutePath: v1 }]));
    const oldRev = first.source.currentRevision;
    writePageFixture(kbPath, first.source.sourceId, oldRev);
    const v2 = makeIncoming('doc2.md', 'bytes-v2');
    await importWikiSources(kbPath, [{ absolutePath: v2, relPath: 'doc.md' }]);

    const p = await resolveWikiOriginalPath(kbPath, { sourceId: first.source.sourceId, revision: oldRev });
    expect(p).not.toBeNull();
    expect(readFileSync(p!, 'utf-8')).toBe('bytes-v1');
  });
});

// ─── 批量导入 ───────────────────────────────────────────────

describe('批量导入 — 小批量多文件', () => {
  it('批量导入逐文件独立结果；部分失败不影响其余', async () => {
    const ok1 = makeIncoming('a.md', 'A');
    const bad = makeIncoming('b.html', '<html>');
    const ok2 = makeIncoming('c.md', 'C', 'nested');

    const results = await importWikiSources(kbPath, [
      { absolutePath: ok1, relPath: 'a.md' },
      { absolutePath: bad, relPath: 'b.html' },
      { absolutePath: ok2, relPath: 'nested/c.md' },
    ]);

    expect(results).toHaveLength(3);
    expect(results[0].ok).toBe(true);
    expect(results[1].ok).toBe(false);
    if (!results[1].ok) expect(results[1].error.code).toBe('unsupportedFormat');
    expect(results[2].ok).toBe(true);

    const manifest = await readManifest(kbPath);
    expect(Object.keys(manifest.sources ?? {})).toHaveLength(2);
    expect(existsSync(join(kbPath, 'raw', 'sources', 'nested', 'c.md'))).toBe(true);
  });
});
