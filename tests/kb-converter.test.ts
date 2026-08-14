/**
 * Knowledge Base Converter 测试。
 *
 * 测试缝：converter 模块的公开 API (convertDocument)。
 * mock `@firecrawl/anydoc` NAPI 边界 (toDocument / toMarkdownBytes)，不真实调用原生模块。
 * 源文件用临时文件模拟（converter 先读字节再传给 anydoc，mock anydoc 后字节内容无关）。
 *
 * 覆盖场景：
 *  - 转换成功路径：Markdown 落盘、图片按序落盘、md 内链接替换为相对路径
 *  - 六种错误码透传为结构化错误（code + 用户可读信息）
 *  - 同名覆盖：重转前清理旧 Markdown 与旧 assets
 *  - 冒烟测试：真实 anydoc NAPI 转换 CSV
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { mkdtemp, rm, readFile, mkdir, writeFile, stat } from 'node:fs/promises';
import type { Document, Asset, Block, Inline } from '@firecrawl/anydoc';

// ── mock @firecrawl/anydoc NAPI 边界 ──────────────────────────────

const { toDocumentMock, toMarkdownBytesMock, formatFromPathMock } = vi.hoisted(() => ({
  toDocumentMock: vi.fn(),
  toMarkdownBytesMock: vi.fn(),
  formatFromPathMock: vi.fn(),
}));

vi.mock('@firecrawl/anydoc', () => ({
  toDocument: toDocumentMock,
  toMarkdownBytes: toMarkdownBytesMock,
  formatFromPath: formatFromPathMock,
  toMarkdown: vi.fn(),
  formatFromBytes: vi.fn(),
  formatFromExtension: vi.fn(),
}));

import { convertDocument, type ConvertResult } from '../src/main/kb/converter';

// ── 测试工具 ──────────────────────────────────────────────────────

/** 创建临时目录 + 临时源文件（假字节，内容无关紧要） */
async function makeTempEnv(
  fileName = 'test.docx',
): Promise<{ docsDir: string; sourcePath: string; cleanup: () => Promise<void> }> {
  const dir = await mkdtemp(join(tmpdir(), 'kb-converter-test-'));
  const sourcesDir = join(dir, 'sources');
  await mkdir(sourcesDir, { recursive: true });
  const sourcePath = join(sourcesDir, fileName);
  await writeFile(sourcePath, Buffer.from([0x50, 0x4b, 0x03, 0x04])); // fake zip header
  return {
    docsDir: dir,
    sourcePath,
    cleanup: async () => {
      await rm(dir, { recursive: true, force: true });
    },
  };
}

/** 构造一个有图片的 document model（2 个 asset） */
function makeDocWithImages(): { doc: Document; markdown: string } {
  const pngBytes1 = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3]);
  const pngBytes2 = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 4, 5, 6]);

  const assets: Asset[] = [
    { id: 0, mediaType: 'image/png', originPart: 'word/media/image1.png', data: pngBytes1 },
    { id: 1, mediaType: 'image/jpeg', originPart: 'word/media/image2.jpeg', data: pngBytes2 },
  ];

  const blocks: Block[] = [
    { kind: 'heading' as Block['kind'], level: 1, content: [{ kind: 'text' as Inline['kind'], text: '验证计划' }] },
    {
      kind: 'paragraph' as Block['kind'],
      content: [
        { kind: 'text' as Inline['kind'], text: '框图如下：' },
        { kind: 'image' as Inline['kind'], alt: '图1', source: { kind: 'asset' as NonNullable<NonNullable<Inline['source']>['kind']>, assetId: 0 } },
      ],
    },
    {
      kind: 'paragraph' as Block['kind'],
      content: [
        { kind: 'text' as Inline['kind'], text: '时序图如下：' },
        { kind: 'image' as Inline['kind'], alt: '图2', source: { kind: 'asset' as NonNullable<NonNullable<Inline['source']>['kind']>, assetId: 1 } },
      ],
    },
  ];

  const doc: Document = { blocks, notes: [], assets };
  const markdown = `# 验证计划\n框图如下：![图1](image1)\n时序图如下：![图2](image2)`;
  return { doc, markdown };
}

