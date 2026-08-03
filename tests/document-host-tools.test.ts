/**
 * 文档创建/读取 Host Tools 测试。
 *
 * 测试缝：HostToolsRegistry 的 document 工具注册与调用。
 * mock officecli executor（execOfficeCli），不真实调用 officecli 二进制。
 *
 * 覆盖场景：
 *  - 工具注册（create_docx / create_xlsx / create_pptx / create_pdf / read_document）
 *  - create_docx 成功（Markdown 内容 → batch 操作）
 *  - create_docx 失败（officecli 执行错误）
 *  - create_xlsx 二维数组 sheets
 *  - create_pptx slides
 *  - create_pdf 从 Markdown 生成 PDF
 *  - read_document 返回结构化内容
 *  - 默认输出路径（<cwd>/docs/）
 *  - 自定义 outputPath
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// Mock officecli executor —— 避免真实调用 officecli 二进制
vi.mock('../src/main/officecli/executor', () => ({
  execOfficeCli: vi.fn(),
  OfficeCliNotAvailableError: class OfficeCliNotAvailableError extends Error {
    constructor() {
      super('OfficeCLI not available');
      this.name = 'OfficeCliNotAvailableError';
    }
  },
}));

import { execOfficeCli } from '../src/main/officecli/executor';
import { HostToolsRegistry } from '../src/main/host/host-tools';

type ExecMock = ReturnType<typeof vi.fn>;

/** 从 AgentToolResult 中提取 JSON 解析后的内容 */
function parseResult(result: unknown): Record<string, unknown> {
  const r = result as { content: Array<{ text: string }> };
  return JSON.parse(r.content[0].text);
}

/** 从 execOfficeCli mock 调用中提取参数 */
function getCallArgs(mock: ExecMock, callIndex: number): string[] {
  const call = mock.mock.calls[callIndex];
  return (call[0] as { args: string[] }).args;
}

describe('Document Host Tools — 注册', () => {
  it('注册 create_docx / create_xlsx / create_pptx / create_pdf / read_document 5 个工具', () => {
    const registry = new HostToolsRegistry();
    expect(registry.hasTool('create_docx')).toBe(true);
    expect(registry.hasTool('create_xlsx')).toBe(true);
    expect(registry.hasTool('create_pptx')).toBe(true);
    expect(registry.hasTool('create_pdf')).toBe(true);
    expect(registry.hasTool('read_document')).toBe(true);
  });

  it('工具定义包含正确的参数 schema', () => {
    const registry = new HostToolsRegistry();
    const defs = registry.getDefinitions();
    const docxDef = defs.find((d) => d.name === 'create_docx');
    expect(docxDef).toBeDefined();
    expect(docxDef!.parameters).toHaveProperty('properties.content');
    expect(docxDef!.parameters).toHaveProperty('properties.outputPath');

    const xlsxDef = defs.find((d) => d.name === 'create_xlsx');
    expect(xlsxDef).toBeDefined();
    expect(xlsxDef!.parameters).toHaveProperty('properties.sheets');

    const pptxDef = defs.find((d) => d.name === 'create_pptx');
    expect(pptxDef).toBeDefined();
    expect(pptxDef!.parameters).toHaveProperty('properties.slides');

    const readDef = defs.find((d) => d.name === 'read_document');
    expect(readDef).toBeDefined();
    expect(readDef!.parameters).toHaveProperty('properties.path');
  });
});

