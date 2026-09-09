// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import {
  AI_SELECTION_ACTIONS,
  SELECTION_ACTIONS,
  SelectionActions,
} from '@renderer/components/ui/SelectionActions';
import { SelectionActionsHost } from '@renderer/components/chat/SelectionActionsHost';
import { ComposerQuoteChips } from '@renderer/components/chat/ComposerQuoteChips';
import { useSessionCoreStore } from '@renderer/stores/session-core';
import { useSessionMessagesStore } from '@renderer/stores/session-messages';
import type { ChatMessage, SessionEntry, SessionQuote } from '@renderer/stores/session-types';

/**
 * 划选「添加到当前任务」（对话引用）链路：
 * 1. SelectionActions 浮条按钮渲染与回调；
 * 2. ComposerQuoteChips 输入框引用 chip（hover 预览 / 删除 / 只读回显）；
 * 3. session-core 的 addSelectionQuote / removeSelectionQuote；
 * 4. sendMessage 消费 quotes 组装 blockquote 发给 LLM + composer 清空；
 * 5. SelectionActionsHost 集成：点击浮条按钮写入当前会话（含文件来源标注）。
 */

vi.mock('@renderer/hooks/use-selection-anchor', () => ({
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

function assistantMsg(id: string, content: string): ChatMessage {
  return { id, role: 'assistant', content, timestamp: 1, isStreaming: false };
}

function setCoreSession(messages: ChatMessage[], composer?: Partial<SessionEntry['composer']>): SessionEntry {
  const session: SessionEntry = {
    id: SESSION_ID,
    runtimeSessionId: 'sess_rt_1',
    projectId: 'proj_1',
    cwd: '/tmp/proj',
    name: '测试会话',
    status: 'idle',
    messages,
    composer: { inputMessage: '', selectedSkills: [], contextFiles: [], quotes: [], ...composer },
    createdAt: 0,
  };
  useSessionCoreStore.setState({ sessions: [session], currentSessionId: session.id });
  return session;
}

function renderBar(overrides: Partial<Parameters<typeof SelectionActions>[0]> = {}) {
  const props: Parameters<typeof SelectionActions>[0] = {
    actions: SELECTION_ACTIONS,
    anchor: { x: 120, y: 80 },
    visible: true,
    phase: 'idle',
    request: null,
    streamText: '',
    onSelectAction: vi.fn(),
    onSubmitPrompt: vi.fn(),
    onKeep: vi.fn(),
    onDiscard: vi.fn(),
    onRetry: vi.fn(),
    onDismiss: vi.fn(),
    ...overrides,
  };
  render(<SelectionActions {...props} />);
  return props;
}

beforeEach(() => {
  vi.mocked(trpc.session.send.mutate).mockClear();
  vi.mocked(trpc.session.saveStoredMessages.mutate).mockClear();
});

afterEach(() => {
  document.body.innerHTML = '';
  useSessionCoreStore.setState({ sessions: [], currentSessionId: null });
});

describe('SelectionActions — 添加到当前任务按钮', () => {
  it('提供 onAddQuote 时渲染按钮，点击回调；未提供时不渲染', () => {
    const onAddQuote = vi.fn();
    renderBar({ onAddQuote });
    const btn = screen.getByTestId('selection-action-quote');
    expect(btn.textContent).toContain('添加到当前任务');
    fireEvent.click(btn);
    expect(onAddQuote).toHaveBeenCalledOnce();
  });

  it('未提供 onAddQuote 时不渲染按钮（默认编辑器宿主不受影响）', () => {
    renderBar();
    expect(screen.queryByTestId('selection-action-quote')).toBeNull();
  });

  it('AI_SELECTION_ACTIONS 仅含查阅型动作（解释/翻译），不含改写型', () => {
    expect(AI_SELECTION_ACTIONS.map((a) => a.key)).toEqual(['explain', 'translate']);
    expect(SELECTION_ACTIONS.map((a) => a.key)).toContain('improve');
  });

  it('showPromptInput=false（AI 气泡宿主）：输入框与发送按钮不渲染，动作与 quote 按钮可见', () => {
    renderBar({ actions: AI_SELECTION_ACTIONS, showPromptInput: false, onAddQuote: vi.fn() });
    expect(screen.queryByTestId('selection-prompt')).toBeNull();
    expect(screen.queryByTestId('selection-send')).toBeNull();
    expect(screen.getByTestId('selection-action-explain')).toBeTruthy();
    expect(screen.getByTestId('selection-action-translate')).toBeTruthy();
    expect(screen.getByTestId('selection-action-quote')).toBeTruthy();
  });

  it('仅两个常驻动作时隐藏「展开更多动作」chevron；编辑器动作集保留', () => {
    renderBar({ actions: AI_SELECTION_ACTIONS });
    expect(screen.queryByTestId('selection-expand')).toBeNull();
    // 编辑器动作集（5 个动作，2 个常驻 + 3 个折叠）仍保留 chevron
    document.body.innerHTML = '';
    renderBar();
    expect(screen.getByTestId('selection-expand')).toBeTruthy();
  });
});

describe('ComposerQuoteChips', () => {
  const quotes: SessionQuote[] = [
    { id: 'q1', text: '第一段引用内容', source: '引用自你的回复', createdAt: 1 },
    { id: 'q2', text: '第二段引用内容', source: '引用自文件 /rtl/top.sv', createdAt: 2 },
  ];

  it('渲染引用 chip，多条带序号；hover 预览展示来源与原文', () => {
    render(<ComposerQuoteChips quotes={quotes} onRemove={vi.fn()} />);
    expect(screen.getByTestId('composer-quote-chip-0').textContent).toContain('对话引用 #1');
    expect(screen.getByTestId('composer-quote-chip-1').textContent).toContain('对话引用 #2');
    expect(screen.getByTestId('composer-quote-preview-0').textContent).toContain('引用自你的回复');
    expect(screen.getByTestId('composer-quote-preview-0').textContent).toContain('第一段引用内容');
    expect(screen.getByTestId('composer-quote-preview-1').textContent).toContain('引用自文件 /rtl/top.sv');
  });

  it('点击 × 触发删除回调并携带引用 id', () => {
    const onRemove = vi.fn();
    render(<ComposerQuoteChips quotes={quotes} onRemove={onRemove} />);
    fireEvent.click(screen.getByTestId('composer-quote-remove-1'));
    expect(onRemove).toHaveBeenCalledWith('q2');
  });

  it('无 onRemove 时为只读回显（不渲染删除按钮）', () => {
    render(<ComposerQuoteChips quotes={quotes} />);
    expect(screen.queryByTestId('composer-quote-remove-0')).toBeNull();
    expect(screen.getByTestId('composer-quote-chip-0')).toBeTruthy();
  });

  it('单条引用时 chip 标签不带序号', () => {
    render(<ComposerQuoteChips quotes={[quotes[0]]} onRemove={vi.fn()} />);
    expect(screen.getByTestId('composer-quote-chip-0').textContent).toContain('1 条对话引用');
  });
});

describe('session-core — 对话引用 store 操作', () => {
  it('addSelectionQuote 写入当前会话 composer.quotes', () => {
    setCoreSession([]);
    useSessionCoreStore.getState().addSelectionQuote({ text: '引用正文', source: '引用自你的回复' });
    const quotes = useSessionCoreStore.getState().sessions[0].composer.quotes ?? [];
    expect(quotes).toHaveLength(1);
    expect(quotes[0].text).toBe('引用正文');
    expect(quotes[0].source).toBe('引用自你的回复');
    expect(quotes[0].id).toBeTruthy();
  });

  it('removeSelectionQuote 删除指定引用', () => {
    setCoreSession([], {
      quotes: [{ id: 'q1', text: 'a', source: 's', createdAt: 1 }],
    });
    useSessionCoreStore.getState().removeSelectionQuote('q1');
    expect(useSessionCoreStore.getState().sessions[0].composer.quotes).toEqual([]);
  });
});

describe('sendMessage — 对话引用组装', () => {
  it('发送时把引用组装为 blockquote 追加到消息，composer 引用清空', async () => {
    setCoreSession([assistantMsg('a1', '回复')], {
      quotes: [{ id: 'q1', text: '引用正文', source: '引用自你的回复', createdAt: 1 }],
    });
    await useSessionMessagesStore.getState().sendMessage('看看这段');
    expect(trpc.session.send.mutate).toHaveBeenCalledWith({
      sessionId: 'sess_rt_1',
      message: '看看这段\n\n> 对话引用 #1（引用自你的回复）：\n> 引用正文',
      images: undefined,
    });
    // 发送后 composer 重置，引用清空；用户消息挂 quotes 供气泡回显
    const session = useSessionCoreStore.getState().sessions[0];
    expect(session.composer.quotes).toEqual([]);
    const userMsg = session.messages.find((m) => m.role === 'user');
    expect(userMsg?.quotes).toHaveLength(1);
  });

  it('仅引用无正文也允许发送（引用内容即消息主体）', async () => {
    setCoreSession([assistantMsg('a1', '回复')], {
      quotes: [{ id: 'q1', text: '只有引用', source: '引用自文件 /rtl/top.sv', createdAt: 1 }],
    });
    await useSessionMessagesStore.getState().sendMessage('');
    expect(trpc.session.send.mutate).toHaveBeenCalledWith({
      sessionId: 'sess_rt_1',
      message: '\n\n> 对话引用 #1（引用自文件 /rtl/top.sv）：\n> 只有引用',
      images: undefined,
    });
  });

  it('多行引用逐行加 blockquote 前缀', async () => {
    setCoreSession([assistantMsg('a1', '回复')], {
      quotes: [{ id: 'q1', text: '第一行\n第二行', source: '引用自你的回复', createdAt: 1 }],
    });
    await useSessionMessagesStore.getState().sendMessage('q');
    expect(trpc.session.send.mutate).toHaveBeenCalledWith({
      sessionId: 'sess_rt_1',
      message: 'q\n\n> 对话引用 #1（引用自你的回复）：\n> 第一行\n> 第二行',
      images: undefined,
    });
  });

  it('无正文无引用时仍不发送', async () => {
    setCoreSession([assistantMsg('a1', '回复')]);
    await useSessionMessagesStore.getState().sendMessage('   ');
    expect(trpc.session.send.mutate).not.toHaveBeenCalled();
  });
});

describe('SelectionActionsHost — 添加到当前任务集成', () => {
  it('气泡宿主点击按钮：选区写入当前会话 composer.quotes（来源标注「引用自你的回复」）', () => {
    const session = setCoreSession([assistantMsg('a1', '回复')]);
    render(
      <SelectionActionsHost session={session} enabled actions={AI_SELECTION_ACTIONS}>
        <p>回复正文</p>
      </SelectionActionsHost>,
    );
    fireEvent.click(screen.getByTestId('selection-action-quote'));
    const quotes = useSessionCoreStore.getState().sessions[0].composer.quotes ?? [];
    expect(quotes).toHaveLength(1);
    expect(quotes[0].text).toBe('被选中的片段');
    expect(quotes[0].source).toBe('引用自你的回复');
  });

  it('文件宿主点击按钮：来源标注为「引用自文件 <path>」', () => {
    setCoreSession([assistantMsg('a1', '回复')]);
    render(
      <SelectionActionsHost source={{ kind: 'file', path: '/rtl/top.sv' }} enabled>
        <p>文件内容</p>
      </SelectionActionsHost>,
    );
    fireEvent.click(screen.getByTestId('selection-action-quote'));
    const quotes = useSessionCoreStore.getState().sessions[0].composer.quotes ?? [];
    expect(quotes[0].source).toBe('引用自文件 /rtl/top.sv');
  });

  it('无会话时不渲染添加按钮（划选监听同样禁用）', () => {
    useSessionCoreStore.setState({ sessions: [], currentSessionId: null });
    render(
      <SelectionActionsHost enabled>
        <p>内容</p>
      </SelectionActionsHost>,
    );
    expect(screen.queryByTestId('selection-action-quote')).toBeNull();
  });
});
