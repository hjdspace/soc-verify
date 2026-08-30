// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';

vi.mock('@renderer/lib/trpc', () => ({
  trpc: {
    session: {
      create: { mutate: vi.fn().mockResolvedValue({ sessionId: 'rt_1' }) },
      restore: { mutate: vi.fn().mockResolvedValue({ sessionId: 'rt_1' }) },
      send: { mutate: vi.fn().mockResolvedValue(undefined) },
      regenerate: { mutate: vi.fn().mockResolvedValue({ ok: true, ompSessionId: 'omp_new' }) },
      abort: { mutate: vi.fn().mockResolvedValue(undefined) },
      destroy: { mutate: vi.fn().mockResolvedValue(undefined) },
      list: { query: vi.fn().mockResolvedValue([]) },
      saveStoredMessages: { mutate: vi.fn().mockResolvedValue(undefined) },
      listSkills: { query: vi.fn().mockResolvedValue([]) },
    },
    project: {
      searchFiles: { query: vi.fn().mockResolvedValue([]) },
    },
  },
}));

vi.mock('@renderer/stores/toast', () => ({
  useToastStore: {
    getState: () => ({
      success: vi.fn(),
      error: vi.fn(),
      info: vi.fn(),
    }),
  },
}));

vi.mock('@renderer/stores/diff-review', () => ({
  openReviewAwareFile: vi.fn(),
}));

vi.mock('@renderer/components/chat/MermaidDiagram', () => ({
  MermaidDiagram: ({ code }: { code: string }) => <div data-testid="mermaid-stub">{code}</div>,
}));

const clipboardWrite = vi.fn().mockResolvedValue(undefined);
Object.defineProperty(navigator, 'clipboard', {
  value: { writeText: clipboardWrite },
  writable: true,
});

import { AssistantActions } from '@renderer/components/chat/AssistantActions';
import { useSessionCoreStore } from '@renderer/stores/session-core';
import { useSessionMessagesStore } from '@renderer/stores/session-messages';
import { openReviewAwareFile } from '@renderer/stores/diff-review';
import { trpc } from '@renderer/lib/trpc';
import type { ChatMessage, SessionEntry } from '@renderer/stores/session-types';

function makeSession(overrides: Partial<SessionEntry> = {}): SessionEntry {
  return {
    id: 's1',
    projectId: 'p1',
    name: 'Test',
    status: 'idle',
    messages: [],
    composer: { inputMessage: '', selectedSkills: [], contextFiles: [] },
    createdAt: Date.now(),
    ...overrides,
  };
}

function makeMsg(partial: Partial<ChatMessage> & { id: string; role: ChatMessage['role'] }): ChatMessage {
  return { content: '', timestamp: Date.now(), ...partial };
}