describe('create_docx', () => {
  let mockExec: ExecMock;

  beforeEach(() => {
    mockExec = execOfficeCli as unknown as ExecMock;
    mockExec.mockReset();
  });

  it('成功从 Markdown 内容创建 docx 文档', async () => {
    mockExec.mockResolvedValue({ exitCode: 0, stdout: '', stderr: '' });

    const cwd = tmpdir();
    const registry = new HostToolsRegistry(undefined, cwd);
    const result = await registry.handleToolCall({
      type: 'host_tool_call',
      id: '1',
      toolCallId: 'tc1',
      toolName: 'create_docx',
      arguments: {
        content: '# 验证计划\n## 1. 概述\n这是 SoC 验证计划文档。',
        outputPath: 'docs/verify-plan.docx',
      },
    });

    const parsed = parseResult(result);
    expect(parsed.path).toBeDefined();
    expect(String(parsed.path)).toContain('verify-plan.docx');
    expect(parsed.format).toBe('docx');

    // 第一次调用：create 创建空白文档
    const createArgs = getCallArgs(mockExec, 0);
    expect(createArgs[0]).toBe('create');

    // 第二次调用：batch 添加内容
    const batchArgs = getCallArgs(mockExec, 1);
    expect(batchArgs[0]).toBe('batch');
  });

  it('officecli 执行失败时返回错误信息', async () => {
    mockExec.mockRejectedValue(new Error('OfficeCLI execution failed: binary not found'));

    const registry = new HostToolsRegistry(undefined, tmpdir());
    const result = await registry.handleToolCall({
      type: 'host_tool_call',
      id: '1',
      toolCallId: 'tc1',
      toolName: 'create_docx',
      arguments: { content: '# 测试文档' },
    });

    const parsed = parseResult(result);
    expect(parsed.error).toBeDefined();
    expect(String(parsed.error)).toContain('failed');
  });

  it('缺少 content 参数时返回错误', async () => {
    const registry = new HostToolsRegistry(undefined, tmpdir());
    const result = await registry.handleToolCall({
      type: 'host_tool_call',
      id: '1',
      toolCallId: 'tc1',
      toolName: 'create_docx',
      arguments: {},
    });

    const parsed = parseResult(result);
    expect(parsed.error).toBeDefined();
  });

  it('默认输出到 <cwd>/docs/ 目录', async () => {
    mockExec.mockResolvedValue({ exitCode: 0, stdout: '', stderr: '' });

    const cwd = tmpdir();
    const registry = new HostToolsRegistry(undefined, cwd);
    const result = await registry.handleToolCall({
      type: 'host_tool_call',
      id: '1',
      toolCallId: 'tc1',
      toolName: 'create_docx',
      arguments: { content: '# 测试' },
    });

    const parsed = parseResult(result);
    expect(String(parsed.path)).toContain('docs');
    expect(String(parsed.path)).toContain(cwd);
    expect(String(parsed.path)).toMatch(/\.docx$/);
  });

  it('自定义 outputPath 指定完整文件路径', async () => {
    mockExec.mockResolvedValue({ exitCode: 0, stdout: '', stderr: '' });

    const cwd = tmpdir();
    const customPath = join(cwd, 'reports', 'custom-report.docx');
    const registry = new HostToolsRegistry(undefined, cwd);
    const result = await registry.handleToolCall({
      type: 'host_tool_call',
      id: '1',
      toolCallId: 'tc1',
      toolName: 'create_docx',
      arguments: { content: '# 自定义路径', outputPath: customPath },
    });

    const parsed = parseResult(result);
    expect(parsed.path).toBe(customPath);
  });
});

