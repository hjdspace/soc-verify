/**
 * kb-tools（Host Tools）测试 — doc_to_markdown + kb_search。
 *
 * 重点回归：kb_search 的挂载检测必须基于会话 cwd（项目根目录），
 * 而非按项目 ID 查找（历史 bug：requireProject('default') 永远查不到，
 * 导致已挂载的知识库也返回 "No knowledge base mounted"）。
 *
 * 测试缝：mock kb-registry（status）与 kb/converter；searchKb 用真实
 * 实现对临时知识库目录检索。
 */

import { describe, it, expect, beforeEach, afterAll, vi } from 'vitest';
import { rmSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

// ─── Hoisted mocks ─────────────────────────────────────────

const { projectDir, kbDir } = vi.hoisted(() => {
  const os = require('node:os');
  const fs = require('node:fs');
  const path = require('node:path');
  const base = path.join(os.tmpdir(), `sv-kb-tools-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`);
  const dirs = { projectDir: path.join(base, 'project'), kbDir: path.join(base, 'kb') };
  fs.mkdirSync(dirs.projectDir, { recursive: true });
  return dirs;
});

const { mockStatus, mockConvertToString } = vi.hoisted(() => ({
  mockStatus: vi.fn() as ReturnType<typeof vi.fn>,
  mockConvertToString: vi.fn() as ReturnType<typeof vi.fn>,
}));

vi.mock('../src/main/kb/registry', () => ({
  kbRegistry: { status: mockStatus },
}));

vi.mock('../src/main/kb/converter', () => ({
  convertDocumentToMarkdownString: mockConvertToString,
}));

// ─── Imports (after mocks) ─────────────────────────────────

import { createKbTools } from '../src/main/host/tools/kb-tools';
import type { ToolContext, HostToolEntry } from '../src/main/host/tools/shared';

/** 构造最小 ToolContext（仅 cwd 有意义） */
function makeCtx(cwd: string): ToolContext {
  return {
    discovery: {} as ToolContext['discovery'],
    simulation: null,
    coverage: null,
    coverageManager: null,
    caseStatsService: null,
    cwd,
  };
}

function findTool(tools: HostToolEntry[], name: string): HostToolEntry {
  const tool = tools.find((t) => t.definition.name === name);
  if (!tool) throw new Error(`tool not found: ${name}`);
  return tool;
}

/** 建一个带 index.md + docs/ 的知识库目录（searchKb 真实检索用） */
function makeKbFixture(): string {
  mkdirSync(join(kbDir, 'docs', '协议手册'), { recursive: true });
  writeFileSync(
    join(kbDir, 'index.md'),
    [
      '# 知识库索引',
      '',
      '## 协议手册',
      '',
      '### AXI 总线协议',
      '- **路径**: `协议手册/axi.md`',
      '- **摘要**: AMBA AXI 通道与握手协议',
      '',
    ].join('\n'),
    'utf-8',
  );
  writeFileSync(join(kbDir, 'docs', '协议手册', 'axi.md'), '# AXI 总线协议\n\nVALID/READY 握手。', 'utf-8');
  return kbDir;
}

describe('kb-tools', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterAll(() => {
    rmSync(join(kbDir, '..'), { recursive: true, force: true });
  });

  describe('kb_search 挂载检测', () => {
    it('基于会话 cwd（项目根目录）查询挂载状态，挂载时返回检索结果', async () => {
      makeKbFixture();
      mockStatus.mockResolvedValue({ mounted: { kbId: 'kb-1', mountedAt: 1, name: '测试库', path: kbDir }, health: {} });

      const tools = createKbTools(makeCtx(projectDir));
      const kbSearch = findTool(tools, 'kb_search');
      const result = await kbSearch.handler({ query: 'AXI' });
      const text = (result as { content: Array<{ text: string }> }).content[0].text;
      const payload = JSON.parse(text) as { error?: string; total?: number; results?: Array<{ title: string }> };

      // 回归断言：status 以 ctx.cwd（而非项目 ID）查询
      expect(mockStatus).toHaveBeenCalledWith(projectDir);
      expect(payload.error).toBeUndefined();
      expect(payload.total).toBeGreaterThan(0);
      expect(payload.results?.[0]?.title).toBe('AXI 总线协议');
    });

    it('未挂载时返回结构化错误（status.mounted 为 null）', async () => {
      mockStatus.mockResolvedValue({ mounted: null, health: {} });

      const tools = createKbTools(makeCtx(projectDir));
      const kbSearch = findTool(tools, 'kb_search');
      const result = await kbSearch.handler({ query: 'AXI' });
      const payload = JSON.parse((result as { content: Array<{ text: string }> }).content[0].text) as { error?: string };

      expect(payload.error).toContain('No knowledge base mounted');
    });

    it('status 查询异常时静默返回未挂载错误（不抛出）', async () => {
      mockStatus.mockRejectedValue(new Error('registry io error'));

      const tools = createKbTools(makeCtx(projectDir));
      const kbSearch = findTool(tools, 'kb_search');
      const result = await kbSearch.handler({ query: 'AXI' });
      const payload = JSON.parse((result as { content: Array<{ text: string }> }).content[0].text) as { error?: string };

      expect(payload.error).toContain('No knowledge base mounted');
    });

    it('缺少 query 参数返回错误', async () => {
      const tools = createKbTools(makeCtx(projectDir));
      const kbSearch = findTool(tools, 'kb_search');
      const result = await kbSearch.handler({});
      const payload = JSON.parse((result as { content: Array<{ text: string }> }).content[0].text) as { error?: string };

      expect(payload.error).toBe('query is required');
    });
  });

  describe('doc_to_markdown', () => {
    it('相对路径基于 ctx.cwd 解析并透传转换结果', async () => {
      mockConvertToString.mockResolvedValue({ ok: true, markdown: '# 转换结果' });
      writeFileSync(join(projectDir, 'note.docx'), Buffer.from([0x50, 0x4b, 0x03, 0x04]));

      const tools = createKbTools(makeCtx(projectDir));
      const docTool = findTool(tools, 'doc_to_markdown');
      const result = await docTool.handler({ path: 'note.docx' });
      const payload = JSON.parse((result as { content: Array<{ text: string }> }).content[0].text) as {
        path: string;
        markdown: string;
      };

      expect(mockConvertToString).toHaveBeenCalledWith(join(projectDir, 'note.docx'));
      expect(payload.markdown).toBe('# 转换结果');
      expect(payload.path).toBe(join(projectDir, 'note.docx'));
    });

    it('文件不存在返回错误', async () => {
      const tools = createKbTools(makeCtx(projectDir));
      const docTool = findTool(tools, 'doc_to_markdown');
      const result = await docTool.handler({ path: 'nonexistent.docx' });
      const payload = JSON.parse((result as { content: Array<{ text: string }> }).content[0].text) as { error: string };

      expect(payload.error).toContain('File not found');
    });
  });
});
