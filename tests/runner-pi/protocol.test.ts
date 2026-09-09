/**
 * runner-pi protocol.ts —— JSONL 帧发送与 stdout guard 判定。
 *
 * 与 omp runner 的 protocol.ts 不同，runner-pi 的协议层在导入时**无副作用**
 * （stdout guard 改由 runner-pi/index.ts 显式安装），因此可以在测试中直接导入，
 * 通过临时替换 process.stdout.write 断言发出的 JSONL 帧。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const writes: string[] = [];
let restoreStdout: (() => void) | null = null;

beforeEach(() => {
  writes.length = 0;
  const original = process.stdout.write.bind(process.stdout);
  process.stdout.write = ((chunk: unknown) => {
    writes.push(typeof chunk === 'string' ? chunk : String(chunk));
    return true;
  }) as typeof process.stdout.write;
  restoreStdout = () => {
    process.stdout.write = original;
  };
});

afterEach(() => {
  restoreStdout?.();
  restoreStdout = null;
});

const {
  shouldPassToStdout,
  installStdoutJsonlGuard,
  send,
  sendResponse,
  sendEvent,
  sendToolCall,
} = await import('../../runner-pi/protocol');

describe('shouldPassToStdout', () => {
  it('带 type 字段的 JSON 行放行', () => {
    expect(shouldPassToStdout('{"type":"event"}')).toBe(true);
  });

  it('无 type 字段的 JSON 行拦截（重定向到 stderr）', () => {
    expect(shouldPassToStdout('{"level":"info","message":"log line"}')).toBe(false);
  });

  it('非 JSON 输出拦截', () => {
    expect(shouldPassToStdout('plain console.log output')).toBe(false);
  });

  it('空行拦截', () => {
    expect(shouldPassToStdout('   ')).toBe(false);
  });

  it('JSON 数组拦截（不是协议帧）', () => {
    expect(shouldPassToStdout('[{"type":"event"}]')).toBe(false);
  });
});

describe('installStdoutJsonlGuard', () => {
  it('非 JSONL 输出被重定向到 stderr，协议帧原样通过', () => {
    const stderr = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);

    installStdoutJsonlGuard();

    // 协议帧：走 stdout（被当前测试的桩捕获）
    send({ type: 'event', event: { type: 'agent_start' } });
    expect(writes).toHaveLength(1);

    // 非 JSONL 输出：重定向到 stderr
    process.stdout.write('a stray log line\n');
    expect(stderr).toHaveBeenCalled();

    stderr.mockRestore();
  });
});

describe('JSONL 发送帮助函数', () => {
  it('send 输出单行 JSON + 换行', () => {
    send({ type: 'ready' });
    expect(writes).toHaveLength(1);
    expect(writes[0]).toBe('{"type":"ready"}\n');
  });

  it('sendResponse 输出响应帧（undefined 字段被省略）', () => {
    sendResponse('req_1', true, { ok: true });
    expect(writes[0]).toBe('{"id":"req_1","type":"response","success":true,"data":{"ok":true}}\n');
  });

  it('sendResponse 输出失败帧', () => {
    sendResponse('req_2', false, undefined, 'boom');
    expect(writes[0]).toBe('{"id":"req_2","type":"response","success":false,"error":"boom"}\n');
  });

  it('sendEvent 包裹 event 载荷', () => {
    sendEvent({ type: 'message_end' });
    expect(writes[0]).toBe('{"type":"event","event":{"type":"message_end"}}\n');
  });

  it('sendToolCall 输出工具调用帧', () => {
    sendToolCall('tool_1', 'ask', { questions: [] });
    expect(writes[0]).toBe('{"type":"tool_call","id":"tool_1","toolName":"ask","args":{"questions":[]}}\n');
  });
});