describe('create_xlsx', () => {
  let mockExec: ExecMock;

  beforeEach(() => {
    mockExec = execOfficeCli as unknown as ExecMock;
    mockExec.mockReset();
  });

  it('成功从二维数组 sheets 创建 xlsx 文档', async () => {
    mockExec.mockResolvedValue({ exitCode: 0, stdout: '', stderr: '' });

    const registry = new HostToolsRegistry(undefined, tmpdir());
    const result = await registry.handleToolCall({
      type: 'host_tool_call',
      id: '1',
      toolCallId: 'tc1',
      toolName: 'create_xlsx',
      arguments: {
        sheets: [
          {
            name: '覆盖率汇总',
            data: [
              ['模块', '行覆盖率', '分支覆盖率'],
              ['top/cpu_core', '95.2%', '88.1%'],
              ['top/gpu', '78.3%', '65.0%'],
            ],
          },
        ],
        outputPath: 'docs/coverage-report.xlsx',
      },
    });

    const parsed = parseResult(result);
    expect(String(parsed.path)).toContain('coverage-report.xlsx');
    expect(parsed.format).toBe('xlsx');

    // 验证 batch 操作包含 sheet 重命名和单元格设置
    const batchArgs = getCallArgs(mockExec, 1);
    expect(batchArgs[0]).toBe('batch');
    const batchJson = JSON.parse(batchArgs[2]);
    // 应包含至少一个 set 操作设置单元格值
    const setOps = batchJson.filter((op: { command: string }) => op.command === 'set');
    expect(setOps.length).toBeGreaterThan(0);
  });

  it('缺少 sheets 参数时返回错误', async () => {
    const registry = new HostToolsRegistry(undefined, tmpdir());
    const result = await registry.handleToolCall({
      type: 'host_tool_call',
      id: '1',
      toolCallId: 'tc1',
      toolName: 'create_xlsx',
      arguments: {},
    });

    const parsed = parseResult(result);
    expect(parsed.error).toBeDefined();
  });

  it('默认输出到 <cwd>/docs/ 目录', async () => {
    mockExec.mockResolvedValue({ exitCode: 0, stdout: '', stderr: '' });

    const cwd = tmpdir();
    const registry = new HostToolsRegistry(undefined, cwd);
    const result = await registry.handleToolCall({
      type: 'host_tool_call',
      id: '1',
      toolCallId: 'tc1',
      toolName: 'create_xlsx',
      arguments: {
        sheets: [{ name: 'Sheet1', data: [['A', 'B'], ['1', '2']] }],
      },
    });

    const parsed = parseResult(result);
    expect(String(parsed.path)).toContain('docs');
    expect(String(parsed.path)).toMatch(/\.xlsx$/);
  });
});

describe('create_pptx', () => {
  let mockExec: ExecMock;

  beforeEach(() => {
    mockExec = execOfficeCli as unknown as ExecMock;
    mockExec.mockReset();
  });

  it('成功从 slides 创建 pptx 演示文稿', async () => {
    mockExec.mockResolvedValue({ exitCode: 0, stdout: '', stderr: '' });

    const registry = new HostToolsRegistry(undefined, tmpdir());
    const result = await registry.handleToolCall({
      type: 'host_tool_call',
      id: '1',
      toolCallId: 'tc1',
      toolName: 'create_pptx',
      arguments: {
        slides: [
          { title: '验证计划评审', content: 'SoC 验证计划概览' },
          { title: '覆盖率状态', content: '行覆盖率 95%，分支覆盖率 88%' },
        ],
        outputPath: 'docs/review-deck.pptx',
      },
    });

    const parsed = parseResult(result);
    expect(String(parsed.path)).toContain('review-deck.pptx');
    expect(parsed.format).toBe('pptx');

    // 验证 batch 操作包含 add slide 操作
    const batchArgs = getCallArgs(mockExec, 1);
    expect(batchArgs[0]).toBe('batch');
    const batchJson = JSON.parse(batchArgs[2]);
    const addOps = batchJson.filter((op: { command: string }) => op.command === 'add');
    expect(addOps.length).toBeGreaterThan(0);
  });

  it('缺少 slides 参数时返回错误', async () => {
    const registry = new HostToolsRegistry(undefined, tmpdir());
    const result = await registry.handleToolCall({
      type: 'host_tool_call',
      id: '1',
      toolCallId: 'tc1',
      toolName: 'create_pptx',
      arguments: {},
    });

    const parsed = parseResult(result);
    expect(parsed.error).toBeDefined();
  });
});

