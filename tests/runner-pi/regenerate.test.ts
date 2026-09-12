/**
 * runner-pi regenerate（issue 08）—— 真实分支 + 新 engineSessionId，旧分支可回看。
 *
 * 验收标准（.scratch/pi-engine-migration/issues/08）：
 *   - regenerate 创建真实新分支和新的 engineSessionId，旧分支仍可回看；
 *   - 分支点在最后一条 user message 之前（Regenerate Branch 术语，CONTEXT.md）：
 *     新文件复制 root→branchPoint，随后 re-prompt 以同一文本追加新的 user turn；
 *   - 旧原生文件不被修改或删除（parentSession 链保留回看入口）；
 *   - 进行中的回合（isStreaming）不允许 regenerate。
 *
 * 通过 vi.mock 隔离 pi SDK 与 protocol 层（同 session-recovery.test.ts 模式）。
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { PiRunnerContext } from '../../runner-pi/protocol';

const sendResponse = vi.fn();
const sendEvent = vi.fn();

vi.mock('../../runner-pi/protocol', async () => ({
  sendResponse: (...args: unknown[]) => sendResponse(...args),
  sendEvent: (...args: unknown[]) => sendEvent(...args),
  sendToolCall: vi.fn(),
  send: vi.fn(),
}));

// pi SDK 与 jiti 同样需要 mock：session.ts 顶层 import 了 ESM-only 的 pi SDK，
// vmThreads 池下真实 SDK 的跨 context 链接触发 "Linked modules must use the
// same context"（同 session-recovery.test.ts 的处理）。
vi.mock('@earendil-works/pi-coding-agent', () => ({
  createAgentSession: vi.fn(),
  SessionManager: {
    list: vi.fn(async () => []),
    open: vi.fn(),
    create: vi.fn(),
  },
  ModelRuntime: { create: vi.fn() },
  DefaultResourceLoader: class {
    constructor(_opts: unknown) {}
    async reload(_opts: unknown) {}
  },
  getAgentDir: () => '/fake/agent-dir',
  hasTrustRequiringProjectResources: () => false,
  SettingsManager: { create: () => ({ applyOverrides: () => {} }) },
}));

vi.mock('jiti', () => ({
  createJiti: () => ({
    import: async (id: string) => {
      if (id === 'pi-subagents') return { default: vi.fn() };
      if (id === 'pi-subagents/capability-ceiling') {
        return { registerSubagentCapabilityCeiling: vi.fn(() => ({ update: vi.fn(), dispose: vi.fn() })) };
      }
      if (id === 'pi-mcp-adapter') return { createMcpAdapter: vi.fn() };
      throw new Error(`unexpected jiti import: ${id}`);
    },
  }),
}));

const { handleRegenerate } = await import('../../runner-pi/session');

// ─── 脚手架 ───────────────────────────────────────────────

type Entry = { id: string; parentId: string | null; type: string; message?: { role: string; content: unknown } };

function userEntry(id: string, parentId: string | null, content: unknown): Entry {
  return { id, parentId, type: 'message', message: { role: 'user', content } };
}
function assistantEntry(id: string, parentId: string | null, text: string): Entry {
  return { id, parentId, type: 'message', message: { role: 'assistant', content: [{ type: 'text', text }] } };
}

type FakeManager = {
  sessionId: string;
  getBranch: ReturnType<typeof vi.fn>;
  createBranchedSession: ReturnType<typeof vi.fn>;
  newSession: ReturnType<typeof vi.fn>;
  branch: ReturnType<typeof vi.fn>;
  resetLeaf: ReturnType<typeof vi.fn>;
  getSessionId: ReturnType<typeof vi.fn>;
  buildSessionContext: ReturnType<typeof vi.fn>;
}

function makeManager(entries: Entry[], currentSessionId = 'pi-old-1'): FakeManager {
  const sessionId = currentSessionId;
  return {
    sessionId,
    getBranch: vi.fn(() => entries),
    createBranchedSession: vi.fn(() => '/bucket/new-branch.jsonl'),
    newSession: vi.fn(() => '/bucket/new-session.jsonl'),
    branch: vi.fn(),
    resetLeaf: vi.fn(),
    getSessionId: vi.fn(() => sessionId),
    buildSessionContext: vi.fn(() => ({ messages: [{ role: 'user', content: 'branched-context' }], thinkingLevel: 'medium', model: null })),
  };
}

function makeCtx(session: Record<string, unknown> | null): PiRunnerContext {
  return {
    session,
    unsubscribe: null,
    currentCwd: '/proj/dv',
    currentApprovalMode: 'always-ask',
    callHostTool: vi.fn(async () => ({})),
    requestApproval: vi.fn(async () => true),
    requestTrust: vi.fn(async () => true),
    mcpRuntime: null,
    subagentRuntime: null,
  };
}

function makeSession(manager: FakeManager, opts: { isStreaming?: boolean } = {}): Record<string, unknown> {
  const agent = { state: { messages: [{ role: 'user', content: 'stale-old-turn' }, { role: 'assistant', content: 'stale-reply' }] } };
  return {
    sessionManager: manager,
    agent,
    isStreaming: opts.isStreaming ?? false,
    prompt: vi.fn(async () => undefined),
    sessionId: manager.sessionId,
  };
}

function lastResponse(): { success: boolean; data?: Record<string, unknown>; error?: string } {
  const call = sendResponse.mock.calls.at(-1);
  return { success: call?.[1] as boolean, data: call?.[2] as Record<string, unknown> | undefined, error: call?.[3] as string | undefined };
}

beforeEach(() => {
  sendResponse.mockClear();
  sendEvent.mockClear();
});

// ─── 正常分支 ─────────────────────────────────────────────

describe('handleRegenerate — 真实分支与新 engineSessionId', () => {
  it('分支到最后一条 user message 之前，createBranchedSession 产生新 id，旧文件不被触碰', async () => {
    const entries: Entry[] = [
      userEntry('u1', null, '第一条'),
      assistantEntry('a1', 'u1', '回复一'),
      userEntry('u2', 'a1', '第二条'),
      assistantEntry('a2', 'u2', '回复二'),
    ];
    const manager = makeManager(entries, 'pi-old-1');
    manager.getSessionId.mockReturnValue('pi-new-9');
    const session = makeSession(manager);

    await handleRegenerate({ id: 'r1', type: 'regenerate' }, makeCtx(session));

    // 分支点 = 最后一条 user message（u2）的 parent（a1）—— 不是 u2 本身，
    // re-prompt 会在新文件中重新追加 user turn（Regenerate Branch 语义）
    expect(manager.createBranchedSession).toHaveBeenCalledWith('a1');
    // 新 engineSessionId 回传 host
    expect(lastResponse().success).toBe(true);
    expect(lastResponse().data).toMatchObject({ engineSessionId: 'pi-new-9' });
    // agent 内存状态重置为分支后上下文（不含被丢弃的旧回合）
    expect(manager.buildSessionContext).toHaveBeenCalled();
    expect((session.agent as { state: { messages: unknown[] } }).state.messages).toEqual([
      { role: 'user', content: 'branched-context' },
    ]);
    // 以同一文本 re-prompt（fire-and-forget，在 response 之后）
    expect(session.prompt).toHaveBeenCalledWith('第二条', undefined);
  });

  it('user message 携带图片时 re-prompt 透传图片', async () => {
    const blocks = [
      { type: 'text', text: '看这张图' },
      { type: 'image', data: 'abc123', mimeType: 'image/png' },
    ];
    const entries: Entry[] = [
      userEntry('u1', null, '早'),
      assistantEntry('a1', 'u1', '好'),
      userEntry('u2', 'a1', blocks),
      assistantEntry('a2', 'u2', '图收到了'),
    ];
    const manager = makeManager(entries);
    const session = makeSession(manager);

    await handleRegenerate({ id: 'r2', type: 'regenerate' }, makeCtx(session));

    expect(session.prompt).toHaveBeenCalledWith('看这张图', {
      images: [{ type: 'image', data: 'abc123', mimeType: 'image/png' }],
    });
  });

  it('最后一条 user message 是根（parentId null）时用 newSession 开新文件，同样产生新 id', async () => {
    const entries: Entry[] = [
      userEntry('u1', null, '只有一问'),
      assistantEntry('a1', 'u1', '只有一答'),
    ];
    const manager = makeManager(entries, 'pi-old-1');
    manager.getSessionId.mockReturnValue('pi-fresh-2');
    const session = makeSession(manager);

    await handleRegenerate({ id: 'r3', type: 'regenerate' }, makeCtx(session));

    expect(manager.newSession).toHaveBeenCalled();
    expect(manager.createBranchedSession).not.toHaveBeenCalled();
    expect(lastResponse().data).toMatchObject({ engineSessionId: 'pi-fresh-2' });
    expect(session.prompt).toHaveBeenCalledWith('只有一问', undefined);
  });

  it('非持久化 manager（createBranchedSession 返回 undefined）回退同文件 branch，不产生新 id', async () => {
    const entries: Entry[] = [
      userEntry('u1', null, '问'),
      assistantEntry('a1', 'u1', '答'),
      userEntry('u2', 'a1', '再问'),
      assistantEntry('a2', 'u2', '再答'),
    ];
    const manager = makeManager(entries, 'pi-inmem-1');
    manager.createBranchedSession.mockReturnValue(undefined);
    const session = makeSession(manager);

    await handleRegenerate({ id: 'r4', type: 'regenerate' }, makeCtx(session));

    expect(manager.branch).toHaveBeenCalledWith('a1');
    expect(lastResponse().data).toMatchObject({ engineSessionId: 'pi-inmem-1' });
  });

  it('re-prompt 失败不影响已发出的 response（turn 级错误经事件通道上报）', async () => {
    const entries: Entry[] = [
      userEntry('u1', null, '问'),
      assistantEntry('a1', 'u1', '答'),
      userEntry('u2', 'a1', '再问'),
      assistantEntry('a2', 'u2', '再答'),
    ];
    const manager = makeManager(entries);
    const session = makeSession(manager);
    (session.prompt as ReturnType<typeof vi.fn>).mockRejectedValue(new Error('LLM exploded'));

    await handleRegenerate({ id: 'r5', type: 'regenerate' }, makeCtx(session));

    expect(lastResponse().success).toBe(true);
    expect(lastResponse().data).toMatchObject({ engineSessionId: manager.sessionId });
  });
});

// ─── 守卫 ─────────────────────────────────────────────────

describe('handleRegenerate — 守卫', () => {
  it('会话未初始化时返回失败 response', async () => {
    await handleRegenerate({ id: 'g1', type: 'regenerate' }, makeCtx(null));
    expect(lastResponse().success).toBe(false);
    expect(lastResponse().error).toContain('Session not initialized');
  });

  it('回合进行中（isStreaming）拒绝 regenerate', async () => {
    const manager = makeManager([userEntry('u1', null, '问'), assistantEntry('a1', 'u1', '答')]);
    const session = makeSession(manager, { isStreaming: true });

    await handleRegenerate({ id: 'g2', type: 'regenerate' }, makeCtx(session));

    expect(lastResponse().success).toBe(false);
    expect(lastResponse().error).toContain('idle');
    expect(manager.createBranchedSession).not.toHaveBeenCalled();
    expect(session.prompt).not.toHaveBeenCalled();
  });

  it('没有任何 user message 时报错', async () => {
    const manager = makeManager([assistantEntry('a1', null, '无中生有的回答')]);
    const session = makeSession(manager);

    await handleRegenerate({ id: 'g3', type: 'regenerate' }, makeCtx(session));

    expect(lastResponse().success).toBe(false);
    expect(lastResponse().error).toContain('No user message');
  });
});
