// @vitest-environment jsdom
import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { TodoPanel } from '@renderer/components/chat/TodoPanel';
import type { TodoPhaseData, TodoItemData } from '@renderer/components/chat/tool-helpers';

// ── Helpers ─────────────────────────────────────────────

function makePhase(name: string, items: Array<{ text: string; status: TodoItemData['status'] }>): TodoPhaseData {
  return { name, items };
}

function makeItem(text: string, status: TodoItemData['status']): TodoItemData {
  return { text, status };
}

// ── 4 Todo Lists ────────────────────────────────────────

// List 1: 单阶段 — 4 pending items, 待开始状态
const todoList1_pending: TodoPhaseData[] = [
  makePhase('单阶段任务', [
    makeItem('分析需求文档', 'pending'),
    makeItem('设计数据库模型', 'pending'),
    makeItem('实现 API 接口', 'pending'),
    makeItem('编写单元测试', 'pending'),
  ]),
];

// List 2: 多阶段 — 4 phases, 模拟完成过程
const todoList2_phase1: TodoPhaseData[] = [
  makePhase('需求分析', [
    makeItem('收集用户需求', 'pending'),
    makeItem('编写 PRD', 'pending'),
  ]),
  makePhase('设计', [
    makeItem('系统架构设计', 'pending'),
    makeItem('数据库设计', 'pending'),
  ]),
  makePhase('开发', [
    makeItem('前端页面开发', 'pending'),
    makeItem('后端 API 开发', 'pending'),
    makeItem('接口联调', 'pending'),
  ]),
  makePhase('测试', [
    makeItem('功能测试', 'pending'),
    makeItem('性能测试', 'pending'),
    makeItem('回归测试', 'pending'),
  ]),
];

// 完成第一个 item
const todoList2_phase2: TodoPhaseData[] = [
  makePhase('需求分析', [
    makeItem('收集用户需求', 'completed'),
    makeItem('编写 PRD', 'in_progress'),
  ]),
  makePhase('设计', [
    makeItem('系统架构设计', 'pending'),
    makeItem('数据库设计', 'pending'),
  ]),
  makePhase('开发', [
    makeItem('前端页面开发', 'pending'),
    makeItem('后端 API 开发', 'pending'),
    makeItem('接口联调', 'pending'),
  ]),
  makePhase('测试', [
    makeItem('功能测试', 'pending'),
    makeItem('性能测试', 'pending'),
    makeItem('回归测试', 'pending'),
  ]),
];

// 完成需求分析阶段，进行到设计阶段
const todoList2_phase3: TodoPhaseData[] = [
  makePhase('需求分析', [
    makeItem('收集用户需求', 'completed'),
    makeItem('编写 PRD', 'completed'),
  ]),
  makePhase('设计', [
    makeItem('系统架构设计', 'completed'),
    makeItem('数据库设计', 'in_progress'),
  ]),
  makePhase('开发', [
    makeItem('前端页面开发', 'pending'),
    makeItem('后端 API 开发', 'pending'),
    makeItem('接口联调', 'pending'),
  ]),
  makePhase('测试', [
    makeItem('功能测试', 'pending'),
    makeItem('性能测试', 'pending'),
    makeItem('回归测试', 'pending'),
  ]),
];

// 全部完成
const todoList2_allDone: TodoPhaseData[] = [
  makePhase('需求分析', [
    makeItem('收集用户需求', 'completed'),
    makeItem('编写 PRD', 'completed'),
  ]),
  makePhase('设计', [
    makeItem('系统架构设计', 'completed'),
    makeItem('数据库设计', 'completed'),
  ]),
  makePhase('开发', [
    makeItem('前端页面开发', 'completed'),
    makeItem('后端 API 开发', 'completed'),
    makeItem('接口联调', 'completed'),
  ]),
  makePhase('测试', [
    makeItem('功能测试', 'completed'),
    makeItem('性能测试', 'completed'),
    makeItem('回归测试', 'completed'),
  ]),
];

// List 3: 混合状态 — 含 abandoned 项
const todoList3_mixed: TodoPhaseData[] = [
  makePhase('工作计划', [
    makeItem('完成报告', 'completed'),
    makeItem('团队会议', 'in_progress'),
    makeItem('代码审查', 'pending'),
    makeItem('老旧功能重构', 'abandoned'),
  ]),
];

// List 4: 单一项全部完成 — 验证 100% 状态
const todoList4_singleDone: TodoPhaseData[] = [
  makePhase('快速任务', [
    makeItem('修复登录页 Bug', 'completed'),
  ]),
];

// ── Tests ───────────────────────────────────────────────