describe('create_pdf', () => {
  let mockExec: ExecMock;

  beforeEach(() => {
    mockExec = execOfficeCli as unknown as ExecMock;
    mockExec.mockReset();
  });

  it('成功从 Markdown 内容创建 PDF 文档', async () => {
    mockExec.mockResolvedValue({ exitCode: 0, stdout: '', stderr: '' });

    const registry = new HostToolsRegistry(undefined, tmpdir());
    const result = await registry.handleToolCall({
      type: 'host_tool_call',
      id: '1',
      toolCallId: 'tc1',
      toolName: 'create_pdf',
      arguments: {
        content: '# 回归测试报告\n本次回归共执行 500 个用例。',
        outputPath: 'docs/regression-report.pdf',
      },
    });

    const parsed = parseResult(result);
    expect(String(parsed.path)).toContain('regression-report.pdf');
    expect(parsed.format).toBe('pdf');
  });

  it('officecli 不可用时返回错误', async () => {
    mockExec.mockRejectedValue(new Error('OfficeCLI not available'));

    const registry = new HostToolsRegistry(undefined, tmpdir());
    const result = await registry.handleToolCall({
      type: 'host_tool_call',
      id: '1',
      toolCallId: 'tc1',
      toolName: 'create_pdf',
      arguments: { content: '# 测试' },
    });

    const parsed = parseResult(result);
    expect(parsed.error).toBeDefined();
  });

  it('默认输出到 <cwd>/docs/ 目录', async () => {
    mockExec.mockResolvedValue({ exitCode: 0, stdout: '', stderr: '' });

    const cwd = tmpdir();
    const registry = new HostToolsRegistry(undefined, cwd);
    const result = await registry.handleToolCall({
      type: 'host_tool_call',
      id: '1',
      toolCallId: 'tc1',
      toolName: 'create_pdf',
      arguments: { content: '# 测试 PDF' },
    });

    const parsed = parseResult(result);
    expect(String(parsed.path)).toContain('docs');
    expect(String(parsed.path)).toMatch(/\.pdf$/);
  });
});

describe('read_document', () => {
  let mockExec: ExecMock;

  beforeEach(() => {
    mockExec = execOfficeCli as unknown as ExecMock;
    mockExec.mockReset();
  });

  it('返回文档的结构化内容', async () => {
    mockExec.mockResolvedValue({
      exitCode: 0,
      stdout: '验证计划\n1. 概述\n这是 SoC 验证计划。',
      stderr: '',
    });

    const registry = new HostToolsRegistry(undefined, tmpdir());
    const result = await registry.handleToolCall({
      type: 'host_tool_call',
      id: '1',
      toolCallId: 'tc1',
      toolName: 'read_document',
      arguments: { path: 'docs/verify-plan.docx' },
    });

    const parsed = parseResult(result);
    expect(parsed.path).toBeDefined();
    expect(parsed.content).toBeDefined();
    expect(String(parsed.content)).toContain('验证计划');
    expect(parsed.format).toBeDefined();
  });

  it('缺少 path 参数时返回错误', async () => {
    const registry = new HostToolsRegistry(undefined, tmpdir());
    const result = await registry.handleToolCall({
      type: 'host_tool_call',
      id: '1',
      toolCallId: 'tc1',
      toolName: 'read_document',
      arguments: {},
    });

    const parsed = parseResult(result);
    expect(parsed.error).toBeDefined();
  });

  it('officecli view 失败时返回错误信息', async () => {
    mockExec.mockResolvedValue({
      exitCode: 1,
      stdout: '',
      stderr: 'File not found',
    });

    const registry = new HostToolsRegistry(undefined, tmpdir());
    const result = await registry.handleToolCall({
      type: 'host_tool_call',
      id: '1',
      toolCallId: 'tc1',
      toolName: 'read_document',
      arguments: { path: 'docs/nonexistent.docx' },
    });

    const parsed = parseResult(result);
    expect(parsed.error).toBeDefined();
  });

  it('使用绝对路径读取文档', async () => {
    mockExec.mockResolvedValue({
      exitCode: 0,
      stdout: '文档内容',
      stderr: '',
    });

    const absPath = join(tmpdir(), 'test-doc.docx');
    const registry = new HostToolsRegistry(undefined, tmpdir());
    const result = await registry.handleToolCall({
      type: 'host_tool_call',
      id: '1',
      toolCallId: 'tc1',
      toolName: 'read_document',
      arguments: { path: absPath },
    });

    const parsed = parseResult(result);
    expect(parsed.path).toBe(absPath);

    // 验证 execOfficeCli 被调用时使用了绝对路径
    const viewArgs = getCallArgs(mockExec, 0);
    expect(viewArgs).toContain(absPath);
  });
});