describe('AssistantActions 回合收尾操作栏', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    clipboardWrite.mockClear();
    useSessionCoreStore.setState({ sessions: [], currentSessionId: null });
  });

  it('空闲会话的最后一条助手消息显示复制与重新生成', () => {
    const session = makeSession({
      status: 'idle',
      messages: [
        makeMsg({ id: 'u1', role: 'user', content: 'hi' }),
        makeMsg({ id: 'a2', role: 'assistant', content: '回答' }),
      ],
    });
    render(<AssistantActions message={session.messages[1]} session={session} />);
    expect(screen.getByLabelText('复制回复')).toBeInTheDocument();
    expect(screen.getByTestId('assistant-regenerate')).toBeInTheDocument();
  });

  it('非最后一条助手消息不显示重新生成', () => {
    const session = makeSession({
      status: 'idle',
      messages: [
        makeMsg({ id: 'a1', role: 'assistant', content: '旧回答' }),
        makeMsg({ id: 'u2', role: 'user', content: '追问' }),
        makeMsg({ id: 'a3', role: 'assistant', content: '新回答' }),
      ],
    });
    render(<AssistantActions message={session.messages[0]} session={session} />);
    expect(screen.getByLabelText('复制回复')).toBeInTheDocument();
    expect(screen.queryByTestId('assistant-regenerate')).not.toBeInTheDocument();
  });

  it('会话流式中不显示重新生成', () => {
    const session = makeSession({
      status: 'streaming',
      messages: [
        makeMsg({ id: 'u1', role: 'user', content: 'hi' }),
        makeMsg({ id: 'a2', role: 'assistant', content: '回答' }),
      ],
    });
    render(<AssistantActions message={session.messages[1]} session={session} />);
    expect(screen.queryByTestId('assistant-regenerate')).not.toBeInTheDocument();
  });

  it('复制按钮写入消息原文', () => {
    const msg = makeMsg({ id: 'a1', role: 'assistant', content: '要复制的内容' });
    render(<AssistantActions message={msg} />);
    fireEvent.click(screen.getByLabelText('复制回复'));
    expect(clipboardWrite).toHaveBeenCalledWith('要复制的内容');
  });

  it('点击重新生成调用 store action（触发 trpc.session.regenerate）', async () => {
    const session = makeSession({
      status: 'idle',
      messages: [
        makeMsg({ id: 'u1', role: 'user', content: 'hi' }),
        makeMsg({ id: 'a2', role: 'assistant', content: '回答' }),
      ],
    });
    useSessionCoreStore.setState({ sessions: [session], currentSessionId: 's1' });

    render(<AssistantActions message={session.messages[1]} session={session} />);
    fireEvent.click(screen.getByTestId('assistant-regenerate'));

    await waitFor(() => {
      expect(trpc.session.regenerate.mutate).toHaveBeenCalledWith({ sessionId: 's1' });
    });
  });

  it('引用来源可展开，文件项点击打开文件', () => {
    const msg = makeMsg({
      id: 'a1',
      role: 'assistant',
      content: '查看 src/main/foo.sv:42，结果见 case:///run/1。',
    });
    render(<AssistantActions message={msg} />);

    // 胶囊开关：重叠图标堆叠（每项一枚）+ 计数文本
    expect(document.querySelectorAll('.ap-sources-stack .ap-src-icon')).toHaveLength(2);
    fireEvent.click(screen.getByRole('button', { name: /引用 2 项/ }));

    expect(screen.getByTestId('assistant-sources')).toBeInTheDocument();
    // 文件行：文件名居左，「目录:行号」元信息居右
    fireEvent.click(screen.getByText('foo.sv'));
    expect(openReviewAwareFile).toHaveBeenCalledWith('src/main/foo.sv', 'foo.sv');
    expect(screen.getByText('src/main:42')).toBeInTheDocument();
    // host URI 行：展示去掉协议后的路径，右侧标注协议
    expect(screen.getByText('/run/1')).toBeInTheDocument();
    expect(screen.getByText('case://')).toBeInTheDocument();
  });

  it('无引用内容不显示引用来源入口', () => {
    const msg = makeMsg({ id: 'a1', role: 'assistant', content: '普通回答，无引用。' });
    render(<AssistantActions message={msg} />);
    expect(screen.queryByRole('button', { name: /引用/ })).not.toBeInTheDocument();
  });

  it('建议追问在最后一条助手消息上渲染，点击直接发送', async () => {
    const session = makeSession({
      status: 'idle',
      followUps: ['如何修改复位释放时序？', '查看相关 SDC 约束'],
      messages: [
        makeMsg({ id: 'u1', role: 'user', content: 'hi' }),
        makeMsg({ id: 'a2', role: 'assistant', content: '回答内容' }),
      ],
    });
    useSessionCoreStore.setState({ sessions: [session], currentSessionId: 's1' });

    render(<AssistantActions message={session.messages[1]} session={session} />);
    expect(screen.getByTestId('assistant-followups')).toBeInTheDocument();

    fireEvent.click(screen.getByText('如何修改复位释放时序？'));
    await waitFor(() => {
      expect(trpc.session.send.mutate).toHaveBeenCalledWith(
        expect.objectContaining({ message: '如何修改复位释放时序？' }),
      );
    });
  });

  it('建议追问不显示在非最后一条助手消息上', () => {
    const session = makeSession({
      status: 'idle',
      followUps: ['过期建议'],
      messages: [
        makeMsg({ id: 'a1', role: 'assistant', content: '旧回答' }),
        makeMsg({ id: 'u2', role: 'user', content: '追问' }),
        makeMsg({ id: 'a3', role: 'assistant', content: '新回答' }),
      ],
    });
    render(<AssistantActions message={session.messages[0]} session={session} />);
    expect(screen.queryByTestId('assistant-followups')).not.toBeInTheDocument();
  });
});

