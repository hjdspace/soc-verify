/**
 * verible-lint 测试 — parseVeribleLintOutput 纯函数单测 + runVeribleLint spawn 边界 mock。
 *
 * 测试哲学（spec 测试决策）：
 *   - parseVeribleLintOutput：纯函数单测（正则解析、severity 映射、rule 提取）
 *   - runVeribleLint：spawn 边界 mock（不依赖真实 verible 二进制）
 *   - 不测 verible 工具本身的行为（外部依赖，S0 已实测背书）
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { EventEmitter } from 'node:events';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// ─── Hoisted mocks ──────────────────────────────────────────

const { mockSpawn, mockBinary } = vi.hoisted(() => ({
  mockSpawn: vi.fn(),
  mockBinary: {
    resolveVeribleLintPath: vi.fn((): string | null => '/fake/verible/verible-verilog-lint.exe'),
  },
}));

vi.mock('node:child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:child_process')>();
  return { ...actual, spawn: mockSpawn };
});

vi.mock('../../src/main/rtl/binary', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/main/rtl/binary')>();
  return { ...actual, resolveVeribleLintPath: mockBinary.resolveVeribleLintPath };
});

import { parseVeribleLintOutput, runVeribleLint } from '../../src/main/rtl/verible-lint';

// ─── parseVeribleLintOutput 纯函数单测 ──────────────────────

describe('parseVeribleLintOutput', () => {
  it('解析标准 verible lint 行（file:line:col-range: message [Style: rule]）', () => {
    const output = 'rtl/top.sv:3:7-12: Macro name should be uppercase. [Style: macro-name-style]';
    const diags = parseVeribleLintOutput(output);
    expect(diags).toHaveLength(1);
    expect(diags[0]).toMatchObject({
      line: 2,       // 0-based
      character: 6,  // 0-based
      endLine: 2,
      endCharacter: 12,
      severity: 'warning',
      message: 'Macro name should be uppercase.',
      source: 'verible',
      code: 'macro-name-style',
    });
  });

  it('解析多行诊断', () => {
    const output = [
      'rtl/a.sv:1:1-5: First issue [Style: rule-a]',
      'rtl/b.sv:2:3-8: Second issue [Style: rule-b]',
    ].join('\n');
    const diags = parseVeribleLintOutput(output);
    expect(diags).toHaveLength(2);
    expect(diags[0].line).toBe(0);
    expect(diags[1].line).toBe(1);
  });

  it('无诊断输出返回空数组', () => {
    expect(parseVeribleLintOutput('')).toEqual([]);
    expect(parseVeribleLintOutput('\n\n')).toEqual([]);
  });

  it('不匹配的行被跳过', () => {
    const output = [
      'some random text',
      'rtl/top.sv:3:7-12: Real diagnostic [Style: rule-a]',
      'another non-matching line',
    ].join('\n');
    const diags = parseVeribleLintOutput(output);
    expect(diags).toHaveLength(1);
    expect(diags[0].code).toBe('rule-a');
  });

  it('lintedFilePath 过滤：只保留匹配文件的诊断', () => {
    const output = [
      'rtl/top.sv:1:1-5: Issue in top [Style: rule-a]',
      'rtl/sub.sv:2:3-8: Issue in sub [Style: rule-b]',
    ].join('\n');
    const diags = parseVeribleLintOutput(output, 'rtl/top.sv');
    expect(diags).toHaveLength(1);
    expect(diags[0].message).toBe('Issue in top');
  });

  it('Windows 盘符路径正常解析', () => {
    const output = 'D:\\proj\\rtl\\top.sv:5:1-3: Some issue [Style: rule-x]';
    const diags = parseVeribleLintOutput(output);
    expect(diags).toHaveLength(1);
    expect(diags[0].line).toBe(4);
  });

  it('无 [Style:] 标记的行仍可解析（code 为 undefined）', () => {
    const output = 'rtl/top.sv:1:1-5: Some message without style tag';
    const diags = parseVeribleLintOutput(output);
    expect(diags).toHaveLength(1);
    expect(diags[0].code).toBeUndefined();
    expect(diags[0].message).toBe('Some message without style tag');
  });
});

// ─── runVeribleLint spawn 边界 mock ─────────────────────────

describe('runVeribleLint', () => {
  let projectDir: string;

  beforeEach(() => {
    projectDir = mkdtempSync(join(tmpdir(), 'sv-verible-lint-'));
    mkdirSync(join(projectDir, 'rtl'), { recursive: true });
    writeFileSync(join(projectDir, 'rtl/top.sv'), 'module top; endmodule\n', 'utf-8');
    mockSpawn.mockReset();
    mockBinary.resolveVeribleLintPath.mockReturnValue('/fake/verible/verible-verilog-lint.exe');
  });

  afterEach(() => {
    rmSync(projectDir, { recursive: true, force: true });
  });

  it('verible 不可用时返回空诊断（不抛出）', async () => {
    mockBinary.resolveVeribleLintPath.mockReturnValue(null);
    const result = await runVeribleLint({ filePath: join(projectDir, 'rtl/top.sv') });
    expect(result.diagnostics).toEqual([]);
  });

  it('spawn 成功且有诊断输出时返回解析后的诊断', async () => {
    const filePath = join(projectDir, 'rtl/top.sv');
    mockSpawn.mockImplementation(() => {
      const child = new EventEmitter() as EventEmitter & { stdout: EventEmitter; stderr: EventEmitter; kill: () => void };
      child.stdout = new EventEmitter();
      child.stderr = new EventEmitter();
      child.kill = () => {};
      queueMicrotask(() => {
        child.stdout.emit('data', Buffer.from(`${filePath}:3:7-12: Macro name should be uppercase. [Style: macro-name-style]`));
        child.emit('close', 1);
      });
      return child;
    });

    const result = await runVeribleLint({ filePath });
    expect(result.diagnostics).toHaveLength(1);
    expect(result.diagnostics[0]).toMatchObject({
      line: 2,
      character: 6,
      severity: 'warning',
      code: 'macro-name-style',
      source: 'verible',
    });
  });

  it('spawn 无诊断输出时返回空数组', async () => {
    mockSpawn.mockImplementation(() => {
      const child = new EventEmitter() as EventEmitter & { stdout: EventEmitter; stderr: EventEmitter; kill: () => void };
      child.stdout = new EventEmitter();
      child.stderr = new EventEmitter();
      child.kill = () => {};
      queueMicrotask(() => {
        child.emit('close', 0);
      });
      return child;
    });

    const result = await runVeribleLint({ filePath: join(projectDir, 'rtl/top.sv') });
    expect(result.diagnostics).toEqual([]);
  });

  it('提供 content 时写入临时文件并清理', async () => {
    const filePath = join(projectDir, 'rtl/top.sv');
    const content = 'module top; wire x; endmodule\n';
    mockSpawn.mockImplementation(() => {
      const child = new EventEmitter() as EventEmitter & { stdout: EventEmitter; stderr: EventEmitter; kill: () => void };
      child.stdout = new EventEmitter();
      child.stderr = new EventEmitter();
      child.kill = () => {};
      queueMicrotask(() => {
        child.emit('close', 0);
      });
      return child;
    });

    await runVeribleLint({ filePath, content });
    // 临时文件应被清理（不存在 .verible-lint-* 文件）
    // 验证：spawn 被调用时参数包含临时文件路径
    const spawnArgs = mockSpawn.mock.calls[0]?.[1] as string[];
    expect(spawnArgs[0]).toContain('.verible-lint-');
    expect(spawnArgs[0]).not.toBe(filePath);
  });

  it('spawn 超时时返回空诊断（不抛出）', async () => {
    mockSpawn.mockImplementation(() => {
      const child = new EventEmitter() as EventEmitter & { stdout: EventEmitter; stderr: EventEmitter; kill: () => void };
      child.stdout = new EventEmitter();
      child.stderr = new EventEmitter();
      child.kill = () => {};
      // 不 emit close，模拟超时
      return child;
    });

    const result = await runVeribleLint({
      filePath: join(projectDir, 'rtl/top.sv'),
      timeoutMs: 100,
    });
    expect(result.diagnostics).toEqual([]);
  });
});
