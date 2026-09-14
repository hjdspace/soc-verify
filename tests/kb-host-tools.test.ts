/**
 * KB Host Tools 测试 — doc_to_markdown + kb_search。
 *
 * 测试缝：HostToolsRegistry 的 kb 工具注册与调用。
 * mock @firecrawl/anydoc（convertDocumentToMarkdownString 依赖）、
 * project-service（requireProject 返回临时项目路径）、
 * kb/registry（status 返回挂载信息或 null）。
 *
 * 覆盖场景：
 *  - 工具注册（doc_to_markdown / kb_search）
 *  - doc_to_markdown 成功（返回 Markdown 内容、不产生库内文件）
 *  - doc_to_markdown 六种错误码透传
 *  - doc_to_markdown 参数校验（缺少 path）
 *  - doc_to_markdown 文件不存在
 *  - doc_to_markdown 小文档内联返回 / 大文档落盘缓存返回句柄（零截断）
 *  - kb_doc_read 按分块回读 / count 连读 / 越界与未知 doc_id 错误
 *  - kb_doc_grep 正则与字面量匹配、命中总数与分块映射
 *  - kb_doc_outline 标题大纲与分块映射
 *  - kb_search 索引匹配 + 全文匹配、评分排序、限量返回
 *  - kb_search 分类过滤（category）、中文 bigram 命中、snippet 与 absolutePath
 *  - kb_search 未挂载库时返回错误
 *  - kb_search 参数校验（缺少 query）
 *  - KB 索引上下文注入（context-injector）
 *
 * @see ADR 0021 — anydoc 文档知识库
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { join, resolve, isAbsolute } from 'node:path';
import { mkdirSync, writeFileSync, rmSync } from 'node:fs';

// ─── Hoisted tmp dirs ──────────────────────────────────────

const { tmpDir, projectDir, globalDataDir } = vi.hoisted(() => {
  const os = require('node:os');
  const fs = require('node:fs');
  const path = require('node:path');
  const base = os.tmpdir() + `/sv-kb-host-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
  const dirs = {
    tmpDir: base,
    projectDir: path.join(base, 'project'),
    globalDataDir: path.join(base, 'appdata'),
  };
  fs.mkdirSync(dirs.tmpDir, { recursive: true });
  fs.mkdirSync(dirs.projectDir, { recursive: true });
  fs.mkdirSync(dirs.globalDataDir, { recursive: true });
  return dirs;
});

// ─── Hoisted mocks ─────────────────────────────────────────

const { toDocumentMock, toMarkdownBytesMock, formatFromPathMock } = vi.hoisted(() => ({
  toDocumentMock: vi.fn(),
  toMarkdownBytesMock: vi.fn(),
  formatFromPathMock: vi.fn(),
}));

const { statusMock } = vi.hoisted(() => ({
  statusMock: vi.fn(),
}));

// ─── Mocks ──────────────────────────────────────────────────

vi.mock('electron', () => ({
  app: {
    getPath: vi.fn(() => globalDataDir),
  },
  BrowserWindow: {
    getAllWindows: vi.fn(() => []),
  },
}));

vi.mock('../src/main/services/project-service', () => ({
  requireProject: vi.fn(() => ({
    id: 'test-project-id',
    rootPath: projectDir,
    name: 'Test Project',
  })),
}));

vi.mock('../src/main/credentials/credential-manager', () => ({
  credentialManager: {
    getDefaultCredential: vi.fn(() => null),
  },
}));

vi.mock('@firecrawl/anydoc', () => ({
  toDocument: toDocumentMock,
  toMarkdownBytes: toMarkdownBytesMock,
  formatFromPath: formatFromPathMock,
  toMarkdown: vi.fn(),
  formatFromBytes: vi.fn(),
  formatFromExtension: vi.fn(),
}));

vi.mock('../src/main/kb/registry', () => ({
  kbRegistry: {
    status: statusMock,
  },
}));

// Mock officecli executor（doc-tools 依赖）
vi.mock('../src/main/officecli/executor', () => ({
  execOfficeCli: vi.fn(),
  OfficeCliNotAvailableError: class OfficeCliNotAvailableError extends Error {
    constructor() {
      super('OfficeCLI not available');
      this.name = 'OfficeCliNotAvailableError';
    }
  },
}));

// Mock xlsx-editor（xlsx-edit-tools 依赖）
vi.mock('../src/main/document/xlsx-editor', () => ({
  appendRows: vi.fn(),
  updateCell: vi.fn(),
}));

// Mock editor-registry（xlsx-edit-tools 依赖）
vi.mock('../src/main/document/editor-registry', () => ({
  isEditing: vi.fn(() => false),
  requestFlush: vi.fn(),
  notifyFileChanged: vi.fn(),
}));

// ─── Imports (after mocks) ──────────────────────────────────

import { HostToolsRegistry } from '../src/main/host/host-tools';
import { HOST_TOOL_NAMES } from '../src/main/host/tool-catalog';
import { searchKb } from '../src/main/kb/searcher';
import { buildKbContext, injectKbContext } from '../src/main/kb/context-injector';
import { initWikiLayout, writeWikiManifest, wikiLayout } from '../src/main/kb/wiki-layout';
import type { WikiKbManifest } from '../src/main/kb/wiki-layout';

/** 从 AgentToolResult 中提取 JSON 解析后的内容 */
function parseResult(result: unknown): Record<string, unknown> {
  const r = result as { content: Array<{ text: string }> };
  return JSON.parse(r.content[0].text);
}

// ─── 测试 ────────────────────────────────────────────────────

describe('KB Host Tools — 注册', () => {
  it('注册 doc_to_markdown / kb_search / kb_read（issue 15）', () => {
    const registry = new HostToolsRegistry();
    expect(registry.hasTool('doc_to_markdown')).toBe(true);
    expect(registry.hasTool('kb_search')).toBe(true);
    expect(registry.hasTool('kb_read')).toBe(true);
  });

  it('工具定义包含正确的参数 schema', () => {
    const registry = new HostToolsRegistry();
    const defs = registry.getDefinitions();

    const docDef = defs.find((d) => d.name === 'doc_to_markdown');
    expect(docDef).toBeDefined();
    expect(docDef!.parameters).toHaveProperty('properties.path');
    expect(docDef!.parameters).toHaveProperty('required');
    expect((docDef!.parameters as Record<string, unknown[]>).required).toContain('path');

    const searchDef = defs.find((d) => d.name === 'kb_search');
    expect(searchDef).toBeDefined();
    expect(searchDef!.parameters).toHaveProperty('properties.query');
    // issue 14：category/limit 退役，扩展类型/标签/kind/topK 过滤
    expect(searchDef!.parameters).toHaveProperty('properties.topK');
    expect(searchDef!.parameters).toHaveProperty('properties.pageType');
    expect(searchDef!.parameters).toHaveProperty('properties.tag');
    expect(searchDef!.parameters).toHaveProperty('properties.kind');
    expect((searchDef!.parameters as Record<string, unknown[]>).required).toContain('query');

    // issue 15：kb_read 只读证据读取，按 kind/id 解析，无 absolutePath 输入
    const readDef = defs.find((d) => d.name === 'kb_read');
    expect(readDef).toBeDefined();
    expect(readDef!.parameters).toHaveProperty('properties.kind');
    expect(readDef!.parameters).toHaveProperty('properties.id');
    expect(readDef!.parameters).toHaveProperty('properties.revision');
    expect(readDef!.parameters).toHaveProperty('properties.parsedHash');
    expect(readDef!.parameters).toHaveProperty('properties.assetId');
    expect(readDef!.parameters).toHaveProperty('properties.startLine');
    expect(readDef!.parameters).toHaveProperty('properties.maxChars');
    expect((readDef!.parameters as Record<string, unknown[]>).required).toContain('kind');
    expect((readDef!.parameters as Record<string, unknown[]>).required).toContain('id');
    // 不接受任意绝对路径输入：参数表里没有 path/absolutePath
    const readProps = (readDef!.parameters as { properties: Record<string, unknown> }).properties;
    expect(readProps).not.toHaveProperty('path');
    expect(readProps).not.toHaveProperty('absolutePath');
  });

  it('工具目录登记 kb_read / kb_search / docId 工具（issue 15）', () => {
    expect(HOST_TOOL_NAMES).toContain('kb_read');
    expect(HOST_TOOL_NAMES).toContain('kb_search');
    expect(HOST_TOOL_NAMES).toContain('kb_doc_read');
    expect(HOST_TOOL_NAMES).toContain('kb_doc_grep');
    expect(HOST_TOOL_NAMES).toContain('kb_doc_outline');
  });
});

