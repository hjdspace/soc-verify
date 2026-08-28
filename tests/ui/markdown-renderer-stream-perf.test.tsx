// @vitest-environment jsdom
// MarkdownRenderer 流式渲染性能回归：
//
// 流式快照约 50ms 一次，历史实现对增长中的代码块每个快照都全量重高亮
// （未知语言还会触发 highlightAuto 全语言探测），实测 22ms/快照、峰值
// 256ms，主线程卡顿导致模糊尾缘长时间停留在模糊态。修复约定：
//
// 1. 流式期间代码块渲染实时纯文本，不做同步高亮（已知语言由
//    useDeferredCodeHighlight 每 300ms 节流补算着色；未知语言跳过）
// 2. 落定（streaming=false）后一次性同步全量高亮（含自动检测）
// 3. 每快照渲染耗时保持在帧预算内（宽松断言，防 O(n²) 回归）
import { describe, expect, it, vi, beforeEach } from 'vitest';
import { render, act } from '@testing-library/react';

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

import hljs from 'highlight.js';
import { MarkdownRenderer } from '@renderer/components/chat/MarkdownRenderer';

// ── 模拟真实助手答复文档 ──────────────────────────────────────────────

const PROSE_DOC = [
  '## 验证方案分析',
  '',
  '针对当前的 testbench 结构，我建议从以下几个方面入手排查问题。首先需要确认 clocking block 的采样时序是否与 DUT 的输出延迟匹配，',
  '这是 UVM 环境中最常见的 timeout 根因之一。',
  '',
  '### 1. 时序检查',
  '',
  '`tb_top.sv` 中的时钟产生逻辑使用了 `#1ns` 延迟，而 interface 中的 clocking block 配置了 `default input #1step`，',
  '这意味着采样点位于时钟沿之前的最后一个 delta cycle。如果 DUT 输出使用了非阻塞赋值，采样值将是**旧值**，导致 scoreboard 比对失败。',
  '',
  '- [建议] 将 clocking block 的 skew 显式声明为 `input #1step output #0`',
  '- [建议] 在 `driver.sv:42` 处增加 `$display` 打印实际驱动时间',
  '- [注意] `monitor` 组件必须在 `run_phase` 中使用 `@(vif.cb)` 而不是 `@(posedge vif.clk)`',
  '',
  '### 2. 覆盖率收集策略',
  '',
  '当前 covergroup 的采样时机在 `write()` 方法中触发，这会遗漏 `idle→busy` 的边界场景：',
  '',
  '| 场景 | 当前覆盖 | 目标覆盖 |',
  '| ---- | -------- | -------- |',
  '| idle 突发 | 62% | 90% |',
  '| back-to-back | 45% | 85% |',
  '| 异常终止 | 0% | 70% |',
  '',
  '### 3. 随机约束优化',
  '',
  '约束求解器在 `pkt_len` 分布上花费了大量时间，建议将 `solve pkt_len before pkt_type` 改为显式分层：',
  '',
  '1. 短包（64B）占比 30%',
  '2. 标准包（512B）占比 50%',
  '3. 长包（1500B）占比 20%',
  '',
  '如果需要，我可以进一步生成对应的 `uvm_sequence` 骨架代码，或者先查看 `tests/tb_top.v:100-105` 的现有实现。以上建议均基于 `case:///run/123/main.log` 中的失败日志分析。',
].join('\n');

const TREE_LINES = Array.from({ length: 50 }, (_, i) =>
  `│   ├── module_${i}.sv                        # 子模块 ${i}：负责数据通路第 ${i} 级流水`,
);

const TS_LINES = [
  'class axi_master_seq extends uvm_sequence #(axi_item);',
  '  `uvm_object_utils(axi_master_seq)',
  '',
  '  rand int unsigned burst_len;',
  '  constraint c_burst { burst_len inside { [1:16] }; }',
  '',
  '  task body();',
  '    repeat (100) begin',
  '      `uvm_do_with(req, { addr inside { [0:64\'hFFFF] }; })',
  '      get_response(rsp);',
  '      assert (rsp.status == OKAY)',
  '        else `uvm_error("SEQ", $sformatf("bad status %0d", rsp.status))',
  '    end',
  '  endtask',
  'endclass',
];

const CODE_DOC = [
  '### 项目架构总览',
  '',
  '这是一个大型验证环境，目录结构如下（注意 `dv/` 与 `de/` 的分层）：',
  '',
  '```',
  'soc-verify/',
  ...TREE_LINES,
  '└── tests/                        # 测试套件',
  '```',
  '',
  '其中参考序列的定义如下，注意 `uvm_do_with` 的约束写法：',
  '',
  '```typescript',
  ...TS_LINES,
  '```',
  '',
  '以上结构中，每个 `module_*.sv` 都需要对应的 agent 与 scoreboard，',
  '建议按 `case:///run/123/main.log` 中的失败顺序逐个排查。',
].join('\n');

// ── 工具 ─────────────────────────────────────────────────────────────

type HljsCounts = { highlight: number; highlightAuto: number };

/** 替换 hljs.highlight / highlightAuto 以统计调用次数；返回计数器与恢复函数。 */
function spyHljsCounts(): { counts: HljsCounts; restore: () => void } {
  const counts: HljsCounts = { highlight: 0, highlightAuto: 0 };
  const origHighlight = hljs.highlight.bind(hljs);
  const origAuto = hljs.highlightAuto.bind(hljs);
  (hljs as { highlight: unknown }).highlight = (...args: Parameters<typeof hljs.highlight>) => {
    counts.highlight++;
    return origHighlight(...args);
  };
  (hljs as { highlightAuto: unknown }).highlightAuto = (
    ...args: Parameters<typeof hljs.highlightAuto>
  ) => {
    counts.highlightAuto++;
    return origAuto(...args);
  };
  return {
    counts,
    restore: () => {
      (hljs as { highlight: typeof hljs.highlight }).highlight = origHighlight;
      (hljs as { highlightAuto: typeof hljs.highlightAuto }).highlightAuto = origAuto;
    },
  };
}