describe('regenerateLast store action', () => {
  function seedSession(messages: ChatMessage[], status: SessionEntry['status'] = 'idle') {
    useSessionCoreStore.setState({
      sessions: [makeSession({ messages, status })],
      currentSessionId: 's1',
    });
  }

  beforeEach(() => {
    vi.clearAllMocks();
    useSessionCoreStore.setState({ sessions: [], currentSessionId: null });
  });

  it('截断最后一条用户消息之后的内容并调用 regenerate', async () => {
    seedSession([
      makeMsg({ id: 'u1', role: 'user', content: '第一问' }),
      makeMsg({ id: 'a2', role: 'assistant', content: '第一答' }),
      makeMsg({ id: 't3', role: 'tool', content: '', toolName: 'list_subsys', toolArgs: {} }),
      makeMsg({ id: 'u4', role: 'user', content: '第二问' }),
      makeMsg({ id: 'a5', role: 'assistant', content: '第二答' }),
    ]);

    await useSessionMessagesStore.getState().regenerateLast();

    expect(trpc.session.regenerate.mutate).toHaveBeenCalledWith({ sessionId: 's1' });
    const messages = useSessionCoreStore.getState().sessions[0].messages;
    // 保留到最后一条用户消息 u4，其后内容替换为流式占位
    expect(messages).toHaveLength(5);
    expect(messages[3].id).toBe('u4');
    expect(messages[4].role).toBe('assistant');
    expect(messages[4].isStreaming).toBe(true);
    expect(useSessionCoreStore.getState().sessions[0].status).toBe('streaming');
  });

  it('regenerate 失败时回滚被删除的消息', async () => {
    vi.mocked(trpc.session.regenerate.mutate).mockRejectedValueOnce(new Error('boom'));
    seedSession([
      makeMsg({ id: 'u1', role: 'user', content: '第一问' }),
      makeMsg({ id: 'a2', role: 'assistant', content: '第一答' }),
    ]);

    await useSessionMessagesStore.getState().regenerateLast();

    const session = useSessionCoreStore.getState().sessions[0];
    expect(session.status).toBe('idle');
    expect(session.messages).toHaveLength(2);
    expect(session.messages.map((m) => m.id)).toEqual(['u1', 'a2']);
  });

  it('会话非空闲时不执行重新生成', async () => {
    seedSession(
      [
        makeMsg({ id: 'u1', role: 'user', content: 'hi' }),
        makeMsg({ id: 'a2', role: 'assistant', content: '回答', isStreaming: true }),
      ],
      'streaming',
    );

    await useSessionMessagesStore.getState().regenerateLast();

    expect(trpc.session.regenerate.mutate).not.toHaveBeenCalled();
    expect(useSessionCoreStore.getState().sessions[0].messages).toHaveLength(2);
  });

  it('用户消息之后没有回复时不执行重新生成', async () => {
    seedSession([makeMsg({ id: 'u1', role: 'user', content: 'hi' })]);

    await useSessionMessagesStore.getState().regenerateLast();

    expect(trpc.session.regenerate.mutate).not.toHaveBeenCalled();
  });
});