// ─── doc_to_markdown ─────────────────────────────────────────

describe('doc_to_markdown', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    formatFromPathMock.mockReturnValue('docx');
  });

  it('小文档直接内联返回全文', async () => {
    const markdownContent = '# 验证计划\n\n这是 SoC 验证计划文档。';
    toMarkdownBytesMock.mockResolvedValue(markdownContent);

    const docPath = join(tmpDir, 'test-doc.docx');
    writeFileSync(docPath, Buffer.from('fake docx content'));

    const registry = new HostToolsRegistry(undefined, tmpDir);
    const result = await registry.handleToolCall({
      type: 'host_tool_call',
      id: '1',
      toolCallId: 'tc1',
      toolName: 'doc_to_markdown',
      arguments: { path: docPath },
    });

    const parsed = parseResult(result);
    expect(parsed.path).toBe(docPath);
    expect(parsed.cached).toBe(false);
    expect(parsed.markdown).toBe(markdownContent);

    // 验证不产生库内文件（没有在 docs/ 目录写入）
    expect(toMarkdownBytesMock).toHaveBeenCalled();
  });

  it('大文档落盘缓存并返回句柄（不截断，零丢失）', async () => {
    // 生成超过 50_000 字符的内容（几百页 PDF 的转换产物可达数 MB）
    const longMarkdown = '# 超长文档\n\n## 第一章 概述\n\n' + '很长的正文内容。'.repeat(8000) + '\n\n## 第二章 结尾\n\n完。';
    toMarkdownBytesMock.mockResolvedValue(longMarkdown);

    const docPath = join(tmpDir, 'huge-doc.docx');
    writeFileSync(docPath, Buffer.from('fake'));

    const registry = new HostToolsRegistry(undefined, tmpDir);
    const result = await registry.handleToolCall({
      type: 'host_tool_call',
      id: '1',
      toolCallId: 'tc1',
      toolName: 'doc_to_markdown',
      arguments: { path: docPath },
    });

    const parsed = parseResult(result);
    expect(parsed.cached).toBe(true);
    expect(parsed.totalChars).toBe(longMarkdown.length);

    // 句柄关键字段：doc_id / 分块数 / 预览 / 大纲
    expect(typeof parsed.docId).toBe('string');
    expect(String(parsed.docId)).toMatch(/^[a-f0-9]{12}$/);
    expect((parsed.totalChunks as number)).toBeGreaterThan(1);
    expect(String(parsed.preview)).toContain('# 超长文档');
    const outline = parsed.outline as Array<{ level: number; text: string; chunk: number }>;
    expect(outline.length).toBeGreaterThanOrEqual(2);
    expect(outline[0].text).toBe('超长文档');
    expect(outline[1].text).toBe('第一章 概述');
    expect(String(parsed.note)).toContain('kb_doc_read');
    expect(String(parsed.note)).toContain('nothing is truncated');

    // 全文已在缓存中可回读（末尾内容也能取到，验证零丢失）
    const tail = await registry.handleToolCall({
      type: 'host_tool_call',
      id: '1',
      toolCallId: 'tc2',
      toolName: 'kb_doc_read',
      arguments: { doc_id: parsed.docId, chunk: parsed.totalChunks },
    });
    const tailParsed = parseResult(tail);
    expect(String(tailParsed.markdown)).toContain('第二章 结尾');
  });

  it('同一内容重复转换命中同一缓存（内容哈希寻址）', async () => {
    const longMarkdown = '# 缓存命中测试\n\n' + '重复内容。'.repeat(9000);
    toMarkdownBytesMock.mockResolvedValue(longMarkdown);

    const docPath1 = join(tmpDir, 'cache-hit-1.docx');
    const docPath2 = join(tmpDir, 'cache-hit-2.docx');
    writeFileSync(docPath1, Buffer.from('fake'));
    writeFileSync(docPath2, Buffer.from('fake'));

    const registry = new HostToolsRegistry(undefined, tmpDir);
    const r1 = parseResult(await registry.handleToolCall({
      type: 'host_tool_call', id: '1', toolCallId: 'tc1',
      toolName: 'doc_to_markdown', arguments: { path: docPath1 },
    }));
    const r2 = parseResult(await registry.handleToolCall({
      type: 'host_tool_call', id: '1', toolCallId: 'tc2',
      toolName: 'doc_to_markdown', arguments: { path: docPath2 },
    }));

    expect(r1.docId).toBe(r2.docId);
  });

  it('使用相对路径时基于 cwd 解析', async () => {
    toMarkdownBytesMock.mockResolvedValue('# 测试');

    const cwd = tmpDir;
    const docPath = 'relative/test.docx';
    const absPath = resolve(cwd, docPath);
    mkdirSync(join(cwd, 'relative'), { recursive: true });
    writeFileSync(absPath, Buffer.from('fake'));

    const registry = new HostToolsRegistry(undefined, cwd);
    const result = await registry.handleToolCall({
      type: 'host_tool_call',
      id: '1',
      toolCallId: 'tc1',
      toolName: 'doc_to_markdown',
      arguments: { path: docPath },
    });

    const parsed = parseResult(result);
    expect(parsed.path).toBe(absPath);
  });

  it('缺少 path 参数时返回错误', async () => {
    const registry = new HostToolsRegistry(undefined, tmpDir);
    const result = await registry.handleToolCall({
      type: 'host_tool_call',
      id: '1',
      toolCallId: 'tc1',
      toolName: 'doc_to_markdown',
      arguments: {},
    });

    const parsed = parseResult(result);
    expect(parsed.error).toBeDefined();
    expect(String(parsed.error)).toContain('path is required');
  });

  it('文件不存在时返回错误', async () => {
    const registry = new HostToolsRegistry(undefined, tmpDir);
    const result = await registry.handleToolCall({
      type: 'host_tool_call',
      id: '1',
      toolCallId: 'tc1',
      toolName: 'doc_to_markdown',
      arguments: { path: '/nonexistent/file.docx' },
    });

    const parsed = parseResult(result);
    expect(parsed.error).toBeDefined();
    expect(String(parsed.error)).toContain('not found');
  });

  it('unsupported 错误码透传', async () => {
    formatFromPathMock.mockReturnValue('docx');
    toMarkdownBytesMock.mockRejectedValue(
      Object.assign(new Error('Unsupported format'), { code: 'unsupported' }),
    );

    const docPath = join(tmpDir, 'unsupported.docx');
    writeFileSync(docPath, Buffer.from('fake'));

    const registry = new HostToolsRegistry(undefined, tmpDir);
    const result = await registry.handleToolCall({
      type: 'host_tool_call',
      id: '1',
      toolCallId: 'tc1',
      toolName: 'doc_to_markdown',
      arguments: { path: docPath },
    });

    const parsed = parseResult(result);
    expect(parsed.error).toBeDefined();
    expect(parsed.code).toBe('unsupported');
  });

  it('encrypted 错误码透传', async () => {
    formatFromPathMock.mockReturnValue('docx');
    toMarkdownBytesMock.mockRejectedValue(
      Object.assign(new Error('Document is encrypted'), { code: 'encrypted' }),
    );

    const docPath = join(tmpDir, 'encrypted.docx');
    writeFileSync(docPath, Buffer.from('fake'));

    const registry = new HostToolsRegistry(undefined, tmpDir);
    const result = await registry.handleToolCall({
      type: 'host_tool_call',
      id: '1',
      toolCallId: 'tc1',
      toolName: 'doc_to_markdown',
      arguments: { path: docPath },
    });

    const parsed = parseResult(result);
    expect(parsed.code).toBe('encrypted');
  });

  it('malformed 错误码透传', async () => {
    formatFromPathMock.mockReturnValue('docx');
    toMarkdownBytesMock.mockRejectedValue(
      Object.assign(new Error('Malformed document'), { code: 'malformed' }),
    );

    const docPath = join(tmpDir, 'malformed.docx');
    writeFileSync(docPath, Buffer.from('fake'));

    const registry = new HostToolsRegistry(undefined, tmpDir);
    const result = await registry.handleToolCall({
      type: 'host_tool_call',
      id: '1',
      toolCallId: 'tc1',
      toolName: 'doc_to_markdown',
      arguments: { path: docPath },
    });

    const parsed = parseResult(result);
    expect(parsed.code).toBe('malformed');
  });

  it('resourceLimit 错误码透传', async () => {
    formatFromPathMock.mockReturnValue('docx');
    toMarkdownBytesMock.mockRejectedValue(
      Object.assign(new Error('Too large'), { code: 'resourceLimit' }),
    );

    const docPath = join(tmpDir, 'large.docx');
    writeFileSync(docPath, Buffer.from('fake'));

    const registry = new HostToolsRegistry(undefined, tmpDir);
    const result = await registry.handleToolCall({
      type: 'host_tool_call',
      id: '1',
      toolCallId: 'tc1',
      toolName: 'doc_to_markdown',
      arguments: { path: docPath },
    });

    const parsed = parseResult(result);
    expect(parsed.code).toBe('resourceLimit');
  });

  it('missingPart 错误码透传', async () => {
    formatFromPathMock.mockReturnValue('docx');
    toMarkdownBytesMock.mockRejectedValue(
      Object.assign(new Error('Missing part'), { code: 'missingPart' }),
    );

    const docPath = join(tmpDir, 'missing.docx');
    writeFileSync(docPath, Buffer.from('fake'));

    const registry = new HostToolsRegistry(undefined, tmpDir);
    const result = await registry.handleToolCall({
      type: 'host_tool_call',
      id: '1',
      toolCallId: 'tc1',
      toolName: 'doc_to_markdown',
      arguments: { path: docPath },
    });

    const parsed = parseResult(result);
    expect(parsed.code).toBe('missingPart');
  });

  it('io 错误码透传', async () => {
    formatFromPathMock.mockReturnValue('docx');
    toMarkdownBytesMock.mockRejectedValue(
      Object.assign(new Error('IO error'), { code: 'io' }),
    );

    const docPath = join(tmpDir, 'io-error.docx');
    writeFileSync(docPath, Buffer.from('fake'));

    const registry = new HostToolsRegistry(undefined, tmpDir);
    const result = await registry.handleToolCall({
      type: 'host_tool_call',
      id: '1',
      toolCallId: 'tc1',
      toolName: 'doc_to_markdown',
      arguments: { path: docPath },
    });

    const parsed = parseResult(result);
    expect(parsed.code).toBe('io');
  });

  it('未知格式返回 unsupported', async () => {
    formatFromPathMock.mockReturnValue(null);

    const docPath = join(tmpDir, 'unknown.xyz');
    writeFileSync(docPath, Buffer.from('fake'));

    const registry = new HostToolsRegistry(undefined, tmpDir);
    const result = await registry.handleToolCall({
      type: 'host_tool_call',
      id: '1',
      toolCallId: 'tc1',
      toolName: 'doc_to_markdown',
      arguments: { path: docPath },
    });

    const parsed = parseResult(result);
    expect(parsed.code).toBe('unsupported');
  });
});