function pct(arr: number[], p: number): number {
  const sorted = [...arr].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.floor((sorted.length * p) / 100))];
}

function mean(arr: number[]): number {
  return arr.reduce((x, y) => x + y, 0) / arr.length;
}

/** 模拟 token 流：内容按 chunkChars 逐步增长，每步同步重渲，返回每快照耗时。 */
function simulateStreaming(doc: string, chunkChars: number): number[] {
  const perUpdateMs: number[] = [];
  const view = render(<MarkdownRenderer content="" streaming />);
  try {
    for (let end = chunkChars; end < doc.length + chunkChars; end += chunkChars) {
      const t0 = performance.now();
      view.rerender(<MarkdownRenderer content={doc.slice(0, end)} streaming />);
      perUpdateMs.push(performance.now() - t0);
    }
  } finally {
    view.unmount();
  }
  return perUpdateMs;
}

const allCodeBlocks = (container: HTMLElement): HTMLElement[] =>
  Array.from(container.querySelectorAll('code.hljs'));

// ── 测试 ─────────────────────────────────────────────────────────────

describe('MarkdownRenderer 流式渲染性能回归', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('流式期间不做同步代码高亮（含未知语言不触发 highlightAuto）', () => {
    const { counts, restore } = spyHljsCounts();
    try {
      // 修复前：highlight 63 次 + highlightAuto 55 次（每快照全量重跑增长中的代码块）
      simulateStreaming(CODE_DOC, 64);
      expect(counts.highlight).toBe(0);
      expect(counts.highlightAuto).toBe(0);
    } finally {
      restore();
    }
  });

  it('流式期间代码块渲染实时纯文本（无着色 span），落定后一次性全量高亮', () => {
    const { restore } = spyHljsCounts();
    try {
      const view = render(<MarkdownRenderer content="" streaming />);
      view.rerender(<MarkdownRenderer content={CODE_DOC} streaming />);
      const streamingBlocks = allCodeBlocks(view.container);
      expect(streamingBlocks.length).toBe(2);
      for (const block of streamingBlocks) {
        expect(block.innerHTML).not.toContain('<span');
        // 文本本体必须实时（不因着色延迟而缺行）
        expect(block.textContent).not.toBe('');
      }
      // 落定：streaming 翻 false，同步全量高亮（目录树走 auto、ts 走 highlight）
      view.rerender(<MarkdownRenderer content={CODE_DOC} />);
      const settledBlocks = allCodeBlocks(view.container);
      expect(settledBlocks.length).toBe(2);
      expect(settledBlocks[1].innerHTML).toContain('<span');
      view.unmount();
    } finally {
      restore();
    }
  });

  it('已知语言流式着色按 300ms 节流补算，文本始终实时', () => {
    vi.useFakeTimers();
    const { restore } = spyHljsCounts();
    try {
      const lines = Array.from({ length: 30 }, (_, i) => `const value_${i} = ${i}; // 注释 ${i}`);
      const doc1 = ['```typescript', ...lines, '```'].join('\n');
      const view = render(<MarkdownRenderer content="" streaming />);
      view.rerender(<MarkdownRenderer content={doc1} streaming />);
      const code = () => view.container.querySelector('code.hljs') as HTMLElement;
      // 同步阶段：无着色
      expect(code().innerHTML).not.toContain('<span');

      act(() => { vi.advanceTimersByTime(300); });
      expect(code().innerHTML).toContain('<span');

      // 内容增长后：着色未追上 → 退化为实时纯文本；300ms 窗口后补上着色
      const doc2 = ['```typescript', ...lines, 'const added = 1;', '```'].join('\n');
      view.rerender(<MarkdownRenderer content={doc2} streaming />);
      expect(code().innerHTML).not.toContain('<span');
      act(() => { vi.advanceTimersByTime(299); });
      expect(code().innerHTML).not.toContain('<span');
      act(() => { vi.advanceTimersByTime(1); });
      expect(code().innerHTML).toContain('<span');
      // 着色补算后文本仍是最新内容
      expect(code().textContent).toContain('const added = 1;');
      view.unmount();
    } finally {
      vi.useRealTimers();
      restore();
    }
  });

  it('长文档流式每快照耗时保持在帧预算内', () => {
    const proseTimes = simulateStreaming(PROSE_DOC, 64);
    const codeTimes = simulateStreaming(CODE_DOC, 64);
    const proseLast20 = proseTimes.slice(-20);
    const codeLast20 = codeTimes.slice(-20);
    console.warn(
      `[perf] prose last20 mean=${mean(proseLast20).toFixed(2)}ms p90=${pct(proseTimes, 90).toFixed(2)}ms max=${Math.max(...proseTimes).toFixed(2)}ms; ` +
      `code-doc last20 mean=${mean(codeLast20).toFixed(2)}ms p90=${pct(codeTimes, 90).toFixed(2)}ms max=${Math.max(...codeTimes).toFixed(2)}ms`,
    );
    // 宽松预算（约 1.5 倍帧预算，吸收 CI 机器波动）：
    // 修复前 code-doc 为 last20 mean 22ms / p90 37ms / max 256ms
    expect(mean(codeLast20)).toBeLessThan(24);
    expect(pct(codeTimes, 90)).toBeLessThan(24);
    expect(Math.max(...codeTimes)).toBeLessThan(60);
    expect(mean(proseLast20)).toBeLessThan(24);
  });
});
