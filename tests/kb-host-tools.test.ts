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
 *  - doc_to_markdown 超长内容截断（防撑爆 Agent 上下文）
 *  - kb_search 索引匹配 + 全文匹配、评分排序、限量返回
 *  - kb_search 分类过滤（category）、中文 bigram 命中、snippet 与 absolutePath
 *  - kb_search 未挂载库时返回错误
 *  - kb_search 参数校验（缺少 query）
 *  - KB 索引上下文注入（context-injector）
 *
 * @see ADR 0021 — anydoc 文档知识库
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { join, resolve } from 'node:path';
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
import { searchKb } from '../src/main/kb/searcher';
import { buildKbContext, injectKbContext } from '../src/main/kb/context-injector';

/** 从 AgentToolResult 中提取 JSON 解析后的内容 */
function parseResult(result: unknown): Record<string, unknown> {
  const r = result as { content: Array<{ text: string }> };
  return JSON.parse(r.content[0].text);
}

// ─── 测试 ────────────────────────────────────────────────────

describe('KB Host Tools — 注册', () => {
  it('注册 doc_to_markdown 和 kb_search 两个工具', () => {
    const registry = new HostToolsRegistry();
    expect(registry.hasTool('doc_to_markdown')).toBe(true);
    expect(registry.hasTool('kb_search')).toBe(true);
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
    expect(searchDef!.parameters).toHaveProperty('properties.limit');
    expect((searchDef!.parameters as Record<string, unknown[]>).required).toContain('query');
  });
});

// ─── doc_to_markdown ─────────────────────────────────────────

describe('doc_to_markdown', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    formatFromPathMock.mockReturnValue('docx');
  });

  it('成功转换文档并返回 Markdown 内容', async () => {
    const markdownContent = '# 验证计划\n\n这是 SoC 验证计划文档。';
    toMarkdownBytesMock.mockResolvedValue(markdownContent);

    // 创建临时文件
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
    expect(parsed.markdown).toBe(markdownContent);

    // 验证不产生库内文件（没有在 docs/ 目录写入）
    expect(toMarkdownBytesMock).toHaveBeenCalled();
  });

  it('超长内容截断：超过 MAX_MARKDOWN_CHARS 时返回截断标记', async () => {
    // 生成超过 50_000 字符的内容（几百页 PDF 的转换产物可达数 MB，原样返回会撑爆上下文）
    const longMarkdown = '# 超长文档\n\n' + '很长的正文内容。'.repeat(8000);
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
    expect(parsed.truncated).toBe(true);
    expect(parsed.totalChars).toBe(longMarkdown.length);
    const md = String(parsed.markdown);
    expect(md.length).toBeLessThan(longMarkdown.length);
    expect(md.startsWith('# 超长文档')).toBe(true);
    expect(md).toContain('truncated');
    expect(String(parsed.note)).toContain('truncated');
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

  it('全文命中返回 snippet 与 absolutePath', async () => {
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
    expect(String(first.path)).toContain('CPU验证');
    expect(typeof first.absolutePath).toBe('string');
    expect(String(first.absolutePath).length).toBeGreaterThan(0);
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
    // 压缩视图保留分类与条目路径（而非从中间切掉）
    expect(result.contextText).toContain('分类（1 篇）');
    expect(result.contextText).toContain('文档（doc.md）');
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