// ─── kb_doc_read / kb_doc_grep / kb_doc_outline ──────────────

describe('kb_doc_read / kb_doc_grep / kb_doc_outline', () => {
  const cachedMarkdown = [
    '# 测试大纲文档',
    '',
    '## 第一章 概述',
    '',
    '本章节介绍带宽配置要求。'.repeat(700),
    '',
    '## 第二章 时序约束',
    '',
    '时序约束包括 setup 与 hold 检查。',
    '',
    '## 第三章 结尾',
    '',
    '文档结束。',
  ].join('\n');

  let registry: HostToolsRegistry;

  beforeEach(async () => {
    vi.clearAllMocks();
    registry = new HostToolsRegistry(undefined, tmpDir);
    // 直接写入缓存，绕过 doc_to_markdown（缓存内容固定，便于断言）
    const { cacheDocMarkdown } = await import('../src/main/kb/doc-cache');
    const meta = await cacheDocMarkdown(cachedMarkdown, join(tmpDir, 'cached-source.docx'));
    // 用真实 docId（内容哈希）而非固定值
    (registry as unknown as { __docId: string }).__docId = meta.docId;
  });

  function docId(): string {
    return (registry as unknown as { __docId: string }).__docId;
  }

  it('kb_doc_read：默认读第 1 块，返回行号区间与块号', async () => {
    const parsed = parseResult(await registry.handleToolCall({
      type: 'host_tool_call', id: '1', toolCallId: 'tc1',
      toolName: 'kb_doc_read', arguments: { doc_id: docId() },
    }));
    expect(parsed.docId).toBe(docId());
    expect(parsed.chunkStart).toBe(1);
    expect(parsed.totalChunks).toBeGreaterThan(1);
    expect(String(parsed.markdown)).toContain('# 测试大纲文档');
  });

  it('kb_doc_read：count 连续读取多块，块内容拼接', async () => {
    const parsed = parseResult(await registry.handleToolCall({
      type: 'host_tool_call', id: '1', toolCallId: 'tc1',
      toolName: 'kb_doc_read', arguments: { doc_id: docId(), chunk: 1, count: 99 },
    }));
    expect(parsed.chunkStart).toBe(1);
    expect(parsed.chunkEnd).toBe(parsed.totalChunks);
    expect(String(parsed.markdown)).toContain('文档结束。');
  });

  it('kb_doc_read：chunk 越界返回结构化错误', async () => {
    const parsed = parseResult(await registry.handleToolCall({
      type: 'host_tool_call', id: '1', toolCallId: 'tc1',
      toolName: 'kb_doc_read', arguments: { doc_id: docId(), chunk: 9999 },
    }));
    expect(String(parsed.error)).toContain('out of range');
  });

  it('kb_doc_read：未知 doc_id 返回可操作错误（引导重新转换）', async () => {
    const parsed = parseResult(await registry.handleToolCall({
      type: 'host_tool_call', id: '1', toolCallId: 'tc1',
      toolName: 'kb_doc_read', arguments: { doc_id: 'b'.repeat(12) },
    }));
    expect(String(parsed.error)).toContain('Unknown or expired doc_id');
    expect(String(parsed.error)).toContain('doc_to_markdown');
  });

  it('kb_doc_grep：正则命中并标注分块号', async () => {
    const parsed = parseResult(await registry.handleToolCall({
      type: 'host_tool_call', id: '1', toolCallId: 'tc1',
      toolName: 'kb_doc_grep', arguments: { doc_id: docId(), pattern: '时序约束包括' },
    }));
    expect(parsed.mode).toBe('regex');
    expect(parsed.totalMatches).toBe(1);
    const match = (parsed.matches as Array<{ line: number; chunk: number; text: string }>)[0];
    expect(match.text).toContain('时序约束包括');
    expect(match.chunk).toBeGreaterThan(0);
  });

  it('kb_doc_grep：非法正则退化为字面量匹配', async () => {
    const parsed = parseResult(await registry.handleToolCall({
      type: 'host_tool_call', id: '1', toolCallId: 'tc1',
      toolName: 'kb_doc_grep', arguments: { doc_id: docId(), pattern: '带宽配置(未闭合' },
    }));
    expect(parsed.mode).toBe('literal');
    expect(parsed.totalMatches).toBe(0);
  });

  it('kb_doc_grep：无命中时返回空列表与提示', async () => {
    const parsed = parseResult(await registry.handleToolCall({
      type: 'host_tool_call', id: '1', toolCallId: 'tc1',
      toolName: 'kb_doc_grep', arguments: { doc_id: docId(), pattern: '不存在的词' },
    }));
    expect(parsed.totalMatches).toBe(0);
    expect(parsed.matches).toEqual([]);
  });

  it('kb_doc_grep：缺少 pattern 参数返回错误', async () => {
    const parsed = parseResult(await registry.handleToolCall({
      type: 'host_tool_call', id: '1', toolCallId: 'tc1',
      toolName: 'kb_doc_grep', arguments: { doc_id: docId() },
    }));
    expect(String(parsed.error)).toContain('pattern is required');
  });

  it('kb_doc_outline：返回标题大纲并映射分块', async () => {
    const parsed = parseResult(await registry.handleToolCall({
      type: 'host_tool_call', id: '1', toolCallId: 'tc1',
      toolName: 'kb_doc_outline', arguments: { doc_id: docId() },
    }));
    expect(parsed.outlineCount).toBe(4); // # + 3 个 ##
    const outline = parsed.outline as Array<{ level: number; text: string; chunk: number; line: number }>;
    expect(outline[0]).toMatchObject({ level: 1, text: '测试大纲文档', line: 1, chunk: 0 });
    expect(outline[1].text).toBe('第一章 概述');
    expect(outline[3].text).toBe('第三章 结尾');
  });

  it('kb_doc_outline：未知 doc_id 返回错误', async () => {
    const parsed = parseResult(await registry.handleToolCall({
      type: 'host_tool_call', id: '1', toolCallId: 'tc1',
      toolName: 'kb_doc_outline', arguments: { doc_id: 'c'.repeat(12) },
    }));
    expect(String(parsed.error)).toContain('Unknown or expired doc_id');
  });

  it('新工具均已注册且参数 schema 正确', () => {
    const defs = registry.getDefinitions();
    const readDef = defs.find((d) => d.name === 'kb_doc_read');
    const grepDef = defs.find((d) => d.name === 'kb_doc_grep');
    const outlineDef = defs.find((d) => d.name === 'kb_doc_outline');
    expect(readDef).toBeDefined();
    expect((readDef!.parameters as { required: string[] }).required).toContain('doc_id');
    expect(grepDef).toBeDefined();
    expect((grepDef!.parameters as { required: string[] }).required).toEqual(expect.arrayContaining(['doc_id', 'pattern']));
    expect(outlineDef).toBeDefined();
  });
});

