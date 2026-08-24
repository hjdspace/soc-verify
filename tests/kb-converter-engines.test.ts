/**
 * converter 引擎路由测试 — kb-settings 决定生效引擎，
 * 产物落盘 / 图片占位替换为共享编排逻辑。
 *
 * anydoc 引擎 mock @firecrawl/anydoc。
 * 与 kb-converter.test.ts（anydoc 单引擎语义）互补，本文件聚焦引擎注册表。
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

  it('convertDocumentToMarkdownString 不落盘（anydoc 引擎）', async () => {
    formatFromPathMock.mockReturnValue('csv');
    toMarkdownBytesMock.mockResolvedValue('| a | b |\n|---|---|\n| 1 | 2 |\n');

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
    expect(getConvertEngine('anydoc').id).toBe('anydoc');
    expect(getConvertEngine('bogus').id).toBe('anydoc');
  });

  it('getActiveConvertEngine 跟随 kb-settings', async () => {
    kbSettingsManager.resetCache();
    rmSync(settingsPath, { force: true });
    expect((await getActiveConvertEngine()).id).toBe('anydoc');
  });

  it('listConvertEngines 返回引擎元信息', () => {
    const engines = listConvertEngines();
    expect(engines.map((e) => e.id)).toEqual(['anydoc']);
    for (const engine of engines) {
      expect(engine.label).toBeTruthy();
      expect(engine.description).toBeTruthy();
      expect(engine.supportedExtensions.length).toBeGreaterThan(0);
    }
  });
});