/** 构造一个无图片的 document model */
function makeDocWithoutImages(): { doc: Document; markdown: string } {
  const blocks: Block[] = [
    { kind: 'heading' as Block['kind'], level: 1, content: [{ kind: 'text' as Inline['kind'], text: '纯文本文档' }] },
    { kind: 'paragraph' as Block['kind'], content: [{ kind: 'text' as Inline['kind'], text: '这是一段纯文本内容。' }] },
  ];
  const doc: Document = { blocks, notes: [], assets: [] };
  const markdown = '# 纯文本文档\n这是一段纯文本内容。';
  return { doc, markdown };
}

/** 构造 anydoc 转换错误 */
function makeConvertError(code: string, message: string): Error {
  const err = new Error(message);
  (err as Error & { code: string }).code = code;
  return err;
}

// ──────────────────────────────────────────────────────────────────────────

describe('convertDocument — 转换成功路径', () => {
  let docsDir: string;
  let sourcePath: string;
  let cleanup: () => Promise<void>;

  beforeEach(async () => {
    const tmp = await makeTempEnv('验证计划.docx');
    docsDir = tmp.docsDir;
    sourcePath = tmp.sourcePath;
    cleanup = tmp.cleanup;

    toDocumentMock.mockReset();
    toMarkdownBytesMock.mockReset();
    formatFromPathMock.mockReset();
    formatFromPathMock.mockReturnValue('docx');
  });

  it('Markdown 落盘到 docs/<文档名>.md', async () => {
    const { doc, markdown } = makeDocWithImages();
    toDocumentMock.mockResolvedValue(doc);
    toMarkdownBytesMock.mockResolvedValue(markdown);

    const result = await convertDocument(sourcePath, docsDir);

    expect(result.ok).toBe(true);
    const ok = result as Extract<ConvertResult, { ok: true }>;
    expect(ok.markdownPath).toBe(join(docsDir, '验证计划.md'));
    expect(ok.assetCount).toBe(2);

    const mdContent = await readFile(ok.markdownPath, 'utf-8');
    expect(mdContent).toContain('验证计划');

    await cleanup();
  });

  it('图片按序落盘到 docs/assets/<文档名>/image-NNN.<ext>，扩展名由 media type 推断', async () => {
    const { doc, markdown } = makeDocWithImages();
    toDocumentMock.mockResolvedValue(doc);
    toMarkdownBytesMock.mockResolvedValue(markdown);

    const result = await convertDocument(sourcePath, docsDir);
    expect(result.ok).toBe(true);

    // 验证 image-001.png 存在
    const asset1Path = join(docsDir, 'assets', '验证计划', 'image-001.png');
    const stat1 = await stat(asset1Path);
    expect(stat1.isFile()).toBe(true);

    // 验证 image-002.jpeg 存在（mediaType image/jpeg → 扩展名 jpeg）
    const asset2Path = join(docsDir, 'assets', '验证计划', 'image-002.jpeg');
    const stat2 = await stat(asset2Path);
    expect(stat2.isFile()).toBe(true);

    // 验证图片字节正确
    const bytes1 = await readFile(asset1Path);
    expect(bytes1[0]).toBe(0x89); // PNG header

    await cleanup();
  });

  it('Markdown 内图片占位替换为相对路径链接', async () => {
    const { doc, markdown } = makeDocWithImages();
    toDocumentMock.mockResolvedValue(doc);
    toMarkdownBytesMock.mockResolvedValue(markdown);

    const result = await convertDocument(sourcePath, docsDir);
    expect(result.ok).toBe(true);
    const ok = result as Extract<ConvertResult, { ok: true }>;

    const mdContent = await readFile(ok.markdownPath, 'utf-8');
    expect(mdContent).toContain('assets/验证计划/image-001.png');
    expect(mdContent).toContain('assets/验证计划/image-002.jpeg');
    expect(mdContent).not.toContain('![图1](image1)');
    expect(mdContent).not.toContain('![图2](image2)');

    await cleanup();
  });

  it('无图片文档：只落盘 Markdown，assetCount 为 0', async () => {
    const { doc, markdown } = makeDocWithoutImages();
    toDocumentMock.mockResolvedValue(doc);
    toMarkdownBytesMock.mockResolvedValue(markdown);

    const result = await convertDocument(sourcePath, docsDir);
    expect(result.ok).toBe(true);
    const ok = result as Extract<ConvertResult, { ok: true }>;
    expect(ok.assetCount).toBe(0);
    expect(ok.markdownPath).toBe(join(docsDir, '验证计划.md'));

    // 不应创建 assets 目录
    const assetsDir = join(docsDir, 'assets', '验证计划');
    await expect(stat(assetsDir)).rejects.toThrow();

    await cleanup();
  });

  it('返回 assetCount 为实际落盘的图片数量（只落盘被引用的 asset）', async () => {
    // 3 个 asset，但 blocks 中只引用了 2 个
    const pngBytes = Buffer.from([0x89, 0x50, 0x4e, 0x47]);
    const assets: Asset[] = [
      { id: 0, mediaType: 'image/png', originPart: 'media/image1.png', data: pngBytes },
      { id: 1, mediaType: 'image/png', originPart: 'media/image2.png', data: pngBytes },
      { id: 2, mediaType: 'image/png', originPart: 'media/image3.png', data: pngBytes },
    ];
    const blocks: Block[] = [
      { kind: 'paragraph' as Block['kind'], content: [{ kind: 'image' as Inline['kind'], alt: 'img1', source: { kind: 'asset' as NonNullable<NonNullable<Inline['source']>['kind']>, assetId: 0 } }] },
      { kind: 'paragraph' as Block['kind'], content: [{ kind: 'image' as Inline['kind'], alt: 'img2', source: { kind: 'asset' as NonNullable<NonNullable<Inline['source']>['kind']>, assetId: 1 } }] },
    ];
    const doc: Document = { blocks, notes: [], assets };
    const markdown = '![img1](image1)\n![img2](image2)';

    toDocumentMock.mockResolvedValue(doc);
    toMarkdownBytesMock.mockResolvedValue(markdown);

    const result = await convertDocument(sourcePath, docsDir);
    expect(result.ok).toBe(true);
    const ok = result as Extract<ConvertResult, { ok: true }>;
    expect(ok.assetCount).toBe(2);

    await cleanup();
  });
});

