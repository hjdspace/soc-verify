/**
 * handleSetThinkingLevel / handleGetState 思考强度相关行为。
 *
 * protocol.ts 在导入时会改写 process.stdout.write（JSONL guard），
 * 测试里用 vi.mock 拦截，既避免副作用又能断言 sendResponse 载荷。
 */
import { describe, expect, it, vi, beforeEach } from 'vitest';
import type { RunnerContext } from '../../runner/types';

const sendResponse = vi.fn();
const sendEvent = vi.fn();
const sendContextUsage = vi.fn();

vi.mock('../../runner/protocol', async () => ({
  sendResponse: (...args: unknown[]) => sendResponse(...args),
  sendEvent: (...args: unknown[]) => sendEvent(...args),
  sendContextUsage: (...args: unknown[]) => sendContextUsage(...args),
  // Keep the mock hermetic (avoiding protocol.ts's stdout.write side effect)
  // by mirroring the trivial 'default' → undefined mapping.
  toEngineThinkingLevel: (level?: string) => (level && level !== 'default' ? level : undefined),
}));

const { handleSetThinkingLevel, handleGetState } = await import('../../runner/handlers/session');

function makeCtx(session: unknown): RunnerContext {
  return {
    session,
    unsubscribe: null,
    currentCwd: '/tmp',
    currentApprovalMode: 'yolo',
    currentDisabledTools: new Set(),
    originalTools: null,
    callHostTool: vi.fn(),
    requestApproval: vi.fn(),
  };
}

function makeCmd(level: string): { id: string; type: 'setThinkingLevel'; level: string } {
  return { id: 'req_1', type: 'setThinkingLevel', level };
}

beforeEach(() => {
  sendResponse.mockClear();
  sendEvent.mockClear();
});

describe('handleSetThinkingLevel', () => {
  it('forwards a concrete level to session.setThinkingLevel with persist=true', async () => {
    const setThinkingLevel = vi.fn();
    const ctx = makeCtx({ setThinkingLevel });

    await handleSetThinkingLevel(makeCmd('high') as never, ctx);

    expect(setThinkingLevel).toHaveBeenCalledWith('high', true);
    expect(sendResponse).toHaveBeenCalledWith('req_1', true, { ok: true });
  });

  it('maps the default sentinel to undefined so the engine default applies', async () => {
    const setThinkingLevel = vi.fn();
    const ctx = makeCtx({ setThinkingLevel });

    await handleSetThinkingLevel(makeCmd('default') as never, ctx);

    expect(setThinkingLevel).toHaveBeenCalledWith(undefined, true);
    expect(sendResponse).toHaveBeenCalledWith('req_1', true, { ok: true });
  });

  it('rejects the command when the session is not initialized', async () => {
    const ctx = makeCtx(null);

    await expect(handleSetThinkingLevel(makeCmd('high') as never, ctx)).rejects.toThrow('Session not initialized');
    expect(sendResponse).not.toHaveBeenCalled();
  });
});

describe('handleGetState thinking level exposure', () => {
  it('overrides the resolved agent state level with the configured selector', async () => {
    const ctx = makeCtx({
      state: { thinkingLevel: 'high', messageCount: 3 },
      model: { id: 'glm-5.3' },
      getContextUsage: () => ({ tokens: 1, contextWindow: 2 }),
      configuredThinkingLevel: () => 'auto',
    });

    await handleGetState({ id: 'req_2', type: 'getState' } as never, ctx);

    expect(sendResponse).toHaveBeenCalledTimes(1);
    const [, success, data] = sendResponse.mock.calls[0] as [string, boolean, { state: Record<string, unknown> }];
    expect(success).toBe(true);
    expect(data.state.thinkingLevel).toBe('auto');
    expect(data.state.messageCount).toBe(3);
  });

  it('returns an undefined thinking level when the session exposes no selector', async () => {
    const ctx = makeCtx({
      state: {},
      model: undefined,
    });

    await handleGetState({ id: 'req_3', type: 'getState' } as never, ctx);

    const [, , data] = sendResponse.mock.calls[0] as [string, boolean, { state: Record<string, unknown> }];
    expect(data.state.thinkingLevel).toBeUndefined();
  });
});