// ─── kb_search ──────────────────────────────────────────────

describe('kb_search', () => {
  let kbPath: string;

  beforeEach(() => {
    vi.clearAllMocks();

    // 创建临时知识库目录
    kbPath = join(tmpDir, `kb-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`);
    mkdirSync(join(kbPath, 'docs', '协议手册'), { recursive: true });
    mkdirSync(join(kbPath, 'docs', '验证计划'), { recursive: true });

    // 写入 index.md
    writeFileSync(
      join(kbPath, 'index.md'),
      [
        '# 知识库索引',
        '',
        '## 协议手册',
        '',
        '### DDR5 协议规范',
        '- **路径**: `协议手册/DDR5.md`',
        '- **摘要**: DDR5 SDRAM 的电气与时序规范',
        '- **关键词**: `DDR5` · `SDRAM` · `时序`',
        '',
        '### PCIe 5.0 规范',
        '- **路径**: `协议手册/PCIe.md`',
        '- **摘要**: PCIe 5.0 链路层与物理层规范',
        '- **关键词**: `PCIe` · `链路` · `物理层`',
        '',
        '## 验证计划',
        '',
        '### CPU 验证计划',
        '- **路径**: `验证计划/CPU验证.md`',
        '- **摘要**: CPU 子系统验证策略与用例规划',
        '- **关键词**: `CPU` · `验证` · `覆盖率`',
        '',
      ].join('\n'),
      'utf-8',
    );

    // 写入 Markdown 文件（含全文内容）
    writeFileSync(
      join(kbPath, 'docs', '协议手册', 'DDR5.md'),
      '# DDR5 协议规范\n\n本文档描述 DDR5 SDRAM 的电气规范和时序要求。\n',
      'utf-8',
    );
    writeFileSync(
      join(kbPath, 'docs', '协议手册', 'PCIe.md'),
      '# PCIe 5.0 规范\n\nPCI Express 5.0 链路规范。\n',
      'utf-8',
    );
    writeFileSync(
      join(kbPath, 'docs', '验证计划', 'CPU验证.md'),
      '# CPU 验证计划\n\nCPU 子系统验证策略。\n\n覆盖率目标：95%。\n',
      'utf-8',
    );

    // mock status 返回挂载的库
    statusMock.mockResolvedValue({
      mounted: {
        kbId: 'test-kb-id',
        mountedAt: Date.now(),
        name: 'Test KB',
        path: kbPath,
      },
      health: { hasSources: true, hasDocs: true, hasIndex: true },
    });
  });

  afterEach(() => {
    rmSync(kbPath, { recursive: true, force: true });
  });

  it('索引匹配：标题命中', async () => {
    const registry = new HostToolsRegistry(undefined, tmpDir);
    const result = await registry.handleToolCall({
      type: 'host_tool_call',
      id: '1',
      toolCallId: 'tc1',
      toolName: 'kb_search',
      arguments: { query: 'DDR5' },
    });

    const parsed = parseResult(result);
    expect(parsed.total).toBeGreaterThanOrEqual(1);
    const firstResult = (parsed.results as Array<Record<string, unknown>>)[0];
    expect(firstResult.title).toContain('DDR5');
    // matchedBy 可能是 'index' 或 'both'（如果查询词也在全文中出现）
    expect(['index', 'both']).toContain(firstResult.matchedBy);
    expect(firstResult.score).toBeGreaterThan(0);
  });

  it('关键词匹配', async () => {
    const registry = new HostToolsRegistry(undefined, tmpDir);
    const result = await registry.handleToolCall({
      type: 'host_tool_call',
      id: '1',
      toolCallId: 'tc1',
      toolName: 'kb_search',
      arguments: { query: '时序' },
    });

    const parsed = parseResult(result);
    expect(parsed.total).toBeGreaterThanOrEqual(1);
    const titles = (parsed.results as Array<Record<string, unknown>>).map((r) => r.title);
    expect(titles).toContain('DDR5 协议规范');
  });

  it('全文匹配', async () => {
    const registry = new HostToolsRegistry(undefined, tmpDir);
    const result = await registry.handleToolCall({
      type: 'host_tool_call',
      id: '1',
      toolCallId: 'tc1',
      toolName: 'kb_search',
      arguments: { query: '覆盖率' },
    });

    const parsed = parseResult(result);
    // "覆盖率" 在 CPU 验证计划的 index 关键词和全文中都有
    expect(parsed.total).toBeGreaterThanOrEqual(1);
    const titles = (parsed.results as Array<Record<string, unknown>>).map((r) => r.title);
    expect(titles.some((t) => String(t).includes('CPU'))).toBe(true);
  });

  it('评分排序：标题命中得分高于全文命中', async () => {
    const registry = new HostToolsRegistry(undefined, tmpDir);
    const result = await registry.handleToolCall({
      type: 'host_tool_call',
      id: '1',
      toolCallId: 'tc1',
      toolName: 'kb_search',
      arguments: { query: 'PCIe 链路' },
    });

    const parsed = parseResult(result);
    const results = parsed.results as Array<Record<string, unknown>>;
    expect(results.length).toBeGreaterThanOrEqual(1);

    // PCIe 5.0 规范应该排在最前面（标题 + 关键词 + 摘要命中）
    expect(results[0].title).toContain('PCIe');
  });

  it('限量返回', async () => {
    const registry = new HostToolsRegistry(undefined, tmpDir);
    const result = await registry.handleToolCall({
      type: 'host_tool_call',
      id: '1',
      toolCallId: 'tc1',
      toolName: 'kb_search',
      arguments: { query: '验证', limit: 1 },
    });

    const parsed = parseResult(result);
    expect(parsed.total).toBeLessThanOrEqual(1);
  });

  it('未挂载知识库时返回错误', async () => {
    statusMock.mockResolvedValue({
      mounted: null,
      health: { hasSources: false, hasDocs: false, hasIndex: false },
    });

    const registry = new HostToolsRegistry(undefined, tmpDir);
    const result = await registry.handleToolCall({
      type: 'host_tool_call',
      id: '1',
      toolCallId: 'tc1',
      toolName: 'kb_search',
      arguments: { query: 'test' },
    });

    const parsed = parseResult(result);
    expect(parsed.error).toBeDefined();
    expect(String(parsed.error)).toContain('No knowledge base mounted');
  });

  it('缺少 query 参数时返回错误', async () => {
    const registry = new HostToolsRegistry(undefined, tmpDir);
    const result = await registry.handleToolCall({
      type: 'host_tool_call',
      id: '1',
      toolCallId: 'tc1',
      toolName: 'kb_search',
      arguments: {},
    });

    const parsed = parseResult(result);
    expect(parsed.error).toBeDefined();
    expect(String(parsed.error)).toContain('query is required');
  });

  it('无匹配时返回空列表', async () => {
    const registry = new HostToolsRegistry(undefined, tmpDir);
    const result = await registry.handleToolCall({
      type: 'host_tool_call',
      id: '1',
      toolCallId: 'tc1',
      toolName: 'kb_search',
      arguments: { query: 'xyzqwerty' },
    });

    const parsed = parseResult(result);
    expect(parsed.total).toBe(0);
    expect(parsed.results).toEqual([]);
  });

  it('分类过滤：限定 category 时其他分类不返回', async () => {
    const registry = new HostToolsRegistry(undefined, tmpDir);

    // "覆盖率" 只出现在 验证计划 分类（CPU 验证计划），限定 协议手册 时应为空
    const filtered = await registry.handleToolCall({
      type: 'host_tool_call',
      id: '1',
      toolCallId: 'tc1',
      toolName: 'kb_search',
      arguments: { query: '覆盖率', category: '协议手册' },
    });
    expect(parseResult(filtered).total).toBe(0);

    // 限定 验证计划 时正常命中，且结果都属于该分类
    const matched = await registry.handleToolCall({
      type: 'host_tool_call',
      id: '1',
      toolCallId: 'tc2',
      toolName: 'kb_search',
      arguments: { query: '覆盖率', category: '验证计划' },
    });
    const parsed = parseResult(matched);
    expect(parsed.total).toBeGreaterThanOrEqual(1);
    for (const r of parsed.results as Array<{ category: string }>) {
      expect(r.category).toBe('验证计划');
    }
  });

  it('中文 bigram 匹配：bigram 命中得分高于单字噪音', async () => {
    // 噪音文档只含单字"时""序"，不含"时序"bigram
    writeFileSync(
      join(kbPath, 'docs', '验证计划', '噪音文档.md'),
      '本序列说明各阶段安排次序，涉及时钟与频率配置。',
      'utf-8',
    );

    const registry = new HostToolsRegistry(undefined, tmpDir);
    const result = await registry.handleToolCall({
      type: 'host_tool_call',
      id: '1',
      toolCallId: 'tc1',
      toolName: 'kb_search',
      arguments: { query: '时序' },
    });

    const parsed = parseResult(result);
    const results = parsed.results as Array<{ path: string; score: number }>;
    const ddr5 = results.find((r) => r.path.includes('DDR5'));
    expect(ddr5).toBeDefined();
    if (!ddr5) return;

    const noise = results.find((r) => r.path.includes('噪音文档'));
    if (noise) {
      // 单字命中（0.2/字）得分应低于 bigram 命中（1/次）
      expect(noise.score).toBeLessThan(ddr5.score);
    }
  });

  it('全文命中返回 snippet，path 为绝对路径（Agent read 工具可直接用）', async () => {
    const registry = new HostToolsRegistry(undefined, tmpDir);
    const result = await registry.handleToolCall({
      type: 'host_tool_call',
      id: '1',
      toolCallId: 'tc1',
      toolName: 'kb_search',
      arguments: { query: '覆盖率目标' },
    });

    const parsed = parseResult(result);
    const first = (parsed.results as Array<Record<string, unknown>>)[0];
    // path 为绝对文件路径：Agent 的 read 工具按会话 cwd 解析相对路径，
    // 库目录与 cwd 往往不同，相对路径会读到 "Path not found"
    expect(isAbsolute(String(first.path))).toBe(true);
    expect(String(first.path)).toContain('CPU验证.md');
    expect(String(first.snippet)).toContain('覆盖率目标');
  });
});