// ──────────────────────────────────────────────────────────────────────────

describe('convertDocument — 错误码透传', () => {
  let docsDir: string;
  let sourcePath: string;
  let cleanup: () => Promise<void>;

  beforeEach(async () => {
    const tmp = await makeTempEnv('test.docx');
    docsDir = tmp.docsDir;
    sourcePath = tmp.sourcePath;
    cleanup = tmp.cleanup;

    toDocumentMock.mockReset();
    toMarkdownBytesMock.mockReset();
    formatFromPathMock.mockReset();
    formatFromPathMock.mockReturnValue('docx');
  });

  const errorCases: Array<{ code: string; message: string; expectedHint: string }> = [
    { code: 'unsupported', message: 'image-only PDF', expectedHint: '扫描版 PDF 无文字层' },
    { code: 'malformed', message: 'corrupt file', expectedHint: '结构损坏' },
    { code: 'encrypted', message: 'password protected', expectedHint: '加密' },
    { code: 'resourceLimit', message: 'too large', expectedHint: '资源限制' },
    { code: 'missingPart', message: 'missing part', expectedHint: '缺少部件' },
    { code: 'io', message: 'read error', expectedHint: '读取失败' },
  ];

  for (const { code, message, expectedHint } of errorCases) {
    it(`${code} 错误码透传为结构化错误（code + 用户可读信息含"${expectedHint}"）`, async () => {
      const err = makeConvertError(code, message);
      toDocumentMock.mockRejectedValue(err);

      const result = await convertDocument(sourcePath, docsDir);
      expect(result.ok).toBe(false);
      const fail = result as Extract<ConvertResult, { ok: false }>;
      expect(fail.error.code).toBe(code);
      expect(fail.error.message).toContain(expectedHint);

      await cleanup();
    });
  }

  it('PDF 格式（unsupported for toDocument）转用 toMarkdownBytes', async () => {
    formatFromPathMock.mockReturnValue('pdf');
    toDocumentMock.mockRejectedValue(makeConvertError('unsupported', 'PDF has no document model'));
    toMarkdownBytesMock.mockResolvedValue('# PDF 文档\n内容');

    const result = await convertDocument(sourcePath, docsDir);
    expect(result.ok).toBe(true);
    const ok = result as Extract<ConvertResult, { ok: true }>;
    expect(ok.markdownPath).toBe(join(docsDir, 'test.md'));
    expect(ok.assetCount).toBe(0);

    await cleanup();
  });

  it('PDF 扫描版（unsupported from toMarkdownBytes）返回结构化错误', async () => {
    formatFromPathMock.mockReturnValue('pdf');
    toDocumentMock.mockRejectedValue(makeConvertError('unsupported', 'PDF has no document model'));
    toMarkdownBytesMock.mockRejectedValue(makeConvertError('unsupported', 'image-only PDF'));

    const result = await convertDocument(sourcePath, docsDir);
    expect(result.ok).toBe(false);
    const fail = result as Extract<ConvertResult, { ok: false }>;
    expect(fail.error.code).toBe('unsupported');
    expect(fail.error.message).toContain('扫描版');

    await cleanup();
  });

  it('未识别格式返回 unsupported 错误', async () => {
    formatFromPathMock.mockReturnValue(null);

    const result = await convertDocument(sourcePath, docsDir);
    expect(result.ok).toBe(false);
    const fail = result as Extract<ConvertResult, { ok: false }>;
    expect(fail.error.code).toBe('unsupported');
    expect(fail.error.detail).toContain('未知格式');

    await cleanup();
  });
});

