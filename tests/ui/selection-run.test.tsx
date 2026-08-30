// @vitest-environment jsdom
import { describe, it, expect, vi } from 'vitest';
import { act, renderHook } from '@testing-library/react';
import { useSelectionRun, type SelectionRunRequest } from '@renderer/hooks/use-selection-run';
import type { ChatMessage, SessionEntry } from '@renderer/stores/session-types';

/**
 * 划选回合状态机（issues #5）：假 session 对象直接驱动 phase 派生
 * （thinking → streaming → result）、result 锁存与 Keep/Discard/Retry/
 * dismiss 行为，不 mock store。
 */

const REQ: SelectionRunRequest = { action: 'explain', label: '解释', prompt: null };

function userMsg(content: string): ChatMessage {
  return { id: `u_${content}`, role: 'user', content, timestamp: 1 };
}

function assistantMsg(overrides: Partial<ChatMessage> & { id: string }): ChatMessage {
  return { role: 'assistant', content: '', timestamp: 2, ...overrides };
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

const OLD_REPLY = assistantMsg({ id: 'a_old', content: '旧的回复' });

describe('useSelectionRun 状态机', () => {
  it('run → thinking，且动作经 onSubmit 提交', () => {
    const onSubmit = vi.fn();
    const { result } = renderHook(() =>
      useSelectionRun({ session: makeSession([OLD_REPLY]), onSubmit }),
    );
    expect(result.current.phase).toBe('idle');

    act(() => result.current.run(REQ));
    expect(result.current.phase).toBe('thinking');
    expect(result.current.request).toEqual(REQ);
    expect(onSubmit).toHaveBeenCalledWith(REQ);
    expect(result.current.streamText).toBe('');
  });

  it('回合回复出现首字后 thinking → streaming，streamText 跟随实时内容', () => {
    const onSubmit = vi.fn();
    const { result, rerender } = renderHook(
      ({ session }) => useSelectionRun({ session, onSubmit }),
      { initialProps: { session: makeSession([OLD_REPLY]) } },
    );
    act(() => result.current.run(REQ));

    // onSubmit 后会话同步 append：user 消息 + 空流式 assistant 占位
    rerender({
      session: makeSession([
        OLD_REPLY,
        userMsg('引用'),
        assistantMsg({ id: 'a_new', isStreaming: true }),
      ], 'streaming'),
    });
    expect(result.current.phase).toBe('thinking');

    // 首字落地
    rerender({
      session: makeSession([
        OLD_REPLY,
        userMsg('引用'),
        assistantMsg({ id: 'a_new', isStreaming: true, content: '部分回答' }),
      ], 'streaming'),
    });
    expect(result.current.phase).toBe('streaming');
    expect(result.current.streamText).toBe('部分回答');
  });

  it('回合落定（status idle + 占位收尾 + 无 pending 工具）→ result', () => {
    const onSubmit = vi.fn();
    const { result, rerender } = renderHook(
      ({ session }) => useSelectionRun({ session, onSubmit }),
      { initialProps: { session: makeSession([OLD_REPLY]) } },
    );
    act(() => result.current.run(REQ));
    rerender({
      session: makeSession([
        OLD_REPLY,
        userMsg('引用'),
        assistantMsg({ id: 'a_new', isStreaming: true, content: '流式中' }),
      ], 'streaming'),
    });
    expect(result.current.phase).toBe('streaming');

    rerender({
      session: makeSession([
        OLD_REPLY,
        userMsg('引用'),
        assistantMsg({ id: 'a_new', content: '完整回答' }),
      ]),
    });
    expect(result.current.phase).toBe('result');
    expect(result.current.streamText).toBe('完整回答');
  });

  it('result 锁存：回合结束后用户手动发起新回合，不会把浮条拖回 busy', () => {
    const onSubmit = vi.fn();
    const { result, rerender } = renderHook(
      ({ session }) => useSelectionRun({ session, onSubmit }),
      { initialProps: { session: makeSession([OLD_REPLY]) } },
    );
    act(() => result.current.run(REQ));
    rerender({
      session: makeSession([
        OLD_REPLY,
        userMsg('引用'),
        assistantMsg({ id: 'a_new', content: '完整回答' }),
      ]),
    });
    expect(result.current.phase).toBe('result');

    // 手动新回合：status streaming + 新的流式 assistant
    rerender({
      session: makeSession([
        OLD_REPLY,
        userMsg('引用'),
        assistantMsg({ id: 'a_new', content: '完整回答' }),
        userMsg('下一个问题'),
        assistantMsg({ id: 'a_manual', isStreaming: true, content: '正在回答' }),
      ], 'streaming'),
    });
    expect(result.current.phase).toBe('result');
  });

  it('回合仍在执行工具（pending tool）时不落定', () => {
    const onSubmit = vi.fn();
    const { result, rerender } = renderHook(
      ({ session }) => useSelectionRun({ session, onSubmit }),
      { initialProps: { session: makeSession([OLD_REPLY]) } },
    );
    act(() => result.current.run(REQ));
    rerender({
      session: makeSession([
        OLD_REPLY,
        userMsg('引用'),
        assistantMsg({ id: 'a_new', content: '回答' }),
        { id: 't_1', role: 'tool', content: '', timestamp: 3, toolName: 'read' },
      ]),
    });
    // tool 未带 toolResult 且 status 已回 idle（事件间隙）→ 不判 result
    expect(result.current.phase).toBe('streaming');
  });

  it('历史回合 abort 遗留的 pending tool 不卡死新回合落定（扫描只看本回合）', () => {
    const onSubmit = vi.fn();
    // 更早的回合被 abort：tool 消息永远没有 toolResult（agent_end 不回填）
    const pendingTool: ChatMessage = { id: 't_old', role: 'tool', content: '', timestamp: 3, toolName: 'read' };
    const { result, rerender } = renderHook(
      ({ session }) => useSelectionRun({ session, onSubmit }),
      { initialProps: { session: makeSession([userMsg('第一问'), pendingTool, OLD_REPLY]) } },
    );
    act(() => result.current.run(REQ));
    rerender({
      session: makeSession([
        userMsg('第一问'),
        pendingTool,
        OLD_REPLY,
        userMsg('引用'),
        assistantMsg({ id: 'a_new', content: '新回答' }),
      ]),
    });
    expect(result.current.phase).toBe('result');
  });

  it('keep 回 idle，不触发 onCancel', () => {
    const onSubmit = vi.fn();
    const onCancel = vi.fn();
    const { result, rerender } = renderHook(
      ({ session }) => useSelectionRun({ session, onSubmit, onCancel }),
      { initialProps: { session: makeSession([OLD_REPLY]) } },
    );
    act(() => result.current.run(REQ));
    rerender({
      session: makeSession([OLD_REPLY, userMsg('引用'), assistantMsg({ id: 'a_new', content: '回答' })]),
    });
    act(() => result.current.keep());
    expect(result.current.phase).toBe('idle');
    expect(result.current.request).toBeNull();
    expect(onCancel).not.toHaveBeenCalled();
  });

  it('discard 触发 onCancel（恢复原文）并回 idle', () => {
    const onSubmit = vi.fn();
    const onCancel = vi.fn();
    const { result } = renderHook(() =>
      useSelectionRun({ session: makeSession([OLD_REPLY]), onSubmit, onCancel }),
    );
    act(() => result.current.run(REQ));
    act(() => result.current.discard());
    expect(onCancel).toHaveBeenCalledTimes(1);
    expect(result.current.phase).toBe('idle');
  });

  it('retry 先 onCancel 恢复原文再重新提交，回到 thinking', () => {
    const onSubmit = vi.fn();
    const onCancel = vi.fn();
    const { result, rerender } = renderHook(
      ({ session }) => useSelectionRun({ session, onSubmit, onCancel }),
      { initialProps: { session: makeSession([OLD_REPLY]) } },
    );
    act(() => result.current.run(REQ));
    rerender({
      session: makeSession([OLD_REPLY, userMsg('引用'), assistantMsg({ id: 'a_new', content: '回答' })]),
    });
    expect(result.current.phase).toBe('result');

    act(() => result.current.retry());
    expect(onCancel).toHaveBeenCalledTimes(1);
    expect(onSubmit).toHaveBeenCalledTimes(2);
    expect(result.current.phase).toBe('thinking');

    // 重试后的新回合（新消息 id）照常推进
    rerender({
      session: makeSession([OLD_REPLY, assistantMsg({ id: 'a_retry', isStreaming: true, content: '重试回答' })], 'streaming'),
    });
    expect(result.current.phase).toBe('streaming');
  });

  it('dismiss 在 busy 中脱离：回 idle 且不触发 onCancel（回合照常进行）', () => {
    const onSubmit = vi.fn();
    const onCancel = vi.fn();
    const { result } = renderHook(() =>
      useSelectionRun({ session: makeSession([OLD_REPLY]), onSubmit, onCancel }),
    );
    act(() => result.current.run(REQ));
    act(() => result.current.dismiss());
    expect(result.current.phase).toBe('idle');
    expect(onCancel).not.toHaveBeenCalled();
  });

  it('自定义 prompt 动作同样走完整状态机', () => {
    const onSubmit = vi.fn();
    const { result } = renderHook(() =>
      useSelectionRun({ session: makeSession([OLD_REPLY]), onSubmit }),
    );
    const promptReq: SelectionRunRequest = { action: 'prompt', label: '换个说法', prompt: '换个说法' };
    act(() => result.current.run(promptReq));
    expect(result.current.phase).toBe('thinking');
    expect(onSubmit).toHaveBeenCalledWith(promptReq);
  });
});