// ─── searcher 纯函数测试 ─────────────────────────────────────

describe('searcher — 纯函数', () => {
  it('searchKb 返回正确的结果结构', async () => {
    const kbPath = join(tmpDir, `kb-fn-${Date.now()}`);
    mkdirSync(join(kbPath, 'docs', '分类A'), { recursive: true });

    writeFileSync(
      join(kbPath, 'index.md'),
      [
        '# 知识库索引',
        '',
        '## 分类A',
        '',
        '### 文档1',
        '- **路径**: `分类A/doc1.md`',
        '- **摘要**: 这是一个测试文档',
        '- **关键词**: `测试` · `文档`',
        '',
      ].join('\n'),
      'utf-8',
    );

    writeFileSync(
      join(kbPath, 'docs', '分类A', 'doc1.md'),
      '# 文档1\n\n这是测试文档的正文内容。\n',
      'utf-8',
    );

    const results = await searchKb(kbPath, '测试');
    expect(results.length).toBeGreaterThanOrEqual(1);
    expect(results[0].title).toBe('文档1');
    expect(results[0].path).toBe('分类A/doc1.md');
    expect(results[0].score).toBeGreaterThan(0);

    rmSync(kbPath, { recursive: true, force: true });
  });
});

// ─── context-injector 测试 ───────────────────────────────────

