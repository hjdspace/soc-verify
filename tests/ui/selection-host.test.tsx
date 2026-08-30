// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import { SelectionActionsHost } from '@renderer/components/chat/SelectionActionsHost';
import type { ChatMessage, SessionEntry } from '@renderer/stores/session-types';

/**
 * 气泡宿主集成（issues #5）：mock 划选 hook（注入固定选区）+ mock
 * session-messages store，验证真实 useSelectionRun 状态机下——
 * 快捷动作/自定义 prompt 组装带引用上下文的消息走 session 发送链路、
 * Discard/Retry 按提交前消息数恢复原文。
 */

const { sendMessageSpy, removeMessagesSpy } = vi.hoisted(() => ({
  sendMessageSpy: vi.fn().mockResolvedValue(undefined),
  removeMessagesSpy: vi.fn(),
}));

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

vi.mock('@renderer/stores/session-messages', () => ({
  useSessionMessagesStore: (selector: (state: unknown) => unknown) =>
    selector({ sendMessage: sendMessageSpy, removeMessagesFrom: removeMessagesSpy }),
}));

function assistantMsg(id: string, content: string, isStreaming = false): ChatMessage {
  return { id, role: 'assistant', content, timestamp: 1, isStreaming };
}

function makeSession(messages: ChatMessage[], status: SessionEntry['status'] = 'idle'): SessionEntry {
  return {
    id: 'sess_1',
    projectId: 'proj_1',
    name: '测试会话',
    status,
    messages,
    composer: { inputMessage: '', selectedSkills: [], contextFiles: [] },
    createdAt: 0,
  };
}

beforeEach(() => {
  sendMessageSpy.mockClear();
  removeMessagesSpy.mockClear();
});

afterEach(() => {
  document.body.innerHTML = '';
});

describe('SelectionActionsHost — 气泡接入', () => {
  it('气泡内容渲染，固定选区下浮条可见并锚定', () => {
    render(
      <SelectionActionsHost session={makeSession([assistantMsg('a1', '回复')])} enabled>
        <p data-testid="bubble-content">回复正文</p>
      </SelectionActionsHost>,
    );
    expect(screen.getByTestId('bubble-content')).toBeTruthy();
    expect(screen.getByTestId('selection-bar').style.transform).toBe('translate3d(40px, 24px, 0) translateX(-50%)');
    expect(screen.getByTestId('selection-action-explain')).toBeTruthy();
  });

  it('快捷动作发送带引用上下文的消息（指令 + blockquote 引用）', () => {
    const { rerender } = render(
      <SelectionActionsHost session={makeSession([assistantMsg('a1', '回复')])} enabled>
        <p>回复正文</p>
      </SelectionActionsHost>,
    );

    fireEvent.click(screen.getByTestId('selection-action-explain'));
    expect(sendMessageSpy).toHaveBeenCalledTimes(1);
    expect(sendMessageSpy.mock.calls[0][0]).toBe(
      '请解释下面引用的这段内容\n\n> 引用自你的回复：\n> 被选中的片段',
    );

    // 会话同步 append（占位）→ thinking；落定 → result
    rerender(
      <SelectionActionsHost
        session={makeSession([
          assistantMsg('a1', '回复'),
          { id: 'u1', role: 'user', content: '引用', timestamp: 2 },
          assistantMsg('a2', '新回答'),
        ])}
        enabled
      >
        <p>回复正文</p>
      </SelectionActionsHost>,
    );
    expect(screen.getByTestId('selection-keep')).toBeTruthy();
  });

  it('自定义 prompt 作为指令原文发送', () => {
    render(
      <SelectionActionsHost session={makeSession([assistantMsg('a1', '回复')])} enabled>
        <p>回复正文</p>
      </SelectionActionsHost>,
    );
    fireEvent.change(screen.getByTestId('selection-prompt'), { target: { value: '换个说法' } });
    fireEvent.click(screen.getByTestId('selection-send'));
    expect(sendMessageSpy.mock.calls[0][0]).toBe(
      '换个说法\n\n> 引用自你的回复：\n> 被选中的片段',
    );
  });

  it('Discard 按提交前消息数移除本回合消息（恢复原文）', () => {
    const { rerender } = render(
      <SelectionActionsHost session={makeSession([assistantMsg('a1', '回复')])} enabled>
        <p>回复正文</p>
      </SelectionActionsHost>,
    );
    fireEvent.click(screen.getByTestId('selection-action-improve'));
    rerender(
      <SelectionActionsHost
        session={makeSession([
          assistantMsg('a1', '回复'),
          { id: 'u1', role: 'user', content: '引用', timestamp: 2 },
          assistantMsg('a2', '新回答'),
        ])}
        enabled
      >
        <p>回复正文</p>
      </SelectionActionsHost>,
    );
    fireEvent.click(screen.getByTestId('selection-discard'));
    expect(removeMessagesSpy).toHaveBeenCalledWith('sess_1', 1);
  });

  it('Retry 先恢复原文再重新发送同一动作', () => {
    const { rerender } = render(
      <SelectionActionsHost session={makeSession([assistantMsg('a1', '回复')])} enabled>
        <p>回复正文</p>
      </SelectionActionsHost>,
    );
    fireEvent.click(screen.getByTestId('selection-action-explain'));
    rerender(
      <SelectionActionsHost
        session={makeSession([
          assistantMsg('a1', '回复'),
          { id: 'u1', role: 'user', content: '引用', timestamp: 2 },
          assistantMsg('a2', '新回答'),
        ])}
        enabled
      >
        <p>回复正文</p>
      </SelectionActionsHost>,
    );
    fireEvent.click(screen.getByTestId('selection-retry'));
    expect(removeMessagesSpy).toHaveBeenCalledWith('sess_1', 1);
    expect(sendMessageSpy).toHaveBeenCalledTimes(2);
    expect(screen.getByTestId('selection-busy')).toBeTruthy();
  });

  it('Keep 保留会话仅关闭状态机，不删消息', () => {
    const { rerender } = render(
      <SelectionActionsHost session={makeSession([assistantMsg('a1', '回复')])} enabled>
        <p>回复正文</p>
      </SelectionActionsHost>,
    );
    fireEvent.click(screen.getByTestId('selection-action-explain'));
    rerender(
      <SelectionActionsHost
        session={makeSession([
          assistantMsg('a1', '回复'),
          { id: 'u1', role: 'user', content: '引用', timestamp: 2 },
          assistantMsg('a2', '新回答'),
        ])}
        enabled
      >
        <p>回复正文</p>
      </SelectionActionsHost>,
    );
    fireEvent.click(screen.getByTestId('selection-keep'));
    expect(removeMessagesSpy).not.toHaveBeenCalled();
    // 回 idle：动作区再次可用（mock 选区仍在）
    expect(screen.getByTestId('selection-action-explain')).toBeTruthy();
  });
});
