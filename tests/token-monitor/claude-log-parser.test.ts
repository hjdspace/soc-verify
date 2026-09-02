/**
 * Claude Log Parser 模块测试。
 *
 * 测试缝：模块公开 API（parseClaudeJsonlLine / parseClaudeJsonlLines / parseClaudeJsonlFile）。
 * 使用 fixture JSONL 文件验证解析逻辑。
 *
 * 验证：
 * - 正确解析 assistant message 的 usage 字段
 * - 跳过非 assistant 行（human 行）
 * - 跳过无效 JSON 行
 * - 正确处理空文件
 * - 增量解析（从指定 offset 开始）
 * - 行数计数和记录数计数正确
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { join } from 'node:path';
import { writeFileSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';

import {
  parseClaudeJsonlLine,
  parseClaudeJsonlLines,
  parseClaudeJsonlFile,
} from '../../src/main/token-monitor/claude-log-parser';

// ─── Helpers ───────────────────────────────────────────────

const FIXTURES_DIR = join(__dirname, 'fixtures');

// ─── Tests ─────────────────────────────────────────────────

describe('claude-log-parser — parseClaudeJsonlLine', () => {
  it('正确解析 assistant message 的 usage 字段', () => {
    const line = JSON.stringify({
      type: 'assistant',
      sessionId: 'sess-claude-001',
      message: {
        role: 'assistant',
        id: 'msg_01',
        model: 'claude-sonnet-4-20250514',
        usage: {
          input_tokens: 1000,
          output_tokens: 500,
          cache_creation_input_tokens: 100,
          cache_read_input_tokens: 200,
        },
      },
    });

    const result = parseClaudeJsonlLine(line, '/proj/test', 'sess-claude-001');
    expect(result).not.toBeNull();
    expect(result!.engine).toBe('claude-code');
    expect(result!.sessionId).toBe('sess-claude-001');
    expect(result!.messageId).toBe('msg_01');
    expect(result!.model).toBe('claude-sonnet-4-20250514');
    expect(result!.inputTokens).toBe(1000);
    expect(result!.outputTokens).toBe(500);
    expect(result!.cacheWriteTokens).toBe(100);
    expect(result!.cacheReadTokens).toBe(200);
    expect(result!.totalTokens).toBe(1800); // 1000 + 500 + 100 + 200
  });

  it('跳过 human 行', () => {
    const line = JSON.stringify({
      type: 'human',
      message: { role: 'user', content: 'Hello' },
    });

    const result = parseClaudeJsonlLine(line, '/proj/test', 'sess-1');
    expect(result).toBeNull();
  });

  it('跳过无效 JSON 行', () => {
    const result = parseClaudeJsonlLine('this is not json', '/proj/test', 'sess-1');
    expect(result).toBeNull();
  });

  it('跳过缺少 usage 的 assistant 行', () => {
    const line = JSON.stringify({
      type: 'assistant',
      message: {
        role: 'assistant',
        id: 'msg_01',
        content: 'Hello',
      },
    });

    const result = parseClaudeJsonlLine(line, '/proj/test', 'sess-1');
    expect(result).toBeNull();
  });

  it('跳过缺少 message 字段的行', () => {
    const line = JSON.stringify({
      type: 'summary',
      content: 'Summary',
    });

    const result = parseClaudeJsonlLine(line, '/proj/test', 'sess-1');
    expect(result).toBeNull();
  });

  it('使用 sessionId 来自行内字段或回退到参数', () => {
    // sessionId in the line
    const line1 = JSON.stringify({
      type: 'assistant',
      sessionId: 'sess-from-line',
      message: {
        role: 'assistant',
        id: 'msg_01',
        usage: { input_tokens: 100, output_tokens: 50 },
      },
    });
    const result1 = parseClaudeJsonlLine(line1, '/proj/test', 'sess-fallback');
    expect(result1!.sessionId).toBe('sess-from-line');

    // sessionId not in the line → fallback
    const line2 = JSON.stringify({
      type: 'assistant',
      message: {
        role:        'assistant',
        id:          'msg_02',
        usage: { input_tokens: 100, output_tokens: 50 },
      },
    });
    const result2 = parseClaudeJsonlLine(line2, '/proj/test', 'sess-fallback');
    expect(result2!.sessionId).toBe('sess-fallback');
  });
});

describe('claude-log-parser — parseClaudeJsonlLines', () => {
  it('解析多行并返回有效记录', () => {
    const lines = [
      JSON.stringify({
        type: 'assistant',
        sessionId: 'sess-1',
        message: {
          role: 'assistant',
          id: 'msg_01',
          usage: { input_tokens: 1000, output_tokens: 500 },
        },
      }),
      JSON.stringify({
        type: 'human',
        message: { role: 'user', content: 'Hi' },
      }),
      JSON.stringify({
        type: 'assistant',
        sessionId: 'sess-1',
        message: {
          role: 'assistant',
          id: 'msg_02',
          usage: { input_tokens: 800, output_tokens: 300 },
        },
      }),
    ];

    const result = parseClaudeJsonlLines(lines, '/proj/test', 'sess-1');
    expect(result).toHaveLength(2);
    expect(result[0].messageId).toBe('msg_01');
    expect(result[1].messageId).toBe('msg_02');
  });

  it('空数组返回空结果', () => {
    const result = parseClaudeJsonlLines([], '/proj/test', 'sess-1');
    expect(result).toEqual([]);
  });
});

describe('claude-log-parser — parseClaudeJsonlFile', () => {
  const testDir = join(tmpdir(), `sv-test-claude-${Date.now()}`);

  beforeEach(() => {
    mkdirSync(testDir, { recursive: true });
  });

  afterEach(() => {
    rmSync(testDir, { recursive: true, force: true });
  });

  it('解析完整 JSONL 文件', () => {
    const filePath = join(testDir, 'test.jsonl');
    const lines = [
      JSON.stringify({
        type: 'assistant',
        sessionId: 'sess-1',
        cwd: '/proj/test',
        message: {
          role: 'assistant',
          id: 'msg_01',
          model: 'claude-sonnet-4',
          usage: { input_tokens: 1000, output_tokens: 500, cache_read_input_tokens: 200 },
        },
      }),
      JSON.stringify({
        type: 'human',
        sessionId: 'sess-1',
        message: { role: 'user' },
      }),
      JSON.stringify({
        type: 'assistant',
        sessionId: 'sess-2',
        message: {
          role: 'assistant',
          id: 'msg_02',
          usage: { input_tokens: 800, output_tokens: 300 },
        },
      }),
    ];
    writeFileSync(filePath, lines.join('\n'));

    const result = parseClaudeJsonlFile(filePath);
    expect(result).toHaveLength(2);
    expect(result[0].sessionId).toBe('sess-1');
    expect(result[1].sessionId).toBe('sess-2');
  });

  it('增量解析：从 byte_offset 开始', () => {
    const filePath = join(testDir, 'incremental.jsonl');
    const line1 = JSON.stringify({
      type: 'assistant',
      sessionId: 'sess-1',
      message: { role: 'assistant', id: 'msg_01', usage: { input_tokens: 100, output_tokens: 50 } },
    });
    const line2 = JSON.stringify({
      type: 'assistant',
      sessionId: 'sess-1',
      message: { role: 'assistant', id: 'msg_02', usage: { input_tokens: 200, output_tokens: 100 } },
    });
    const line3 = JSON.stringify({
      type: 'assistant',
      sessionId: 'sess-1',
      message: { role: 'assistant', id: 'msg_03', usage: { input_tokens: 300, output_tokens: 150 } },
    });
    writeFileSync(filePath, `${line1}\n${line2}\n${line3}`);

    // offset past the first line
    const offset = Buffer.byteLength(`${line1}\n`, 'utf8');
    const result = parseClaudeJsonlFile(filePath, offset);
    expect(result).toHaveLength(2);
    expect(result[0].messageId).toBe('msg_02');
    expect(result[1].messageId).toBe('msg_03');
  });

  it('不存在的文件返回空数组（静默降级）', () => {
    const result = parseClaudeJsonlFile(join(testDir, 'nonexistent.jsonl'));
    expect(result).toEqual([]);
  });

  it('空文件返回空数组', () => {
    const filePath = join(testDir, 'empty.jsonl');
    writeFileSync(filePath, '');

    const result = parseClaudeJsonlFile(filePath);
    expect(result).toEqual([]);
  });
});

describe('claude-log-parser — fixture 文件解析', () => {
  it('正确解析 claude-1.jsonl fixture', () => {
    const fixturePath = join(FIXTURES_DIR, 'claude-1.jsonl');
    const result = parseClaudeJsonlFile(fixturePath);

    // 3 lines total, 2 assistant + 1 human → 2 records
    expect(result).toHaveLength(2);

    const msg1 = result.find((r) => r.messageId === 'msg_01')!;
    expect(msg1).toBeDefined();
    expect(msg1.inputTokens).toBe(1000);
    expect(msg1.outputTokens).toBe(500);
    expect(msg1.cacheReadTokens).toBe(200);
    expect(msg1.cacheWriteTokens).toBe(100);

    const msg2 = result.find((r) => r.messageId === 'msg_02')!;
    expect(msg2).toBeDefined();
    expect(msg2.inputTokens).toBe(800);
    expect(msg2.outputTokens).toBe(300);
    expect(msg2.cacheReadTokens).toBe(100);
  });
});
