// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { SelectionActionsHost } from '@renderer/components/chat/SelectionActionsHost';
import { useSessionCoreStore } from '@renderer/stores/session-core';
import type { ChatMessage, SessionEntry } from '@renderer/stores/session-types';

/**
 * 气泡宿主集成（issues #5）：mock 划选 hook（注入固定选区），store 用
 * **真实** session-core/session-messages（trpc 全 mock，同 session-store
 * 测试基线）——真实 sendMessage 同步 append、真实 removeMessagesFrom 截断。
 * 验证：快捷动作/自定义 prompt 组装带引用上下文的消息走 session 发送链路、
 * Discard/Retry 按提交前消息数恢复原文（含 Retry 后再 Discard 的基线
 * 正确性——基线必须取 live store 而非渲染闭包）。
 */

vi.mock('@renderer/hooks/use-selection-anchor', () => ({
  // 尊重 enabled 门控：无会话时宿主禁用监听 → selection/anchor 均为 null
  useSelectionAnchor: (options: { enabled?: boolean }) => ({
    selection: options?.enabled
      ? {
          text: '被选中的片段',
          bounds: { left: 0, top: 0, right: 100, bottom: 16 },
          lastLine: { left: 0, top: 8, right: 100, bottom: 16 },
        }
      : null,
    anchor: options?.enabled ? { x: 40, y: 24 } : null,
    place: vi.fn(),
  }),
}));

vi.mock('@renderer/lib/trpc', () => ({
  trpc: {
    session: {
      create: { mutate: vi.fn().mockResolvedValue({ sessionId: 'sess_rt_1' }) },
      send: { mutate: vi.fn().mockResolvedValue(undefined) },
      abort: { mutate: vi.fn().mockResolvedValue(undefined) },
      saveStoredMessages: { mutate: vi.fn().mockResolvedValue(undefined) },
      updateContextUsage: { mutate: vi.fn().mockResolvedValue(undefined) },
    },
  },
}));

import { trpc } from '@renderer/lib/trpc';

const SESSION_ID = 'sess_1';

function assistantMsg(id: string, content: string, isStreaming = false): ChatMessage {
  return { id, role: 'assistant', content, timestamp: 1, isStreaming };
}

/** 真实 core store 播种（runtimeSessionId 预置跳过 ensureRuntimeSession） */
function setCoreSession(messages: ChatMessage[], status: SessionEntry['status'] = 'idle'): SessionEntry {
  const session: SessionEntry = {
    id: SESSION_ID,
    runtimeSessionId: 'sess_rt_1',
    projectId: 'proj_1',
    cwd: '/tmp/proj',
    name: '测试会话',
    status,
    messages,
    composer: { inputMessage: '', selectedSkills: [], contextFiles: [] },
    createdAt: 0,
  };
  useSessionCoreStore.setState({ sessions: [session], currentSessionId: session.id });
  return session;
}

function storeMessageIds(): string[] {
  return useSessionCoreStore.getState().sessions[0].messages.map((m) => m.id);
}

beforeEach(() => {
  vi.mocked(trpc.session.send.mutate).mockClear();
  vi.mocked(trpc.session.saveStoredMessages.mutate).mockClear();
});

afterEach(() => {
  document.body.innerHTML = '';
  useSessionCoreStore.setState({ sessions: [], currentSessionId: null });
});