describe('TodoPanel — 4 todo lists + completion process', () => {
  it('List 1: 单阶段全部 pending, 显示"待开始"', () => {
    render(<TodoPanel phases={todoList1_pending} isExecuting={false} collapsed={false} onToggleCollapse={vi.fn()} />);

    expect(screen.getByText('任务')).toBeInTheDocument();
    expect(screen.getByText('0/4 已完成 · 待开始')).toBeInTheDocument();

    // 4 个 pending 项
    expect(screen.getByText('分析需求文档')).toBeInTheDocument();
    expect(screen.getByText('设计数据库模型')).toBeInTheDocument();
    expect(screen.getByText('实现 API 接口')).toBeInTheDocument();
    expect(screen.getByText('编写单元测试')).toBeInTheDocument();
  });

  it('List 2: 4 阶段多阶段 todo —— 模拟完成过程', () => {
    const onToggle = vi.fn();

    // ── Step 1: 全部 pending — 待开始 ──
    const { rerender } = render(
      <TodoPanel phases={todoList2_phase1} isExecuting={false} collapsed={false} onToggleCollapse={onToggle} />,
    );

    // 4 个阶段名
    expect(screen.getByText('需求分析')).toBeInTheDocument();
    expect(screen.getByText('设计')).toBeInTheDocument();
    expect(screen.getByText('开发')).toBeInTheDocument();
    expect(screen.getByText('测试')).toBeInTheDocument();

    expect(screen.getByText('0/10 已完成 · 待开始')).toBeInTheDocument();

    // ── Step 2: 完成第一个，开始第二个 — 更新中 ──
    rerender(
      <TodoPanel phases={todoList2_phase2} isExecuting={true} collapsed={false} onToggleCollapse={onToggle} />,
    );

    expect(screen.getByText('1/10 已完成 · 更新中...')).toBeInTheDocument();

    // 已验证的项：收集用户需求 已完成（划线样式）
    const completedItem = screen.getByText('收集用户需求');
    expect(completedItem.className).toContain('line-through');
    expect(completedItem.className).toContain('text-muted-foreground/50');

    // 进行中项：编写 PRD
    const inProgressItem = screen.getByText('编写 PRD');
    expect(inProgressItem.className).toContain('font-medium');

    // ── Step 3: 完成需求分析, 设计阶段进行中 — 2 in_progress ──
    rerender(
      <TodoPanel phases={todoList2_phase3} isExecuting={false} collapsed={false} onToggleCollapse={onToggle} />,
    );

    expect(screen.getByText('3/10 已完成 · 1 项进行中')).toBeInTheDocument();

    // ── Step 4: 全部完成 ──
    rerender(
      <TodoPanel phases={todoList2_allDone} isExecuting={false} collapsed={false} onToggleCollapse={onToggle} />,
    );

    expect(screen.getByText('任务 — 全部完成')).toBeInTheDocument();
    expect(screen.getByText('10/10 已完成')).toBeInTheDocument();
  });

  it('List 3: 混合状态 — abandoned 项正确渲染', () => {
    render(<TodoPanel phases={todoList3_mixed} isExecuting={false} collapsed={false} onToggleCollapse={vi.fn()} />);

    expect(screen.getByText('1/4 已完成 · 1 项进行中')).toBeInTheDocument();

    // 已完成的项
    const doneItem = screen.getByText('完成报告');
    expect(doneItem.className).toContain('line-through');
    expect(doneItem.className).toContain('text-muted-foreground/50');

    // 进行中的项
    const inProgItem = screen.getByText('团队会议');
    expect(inProgItem.className).toContain('font-medium');

    // 废弃的项
    const abandonedItem = screen.getByText('老旧功能重构');
    expect(abandonedItem.className).toContain('line-through');
    expect(abandonedItem.className).toContain('text-muted-foreground/40');
  });

  it('List 4: 单一项完成 — 100% 全部完成状态', () => {
    render(<TodoPanel phases={todoList4_singleDone} isExecuting={false} collapsed={false} onToggleCollapse={vi.fn()} />);

    expect(screen.getByText('任务 — 全部完成')).toBeInTheDocument();
    expect(screen.getByText('1/1 已完成')).toBeInTheDocument();
  });

  it('空列表不渲染', () => {
    const { container } = render(
      <TodoPanel phases={[]} isExecuting={false} collapsed={false} onToggleCollapse={vi.fn()} />,
    );
    expect(container.innerHTML).toBe('');
  });

  it('收起/展开切换', () => {
    const onToggle = vi.fn();
    const { rerender } = render(
      <TodoPanel phases={todoList1_pending} isExecuting={false} collapsed={false} onToggleCollapse={onToggle} />,
    );

    // 展开时可见内容
    expect(screen.getByText('分析需求文档')).toBeInTheDocument();

    // 点击折叠按钮
    const collapseBtn = screen.getByTitle('折叠');
    fireEvent.click(collapseBtn);
    expect(onToggle).toHaveBeenCalledTimes(1);

    // 收起后内容隐藏
    rerender(
      <TodoPanel phases={todoList1_pending} isExecuting={false} collapsed={true} onToggleCollapse={onToggle} />,
    );
    expect(screen.queryByText('分析需求文档')).not.toBeInTheDocument();

    // 展开按钮
    const expandBtn = screen.getByTitle('展开');
    fireEvent.click(expandBtn);
    expect(onToggle).toHaveBeenCalledTimes(2);
  });

  it('单阶段不显示阶段名头', () => {
    render(<TodoPanel phases={todoList1_pending} isExecuting={false} collapsed={false} onToggleCollapse={vi.fn()} />);

    // 单阶段 — 阶段名不显示
    expect(screen.queryByText('单阶段任务')).not.toBeInTheDocument();
  });

  it('多阶段显示阶段名头', () => {
    render(<TodoPanel phases={todoList2_phase1} isExecuting={false} collapsed={false} onToggleCollapse={vi.fn()} />);

    // 多阶段 — 阶段名全部显示
    expect(screen.getByText('需求分析')).toBeInTheDocument();
    expect(screen.getByText('设计')).toBeInTheDocument();
    expect(screen.getByText('开发')).toBeInTheDocument();
    expect(screen.getByText('测试')).toBeInTheDocument();
  });
});
