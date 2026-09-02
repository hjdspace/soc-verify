/**
 * Codex Log Parser 模块测试。
 *
 * 测试缝：模块公开 API（parseCodexJsonlLine / parseCodexJsonlLines / parseCodexJsonlFile）。
 * 使用 fixture JSONL 文件验证解析逻辑。
 *
 * 验证：
 * - 正确解析 assistant message 的 usage 字段
 * - 跳过非 assistant 行（human 行）
 * - 跳过无效 JSON 行
 * - 正确处理 cost 字段
 * - 增量解析
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { join } from 'node:path';
import { writeFileSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';

import {
  parseCodexJsonlLine,
  parseCodexJsonlLines,
  parseCodexJsonlFile,
} from '../../src/main/token-monitor/codex-log-parser';

// ─── Helpers ───────────────────────────────────────────────

const FIXTURES_DIR = join(__dirname, 'fixtures');

// ─── Tests ─────────────────────────────────────────────────

describe('codex-log-parser — parseCodexJsonlLine', () => {
  it('正确解析 assistant message 的 usage 字段', () => {
    const line = JSON.stringify({
      sessionId: 'sess-codex-001',
      messageId: 'msg_c_001',
      timestamp: '2025-01-15T10:00:00.000Z',
      message: {
        role: 'assistant',
        usage: {
          input_tokens: 2000,
          output_tokens: 800,
          total_tokens: 2800,
        },
        model: 'gpt-5',
        provider: 'openai',
        cost: {
          input: 0.02,
          output: 0.04,
          total: 0.06,
        },
      },
    });

    const result = parseCodexJsonlLine(line, '/proj/test', 'fallback-sess');
    expect(result).not.toBeNull();
    expect(result!.engine).toBe('codex');
    expect(result!.sessionId).toBe('sess-codex-001');
    expect(result!.messageId).toBe('msg_c_001');
    expect(result!.model).toBe('gpt-5');
    expect(result!.provider).toBe('openai');
    expect(result!.inputTokens).toBe(2000);
    expect(result!.outputTokens).toBe(800);
    expect(result!.totalTokens).toBe(2800);
    expect(result!.costUsd).toBeCloseTo(0.06, 5);
  });

  it('跳过 human 行', () => {
    const line = JSON.stringify({
      sessionId: 'sess-1',
      messageId: 'msg_h_001',
      message: { role: 'user', content: 'Hello' },
    });

    const result = parseCodexJsonlLine(line, '/proj/test', 'fallback-sess');
    expect(result).toBeNull();
  });

  it('跳过无效 JSON 行', () => {
    const result = parseCodexJsonlLine('this is not json either', '/proj/test', 'fallback');
    expect(result).toBeNull();
  });

  it('跳过缺少 usage 的 assistant 行', () => {
    const line = JSON.stringify({
      sessionId: 'sess-1',
      messageId: 'msg_01',
      message: {
        role: 'assistant',
        content: 'Hello',
      },
    });

    const result = parseCodexJsonlLine(line, '/proj/test', 'fallback');
    expect(result).toBeNull();
  });

  it('跳过缺少 message 字段的行', () => {
    const line = JSON.stringify({
      sessionId: 'sess-1',
      type: 'summary',
    });

    const result = parseCodexJsonlLine(line, '/proj/test', 'fallback');
    expect(result).toBeNull();
  });

  it('缺少 cost 时 costUsd 默认为 0', () => {
    const line = JSON.stringify({
      sessionId: 'sess-1',
      messageId: 'msg_01',
      message: {
        role: 'assistant',
        usage: { input_tokens: 100, output_tokens: 50, total_tokens: 150 },
      },
    });

    const result = parseCodexJsonlLine(line, '/proj/test', 'fallback');
    expect(result).not.toBeNull();
    expect(result!.costUsd).toBe(0);
  });

  it('从 message.usage 提取 model/provider', () => {
    const line = JSON.stringify({
      sessionId: 'sess-1',
      messageId: 'msg_01',
      message: {
        role: 'assistant',
        model: 'gpt-5',
        provider: 'openai',
        usage: { input_tokens: 500, output_tokens: 200, total_tokens: 700 },
      },
    });

    const result = parseCodexJsonlLine(line, '/proj/test', 'fallback');
    expect(result).not.toBeNull();
    expect(result!.model).toBe('gpt-5');
    expect(result!.provider).toBe('openai');
  });
});

describe('codex-log-parser — parseCodexJsonlLines', () => {
  it('解析多行并返回有效记录', () => {
    const lines = [
      JSON.stringify({
        sessionId: 'sess-1',
        messageId: 'msg_01',
        message: {
          role: 'assistant',
          usage: { input_tokens: 1000, output_tokens: 500, total_tokens: 1500 },
        },
      }),
      JSON.stringify({
        sessionId: 'sess-1',
        messageId: 'msg_02',
        message: { role: 'user', content: 'Hi' },
      }),
      JSON.stringify({
        sessionId: 'sess-1',
        messageId: 'msg_03',
        message: {
          role: 'assistant',
          usage: { input_tokens: 800, output_tokens: 300, total_tokens: 1100 },
        },
      }),
    ];

    const result = parseCodexJsonlLines(lines, '/proj/test', 'fallback');
    expect(result).toHaveLength(2);
    expect(result[0].messageId).toBe('msg_01');
    expect(result[1].messageId).toBe('msg_03');
  });

  it('空数组返回空结果', () => {
    const result = parseCodexJsonlLines([], '/proj/test', 'fallback');
    expect(result).toEqual([]);
  });
});

describe('codex-log-parser — parseCodexJsonlFile', () => {
  const testDir = join(tmpdir(), `sv-test-codex-${Date.now()}`);

  beforeEach(() => {
    mkdirSync(testDir, { recursive: true });
  });

  afterEach(() => {
    rmSync(testDir, { recursive: true, force: true });
  });

  it('解析完整 JSONL 文件', () => {
    const filePath = join(testDir, 'codex.jsonl');
    const lines = [
      JSON.stringify({
        sessionId: 'sess-codex-001',
        messageId: 'msg_01',
        message: {
          role: 'assistant',
          usage: { input_tokens: 2000, output_tokens: 800, total_tokens: 2800 },
          cost: { total: 0.06 },
        },
      }),
      JSON.stringify({
        sessionId: 'sess-codex-001',
        messageId: 'msg_02',
        message: { role: 'user', content: 'Hi' },
      }),
      JSON.stringify({
        sessionId: 'sess-codex-001',
        messageId: 'msg_03',
        message: {
          role: 'assistant',
          usage: { input_tokens: 1500, output_tokens: 600, total_tokens: 2100 },
        },
      }),
    ];
    writeFileSync(filePath, lines.join('\n'));

    const result = parseCodexJsonlFile(filePath);
    expect(result).toHaveLength(2);
    expect(result[0].messageId).toBe('msg_01');
    expect(result[0].costUsd).toBeCloseTo(0.06, 5);
    expect(result[1].messageId).toBe('msg_03');
  });

  it('增量解析：从 byte_offset 开始', () => {
    const filePath = join(testDir, 'incremental.jsonl');
    const line1 = JSON.stringify({
      sessionId: 'sess-1',
      messageId: 'msg_01',
      message: { role: 'assistant', usage: { input_tokens: 100, output_tokens: 50, total_tokens: 150 } },
    });
    const line2 = JSON.stringify({
      sessionId: 'sess-1',
      messageId: 'msg_02',
      message: { role: 'assistant', usage: { input_tokens: 200, output_tokens: 100, total_tokens: 300 } },
    });
    writeFileSync(filePath, `${line1}\n${line2}`);

    const offset = Buffer.byteLength(`${line1}\n`, 'utf8');
    const result = parseCodexJsonlFile(filePath, offset);
    expect(result).toHaveLength(1);
    expect(result[0].messageId).toBe('msg_02');
    expect(result[0].totalTokens).toBe(300);
  });

  it('不存在的文件返回空数组（静默降级）', () => {
    const result = parseCodexJsonlFile(join(testDir, 'nonexistent.jsonl'));
    expect(result).toEqual([]);
  });

  it('空文件返回空数组', () => {
    const filePath = join(testDir, 'empty.jsonl');
    writeFileSync(filePath, '');

    const result = parseCodexJsonlFile(filePath);
    expect(result).toEqual([]);
  });
});

describe('codex-log-parser — fixture 文件解析', () => {
  it('正确解析 codex-1.jsonl fixture', () => {
    const fixturePath = join(FIXTURES_DIR, 'codex-1.jsonl');
    const result = parseCodexJsonlFile(fixturePath);

    // 3 lines total, 2 assistant + 1 human → 2 records
    expect(result).toHaveLength(2);

    const msg1 = result.find((r) => r.messageId === 'msg_c_001')!;
    expect(msg1).toBeDefined();
    expect(msg1.inputTokens).toBe(2000);
    expect(msg1.outputTokens).toBe(800);
    expect(msg1.totalTokens).toBe(2800);
    expect(msg1.costUsd).toBeCloseTo(0.06, 5);

    const msg3 = result.find((r) => r.messageId === 'msg_c_003')!;
    expect(msg3).toBeDefined();
    expect(msg3.inputTokens).toBe(1500);
    expect(msg3.outputTokens).toBe(600);
    expect(msg3.totalTokens).toBe(2100);
    expect(msg3.costUsd).toBeCloseTo(0.045, 5);
  });
});