describe('SelectionActionsHost — 气泡接入', () => {
  it('气泡内容渲染，固定选区下浮条可见并锚定', () => {
    const session = setCoreSession([assistantMsg('a1', '回复')]);
    render(
      <SelectionActionsHost session={session} enabled>
        <p data-testid="bubble-content">回复正文</p>
      </SelectionActionsHost>,
    );
    expect(screen.getByTestId('bubble-content')).toBeTruthy();
    expect(screen.getByTestId('selection-bar').style.transform).toBe('translate3d(40px, 24px, 0) translateX(-50%)');
    expect(screen.getByTestId('selection-action-explain')).toBeTruthy();
  });

  it('查阅型动作（explain）在临时会话发送，不写入当前会话', async () => {
    const session = setCoreSession([assistantMsg('a1', '回复')]);
    render(
      <SelectionActionsHost session={session} enabled>
        <p>回复正文</p>
      </SelectionActionsHost>,
    );

    fireEvent.click(screen.getByTestId('selection-action-explain'));
    // 查阅型动作创建临时会话 → sendMessage 在临时会话上发送
    await waitFor(() => {
      expect(trpc.session.send.mutate).toHaveBeenCalledWith({
        sessionId: 'sess_rt_1',
        message: '请解释下面引用的这段内容\n\n> 引用自你的回复：\n> 被选中的片段',
        images: undefined,
      });
    });
    // 当前会话消息不变——查阅型动作不打断当前会话
    expect(storeMessageIds()).toEqual(['a1']);
    // 临时会话出现在 sessions 列表中，标记为 transient
    const allSessions = useSessionCoreStore.getState().sessions;
    expect(allSessions).toHaveLength(2);
    const transient = allSessions.find((s) => s.id !== SESSION_ID);
    expect(transient?.transient).toBe(true);
    // 临时会话有 user + assistant 消息（sendMessage 同步 append）
    expect(transient?.messages).toHaveLength(2);
  });

  it('自定义 prompt 在临时会话发送（查阅型），不写入当前会话', async () => {
    const session = setCoreSession([assistantMsg('a1', '回复')]);
    render(
      <SelectionActionsHost session={session} enabled>
        <p>回复正文</p>
      </SelectionActionsHost>,
    );
    fireEvent.change(screen.getByTestId('selection-prompt'), { target: { value: '换个说法' } });
    fireEvent.click(screen.getByTestId('selection-send'));
    await waitFor(() => {
      expect(trpc.session.send.mutate).toHaveBeenCalledWith({
        sessionId: 'sess_rt_1',
        message: '换个说法\n\n> 引用自你的回复：\n> 被选中的片段',
        images: undefined,
      });
    });
    // 当前会话不变——自定义 prompt 也是查阅型，不打断当前会话
    expect(storeMessageIds()).toEqual(['a1']);
  });

  it('Discard 按提交前消息数移除本回合消息（恢复原文）', async () => {
    const session = setCoreSession([assistantMsg('a1', '回复')]);
    const { rerender } = render(
      <SelectionActionsHost session={session} enabled>
        <p>回复正文</p>
      </SelectionActionsHost>,
    );
    fireEvent.click(screen.getByTestId('selection-action-improve'));
    await waitFor(() => {
      expect(storeMessageIds()).toHaveLength(3);
    });
    rerender(
      <SelectionActionsHost
        session={setCoreSession([
          assistantMsg('a1', '回复'),
          { id: 'u_1', role: 'user', content: '引用', timestamp: 2 },
          assistantMsg('a_2', '新回答'),
        ])}
        enabled
      >
        <p>回复正文</p>
      </SelectionActionsHost>,
    );
    fireEvent.click(screen.getByTestId('selection-discard'));
    // 真实 removeMessagesFrom：截断到提交前（1 条），恢复原文
    expect(storeMessageIds()).toEqual(['a1']);
  });

  it('Retry 先恢复原文再重新发送同一动作（改写型 improve）', async () => {
    const session = setCoreSession([assistantMsg('a1', '回复')]);
    const { rerender } = render(
      <SelectionActionsHost session={session} enabled>
        <p>回复正文</p>
      </SelectionActionsHost>,
    );
    fireEvent.click(screen.getByTestId('selection-action-improve'));
    await waitFor(() => {
      expect(storeMessageIds()).toHaveLength(3);
    });
    rerender(
      <SelectionActionsHost
        session={setCoreSession([
          assistantMsg('a1', '回复'),
          { id: 'u_1', role: 'user', content: '引用', timestamp: 2 },
          assistantMsg('a_2', '新回答'),
        ])}
        enabled
      >
        <p>回复正文</p>
      </SelectionActionsHost>,
    );
    fireEvent.click(screen.getByTestId('selection-retry'));
    await waitFor(() => {
      expect(trpc.session.send.mutate).toHaveBeenCalledTimes(2);
    });
    // 截断回 1 条后重提：store 又是 3 条（新 user + 新占位）
    expect(storeMessageIds()).toHaveLength(3);
    expect(screen.getByTestId('selection-busy')).toBeTruthy();
  });

  it('Retry 后再次 Discard 仍按重提时的基线恢复（改写型 improve，live 基线，非渲染闭包）', async () => {
    const session = setCoreSession([assistantMsg('a1', '回复')]);
    const { rerender } = render(
      <SelectionActionsHost session={session} enabled>
        <p>回复正文</p>
      </SelectionActionsHost>,
    );
    // 第一回合（improve 是改写型，落定后显示 Keep/Discard/Retry）
    fireEvent.click(screen.getByTestId('selection-action-improve'));
    await waitFor(() => {
      expect(storeMessageIds()).toHaveLength(3);
    });
    rerender(
      <SelectionActionsHost
        session={setCoreSession([
          assistantMsg('a1', '回复'),
          { id: 'u_1', role: 'user', content: '引用', timestamp: 2 },
          assistantMsg('a_2', '新回答'),
        ])}
        enabled
      >
        <p>回复正文</p>
      </SelectionActionsHost>,
    );
    // Retry：截断回 1 条 → 重提（重提基线必须取截断后的 live 长度 1）
    fireEvent.click(screen.getByTestId('selection-retry'));
    await waitFor(() => {
      expect(trpc.session.send.mutate).toHaveBeenCalledTimes(2);
      expect(storeMessageIds()).toHaveLength(3);
    });
    rerender(
      <SelectionActionsHost
        session={setCoreSession([
          assistantMsg('a1', '回复'),
          { id: 'u_2', role: 'user', content: '引用', timestamp: 3 },
          assistantMsg('a_3', '重试回答'),
        ])}
        enabled
      >
        <p>回复正文</p>
      </SelectionActionsHost>,
    );
    fireEvent.click(screen.getByTestId('selection-discard'));
    // 基线若取渲染闭包（重提前 3 条），此处会截不到任何消息
    expect(storeMessageIds()).toEqual(['a1']);
  });

  it('Keep 保留会话消息并将改写结果交给宿主（改写型 improve）', async () => {
    const session = setCoreSession([assistantMsg('a1', '回复')]);
    const onAcceptSelection = vi.fn();
    const { rerender } = render(
      <SelectionActionsHost session={session} enabled onAcceptSelection={onAcceptSelection}>
        <p>回复正文</p>
      </SelectionActionsHost>,
    );
    fireEvent.click(screen.getByTestId('selection-action-improve'));
    await waitFor(() => {
      expect(storeMessageIds()).toHaveLength(3);
    });
    rerender(
      <SelectionActionsHost
        session={setCoreSession([
          assistantMsg('a1', '回复'),
          { id: 'u_1', role: 'user', content: '引用', timestamp: 2 },
          assistantMsg('a_2', '新回答'),
        ])}
        enabled
        onAcceptSelection={onAcceptSelection}
      >
        <p>回复正文</p>
      </SelectionActionsHost>,
    );
    fireEvent.click(screen.getByTestId('selection-keep'));
    // 消息不删——保留在会话中
    expect(storeMessageIds()).toHaveLength(3);
    expect(onAcceptSelection).toHaveBeenCalledWith('新回答', '被选中的片段');
    // 回 idle：动作区再次可用（mock 选区仍在）
    expect(screen.getByTestId('selection-action-explain')).toBeTruthy();
  });

  it('任务运行中改写型动作填入当前会话输入框', () => {
    // 会话处于 streaming 状态（任务正在运行）
    const session = setCoreSession(
      [assistantMsg('a1', '回复', true)],
      'streaming',
    );
    render(
      <SelectionActionsHost session={session} enabled>
        <p>回复正文</p>
      </SelectionActionsHost>,
    );

    fireEvent.click(screen.getByTestId('selection-action-improve'));

    expect(trpc.session.send.mutate).not.toHaveBeenCalled();
    // 不追加本地回合消息，但消息应写入当前会话 composer
    expect(storeMessageIds()).toEqual(['a1']);
    const live = useSessionCoreStore.getState().sessions[0];
    expect(live.composer.inputMessage).toBe('请改进下面引用的这段内容的表达，使其更清晰专业\n\n> 引用自你的回复：\n> 被选中的片段');
    expect(screen.queryByTestId('selection-busy')).toBeNull();
  });
});

