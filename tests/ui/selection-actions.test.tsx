// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import {
  SELECTION_ACTIONS,
  SelectionActions,
  splitStreamPreview,
} from '@renderer/components/ui/SelectionActions';
import type { SelectionRunRequest } from '@renderer/hooks/use-selection-run';

/**
 * 划选 AI 操作条（issues #5）：全受控 props 驱动（测试缝——不模拟真实
 * 划选、不 mock hook，直接传 phase/anchor/visible 断言渲染与按钮行为）。
 * 动画本身不做断言（PRD 测试决策 4）。
 */

const REQ_EXPLAIN: SelectionRunRequest = { action: 'explain', label: '解释', prompt: null };
const REQ_IMPROVE: SelectionRunRequest = { action: 'improve', label: '改进', prompt: null };

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
  const utils = render(<SelectionActions {...props} />);
  return { ...utils, props };
}

afterEach(() => {
  document.body.innerHTML = '';
});

describe('SelectionActions — idle 态', () => {
  it('常驻动作渲染，收进展开区的动作不渲染；点击动作回调 key', () => {
    const { props } = renderBar();
    expect(screen.getByTestId('selection-action-explain')).toBeTruthy();
    expect(screen.getByTestId('selection-action-improve')).toBeTruthy();
    expect(screen.queryByTestId('selection-action-shorten')).toBeNull();
    expect(screen.queryByTestId('selection-action-translate')).toBeNull();

    fireEvent.click(screen.getByTestId('selection-action-explain'));
    expect(props.onSelectAction).toHaveBeenCalledWith('explain');
  });

  it('展开更多动作后全部动作可见，chevron 旋转并带 aria-expanded', () => {
    renderBar();
    const expand = screen.getByTestId('selection-expand');
    expect(expand.getAttribute('aria-expanded')).toBe('false');
    fireEvent.click(expand);
    expect(expand.getAttribute('aria-expanded')).toBe('true');
    expect(screen.getByTestId('selection-action-shorten')).toBeTruthy();
    expect(screen.getByTestId('selection-action-expand')).toBeTruthy();
    expect(screen.getByTestId('selection-action-translate')).toBeTruthy();
  });

  it('自定义 prompt 输入展开发送槽位，点击发送回调 trim 后的文本', () => {
    const { props } = renderBar();
    const input = screen.getByTestId('selection-prompt') as HTMLInputElement;
    const sendSlot = screen.getByTestId('selection-send').closest('.ap-sel-slot') as HTMLElement;
    // 未输入：发送槽位塌缩不可见（maxWidth 0）
    expect(sendSlot.style.maxWidth).toBe('0px');

    fireEvent.change(input, { target: { value: '  换个说法  ' } });
    expect(sendSlot.style.maxWidth).toBe('30px');
    fireEvent.click(screen.getByTestId('selection-send'));
    expect(props.onSubmitPrompt).toHaveBeenCalledWith('换个说法');
  });

  it('prompt 输入后动作区塌缩（max-width 0），Esc 清空恢复', () => {
    renderBar();
    const input = screen.getByTestId('selection-prompt') as HTMLInputElement;
    const actionsSlot = screen.getByTestId('selection-action-explain').closest('.ap-sel-slot') as HTMLElement;
    fireEvent.change(input, { target: { value: '解释这段' } });
    expect(actionsSlot.style.maxWidth).toBe('0px');

    fireEvent.keyDown(input, { key: 'Escape' });
    expect((screen.getByTestId('selection-prompt') as HTMLInputElement).value).toBe('');
    expect(actionsSlot.style.maxWidth).toBe('196px');
  });

  it('空 prompt 提交（Enter/发送）不触发回调', () => {
    const { props } = renderBar();
    const input = screen.getByTestId('selection-prompt') as HTMLInputElement;
    fireEvent.change(input, { target: { value: '   ' } });
    fireEvent.click(screen.getByTestId('selection-send'));
    fireEvent.submit(input.closest('form')!);
    expect(props.onSubmitPrompt).not.toHaveBeenCalled();
  });

  it('锚点经 translate3d 定位并水平居中（-50%），隐藏时 opacity 0 + 禁点', () => {
    const { container } = renderBar({ anchor: { x: 120, y: 80 }, visible: false });
    const layer = container.querySelector('[data-testid="selection-bar"]') as HTMLElement;
    expect(layer.style.transform).toBe('translate3d(120px, 80px, 0) translateX(-50%)');
    expect(layer.style.opacity).toBe('0');
    expect(layer.style.pointerEvents).toBe('none');
  });

  it('mousedown 拦截所有元素（含 input，保住文档选区）', () => {
    const { container } = renderBar();
    const layer = container.querySelector('[data-testid="selection-bar"]') as HTMLElement;
    const input = screen.getByTestId('selection-prompt') as HTMLInputElement;
    const mouseEvent = (target: Element) => {
      const event = new MouseEvent('mousedown', { bubbles: true, cancelable: true });
      Object.defineProperty(event, 'target', { value: target });
      layer.dispatchEvent(event);
      return event;
    };
    // 修复后：所有元素（含 input）都 preventDefault，防止选区折叠；
    // input 点击后手动 focus（preventDefault 不影响 focus() 调用）
    expect(mouseEvent(input).defaultPrevented).toBe(true);
    expect(mouseEvent(screen.getByTestId('selection-action-explain')).defaultPrevented).toBe(true);
  });
});

