// @vitest-environment jsdom
/**
 * 已落定 Markdown 的内容级元素缓存（settledCache）回归测试。
 *
 * 背景：切 tab 时消息列整列卸载重挂，react-markdown 对已落定内容每次
 * 重新 parse（单条 5.5KB 消息 ~430ms，是 tab 切换卡顿的主要剩余成分）。
 * 缓存策略：仅「非 streaming 且无 onUriClick 且 ≥256 字节」的输入走
 * 模块级 LRU（上限 100 条）；streaming / onUriClick 路径必须绕过缓存。
 */
import { describe, expect, it, vi } from 'vitest';
import { render } from '@testing-library/react';

vi.mock('@renderer/lib/trpc', () => ({
  trpc: {
    system: {
      openExternal: { mutate: vi.fn() },
    },
  },
}));

vi.mock('@renderer/stores/diff-review', () => ({
  openReviewAwareFile: vi.fn(),
}));

vi.mock('@renderer/components/chat/MermaidDiagram', () => ({
  MermaidDiagram: ({ code }: { code: string }) => <div data-testid="mermaid-stub">{code}</div>,
}));

import {
  MarkdownRenderer,
  getSettledMarkdownCacheStats,
  clearSettledMarkdownCache,
} from '@renderer/components/chat/MarkdownRenderer';

// ≥256 字节：满足缓存门槛的已落定内容（表格 + 段落 + 文件引用）
const LONG_SETTLED = [
  '## 审查报告',
  '',
  '| 模块 | 状态 | 说明 |',
  '| --- | --- | --- |',
  '| main | 通过 | 窗口管理正常 |',
  '| renderer | 通过 | React SPA 正常 |',
  '| preload | 通过 | contextBridge 正常 |',
  '| ipc | 通过 | tRPC router 正常 |',
  '| scm | 通过 | 源码面板正常 |',
  '| coverage | 通过 | 覆盖率正常 |',
  '| simulation | 通过 | 仿真控制正常 |',
  '| token | 通过 | 监控正常 |',
  '',
  '详见 src/main/foo.sv:42 的实现与 tests/tb_top.v:100-105。',
  '',
  '以上审查项均已逐条验证，结论为整体通过，可进入下一阶段联调。',
].join('\n');

// <256 字节：短内容刻意不走缓存（parse 成本低，不值得占缓存槽）
const SHORT_SETTLED = '好的，让我先浏览一下项目的整体结构，再深入查看关键文件。';

describe('MarkdownRenderer 已落定内容元素缓存', () => {
  it('同内容二次挂载命中缓存，且内容渲染不受缓存影响', () => {
    clearSettledMarkdownCache();
    const { unmount } = render(<MarkdownRenderer content={LONG_SETTLED} />);
    unmount();

    const { container } = render(<MarkdownRenderer content={LONG_SETTLED} />);
    const stats = getSettledMarkdownCacheStats();
    expect(stats.misses).toBe(1);
    expect(stats.hits).toBe(1);
    expect(stats.size).toBe(1);

    // 缓存命中后渲染结果与直连 ReactMarkdown 一致：结构 + chip 化文件引用
    expect(container.querySelector('h2')?.textContent).toContain('审查报告');
    expect(container.querySelectorAll('table tr').length).toBe(9);
    const chip = container.querySelector('button.ap-chip');
    expect(chip?.textContent).toContain('src/main/foo.sv');
    unmount();
  });

  it('streaming 内容绕过缓存（不写入、不命中）', () => {
    clearSettledMarkdownCache();
    const { unmount } = render(<MarkdownRenderer content={LONG_SETTLED} streaming />);
    expect(getSettledMarkdownCacheStats().size).toBe(0);
    unmount();

    render(<MarkdownRenderer content={LONG_SETTLED} streaming />);
    expect(getSettledMarkdownCacheStats().size).toBe(0);
    unmount();
  });

  it('onUriClick 路径绕过缓存（不写入）', () => {
    clearSettledMarkdownCache();
    const { unmount } = render(
      <MarkdownRenderer content={LONG_SETTLED} onUriClick={() => undefined} />,
    );
    expect(getSettledMarkdownCacheStats().size).toBe(0);
    unmount();
  });

  it('短内容（<256 字节）不走缓存', () => {
    clearSettledMarkdownCache();
    const { container, unmount } = render(<MarkdownRenderer content={SHORT_SETTLED} />);
    expect(container.querySelector('p')?.textContent).toContain('整体结构');
    expect(getSettledMarkdownCacheStats().size).toBe(0);
    unmount();
  });

  it('LRU 上限 100 条：写入超限后逐出最旧条目', () => {
    clearSettledMarkdownCache();
    const { unmount } = render(
      <div>
        {Array.from({ length: 105 }, (_, i) => (
          <MarkdownRenderer key={i} content={`${LONG_SETTLED} 唯一序号 ${i}`} />
        ))}
      </div>,
    );
    const stats = getSettledMarkdownCacheStats();
    expect(stats.size).toBe(100);
    // 最旧的 5 条被逐出，最新的第 105 条仍在缓存中
    expect(stats.misses).toBe(105);
    unmount();

    const { container } = render(<MarkdownRenderer content={`${LONG_SETTLED} 唯一序号 104`} />);
    expect(getSettledMarkdownCacheStats().hits).toBe(1);
    expect(container.textContent).toContain('唯一序号 104');
    unmount();
  });

  it('LRU 命中会刷新条目热度：触碰过的条目后插入仍逐出（99 条内存活）', () => {
    clearSettledMarkdownCache();
    const { unmount: u0 } = render(<MarkdownRenderer content={`${LONG_SETTLED} 热点条目`} />);
    u0();
    expect(getSettledMarkdownCacheStats().size).toBe(1);

    // 再插 99 条新内容：缓存 100 条未满，热点条目存活且可命中
    const { unmount: u1 } = render(
      <div>
        {Array.from({ length: 99 }, (_, i) => (
          <MarkdownRenderer key={i} content={`${LONG_SETTLED} 填充 ${i}`} />
        ))}
      </div>,
    );
    u1();

    const { container, unmount } = render(<MarkdownRenderer content={`${LONG_SETTLED} 热点条目`} />);
    expect(getSettledMarkdownCacheStats().hits).toBe(1);
    expect(container.textContent).toContain('热点条目');
    unmount();
  });

  it('缓存命中的元素树跨挂载点正常挂载（SelectionActions 划选场景）', () => {
    clearSettledMarkdownCache();
    const { unmount: u1 } = render(<MarkdownRenderer content={LONG_SETTLED} />);
    u1();

    // 同一棵缓存元素树渲染进两个并行挂载点（如划选预览 + 消息气泡）
    const { container, unmount } = render(
      <div>
        <div data-testid="mount-a"><MarkdownRenderer content={LONG_SETTLED} /></div>
        <div data-testid="mount-b"><MarkdownRenderer content={LONG_SETTLED} /></div>
      </div>,
    );
    const a = container.querySelector('[data-testid="mount-a"]');
    const b = container.querySelector('[data-testid="mount-b"]');
    expect(a?.querySelectorAll('tr').length).toBe(9);
    expect(b?.querySelectorAll('tr').length).toBe(9);
    // 命中两次（A、B 两个挂载点各一次）
    expect(getSettledMarkdownCacheStats().hits).toBe(2);
    unmount();
  });
});
