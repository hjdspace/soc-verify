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
import { join, resolve } from 'node:path';

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

// Mock xlsx-editor 细粒度编辑工具（避免真实文件操作）
const { appendRowsMock, updateCellMock } = vi.hoisted(() => ({
  appendRowsMock: vi.fn(),
  updateCellMock: vi.fn(),
}));
vi.mock('../src/main/document/xlsx-editor', () => ({
  appendRows: appendRowsMock,
  updateCell: updateCellMock,
}));

// Mock editor-registry（避免真实 electron BrowserWindow 调用）
const { isEditingMock, requestFlushMock, notifyFileChangedMock } = vi.hoisted(() => ({
  isEditingMock: vi.fn(),
  requestFlushMock: vi.fn(),
  notifyFileChangedMock: vi.fn(),
}));
vi.mock('../src/main/document/editor-registry', () => ({
  isEditing: isEditingMock,
  requestFlush: requestFlushMock,
  notifyFileChanged: notifyFileChangedMock,
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

/** 从 execOfficeCli mock 调用中提取 stdin input */
function getCallInput(mock: ExecMock, callIndex: number): string | undefined {
  const call = mock.mock.calls[callIndex];
  return (call[0] as { input?: string }).input;
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
    // batch 命令通过 stdin 传递 JSON（不再作为位置参数）
    const batchInput = getCallInput(mockExec, 1);
    expect(batchInput).toBeDefined();
    const batchJson = JSON.parse(batchInput!);
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

  it('batch 命令通过 stdin 传递 JSON（不作为位置参数）', async () => {
    mockExec.mockResolvedValue({ exitCode: 0, stdout: '', stderr: '' });

    const registry = new HostToolsRegistry(undefined, tmpdir());
    await registry.handleToolCall({
      type: 'host_tool_call',
      id: '1',
      toolCallId: 'tc1',
      toolName: 'create_xlsx',
      arguments: {
        sheets: [{ name: 'S1', data: [['A', 'B']] }],
      },
    });

    // batch 调用只有 2 个 args：['batch', <path>]，JSON 通过 input 字段传递
    const batchArgs = getCallArgs(mockExec, 1);
    expect(batchArgs).toHaveLength(2);
    expect(batchArgs[0]).toBe('batch');
    const batchInput = getCallInput(mockExec, 1);
    expect(batchInput).toBeDefined();
    expect(() => JSON.parse(batchInput!)).not.toThrow();
  });

  it('officecli 返回非零退出码时返回错误信息', async () => {
    mockExec.mockResolvedValue({
      exitCode: 1,
      stdout: '',
      stderr: 'Unrecognized command',
      duration: 100,
    });

    const registry = new HostToolsRegistry(undefined, tmpdir());
    const result = await registry.handleToolCall({
      type: 'host_tool_call',
      id: '1',
      toolCallId: 'tc1',
      toolName: 'create_xlsx',
      arguments: {
        sheets: [{ name: 'S1', data: [['A']] }],
      },
    });

    const parsed = parseResult(result);
    expect(parsed.error).toBeDefined();
    expect(String(parsed.error)).toContain('failed');
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
    // batch 命令通过 stdin 传递 JSON（不再作为位置参数）
    const batchInput = getCallInput(mockExec, 1);
    expect(batchInput).toBeDefined();
    const batchJson = JSON.parse(batchInput!);
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

// ─── append_xlsx_row / update_xlsx_cell（Issue #7）──────────────

describe('append_xlsx_row', () => {
  beforeEach(() => {
    appendRowsMock.mockReset();
    isEditingMock.mockReset();
    requestFlushMock.mockReset();
    notifyFileChangedMock.mockReset();
    // 默认：文件未在前端编辑
    isEditingMock.mockReturnValue(false);
    requestFlushMock.mockResolvedValue(undefined);
  });

  it('注册 append_xlsx_row 工具', () => {
    const registry = new HostToolsRegistry();
    expect(registry.hasTool('append_xlsx_row')).toBe(true);
  });

  it('成功追加行到 xlsx 文件', async () => {
    const appendResult = {
      path: '/tmp/sheet.xlsx',
      sheet: 'Data',
      appendedRows: 2,
      startRow: 3,
    };
    appendRowsMock.mockResolvedValue(appendResult);

    const registry = new HostToolsRegistry(undefined, '/project');
    const result = await registry.handleToolCall({
      type: 'host_tool_call',
      id: '1',
      toolCallId: 'tc1',
      toolName: 'append_xlsx_row',
      arguments: {
        path: 'docs/sheet.xlsx',
        sheet: 'Data',
        rows: [['gpu', 78.3], ['memory', 88.1]],
      },
    });

    const parsed = parseResult(result);
    expect(parsed.appendedRows).toBe(2);
    expect(parsed.startRow).toBe(3);

    // 验证 appendRows 被调用时使用了绝对路径
    expect(appendRowsMock).toHaveBeenCalledWith(
      resolve('/project/docs/sheet.xlsx'),
      'Data',
      [['gpu', 78.3], ['memory', 88.1]],
    );
    // 通知前端文件已变更
    expect(notifyFileChangedMock).toHaveBeenCalledWith(resolve('/project/docs/sheet.xlsx'));
  });

  it('文件正在前端编辑时先 flush 再追加', async () => {
    isEditingMock.mockReturnValue(true);
    appendRowsMock.mockResolvedValue({ path: '/tmp/sheet.xlsx', sheet: 'Data', appendedRows: 1, startRow: 1 });

    const registry = new HostToolsRegistry(undefined, '/tmp');
    await registry.handleToolCall({
      type: 'host_tool_call',
      id: '1',
      toolCallId: 'tc1',
      toolName: 'append_xlsx_row',
      arguments: { path: 'sheet.xlsx', sheet: 'Data', rows: [['a']] },
    });

    // 应先调用 requestFlush
    expect(requestFlushMock).toHaveBeenCalledWith(resolve('/tmp/sheet.xlsx'));
    // 再调用 appendRows
    expect(appendRowsMock).toHaveBeenCalled();
  });

  it('文件未在前端编辑时不调用 requestFlush', async () => {
    isEditingMock.mockReturnValue(false);
    appendRowsMock.mockResolvedValue({ path: '/tmp/sheet.xlsx', sheet: 'Data', appendedRows: 1, startRow: 1 });

    const registry = new HostToolsRegistry(undefined, '/tmp');
    await registry.handleToolCall({
      type: 'host_tool_call',
      id: '1',
      toolCallId: 'tc1',
      toolName: 'append_xlsx_row',
      arguments: { path: 'sheet.xlsx', sheet: 'Data', rows: [['a']] },
    });

    expect(requestFlushMock).not.toHaveBeenCalled();
  });

  it('缺少 path 参数时返回错误', async () => {
    const registry = new HostToolsRegistry(undefined, tmpdir());
    const result = await registry.handleToolCall({
      type: 'host_tool_call',
      id: '1',
      toolCallId: 'tc1',
      toolName: 'append_xlsx_row',
      arguments: { sheet: 'Data', rows: [['a']] },
    });

    const parsed = parseResult(result);
    expect(parsed.error).toBeDefined();
    expect(appendRowsMock).not.toHaveBeenCalled();
  });

  it('缺少 sheet 参数时返回错误', async () => {
    const registry = new HostToolsRegistry(undefined, tmpdir());
    const result = await registry.handleToolCall({
      type: 'host_tool_call',
      id: '1',
      toolCallId: 'tc1',
      toolName: 'append_xlsx_row',
      arguments: { path: '/tmp/sheet.xlsx', rows: [['a']] },
    });

    const parsed = parseResult(result);
    expect(parsed.error).toBeDefined();
  });

  it('rows 为空数组时返回错误', async () => {
    const registry = new HostToolsRegistry(undefined, tmpdir());
    const result = await registry.handleToolCall({
      type: 'host_tool_call',
      id: '1',
      toolCallId: 'tc1',
      toolName: 'append_xlsx_row',
      arguments: { path: '/tmp/sheet.xlsx', sheet: 'Data', rows: [] },
    });

    const parsed = parseResult(result);
    expect(parsed.error).toBeDefined();
  });

  it('appendRows 抛错时返回错误信息', async () => {
    appendRowsMock.mockRejectedValue(new Error('File not found'));

    const registry = new HostToolsRegistry(undefined, '/tmp');
    const result = await registry.handleToolCall({
      type: 'host_tool_call',
      id: '1',
      toolCallId: 'tc1',
      toolName: 'append_xlsx_row',
      arguments: { path: 'missing.xlsx', sheet: 'Data', rows: [['a']] },
    });

    const parsed = parseResult(result);
    expect(parsed.error).toContain('append_xlsx_row failed');
    expect(parsed.error).toContain('File not found');
  });

  it('使用绝对路径时不进行 cwd 拼接', async () => {
    appendRowsMock.mockResolvedValue({ path: '/abs/sheet.xlsx', sheet: 'Data', appendedRows: 1, startRow: 1 });

    const registry = new HostToolsRegistry(undefined, '/project');
    await registry.handleToolCall({
      type: 'host_tool_call',
      id: '1',
      toolCallId: 'tc1',
      toolName: 'append_xlsx_row',
      arguments: { path: '/abs/sheet.xlsx', sheet: 'Data', rows: [['a']] },
    });

    expect(appendRowsMock).toHaveBeenCalledWith('/abs/sheet.xlsx', 'Data', [['a']]);
  });
});

describe('update_xlsx_cell', () => {
  beforeEach(() => {
    updateCellMock.mockReset();
    isEditingMock.mockReset();
    requestFlushMock.mockReset();
    notifyFileChangedMock.mockReset();
    isEditingMock.mockReturnValue(false);
    requestFlushMock.mockResolvedValue(undefined);
  });

  it('注册 update_xlsx_cell 工具', () => {
    const registry = new HostToolsRegistry();
    expect(registry.hasTool('update_xlsx_cell')).toBe(true);
  });

  it('成功更新单元格值', async () => {
    const updateResult = {
      path: '/tmp/sheet.xlsx',
      sheet: 'Data',
      row: 2,
      col: 2,
      previousValue: 95.2,
      newValue: 99.9,
    };
    updateCellMock.mockResolvedValue(updateResult);

    const registry = new HostToolsRegistry(undefined, '/project');
    const result = await registry.handleToolCall({
      type: 'host_tool_call',
      id: '1',
      toolCallId: 'tc1',
      toolName: 'update_xlsx_cell',
      arguments: {
        path: 'docs/sheet.xlsx',
        sheet: 'Data',
        row: 2,
        col: 2,
        value: 99.9,
      },
    });

    const parsed = parseResult(result);
    expect(parsed.previousValue).toBe(95.2);
    expect(parsed.newValue).toBe(99.9);

    expect(updateCellMock).toHaveBeenCalledWith(resolve('/project/docs/sheet.xlsx'), 'Data', 2, 2, 99.9);
    expect(notifyFileChangedMock).toHaveBeenCalledWith(resolve('/project/docs/sheet.xlsx'));
  });

  it('文件正在前端编辑时先 flush 再更新', async () => {
    isEditingMock.mockReturnValue(true);
    updateCellMock.mockResolvedValue({
      path: '/tmp/sheet.xlsx', sheet: 'Data', row: 1, col: 1,
      previousValue: null, newValue: 'x',
    });

    const registry = new HostToolsRegistry(undefined, '/tmp');
    await registry.handleToolCall({
      type: 'host_tool_call',
      id: '1',
      toolCallId: 'tc1',
      toolName: 'update_xlsx_cell',
      arguments: { path: 'sheet.xlsx', sheet: 'Data', row: 1, col: 1, value: 'x' },
    });

    expect(requestFlushMock).toHaveBeenCalledWith(resolve('/tmp/sheet.xlsx'));
    expect(updateCellMock).toHaveBeenCalled();
  });

  it('用 null 清除单元格值', async () => {
    updateCellMock.mockResolvedValue({
      path: '/tmp/sheet.xlsx', sheet: 'Data', row: 1, col: 1,
      previousValue: 'old', newValue: null,
    });

    const registry = new HostToolsRegistry(undefined, '/tmp');
    const result = await registry.handleToolCall({
      type: 'host_tool_call',
      id: '1',
      toolCallId: 'tc1',
      toolName: 'update_xlsx_cell',
      arguments: { path: 'sheet.xlsx', sheet: 'Data', row: 1, col: 1, value: null },
    });

    const parsed = parseResult(result);
    expect(parsed.newValue).toBeNull();
    expect(updateCellMock).toHaveBeenCalledWith(resolve('/tmp/sheet.xlsx'), 'Data', 1, 1, null);
  });

  it('row 或 col 小于 1 时返回错误', async () => {
    const registry = new HostToolsRegistry(undefined, tmpdir());

    const result1 = await registry.handleToolCall({
      type: 'host_tool_call',
      id: '1',
      toolCallId: 'tc1',
      toolName: 'update_xlsx_cell',
      arguments: { path: '/tmp/sheet.xlsx', sheet: 'Data', row: 0, col: 1, value: 'x' },
    });
    expect(parseResult(result1).error).toBeDefined();

    const result2 = await registry.handleToolCall({
      type: 'host_tool_call',
      id: '1',
      toolCallId: 'tc2',
      toolName: 'update_xlsx_cell',
      arguments: { path: '/tmp/sheet.xlsx', sheet: 'Data', row: 1, col: 0, value: 'x' },
    });
    expect(parseResult(result2).error).toBeDefined();

    expect(updateCellMock).not.toHaveBeenCalled();
  });

  it('缺少 path 参数时返回错误', async () => {
    const registry = new HostToolsRegistry(undefined, tmpdir());
    const result = await registry.handleToolCall({
      type: 'host_tool_call',
      id: '1',
      toolCallId: 'tc1',
      toolName: 'update_xlsx_cell',
      arguments: { sheet: 'Data', row: 1, col: 1, value: 'x' },
    });

    expect(parseResult(result).error).toBeDefined();
  });

  it('updateCell 抛错时返回错误信息', async () => {
    updateCellMock.mockRejectedValue(new Error('Sheet not found'));

    const registry = new HostToolsRegistry(undefined, '/tmp');
    const result = await registry.handleToolCall({
      type: 'host_tool_call',
      id: '1',
      toolCallId: 'tc1',
      toolName: 'update_xlsx_cell',
      arguments: { path: 'sheet.xlsx', sheet: 'Missing', row: 1, col: 1, value: 'x' },
    });

    const parsed = parseResult(result);
    expect(parsed.error).toContain('update_xlsx_cell failed');
    expect(parsed.error).toContain('Sheet not found');
  });
});