describe('SelectionActionsHost — 文件/产物表面接入（source 来源 + session 回退）', () => {
  it('查阅型动作（explain）在临时会话发送，引用标注为「引用自文件 <path>」', async () => {
    setCoreSession([assistantMsg('a1', '回复')]);
    render(
      <SelectionActionsHost source={{ kind: 'file', path: '/proj/view/dv/tb_top.sv' }}>
        <p>文件内容</p>
      </SelectionActionsHost>,
    );

    // 浮条可见（当前会话存在 → 划选监听开启）
    expect(screen.getByTestId('selection-bar').style.opacity).toBe('1');
    fireEvent.click(screen.getByTestId('selection-action-explain'));
    await waitFor(() => {
      expect(trpc.session.send.mutate).toHaveBeenCalledWith({
        sessionId: 'sess_rt_1',
        message: '请解释下面引用的这段内容\n\n> 引用自文件 /proj/view/dv/tb_top.sv：\n> 被选中的片段',
        images: undefined,
      });
    });
    // 当前会话不变——查阅型动作不打断当前会话
    expect(storeMessageIds()).toEqual(['a1']);
  });

  it('自定义 prompt 在临时会话发送，同样携带文件来源标注', async () => {
    setCoreSession([assistantMsg('a1', '回复')]);
    render(
      <SelectionActionsHost source={{ kind: 'file', path: '/docs/report.md' }}>
        <p>文件内容</p>
      </SelectionActionsHost>,
    );
    fireEvent.change(screen.getByTestId('selection-prompt'), { target: { value: '总结要点' } });
    fireEvent.click(screen.getByTestId('selection-send'));
    await waitFor(() => {
      expect(trpc.session.send.mutate).toHaveBeenCalledWith({
        sessionId: 'sess_rt_1',
        message: '总结要点\n\n> 引用自文件 /docs/report.md：\n> 被选中的片段',
        images: undefined,
      });
    });
    // 当前会话不变
    expect(storeMessageIds()).toEqual(['a1']);
  });

  it('文件来源回合的 Discard 按当前会话基线恢复原文', async () => {
    setCoreSession([assistantMsg('a1', '回复')]);
    render(
      <SelectionActionsHost source={{ kind: 'file', path: '/rtl/top.sv' }}>
        <p>文件内容</p>
      </SelectionActionsHost>,
    );
    fireEvent.click(screen.getByTestId('selection-action-improve'));
    await waitFor(() => {
      expect(storeMessageIds()).toHaveLength(3);
    });
    // 回合回复落定（真实 sendMessage 追加的流式占位转为静止、状态回闲）→ result
    const live = useSessionCoreStore.getState().sessions[0];
    act(() => {
      useSessionCoreStore.setState({
        sessions: [{
          ...live,
          status: 'idle',
          messages: live.messages.map((m) => ({ ...m, isStreaming: false })),
        }],
      });
    });
    expect(screen.getByTestId('selection-keep')).toBeTruthy();
    fireEvent.click(screen.getByTestId('selection-discard'));
    // 基线 = 提交前的 1 条，截断恢复原文
    expect(storeMessageIds()).toEqual(['a1']);
  });

  it('无任何会话时禁用划选监听（浮条不可见，动作无发送目标）', () => {
    useSessionCoreStore.setState({ sessions: [], currentSessionId: null });
    render(
      <SelectionActionsHost source={{ kind: 'file', path: '/rtl/top.sv' }}>
        <p>文件内容</p>
      </SelectionActionsHost>,
    );
    expect(screen.getByTestId('selection-bar').style.opacity).toBe('0');
  });
});
