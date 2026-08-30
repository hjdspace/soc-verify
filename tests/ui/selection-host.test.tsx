// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
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
  useSelectionAnchor: () => ({
    selection: {
      text: '被选中的片段',
      bounds: { left: 0, top: 0, right: 100, bottom: 16 },
      lastLine: { left: 0, top: 8, right: 100, bottom: 16 },
    },
    anchor: { x: 40, y: 24 },
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

  it('快捷动作发送带引用上下文的消息（指令 + blockquote 引用）', async () => {
    const session = setCoreSession([assistantMsg('a1', '回复')]);
    const { rerender } = render(
      <SelectionActionsHost session={session} enabled>
        <p>回复正文</p>
      </SelectionActionsHost>,
    );

    fireEvent.click(screen.getByTestId('selection-action-explain'));
    await waitFor(() => {
      expect(trpc.session.send.mutate).toHaveBeenCalledWith({
        sessionId: 'sess_rt_1',
        message: '请解释下面引用的这段内容\n\n> 引用自你的回复：\n> 被选中的片段',
        images: undefined,
      });
    });
    // 真实 sendMessage 同步 append：user 引用消息 + 空流式 assistant 占位
    expect(storeMessageIds()).toHaveLength(3);

    // 引擎事件落定（模拟 message_end 后状态）→ result
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
    expect(screen.getByTestId('selection-keep')).toBeTruthy();
  });

  it('自定义 prompt 作为指令原文发送', async () => {
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

  it('Retry 先恢复原文再重新发送同一动作', async () => {
    const session = setCoreSession([assistantMsg('a1', '回复')]);
    const { rerender } = render(
      <SelectionActionsHost session={session} enabled>
        <p>回复正文</p>
      </SelectionActionsHost>,
    );
    fireEvent.click(screen.getByTestId('selection-action-explain'));
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

  it('Retry 后再次 Discard 仍按重提时的基线恢复（live 基线，非渲染闭包）', async () => {
    const session = setCoreSession([assistantMsg('a1', '回复')]);
    const { rerender } = render(
      <SelectionActionsHost session={session} enabled>
        <p>回复正文</p>
      </SelectionActionsHost>,
    );
    // 第一回合
    fireEvent.click(screen.getByTestId('selection-action-explain'));
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

  it('Keep 保留会话仅关闭状态机，不删消息', async () => {
    const session = setCoreSession([assistantMsg('a1', '回复')]);
    const { rerender } = render(
      <SelectionActionsHost session={session} enabled>
        <p>回复正文</p>
      </SelectionActionsHost>,
    );
    fireEvent.click(screen.getByTestId('selection-action-explain'));
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
    fireEvent.click(screen.getByTestId('selection-keep'));
    expect(storeMessageIds()).toHaveLength(3);
    // 回 idle：动作区再次可用（mock 选区仍在）
    expect(screen.getByTestId('selection-action-explain')).toBeTruthy();
  });
});
