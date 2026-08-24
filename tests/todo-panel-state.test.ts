import { describe, it, expect } from 'vitest';
import { getLatestTodoState } from '@renderer/components/chat/tool-helpers';
import type { ChatMessage } from '@renderer/stores/session-types';

// ── Helpers ────────────────────────────────────────────────

type TodoResultPhase = {
  name: string;
  tasks: Array<{ content: string; status: string }>;
};

function makeTodoResult(phases: TodoResultPhase[]): unknown {
  return { details: { phases } };
}

function userMsg(content: string, id?: string): ChatMessage {
  return {
    id: id ?? `user_${Date.now()}`,
    role: 'user',
    content,
    timestamp: Date.now(),
  };
}

function assistantMsg(content: string, id?: string): ChatMessage {
  return {
    id: id ?? `ai_${Date.now()}`,
    role: 'assistant',
    content,
    timestamp: Date.now(),
  };
}

function todoToolMsg(
  result: unknown,
  id?: string,
): ChatMessage {
  return {
    id: id ?? `tool_${Date.now()}`,
    role: 'tool',
    toolName: 'todo',
    toolResult: result,
    content: '',
    timestamp: Date.now(),
  };
}

// ── Tests ───────────────────────────────────────────────────

describe('getLatestTodoState', () => {
  it('returns the todo state from the latest todo tool call', () => {
    const messages: ChatMessage[] = [
      userMsg('帮我排查问题', 'u1'),
      assistantMsg('好的，我来制定排查计划', 'a1'),
      todoToolMsg(
        makeTodoResult([
          {
            name: 'Phase 1',
            tasks: [
              { content: '分析代码', status: 'completed' },
              { content: '运行测试', status: 'in_progress' },
            ],
          },
        ]),
        't1',
      ),
    ];

    const state = getLatestTodoState(messages);
    expect(state).not.toBeNull();
    expect(state!.phases).toHaveLength(1);
    expect(state!.phases[0].items).toHaveLength(2);
    expect(state!.isExecuting).toBe(false);
  });

  it('returns null when there are no todo tool calls', () => {
    const messages: ChatMessage[] = [
      userMsg('你好', 'u1'),
      assistantMsg('你好！', 'a1'),
    ];

    const state = getLatestTodoState(messages);
    expect(state).toBeNull();
  });

  // ── This is the bug ──────────────────────────────────────
  it('returns null when the latest todo is all-completed AND a new user turn has started', () => {
    // Scenario: previous turn had a todo that was all completed,
    // then the user sent a new message starting a new turn.
    // The pinned panel should NOT show the stale completed todo.
    const allDoneResult = makeTodoResult([
      {
        name: 'Phase 1',
        tasks: [
          { content: '分析代码', status: 'completed' },
          { content: '运行测试', status: 'completed' },
        ],
      },
    ]);

    const messages: ChatMessage[] = [
      // ── Turn 1 (completed) ──
      userMsg('帮我排查问题', 'u1'),
      assistantMsg('好的，我来制定排查计划', 'a1'),
      todoToolMsg(allDoneResult, 't1'),
      assistantMsg('排查完成，所有步骤已执行完毕。', 'a2'),
      // ── Turn 2 (new user message, no todo yet) ──
      userMsg('帮我做另一件事', 'u2'),
      assistantMsg('好的，我来处理', 'a3'),
    ];

    const state = getLatestTodoState(messages);
    // BUG: currently returns the stale completed todo from turn 1.
    // Expected: should return null because the todo is from a previous
    // turn that has already completed.
    expect(state).toBeNull();
  });

  it('returns the todo state when the todo is still being executed in the current turn', () => {
    const inProgressResult = makeTodoResult([
      {
        name: 'Phase 1',
        tasks: [
          { content: '分析代码', status: 'completed' },
          { content: '运行测试', status: 'in_progress' },
        ],
      },
    ]);

    const messages: ChatMessage[] = [
      userMsg('帮我排查问题', 'u1'),
      assistantMsg('好的', 'a1'),
      todoToolMsg(inProgressResult, 't1'),
      // New user message starts a new turn, but the todo is not all done
      userMsg('继续', 'u2'),
    ];

    // Even though a new user message arrived, the todo was NOT all completed,
    // so it might be relevant — but per the fix, completed-only todos from
    // a previous turn should be hidden. This test just checks behavior is
    // consistent.
    const state = getLatestTodoState(messages);
    // Since not all items are completed, the todo is still "active" and
    // should be shown (the user may have sent "继续" as part of the same
    // workflow).
    expect(state).not.toBeNull();
  });

  it('returns the todo state when a new todo init appears in the latest turn', () => {
    const allDoneResult = makeTodoResult([
      {
        name: 'Phase 1',
        tasks: [
          { content: '任务A', status: 'completed' },
        ],
      },
    ]);
    const newTodoResult = makeTodoResult([
      {
        name: 'Phase 1',
        tasks: [
          { content: '任务B', status: 'pending' },
        ],
      },
    ]);

    const messages: ChatMessage[] = [
      // Turn 1 — old todo, all done
      userMsg('帮我做A', 'u1'),
      todoToolMsg(allDoneResult, 't1'),
      assistantMsg('完成', 'a1'),
      // Turn 2 — new todo
      userMsg('帮我做B', 'u2'),
      todoToolMsg(newTodoResult, 't2'),
    ];

    const state = getLatestTodoState(messages);
    expect(state).not.toBeNull();
    expect(state!.phases[0].items[0].text).toBe('任务B');
  });
});
