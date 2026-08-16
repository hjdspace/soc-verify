/**
 * converter 引擎路由测试 — kb-settings 决定生效引擎，
 * 产物落盘 / 图片占位替换为共享编排逻辑。
 *
 * anydoc 引擎 mock @firecrawl/anydoc；markitdown 引擎用真实实现
 * （csv / docx fixture 由 jszip 在测试内构造）。
 * 与 kb-converter.test.ts（anydoc 单引擎语义）互补，本文件聚焦引擎切换。
 */

import { describe, it, expect, beforeEach, afterAll, vi } from 'vitest';
import { rmSync, mkdirSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';

const { tmpBase, dataDir } = vi.hoisted(() => {
  const os = require('node:os');
  const fs = require('node:fs');
  const path = require('node:path');
  const base = path.join(os.tmpdir(), `sv-kb-engines-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`);
  fs.mkdirSync(base, { recursive: true });
  return { tmpBase: base, dataDir: path.join(base, 'appdata') };
});

vi.mock('electron', () => ({
  app: { getPath: vi.fn(() => dataDir) },
}));

// Mock @firecrawl/anydoc：anydoc 引擎依赖
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

import { convertDocument, convertDocumentToMarkdownString } from '../src/main/kb/converter';
import { getConvertEngine, getActiveConvertEngine, listConvertEngines } from '../src/main/kb/engines';
import { kbSettingsManager } from '../src/main/kb/kb-settings';

const sourcesDir = join(tmpBase, 'sources');
const docsDir = join(tmpBase, 'docs');
const settingsPath = join(dataDir, 'socverify-data', 'kb-settings.json');

function makeSource(name: string, content: string | Uint8Array): string {
  mkdirSync(sourcesDir, { recursive: true });
  const filePath = join(sourcesDir, name);
  writeFileSync(filePath, content);
  return filePath;
}

/** 构造带一张内嵌图片的 docx（jszip） */
async function makeDocx(withImage: boolean): Promise<Uint8Array> {
  const { default: JSZip } = await import('jszip');
  const zip = new JSZip();
  if (withImage) {
    zip.file(
      'word/_rels/document.xml.rels',
      '<?xml version="1.0"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">'
      + '<Relationship Id="rId8" Type="image" Target="media/image1.png"/></Relationships>',
    );
    zip.file('word/media/image1.png', new Uint8Array([0x89, 0x50, 0x4e, 0x47]));
    zip.file(
      'word/document.xml',
      '<?xml version="1.0"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><w:body>'
      + '<w:p><w:r><w:t>带图版本</w:t></w:r></w:p>'
      + '<w:p><w:r><w:drawing><a:blip xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" r:embed="rId8"/></w:drawing></w:r></w:p>'
      + '</w:body></w:document>',
    );
  } else {
    zip.file(
      'word/document.xml',
      '<?xml version="1.0"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>'
      + '<w:p><w:r><w:t>无图版本</w:t></w:r></w:p></w:body></w:document>',
    );
  }
  return new Uint8Array(await zip.generateAsync({ type: 'arraybuffer' }));
}

describe('converter 引擎路由', () => {
  beforeEach(async () => {
    vi.clearAllMocks();
    rmSync(docsDir, { recursive: true, force: true });
    kbSettingsManager.resetCache();
    rmSync(settingsPath, { force: true });
    await kbSettingsManager.load();
  });

  afterAll(() => {
    rmSync(tmpBase, { recursive: true, force: true });
  });

  it('默认引擎 anydoc：走 anydoc 转换并落盘', async () => {
    formatFromPathMock.mockReturnValue('docx');
    toDocumentMock.mockResolvedValue({ blocks: [], notes: [], assets: [] });
    toMarkdownBytesMock.mockResolvedValue('# anydoc 产物\n');

    const source = makeSource('文档.docx', Buffer.from([0x50, 0x4b]));
    const result = await convertDocument(source, docsDir);

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error('expected success');
    expect(result.markdownPath).toBe(join(docsDir, '文档.md'));
    expect(readFileSync(join(docsDir, '文档.md'), 'utf-8')).toContain('anydoc 产物');
    expect(formatFromPathMock).toHaveBeenCalled();
  });

  it('切换 markitdown 引擎后：csv 走 markitdown 转换（anydoc 不被调用）', async () => {
    await kbSettingsManager.save({ convertEngine: 'markitdown', llm: {} });

    const source = makeSource('回归.csv', '模块,状态\nAXI,PASS\n');
    const result = await convertDocument(source, docsDir);

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error('expected success');
    expect(result.assetCount).toBe(0);
    const markdown = readFileSync(join(docsDir, '回归.md'), 'utf-8');
    expect(markdown).toContain('| 模块 | 状态 |');
    expect(markdown).toContain('| AXI | PASS |');
    expect(formatFromPathMock).not.toHaveBeenCalled();
    expect(toDocumentMock).not.toHaveBeenCalled();
  });

  it('markitdown 引擎不支持 .doc：返回 unsupported 且提示切换引擎', async () => {
    await kbSettingsManager.save({ convertEngine: 'markitdown', llm: {} });

    const source = makeSource('旧文档.doc', 'legacy binary');
    const result = await convertDocument(source, docsDir);

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('expected failure');
    expect(result.error.code).toBe('unsupported');
    expect(result.error.message).toContain('切换');
  });

  it('markitdown 引擎 docx 图片落盘：assets/image-NNN + 相对路径替换', async () => {
    await kbSettingsManager.save({ convertEngine: 'markitdown', llm: {} });

    const source = makeSource('插图文档.docx', await makeDocx(true));
    const result = await convertDocument(source, docsDir);

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error('expected success');
    expect(result.assetCount).toBe(1);

    // 图片落盘到 docs/assets/<文档名>/image-001.png
    const assetPath = join(docsDir, 'assets', '插图文档', 'image-001.png');
    expect(existsSync(assetPath)).toBe(true);

    // Markdown 占位已替换为相对路径
    const markdown = readFileSync(join(docsDir, '插图文档.md'), 'utf-8');
    expect(markdown).toContain('![](assets/插图文档/image-001.png)');
    expect(markdown).not.toContain('![](image1)');
  });

  it('同名重转清理旧 assets（覆盖场景）', async () => {
    await kbSettingsManager.save({ convertEngine: 'markitdown', llm: {} });

    const source = join(sourcesDir, '覆盖.docx');
    writeFileSync(source, await makeDocx(true));
    let result = await convertDocument(source, docsDir);
    expect(result.ok && result.assetCount === 1).toBe(true);

    // 第二次上传同名文件（无图版本）：旧 assets 目录应被清理
    writeFileSync(source, await makeDocx(false));
    result = await convertDocument(source, docsDir);
    expect(result.ok).toBe(true);
    expect(existsSync(join(docsDir, 'assets', '覆盖'))).toBe(false);
    expect(readFileSync(join(docsDir, '覆盖.md'), 'utf-8')).toContain('无图版本');
  });

  it('convertDocumentToMarkdownString 不落盘（markitdown 引擎）', async () => {
    await kbSettingsManager.save({ convertEngine: 'markitdown', llm: {} });

    const source = makeSource('临时.csv', 'a,b\n1,2\n');
    const result = await convertDocumentToMarkdownString(source);

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error('expected success');
    expect(result.markdown).toContain('| a | b |');
    expect(existsSync(docsDir)).toBe(false);
  });
});

describe('engines 注册表', () => {
  it('按 ID 取引擎，未知 ID 回退 anydoc', () => {
    expect(getConvertEngine('markitdown').id).toBe('markitdown');
    expect(getConvertEngine('anydoc').id).toBe('anydoc');
    expect(getConvertEngine('bogus').id).toBe('anydoc');
  });

  it('getActiveConvertEngine 跟随 kb-settings', async () => {
    kbSettingsManager.resetCache();
    rmSync(settingsPath, { force: true });
    expect((await getActiveConvertEngine()).id).toBe('anydoc');

    await kbSettingsManager.save({ convertEngine: 'markitdown', llm: {} });
    kbSettingsManager.resetCache();
    expect((await getActiveConvertEngine()).id).toBe('markitdown');
  });

  it('listConvertEngines 返回两个引擎的元信息', () => {
    const engines = listConvertEngines();
    expect(engines.map((e) => e.id).sort()).toEqual(['anydoc', 'markitdown']);
    for (const engine of engines) {
      expect(engine.label).toBeTruthy();
      expect(engine.description).toBeTruthy();
      expect(engine.supportedExtensions.length).toBeGreaterThan(0);
    }
  });
});