// ──────────────────────────────────────────────────────────────────────────

describe('convertDocument — 同名覆盖', () => {
  let docsDir: string;
  let sourcePath: string;
  let cleanup: () => Promise<void>;

  beforeEach(async () => {
    const tmp = await makeTempEnv('验证计划.docx');
    docsDir = tmp.docsDir;
    sourcePath = tmp.sourcePath;
    cleanup = tmp.cleanup;

    toDocumentMock.mockReset();
    toMarkdownBytesMock.mockReset();
    formatFromPathMock.mockReset();
    formatFromPathMock.mockReturnValue('docx');
  });

  it('重转前清理旧 Markdown 与旧 assets 目录', async () => {
    // 第一次转换
    const { doc: doc1, markdown: md1 } = makeDocWithImages();
    toDocumentMock.mockResolvedValueOnce(doc1);
    toMarkdownBytesMock.mockResolvedValueOnce(md1);

    const result1 = await convertDocument(sourcePath, docsDir);
    expect(result1.ok).toBe(true);

    // 旧 assets 目录存在
    const oldAssetDir = join(docsDir, 'assets', '验证计划');
    const oldStat = await stat(oldAssetDir);
    expect(oldStat.isDirectory()).toBe(true);

    // 在旧 assets 目录中手动放一个"孤儿"文件
    await writeFile(join(oldAssetDir, 'orphan.png'), 'should be deleted');

    // 第二次转换（同名覆盖）
    const { doc: doc2, markdown: md2 } = makeDocWithoutImages();
    toDocumentMock.mockResolvedValueOnce(doc2);
    toMarkdownBytesMock.mockResolvedValueOnce(md2);

    const result2 = await convertDocument(sourcePath, docsDir);
    expect(result2.ok).toBe(true);
    const ok2 = result2 as Extract<ConvertResult, { ok: true }>;
    expect(ok2.assetCount).toBe(0);

    // 孤儿文件应被删除（旧 assets 目录被清理）
    await expect(stat(join(oldAssetDir, 'orphan.png'))).rejects.toThrow();

    // 旧 Markdown 内容应被新内容覆盖
    const mdContent = await readFile(ok2.markdownPath, 'utf-8');
    expect(mdContent).toContain('纯文本文档');
    expect(mdContent).not.toContain('验证计划');

    await cleanup();
  });

  it('重转时旧 assets 目录不存在不报错', async () => {
    const { doc, markdown } = makeDocWithoutImages();
    toDocumentMock.mockResolvedValue(doc);
    toMarkdownBytesMock.mockResolvedValue(markdown);

    const result = await convertDocument(sourcePath, docsDir);
    expect(result.ok).toBe(true);

    await cleanup();
  });
});

// 冒烟测试（真实 anydoc NAPI）见 tests/kb-converter-smoke.test.ts
