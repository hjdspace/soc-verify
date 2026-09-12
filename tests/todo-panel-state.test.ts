import { describe, it, expect } from 'vitest';
import {
  getLatestTodoState,
  extractTodoPhases,
  extractRpivTodoTasks,
  parseTodoItems,
} from '@renderer/components/chat/tool-helpers';
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

// ── rpiv-todo（pi 引擎 @juicesharp/rpiv-todo）格式 ──────────

function makeRpivTodoResult(tasks: Array<Record<string, unknown>>): unknown {
  return { content: [{ type: 'text', text: 'list' }], details: { action: 'list', params: {}, tasks, nextId: tasks.length + 1 } };
}

describe('rpiv-todo 格式解析（details.tasks 快照）', () => {
  it('extractRpivTodoTasks 解析扁平 Task[] 并剔除 deleted 墓碑', () => {
    const items = extractRpivTodoTasks(
      makeRpivTodoResult([
        { id: 1, subject: '调研现有方案', status: 'completed' },
        { id: 2, subject: '编写测试', status: 'in_progress' },
        { id: 3, subject: '已废弃任务', status: 'deleted' },
        { id: 4, subject: '待办任务', status: 'pending' },
      ]),
    );
    expect(items).not.toBeNull();
    expect(items).toHaveLength(3);
    expect(items![0]).toEqual({ text: '调研现有方案', status: 'completed' });
    expect(items![1].status).toBe('in_progress');
    expect(items![2].status).toBe('pending');
  });

  it('in_progress 任务优先展示 activeForm 标签', () => {
    const items = extractRpivTodoTasks(
      makeRpivTodoResult([{ id: 1, subject: '写测试', status: 'in_progress', activeForm: 'writing tests' }]),
    );
    expect(items![0].text).toBe('写测试 (writing tests)');
    expect(items![0].status).toBe('in_progress');
  });

  it('tasks 为空数组（clear）时返回空数组而非 null', () => {
    expect(extractRpivTodoTasks(makeRpivTodoResult([]))).toEqual([]);
  });

  it('omp 格式（无 details.tasks）返回 null', () => {
    expect(extractRpivTodoTasks({ details: { phases: [{ name: 'P1', tasks: [] }] } })).toBeNull();
    expect(extractRpivTodoTasks(null)).toBeNull();
  });

  it('extractTodoPhases 将 rpiv 扁平快照映射为单 phase', () => {
    const phases = extractTodoPhases(
      makeRpivTodoResult([
        { id: 1, subject: '任务A', status: 'completed' },
        { id: 2, subject: '任务B', status: 'pending' },
      ]),
    );
    expect(phases).toHaveLength(1);
    expect(phases[0].items.map((i) => i.text)).toEqual(['任务A', '任务B']);
  });

  it('getLatestTodoState 支持 rpiv 结果（面板展示 + 全部完成后随新 turn 隐藏）', () => {
    const allDone = makeRpivTodoResult([
      { id: 1, subject: '任务A', status: 'completed' },
      { id: 2, subject: '任务B', status: 'completed' },
    ]);
    const active = makeRpivTodoResult([
      { id: 1, subject: '任务A', status: 'completed' },
      { id: 2, subject: '任务B', status: 'in_progress' },
    ]);

    // 进行中 → 展示
    const messages: ChatMessage[] = [
      userMsg('开始干活', 'u1'),
      todoToolMsg(active, 't1'),
    ];
    const state = getLatestTodoState(messages);
    expect(state).not.toBeNull();
    expect(state!.phases[0].items).toHaveLength(2);
    expect(state!.isExecuting).toBe(false);

    // 全部完成 + 新 user turn → 隐藏
    const stale: ChatMessage[] = [
      userMsg('开始干活', 'u1'),
      todoToolMsg(allDone, 't1'),
      assistantMsg('完成', 'a1'),
      userMsg('下一件事', 'u2'),
    ];
    expect(getLatestTodoState(stale)).toBeNull();

    // clear（tasks 空）→ 面板隐藏
    const cleared: ChatMessage[] = [
      userMsg('开始干活', 'u1'),
      todoToolMsg(makeRpivTodoResult([]), 't1'),
    ];
    expect(getLatestTodoState(cleared)).toBeNull();
  });
});

describe('rpiv-todo 结果文本行解析（parseTodoItems 兜底）', () => {
  it('解析 list 输出的 [status] #id subject 行并剥离依赖链', () => {
    const items = parseTodoItems(
      { action: 'list' },
      '[completed] #1 调研现有方案\n[in_progress] #2 编写测试 (writing tests)\n[pending] #3 发版 ⛓ #1,#2',
    );
    expect(items).toHaveLength(3);
    expect(items[0]).toEqual({ text: '调研现有方案', status: 'completed' });
    expect(items[1]).toEqual({ text: '编写测试 (writing tests)', status: 'in_progress' });
    expect(items[2]).toEqual({ text: '发版', status: 'pending' });
  });

  it('解析 create 输出的 Created #id: subject (status) 行', () => {
    const items = parseTodoItems({ action: 'create', subject: '新任务' }, 'Created #1: 新任务 (pending)');
    expect(items).toEqual([{ text: '新任务', status: 'pending' }]);
  });

  it('deleted 墓碑行不产出条目', () => {
    const items = parseTodoItems({ action: 'list' }, '[deleted] #1 已删除\n[pending] #2 保留');
    expect(items).toEqual([{ text: '保留', status: 'pending' }]);
  });
});
