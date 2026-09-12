// @vitest-environment jsdom
import { describe, it, expect } from 'vitest';
import { createElement } from 'react';
import { render, screen } from '@testing-library/react';
import { AskBody } from '@renderer/components/chat/tool-bodies/interactive/AskBody';

/** 选中态选项带 font-medium + text-foreground，未选中为 text-muted-foreground。 */
function isSelected(label: string): boolean {
  const el = screen.getByText(label);
  return el.className.includes('text-foreground') && el.className.includes('font-medium');
}

const singleQuestionArgs = {
  questions: [
    { id: 'q1', question: '选择实现方案', options: [{ label: '方案 A' }, { label: '方案 B' }] },
  ],
};

describe('AskBody 答案回显', () => {
  it('单问题：User selected 格式回显选中项（不显示"无答案"）', () => {
    render(
      createElement(AskBody, {
        args: singleQuestionArgs,
        resultText: 'User selected: 方案 A',
      }),
    );
    expect(isSelected('方案 A')).toBe(true);
    expect(isSelected('方案 B')).toBe(false);
    expect(screen.queryByText('(无答案)')).toBeNull();
  });

  it('单问题多选：逗号分隔的 User selected 回显全部选中项', () => {
    const args = {
      questions: [
        {
          id: 'q1',
          question: '启用哪些检查?',
          multi: true,
          options: [{ label: 'lint' }, { label: 'typecheck' }, { label: 'test' }],
        },
      ],
    };
    render(
      createElement(AskBody, {
        args,
        resultText: 'User selected: lint, typecheck',
      }),
    );
    expect(isSelected('lint')).toBe(true);
    expect(isSelected('typecheck')).toBe(true);
    expect(isSelected('test')).toBe(false);
    expect(screen.queryByText('(无答案)')).toBeNull();
  });

  it('单问题：User provided custom input 格式回显自定义答案', () => {
    render(
      createElement(AskBody, {
        args: singleQuestionArgs,
        resultText: 'User provided custom input: 用方案 A 但去掉缓存层',
      }),
    );
    expect(screen.getByText('用方案 A 但去掉缓存层')).not.toBeNull();
    expect(screen.queryByText('(无答案)')).toBeNull();
  });

  it('单问题：多行自定义输入回显完整内容（去缩进）', () => {
    render(
      createElement(AskBody, {
        args: singleQuestionArgs,
        resultText: 'User provided custom input:\n  第一行意见\n  第二行意见',
      }),
    );
    expect(screen.getByText(/第一行意见/)).not.toBeNull();
    expect(screen.queryByText('(无答案)')).toBeNull();
  });

  it('多问题：User answers 逐题回显选中/自定义答案', () => {
    const args = {
      questions: [
        { id: 'q1', question: 'Q1', options: [{ label: '甲' }, { label: '乙' }] },
        { id: 'q2', question: 'Q2', options: [{ label: '丙' }, { label: '丁' }] },
      ],
    };
    render(
      createElement(AskBody, {
        args,
        resultText: 'User answers:\nq1: 甲\nq2: "自定义内容"',
      }),
    );
    expect(isSelected('甲')).toBe(true);
    expect(isSelected('乙')).toBe(false);
    expect(isSelected('丙')).toBe(false);
    expect(isSelected('丁')).toBe(false);
    expect(screen.getByText('自定义内容')).not.toBeNull();
    expect(screen.queryByText('(无答案)')).toBeNull();
  });

  it('多问题：[a, b] 括号格式回显多选题', () => {
    const args = {
      questions: [
        { id: 'q1', question: 'Q1', options: [{ label: 'x' }, { label: 'y' }, { label: 'z' }] },
        { id: 'q2', question: 'Q2', options: [{ label: 'p' }, { label: 'q' }] },
      ],
    };
    render(
      createElement(AskBody, {
        args,
        resultText: 'User answers:\nq1: [x, z]\nq2: p',
      }),
    );
    expect(isSelected('x')).toBe(true);
    expect(isSelected('z')).toBe(true);
    expect(isSelected('y')).toBe(false);
    expect(isSelected('p')).toBe(true);
    expect(isSelected('q')).toBe(false);
    expect(screen.queryByText('(无答案)')).toBeNull();
  });

  it('多行自定义输入（id 引号格式跨行）不破坏后续题目解析', () => {
    const args = {
      questions: [
        { id: 'q1', question: 'Q1', options: [{ label: '甲' }, { label: '乙' }] },
        { id: 'q2', question: 'Q2', options: [{ label: '丙' }, { label: '丁' }] },
      ],
    };
    render(
      createElement(AskBody, {
        args,
        resultText: 'User answers:\nq1: "第一行\n第二行"\nq2: 丁',
      }),
    );
    expect(screen.getByText(/第一行/)).not.toBeNull();
    expect(isSelected('丁')).toBe(true);
    expect(screen.queryByText('(无答案)')).toBeNull();
  });

  it('id 含正则特殊字符时正常解析且不抛异常', () => {
    const args = {
      questions: [
        { id: 'q.1*', question: 'Q1', options: [{ label: '甲' }, { label: '乙' }] },
        { id: 'q(2)', question: 'Q2', options: [{ label: '丙' }, { label: '丁' }] },
      ],
    };
    expect(() =>
      render(
        createElement(AskBody, {
          args,
          resultText: 'User answers:\nq.1*: 甲\nq(2): 丁',
        }),
      ),
    ).not.toThrow();
    expect(isSelected('甲')).toBe(true);
    expect(isSelected('丁')).toBe(true);
  });

  it('未回答的题目显示(无答案)，已回答的不显示', () => {
    const args = {
      questions: [
        { id: 'q1', question: 'Q1', options: [{ label: '甲' }, { label: '乙' }] },
        { id: 'q2', question: 'Q2', options: [{ label: '丙' }, { label: '丁' }] },
      ],
    };
    render(
      createElement(AskBody, {
        args,
        resultText: 'User answers:\nq1: 甲',
      }),
    );
    expect(isSelected('甲')).toBe(true);
    expect(screen.getByText('(无答案)')).not.toBeNull();
  });

  it('legacy 参数格式（顶层 question/options）仍可解析 User selected', () => {
    const args = { question: '选择', options: [{ label: '方案 A' }, { label: '方案 B' }] };
    render(createElement(AskBody, { args, resultText: 'User selected: 方案 B' }));
    expect(isSelected('方案 B')).toBe(true);
    expect(isSelected('方案 A')).toBe(false);
    expect(screen.queryByText('(无答案)')).toBeNull();
  });
});