describe('context-injector', () => {
  let kbPath: string;

  beforeEach(() => {
    vi.clearAllMocks();

    kbPath = join(tmpDir, `kb-ctx-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`);
    mkdirSync(join(kbPath, 'sources'), { recursive: true });
    mkdirSync(join(kbPath, 'docs'), { recursive: true });

    statusMock.mockResolvedValue({
      mounted: {
        kbId: 'test-kb-id',
        mountedAt: Date.now(),
        name: 'Test KB',
        path: kbPath,
      },
      health: { hasSources: true, hasDocs: true, hasIndex: true },
    });
  });

  afterEach(() => {
    rmSync(kbPath, { recursive: true, force: true });
  });

  it('未挂载库时返回空上下文', async () => {
    statusMock.mockResolvedValue({
      mounted: null,
      health: { hasSources: false, hasDocs: false, hasIndex: false },
    });

    const result = await buildKbContext(projectDir);
    expect(result.contextText).toBe('');
    expect(result.kbName).toBeNull();
  });

  it('挂载库有 index.md 时注入上下文', async () => {
    writeFileSync(
      join(kbPath, 'index.md'),
      '# 知识库索引\n\n## 分类A\n\n### 文档1\n- **路径**: `doc1.md`\n- **摘要**: 摘要\n',
      'utf-8',
    );

    const result = await buildKbContext(projectDir);
    expect(result.contextText).toContain('<kb-index');
    expect(result.contextText).toContain('知识库索引');
    expect(result.kbName).toBe('Test KB');
    expect(result.truncated).toBe(false);
  });

  it('index.md 为空时不注入', async () => {
    writeFileSync(join(kbPath, 'index.md'), '', 'utf-8');

    const result = await buildKbContext(projectDir);
    expect(result.contextText).toBe('');
  });

  it('index.md 不存在时不注入', async () => {
    const result = await buildKbContext(projectDir);
    expect(result.contextText).toBe('');
  });

  it('索引超长时降级为压缩视图并保留全部分类', async () => {
    // 生成超长索引（单分类 + 超长摘要触发压缩，不做中间硬截断丢分类）
    const longContent = '# 知识库索引\n\n' + '## 分类\n\n' +
      '### 文档\n- **路径**: `doc.md`\n- **摘要**: ' + '很长的摘要'.repeat(2000) + '\n';
    writeFileSync(join(kbPath, 'index.md'), longContent, 'utf-8');

    const result = await buildKbContext(projectDir);
    expect(result.truncated).toBe(true);
    expect(result.contextText).toContain('索引已截断');
    expect(result.contextText).toContain('kb_search');
    // 压缩视图保留分类与条目路径（而非从中间切掉）。
    // 路径为绝对路径：Agent 的 read 工具按会话 cwd 解析相对路径，读不到库内文档。
    expect(result.contextText).toContain('分类（1 篇）');
    const compactLine = result.contextText
      .split('\n')
      .find((l) => l.startsWith('- 文档（'));
    expect(compactLine).toBeDefined();
    expect(compactLine).toContain('doc.md');
    const innerPath = compactLine?.slice('- 文档（'.length, -1) ?? '';
    expect(isAbsolute(innerPath)).toBe(true);
  });

  it('injectKbContext 追加到已有 systemPrompt', async () => {
    writeFileSync(
      join(kbPath, 'index.md'),
      '# 知识库索引\n\n## 分类A\n',
      'utf-8',
    );

    const original = 'You are a SoC verification assistant.';
    const result = await injectKbContext(original, projectDir);
    expect(result).toBeDefined();
    expect(result).toContain('You are a SoC verification assistant.');
    expect(result).toContain('<kb-index');
  });

  it('injectKbContext 无 systemPrompt 时以 KB 上下文开始', async () => {
    writeFileSync(
      join(kbPath, 'index.md'),
      '# 知识库索引\n\n## 分类A\n',
      'utf-8',
    );

    const result = await injectKbContext(undefined, projectDir);
    expect(result).toBeDefined();
    expect(result).toContain('<kb-index');
  });

  it('injectKbContext 未挂载库时保持原 systemPrompt', async () => {
    statusMock.mockResolvedValue({
      mounted: null,
      health: { hasSources: false, hasDocs: false, hasIndex: false },
    });

    const original = 'Original system prompt.';
    const result = await injectKbContext(original, projectDir);
    expect(result).toBe(original);
  });

  it('injectKbContext 未挂载库且无 systemPrompt 时返回 undefined', async () => {
    statusMock.mockResolvedValue({
      mounted: null,
      health: { hasSources: false, hasDocs: false, hasIndex: false },
    });

    const result = await injectKbContext(undefined, projectDir);
    expect(result).toBeUndefined();
  });
});

// ─── kb_search — wiki 布局（issue 14，统一检索服务）──────────