describe('SelectionActions — busy 态（thinking/streaming）', () => {
  it('thinking：spinner + Shimmer busy 标签，无动作/结果按钮', () => {
    renderBar({ phase: 'thinking', request: REQ_EXPLAIN });
    expect(screen.getByTestId('selection-busy').textContent).toContain('解释中…');
    expect(screen.queryByTestId('selection-action-explain')).toBeNull();
    expect(screen.queryByTestId('selection-keep')).toBeNull();
    // busy 中的减动关闭按钮（回合照常进行的出口）
    expect(screen.getByTestId('selection-dismiss')).toBeTruthy();
  });

  it('streaming：改写型动作实时回复预览，尾缘字符数 0（禁用态）不渲染模糊尾缘', () => {
    renderBar({ phase: 'streaming', request: REQ_IMPROVE, streamText: '这是流式增长的回答正文' });
    const preview = screen.getByTestId('selection-preview');
    expect(preview.textContent).toContain('这是流式增长的回答正文');
    // tail 为空串时条件渲染跳过，无 .ap-stream-tail span
    expect(preview.querySelector('.ap-stream-tail')).toBeNull();
  });

  it('streaming：查阅型动作不在条内显示预览（由结果浮窗展示完整回复）', () => {
    renderBar({ phase: 'streaming', request: REQ_EXPLAIN, streamText: '这是流式增长的回答正文' });
    // 查阅型动作的回复在结果浮窗展示，条内不显示预览
    expect(screen.queryByTestId('selection-preview')).toBeNull();
    // 但结果浮窗已展开，展示完整流式文本
    expect(screen.getByTestId('selection-result-popover')).toBeTruthy();
    expect(screen.getByTestId('selection-popover-body').textContent).toContain('这是流式增长的回答正文');
  });

  it('streaming 无预览文本时回落 busy 标签', () => {
    renderBar({ phase: 'streaming', request: REQ_IMPROVE, streamText: '' });
    expect(screen.getByTestId('selection-busy').textContent).toContain('改进中…');
    expect(screen.queryByTestId('selection-preview')).toBeNull();
  });

  it('自定义 prompt 的 busy 标签回落「处理中」，dismiss 触发回调', () => {
    const { props } = renderBar({
      phase: 'thinking',
      request: { action: 'prompt', label: '换个说法', prompt: '换个说法' },
    });
    expect(screen.getByTestId('selection-busy').textContent).toContain('处理中…');
    fireEvent.click(screen.getByTestId('selection-dismiss'));
    expect(props.onDismiss).toHaveBeenCalled();
  });
});

describe('SelectionActions — result 态（改写型 Keep/Discard/Retry）', () => {
  it('保留/放弃/重试按钮渲染并各自回调', () => {
    const { props } = renderBar({ phase: 'result', request: REQ_IMPROVE });
    expect(screen.getByTestId('selection-keep').textContent).toContain('保留');
    expect(screen.getByTestId('selection-discard').textContent).toContain('放弃');
    expect(screen.getByTestId('selection-retry').getAttribute('aria-label')).toBe('重试改进');

    fireEvent.click(screen.getByTestId('selection-keep'));
    expect(props.onKeep).toHaveBeenCalledTimes(1);
    fireEvent.click(screen.getByTestId('selection-discard'));
    expect(props.onDiscard).toHaveBeenCalledTimes(1);
    fireEvent.click(screen.getByTestId('selection-retry'));
    expect(props.onRetry).toHaveBeenCalledTimes(1);
  });

  it('result 态不渲染 idle 动作区与 busy 指示', () => {
    renderBar({ phase: 'result', request: REQ_IMPROVE });
    expect(screen.queryByTestId('selection-busy')).toBeNull();
    expect(screen.queryByTestId('selection-prompt')).toBeNull();
    expect(screen.queryByTestId('selection-action-explain')).toBeNull();
  });
});

describe('SelectionActions — 查阅型结果浮窗（Popover）', () => {
  it('查阅型 streaming 阶段展开结果浮窗，展示完整流式文本', () => {
    renderBar({ phase: 'streaming', request: REQ_EXPLAIN, streamText: '这是完整回复内容' });
    expect(screen.getByTestId('selection-result-popover')).toBeTruthy();
    expect(screen.getByTestId('selection-popover-body').textContent).toBe('这是完整回复内容');
    // streaming 阶段显示「回复中」状态
    expect(screen.getByText('回复中')).toBeTruthy();
  });

  it('查阅型 result 阶段浮窗展示完整结果，关闭按钮触发 onDismiss', () => {
    const { props } = renderBar({ phase: 'result', request: REQ_EXPLAIN, streamText: '解释结果内容' });
    // 查阅型动作不显示 Keep/Discard/Retry
    expect(screen.queryByTestId('selection-keep')).toBeNull();
    expect(screen.queryByTestId('selection-discard')).toBeNull();
    expect(screen.queryByTestId('selection-retry')).toBeNull();
    // 浮窗展示完整结果
    expect(screen.getByTestId('selection-popover-body').textContent).toBe('解释结果内容');
    // 关闭按钮触发 dismiss
    fireEvent.click(screen.getByTestId('selection-popover-close'));
    expect(props.onDismiss).toHaveBeenCalled();
  });

  it('改写型动作不弹结果浮窗（走 Keep/Discard 回合）', () => {
    renderBar({ phase: 'result', request: REQ_IMPROVE, streamText: '改进后的内容' });
    expect(screen.queryByTestId('selection-result-popover')).toBeNull();
  });
});

describe('splitStreamPreview', () => {
  it('尾缘字符数为 0（禁用态）：settled 为整串文本，tail 恒为空串', () => {
    expect(splitStreamPreview('abcdefghij')).toEqual({ settled: 'abcdefghij', tail: '' });
    expect(splitStreamPreview('短文本')).toEqual({ settled: '短文本', tail: '' });
    expect(splitStreamPreview('')).toEqual({ settled: '', tail: '' });
  });
});