describe('kb_search — wiki 布局', () => {
  let kbPath: string;
  let kbPathB: string;

  const writePage = (root: string, rel: string, content: string): void => {
    const abs = join(root, 'wiki', rel);
    mkdirSync(abs.replace(/[\\/][^\\/]*$/, ''), { recursive: true });
    writeFileSync(abs, content, 'utf-8');
  };

  const page = (type: string, title: string, body = ''): string => [
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

  const sources = (over: Record<string, unknown>): Record<string, unknown> => ({
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
    ...over,
  });

  beforeEach(async () => {
    vi.clearAllMocks();
    kbPath = join(tmpDir, `wikikb-a-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`);
    kbPathB = join(tmpDir, `wikikb-b-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`);
    await initWikiLayout(kbPath, { kbId: 'kb-wiki-a', name: 'Wiki A' });
    await initWikiLayout(kbPathB, { kbId: 'kb-wiki-b', name: 'Wiki B' });

    writePage(kbPath, 'concepts/dds.md', page('concept', 'DDS 原理', 'AWLEN 位宽 [7:0]。'));
    writePage(kbPath, 'pitfalls/dds-p.md', page('pitfall', 'DDS 踩坑'));

    // manifest sources + parsed 全文
    await writeWikiManifest(kbPath, {
      manifestVersion: 1, format: 'wiki', kbId: 'kb-wiki-a', name: 'Wiki A',
      createdAt: '2026-09-13T00:00:00Z', updatedAt: '2026-09-13T00:00:00Z',
      sources: { 'src-1': sources({}) },
    } as unknown as WikiKbManifest);
    const parsedPath = join(wikiLayout(kbPath).rawParsedDir, 'spec', 'dds.pdf.md');
    mkdirSync(parsedPath.replace(/[\\/][^\\/]*$/, ''), { recursive: true });
    writeFileSync(parsedPath, '来源全文：DDS 直接频率合成。\n', 'utf-8');

    statusMock.mockResolvedValue({
      mounted: { kbId: 'kb-wiki-a', mountedAt: Date.now(), name: 'Wiki A', path: kbPath, format: 'wiki', state: 'active' },
      health: { hasSources: true, hasDocs: false, hasIndex: false },
      wikiHealth: null,
    });
  });

  afterEach(() => {
    rmSync(kbPath, { recursive: true, force: true });
    rmSync(kbPathB, { recursive: true, force: true });
  });

  it('wiki 挂载走统一检索服务：kind、pageType、absolutePath、覆盖状态', async () => {
    const registry = new HostToolsRegistry(undefined, tmpDir);
    const result = await registry.handleToolCall({
      type: 'host_tool_call', id: 'w1', toolCallId: 'tw1', toolName: 'kb_search',
      arguments: { query: 'DDS', pageType: 'pitfall', kind: 'wiki' },
    });

    const parsed = parseResult(result);
    expect(parsed.mode).toBe('keyword');
    expect(parsed.kbId).toBe('kb-wiki-a');
    // kind='wiki' 限定检索对象：coverage 只计参与排名的候选，parsedSources=0
    expect(parsed.coverage).toEqual({ wikiPages: 2, parsedSources: 0 });
    const results = parsed.results as Array<Record<string, unknown>>;
    expect(results).toHaveLength(1);
    expect(results[0].kind).toBe('wiki');
    expect(results[0].id).toBe('pitfalls/dds-p');
    expect(results[0].pageType).toBe('pitfall');
    // path 是运行时绝对路径（Agent 的 read 工具按会话 cwd 解析相对路径会失败）
    expect(results[0].path).toBe(join(kbPath, 'wiki', 'pitfalls', 'dds-p.md'));
  });

  it('parsed 命中：kind=parsed、来源修订、relativePath 前缀 raw/parsed', async () => {
    const registry = new HostToolsRegistry(undefined, tmpDir);
    const result = await registry.handleToolCall({
      type: 'host_tool_call', id: 'w2', toolCallId: 'tw2', toolName: 'kb_search',
      arguments: { query: '直接频率合成', kind: 'parsed' },
    });

    const parsed = parseResult(result);
    const results = parsed.results as Array<Record<string, unknown>>;
    expect(results).toHaveLength(1);
    expect(results[0].kind).toBe('parsed');
    expect(results[0].id).toBe('src-1');
    expect(results[0].relativePath).toBe('raw/parsed/spec/dds.pdf.md');
    expect(results[0].sourceRevision).toBe('rev-a');
    expect(results[0].stale).toBe(false);
    expect(String(results[0].snippet)).toContain('直接频率合成');
  });

  it('未挂载库返回 notMounted 错误', async () => {
    statusMock.mockResolvedValue({
      mounted: null,
      health: { hasSources: false, hasDocs: false, hasIndex: false },
      wikiHealth: null,
    });

    const registry = new HostToolsRegistry(undefined, tmpDir);
    const result = await registry.handleToolCall({
      type: 'host_tool_call', id: 'w3', toolCallId: 'tw3', toolName: 'kb_search',
      arguments: { query: 'DDS' },
    });

    const parsed = parseResult(result);
    expect(parsed.code).toBe('notMounted');
    expect(String(parsed.error)).toContain('No knowledge base mounted');
  });

  it('切库后动态核对：每次调用都返回当前挂载库的数据（旧注入不是跨库授权）', async () => {
    writePage(kbPathB, 'concepts/b-page.md', page('concept', 'B 库专属页'));

    const registry = new HostToolsRegistry(undefined, tmpDir);
    const first = parseResult(await registry.handleToolCall({
      type: 'host_tool_call', id: 'w4', toolCallId: 'tw4', toolName: 'kb_search',
      arguments: { query: 'B 库专属' },
    }));
    expect((first.results as unknown[]).length).toBe(0); // A 库没有该页

    // 切换挂载到 B 库（同一会话、同一系统提示）
    statusMock.mockResolvedValue({
      mounted: { kbId: 'kb-wiki-b', mountedAt: Date.now(), name: 'Wiki B', path: kbPathB, format: 'wiki', state: 'active' },
      health: { hasSources: false, hasDocs: false, hasIndex: false },
      wikiHealth: null,
    });

    const second = parseResult(await registry.handleToolCall({
      type: 'host_tool_call', id: 'w5', toolCallId: 'tw5', toolName: 'kb_search',
      arguments: { query: 'B 库专属' },
    }));
    const results = second.results as Array<Record<string, unknown>>;
    expect(results).toHaveLength(1);
    expect(second.kbId).toBe('kb-wiki-b');
    expect(results[0].path).toBe(join(kbPathB, 'wiki', 'concepts', 'b-page.md'));
  });
});

// ─── buildKbContext — wiki 布局注入（issue 14，spec §8）──────

describe('buildKbContext — wiki 布局注入', () => {
  let kbPath: string;

  const writePage = (rel: string, content: string): void => {
    const abs = join(kbPath, 'wiki', rel);
    mkdirSync(abs.replace(/[\\/][^\\/]*$/, ''), { recursive: true });
    writeFileSync(abs, content, 'utf-8');
  };

  const page = (type: string, title: string, summaryLen = 10): string => [
    '---',
    `type: ${type}`,
    `title: "${title}"`,
    `summary: ${'很长的摘要内容'.repeat(Math.ceil(summaryLen / 6)).slice(0, summaryLen)}`,
    'keywords: [测试]',
    'tags: [单测]',
    'sources: []',
    'created: "2026-09-13T00:00:00Z"',
    'updated: "2026-09-13T00:00:00Z"',
    '---',
    '',
    `# ${title}`,
  ].join('\n');

  beforeEach(async () => {
    vi.clearAllMocks();
    kbPath = join(tmpDir, `wikikb-inject-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`);
    await initWikiLayout(kbPath, { kbId: 'kb-inject', name: '注入测试库' });
    statusMock.mockResolvedValue({
      mounted: { kbId: 'kb-inject', mountedAt: Date.now(), name: '注入测试库', path: kbPath, format: 'wiki', state: 'active' },
      health: { hasSources: false, hasDocs: false, hasIndex: false },
      wikiHealth: null,
    });
  });

  afterEach(() => {
    rmSync(kbPath, { recursive: true, force: true });
  });

  it('有已发布页：类型骨架计数 + 完整条目（pageId + 绝对路径）+ 工具说明，总长 ≤ 8000', async () => {
    writePage('concepts/dds.md', page('concept', 'DDS 原理'));
    writePage('entities/ddr.md', page('entity', 'DDR 控制器'));

    const result = await buildKbContext(projectDir);
    expect(result.truncated).toBe(false);
    expect(result.contextText.length).toBeLessThanOrEqual(8000);
    expect(result.contextText).toContain('<kb-index');
    expect(result.contextText).toContain('kb_search'); // 工具说明计入预算
    expect(result.contextText).toContain('concept（概念）：1 页');
    expect(result.contextText).toContain('entity（实体）：1 页');
    // 条目含 pageId 与运行时绝对路径
    expect(result.contextText).toContain('（concepts/dds）');
    expect(result.contextText).toContain(join(kbPath, 'wiki', 'concepts', 'dds.md'));
  });

  it('页数超预算：整条目不截半、总长恒 ≤ 8000、truncated=true 并提示 kb_search', async () => {
    // 每条目 ~300 字符 → 60 页必超 8000
    for (let i = 0; i < 60; i++) {
      writePage(`concepts/p${String(i).padStart(2, '0')}.md`, page('concept', `页面 ${i}`, 120));
    }

    const result = await buildKbContext(projectDir);
    expect(result.truncated).toBe(true);
    expect(result.contextText.length).toBeLessThanOrEqual(8000);
    expect(result.contextText).toContain('注入预算已达上限');
    expect(result.contextText).toContain('kb_search');
    // 不在半个链接处截断：非空行要么是骨架/提示，要么是完整条目行
    const entryLines = result.contextText.split('\n').filter((l) => l.startsWith('- ') && l.includes('）: '));
    expect(entryLines.length).toBeGreaterThan(0);
    for (const line of entryLines) {
      expect(line).toMatch(/^- .+（.+）: .+( — .*)?$/); // pageId 与路径完整
      expect(line.endsWith('）:')).toBe(false); // 路径没被截在中间
    }
    expect(result.contextText.endsWith('</kb-index>')).toBe(true);
  });

  it('仅 raw（无已发布页有来源）：说明未编译来源 + kb_search 检索入口', async () => {
    writeFileSync(join(kbPath, 'raw', 'sources', 'spec.pdf'), 'PDF bytes', 'utf-8');

    const result = await buildKbContext(projectDir);
    expect(result.contextText).not.toBe('');
    expect(result.contextText).toContain('未编译来源');
    expect(result.contextText).toContain('kb_search');
    expect(result.contextText).not.toContain('（concepts/'); // 无条目
  });

  it('空库（无已发布页也无来源）：不注入', async () => {
    const result = await buildKbContext(projectDir);
    expect(result.contextText).toBe('');
  });
});

// ─── kb_read — 只读证据读取（issue 15，spec §8）──────────────

describe('kb_read — wiki 布局', () => {
  let kbPath: string;
  // 资产/来源身份是内容 hash：sourceId 必须是 64 位 hex
  const SID = 'aa'.repeat(32);

  const writePage = (rel: string, content: string): void => {
    const abs = join(kbPath, 'wiki', rel);
    mkdirSync(abs.replace(/[\\/][^\\/]*$/, ''), { recursive: true });
    writeFileSync(abs, content, 'utf-8');
  };

  const page = (type: string, title: string, body = ''): string => [
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

  const sourceRecord = (over: Record<string, unknown>): Record<string, unknown> => ({
    sourcePath: 'spec/dds.pdf',
    sourceId: SID,
    ext: '.pdf',
    size: 100,
    currentRevision: 'a'.repeat(64),
    parsedRevision: 'a'.repeat(64),
    parsedHash: 'p1'.padEnd(64, '0'),
    engine: 'anydoc',
    engineFingerprint: 'fp',
    status: 'ready',
    assetCount: 1,
    importedAt: '2026-09-13T00:00:00Z',
    updatedAt: '2026-09-13T00:00:00Z',
    ...over,
  });

  const writeManifest = async (sources: Record<string, unknown>): Promise<void> => {
    await writeWikiManifest(kbPath, {
      manifestVersion: 1, format: 'wiki', kbId: 'kb-read-tool', name: 'Read Tool',
      createdAt: '2026-09-13T00:00:00Z', updatedAt: '2026-09-13T00:00:00Z',
      sources: sources as unknown as WikiKbManifest['sources'],
    } as unknown as WikiKbManifest);
  };

  const writeAssetFixture = (): void => {
    const rev = 'a'.repeat(64);
    const assetId = '1'.repeat(64);
    const dir = join(wikiLayout(kbPath).rawAssetsDir, SID, rev);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, `${assetId}.png`), Buffer.from([0x89, 0x50, 0x4e, 0x47]));
    writeFileSync(join(dir, 'pdf-assets.json'), JSON.stringify({
      manifestVersion: 1, sourceId: SID, revision: rev, parsedHash: null,
      extractor: { runtime: 'pdfjs', version: '1' },
      assets: [{ assetId, ext: 'png', page: 2, method: 'object', width: 8, height: 8 }],
      pages: [], stats: {}, extractions: [], textLayer: true,
      createdAt: '2026-09-13T00:00:00Z', updatedAt: '2026-09-13T00:00:00Z',
    }), 'utf-8');
  };

  beforeEach(async () => {
    vi.clearAllMocks();
    kbPath = join(tmpDir, `wikikb-read-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`);
    await initWikiLayout(kbPath, { kbId: 'kb-read-tool', name: 'Read Tool' });

    writePage('concepts/dds.md', page('concept', 'DDS 原理', '第一段。\n\n第二段。'));

    // 真实系统 sources 以 sourceId 为 key（source-import.ts），id 查询按 key 命中
    await writeManifest({ [SID]: sourceRecord({}) });
    const parsedPath = join(wikiLayout(kbPath).rawParsedDir, 'spec', 'dds.pdf.md');
    mkdirSync(parsedPath.replace(/[\\/][^\\/]*$/, ''), { recursive: true });
    writeFileSync(parsedPath, '来源全文：DDS 直接频率合成。\n第二行。\n', 'utf-8');
    writeAssetFixture();

    statusMock.mockResolvedValue({
      mounted: { kbId: 'kb-read-tool', mountedAt: Date.now(), name: 'Read Tool', path: kbPath, format: 'wiki', state: 'active' },
      health: { hasSources: true, hasDocs: false, hasIndex: false },
      wikiHealth: null,
    });
  });

  afterEach(() => {
    rmSync(kbPath, { recursive: true, force: true });
  });

  it('kind=wiki：按 pageId 分页读取，返回 hash/行号/next', async () => {
    const registry = new HostToolsRegistry(undefined, tmpDir);
    const parsed = parseResult(await registry.handleToolCall({
      type: 'host_tool_call', id: 'r1', toolCallId: 'tr1', toolName: 'kb_read',
      arguments: { kind: 'wiki', id: 'concepts/dds', maxChars: 30 },
    }));

    expect(parsed.kind).toBe('wiki');
    expect(parsed.kbId).toBe('kb-read-tool');
    expect(parsed.title).toBe('DDS 原理');
    expect(parsed.startLine).toBe(1);
    expect(parsed.next).toBeGreaterThan(1);
    expect(typeof parsed.hash).toBe('string');
  });

  it('kind=parsed：读来源全文；按 next 翻页拼接不丢失', async () => {
    const registry = new HostToolsRegistry(undefined, tmpDir);
    const first = parseResult(await registry.handleToolCall({
      type: 'host_tool_call', id: 'r2', toolCallId: 'tr2', toolName: 'kb_read',
      arguments: { kind: 'parsed', id: SID, maxChars: 12 },
    }));
    expect(first.kind).toBe('parsed');
    expect(first.hash).toBe('p1'.padEnd(64, '0'));
    expect(first.isHistorical).toBe(false);

    const second = parseResult(await registry.handleToolCall({
      type: 'host_tool_call', id: 'r3', toolCallId: 'tr3', toolName: 'kb_read',
      arguments: { kind: 'parsed', id: SID, startLine: first.next, maxChars: 500 },
    }));
    expect(first.content).not.toContain('第二行');
    expect(second.content).toContain('第二行');
  });

  it('kind=asset：返回 image 内容块 + 元数据文本块', async () => {
    const registry = new HostToolsRegistry(undefined, tmpDir);
    const result = await registry.handleToolCall({
      type: 'host_tool_call', id: 'r4', toolCallId: 'tr4', toolName: 'kb_read',
      arguments: { kind: 'asset', id: SID, assetId: '1'.repeat(64) },
    });

    const content = (result as { content: Array<{ type: string; text?: string; data?: string; mimeType?: string }> }).content;
    const textBlock = content.find((c) => c.type === 'text');
    const imageBlock = content.find((c) => c.type === 'image');
    expect(textBlock).toBeDefined();
    expect(imageBlock).toBeDefined();
    expect(imageBlock!.mimeType).toBe('image/png');

    const meta = JSON.parse(textBlock!.text!) as Record<string, unknown>;
    expect(meta.kind).toBe('asset');
    expect(meta.assetId).toBe('1'.repeat(64));
    expect(meta.page).toBe(2);
    expect(meta.method).toBe('object');
  });

  it('未挂载库返回 notMounted', async () => {
    statusMock.mockResolvedValue({
      mounted: null,
      health: { hasSources: false, hasDocs: false, hasIndex: false },
      wikiHealth: null,
    });
    const registry = new HostToolsRegistry(undefined, tmpDir);
    const parsed = parseResult(await registry.handleToolCall({
      type: 'host_tool_call', id: 'r5', toolCallId: 'tr5', toolName: 'kb_read',
      arguments: { kind: 'wiki', id: 'concepts/dds' },
    }));
    expect(parsed.code).toBe('notMounted');
  });

  it('legacy 布局挂载返回 notWikiLayout（旧布局走 docId 工具）', async () => {
    statusMock.mockResolvedValue({
      mounted: { kbId: 'kb-legacy', mountedAt: Date.now(), name: 'Legacy', path: kbPath, format: 'legacy', state: 'ok' },
      health: { hasSources: true, hasDocs: true, hasIndex: true },
      wikiHealth: null,
    });
    const registry = new HostToolsRegistry(undefined, tmpDir);
    const parsed = parseResult(await registry.handleToolCall({
      type: 'host_tool_call', id: 'r6', toolCallId: 'tr6', toolName: 'kb_read',
      arguments: { kind: 'wiki', id: 'concepts/dds' },
    }));
    expect(parsed.code).toBe('notWikiLayout');
  });

  it('越界与未知引用返回结构化错误（不编造）', async () => {
    const registry = new HostToolsRegistry(undefined, tmpDir);

    const over = parseResult(await registry.handleToolCall({
      type: 'host_tool_call', id: 'r7', toolCallId: 'tr7', toolName: 'kb_read',
      arguments: { kind: 'parsed', id: SID, startLine: 999 },
    }));
    expect(over.code).toBe('outOfRange');

    const ghost = parseResult(await registry.handleToolCall({
      type: 'host_tool_call', id: 'r8', toolCallId: 'tr8', toolName: 'kb_read',
      arguments: { kind: 'wiki', id: 'concepts/ghost' },
    }));
    expect(ghost.code).toBe('unknownPage');

    const badKind = parseResult(await registry.handleToolCall({
      type: 'host_tool_call', id: 'r9', toolCallId: 'tr9', toolName: 'kb_read',
      arguments: { kind: 'log', id: 'x' },
    }));
    expect(badKind.code).toBe('invalidKind');
  });
});
